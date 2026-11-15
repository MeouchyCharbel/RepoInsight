import type { FastifyInstance } from 'fastify';
import type { Filter } from 'mongodb';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { HttpError, parse } from '../errors.js';
import type { IssueDoc, RepositoryDoc } from '../types.js';
import { labelSchema, repoIdSchema } from '../validation.js';

const repoParams = z.object({ repoId: repoIdSchema });
const issueParams = z.object({ repoId: repoIdSchema, number: z.coerce.number().int().min(1).max(1e9) });
// Strict: unknown query parameters (e.g. "label[$ne]") are rejected rather than ignored.
const issueQuery = z.strictObject({
  label: labelSchema.optional(),
  state: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
const cursorSchema = z.object({ u: z.iso.datetime(), n: z.number().int().min(1) });

const repoView = (r: RepositoryDoc) => ({
  repo_id: r.repo_id,
  full_name: r.full_name,
  description: r.description ?? null,
  visibility: r.visibility,
  default_branch: r.default_branch,
});

const issueSummary = (i: IssueDoc) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  labels: i.labels,
  updated_at: i.updated_at,
  fixed_in_release: i.fixed_in_release ?? null,
  fixed_in_status: i.fixed_in_status ?? null,
});

function decodeCursor(raw: string) {
  try {
    return parse(cursorSchema, JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'invalid_request', 'Invalid request: cursor');
  }
}

export async function repoRoutes(app: FastifyInstance) {
  const { db, acl } = app;
  const repos = db.collection<RepositoryDoc>('repositories');
  const issues = db.collection<IssueDoc>('issues');
  app.addHook('preHandler', requireAuth);

  // Only repositories the caller can read: public, or private with a current membership.
  app.get('/repos', async (req) => {
    const memberIds = await acl.memberRepoIds(req.principal!);
    const rows = await repos
      .find({ $or: [{ visibility: 'public' }, { repo_id: { $in: memberIds } }] })
      .sort({ full_name: 1 })
      .limit(200)
      .toArray();
    return { items: rows.map(repoView) };
  });

  app.get('/repos/:repoId', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    return acl.withRead(req.principal!, repoId, async (access) => {
      const repo = await repos.findOne({ repo_id: repoId });
      if (!repo) throw new HttpError(404, 'not_found', 'Repository not found');
      return { ...repoView(repo), your_role: access.role };
    });
  });

  // Keyset pagination on (updated_at desc, number desc); no total counts are returned.
  app.get('/repos/:repoId/issues', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    const q = parse(issueQuery, req.query);
    return acl.withRead(req.principal!, repoId, async () => {
      const filter: Filter<IssueDoc> = { repo_id: repoId };
      if (q.label) filter.labels = q.label;
      if (q.state) filter.state = q.state;
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        const u = new Date(c.u);
        filter.$or = [{ updated_at: { $lt: u } }, { updated_at: u, number: { $lt: c.n } }];
      }
      const rows = await issues.find(filter).sort({ updated_at: -1, number: -1 }).limit(q.limit + 1).toArray();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const next =
        rows.length > q.limit && last
          ? Buffer.from(JSON.stringify({ u: last.updated_at.toISOString(), n: last.number })).toString('base64url')
          : null;
      return { items: page.map(issueSummary), next_cursor: next };
    });
  });

  app.get('/repos/:repoId/issues/:number', async (req) => {
    const { repoId, number } = parse(issueParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => {
      const issue = await issues.findOne({ repo_id: repoId, number });
      if (!issue) throw new HttpError(404, 'not_found', 'Issue not found');
      return { ...issueSummary(issue), body: issue.body, author_id: issue.author_id, revision: issue.revision, created_at: issue.created_at };
    });
  });
}
