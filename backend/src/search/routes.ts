import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { HttpError, parse } from '../errors.js';
import { labelSchema, repoIdSchema } from '../validation.js';
import type { QueryLog } from './querylog.js';
import type { SearchService } from './service.js';

const tag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/);
const query = z.string().trim().min(1).max(200);
const searchQuery = z.strictObject({
  q: query,
  repo: repoIdSchema.optional(),
  label: labelSchema.optional(),
  release: tag.optional(),
  type: z.string().max(100).optional().transform((v, ctx) => {
    if (!v) return undefined;
    const types = v.split(',');
    const ok = ['doc', 'release_notes', 'issue', 'pr', 'comment'];
    if (!types.every((t) => ok.includes(t))) {
      ctx.addIssue({ code: 'custom', message: 'type' });
      return z.NEVER;
    }
    return types as ('doc' | 'release_notes' | 'issue' | 'pr' | 'comment')[];
  }),
  // Default shows everything, clearly marked (historical results rank lower); 'current' filters.
  status: z.enum(['current', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const verifyBody = z.strictObject({ repo_id: repoIdSchema, chunk_id: z.string().regex(/^c_[0-9a-f]{24}$/) });
const compareQuery = z.strictObject({
  topic: z.string().regex(/^(--[a-z][a-z0-9-]+|[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+)$/),
  from: tag.optional(),
  to: z.union([tag, z.literal('effective')]).optional(),
});
const answerBody = z.strictObject({ repo_id: repoIdSchema, query, release: tag.optional() });

export async function searchRoutes(app: FastifyInstance, opts: { service: SearchService; log: QueryLog }) {
  const { service, log } = opts;
  app.addHook('preHandler', requireAuth);

  app.get('/search', async (req) => {
    const q = parse(searchQuery, req.query);
    const r = await service.search(req.principal!, { q: q.q, repo: q.repo, label: q.label, release: q.release, types: q.type, status: q.status, limit: q.limit });
    const repos = [...new Set(r.items.map((i) => i.repo_id))];
    const queryId = await log.write({
      endpoint: 'search', principalId: req.principal!.userId, repoIds: q.repo ? [q.repo] : repos, tenantId: q.repo ?? 'multi', query: q.q,
      filters: { label: q.label, release: q.release, type: q.type, status: q.status }, aclEpochs: r.aclEpochs, indexAlias: service.alias,
      latencyMs: r.timings, resultCount: r.items.length, dropped: r.dropped,
    });
    // No hit totals: they could reveal documents the caller is not allowed to see.
    return { query_id: queryId, items: r.items };
  });

  app.post('/citations/verify', async (req) => {
    const b = parse(verifyBody, req.body);
    return service.verifyCitation(req.principal!, b.repo_id, b.chunk_id);
  });

  app.get('/repos/:repoId/guidance/compare', async (req) => {
    const { repoId } = parse(z.object({ repoId: repoIdSchema }), req.params);
    const q = parse(compareQuery, req.query);
    return service.compare(req.principal!, repoId, q.topic, q.from, q.to);
  });

  app.post('/answer', async (req) => {
    const b = parse(answerBody, req.body);
    return service.answer(req.principal!, b.repo_id, b.query, b.release);
  });

  app.get('/analytics/queries', async (req) => {
    if (!req.principal?.isPlatformAdmin) throw new HttpError(403, 'forbidden', 'Platform admin role required');
    const { days } = parse(z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(7) }), req.query);
    return { items: await log.summary(days), note: 'Aggregates over pseudonymised logs; raw query text is not stored by default.' };
  });
}
