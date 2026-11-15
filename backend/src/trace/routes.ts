import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { HttpError, parse } from '../errors.js';
import type { EdgeDoc, IssueDoc, PullRequestDoc, ReleaseDoc } from '../types.js';
import { repoIdSchema } from '../validation.js';
import type { TraceBuilder } from './builder.js';

const tagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/);
const issueParams = z.object({ repoId: repoIdSchema, number: z.coerce.number().int().min(1).max(1e9) });
const releaseParams = z.object({ repoId: repoIdSchema, tag: tagSchema });

/**
 * Relationship tracing endpoints. Every route checks repository access first and re-checks
 * before responding; traversal never leaves the repository being read.
 */
export async function traceRoutes(app: FastifyInstance, opts: { builder: TraceBuilder }) {
  const { db, acl } = app;
  app.addHook('preHandler', requireAuth);

  app.get('/repos/:repoId/issues/:number/trace', async (req) => {
    const { repoId, number } = parse(issueParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => {
      const t = await opts.builder.traceIssue(repoId, number);
      if (!t) throw new HttpError(404, 'not_found', 'Issue not found');
      return t;
    });
  });

  app.get('/repos/:repoId/releases', async (req) => {
    const { repoId } = parse(z.object({ repoId: repoIdSchema }), req.params);
    return acl.withRead(req.principal!, repoId, async () => ({
      items: (await db.collection<ReleaseDoc>('releases').find({ repo_id: repoId }).sort({ published_at: -1 }).limit(100).toArray()).map((r) => ({
        release_id: r.release_id,
        name: r.name,
        published_at: r.published_at,
        channel: r.channel,
        target_sha: r.target_sha,
        prev_release_id: r.prev_release_id ?? null,
      })),
    }));
  });

  /**
   * Issues fixed in a release, from the materialised edges (single indexed reads per hop):
   * release -> commits in its range -> PRs merged as those commits (directly or via a verified
   * backport) -> issues closed by those PRs. Unverified links are returned separately.
   */
  app.get('/repos/:repoId/releases/:tag/issues', async (req) => {
    const { repoId, tag } = parse(releaseParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => {
      const rel = await db.collection<ReleaseDoc>('releases').findOne({ repo_id: repoId, release_id: tag });
      if (!rel) throw new HttpError(404, 'not_found', 'Release not found');
      const edges = db.collection<EdgeDoc>('edges');
      const inRange = await edges.find({ repo_id: repoId, from: `release:${tag}`, relation: 'RELEASE_CONTAINS_COMMIT', status: 'active' }).toArray();
      const commits = inRange.map((e) => e.to);
      const backports = await edges.find({ repo_id: repoId, relation: 'COMMIT_BACKPORT_OF', status: 'active', from: { $in: commits } }).toArray();
      const target = new Map<string, { via: string; confidence: string; commit: string }>();
      for (const c of commits) target.set(c, { via: 'merged_commit', confidence: 'verified', commit: c });
      for (const b of backports) target.set(b.to, { via: `backport:${b.provenance}`, confidence: b.confidence, commit: b.from });
      const merged = await edges.find({ repo_id: repoId, relation: 'PR_MERGED_AS_COMMIT', status: 'active', to: { $in: [...target.keys()] } }).toArray();
      const prKeys = merged.map((m) => m.from);
      const fixes = await edges.find({ repo_id: repoId, relation: 'ISSUE_FIXED_BY_PR', status: 'active', to: { $in: prKeys } }).toArray();
      const issues = await db.collection<IssueDoc>('issues').find({ repo_id: repoId, number: { $in: fixes.map((f) => Number(f.from.slice(6))) } }, { projection: { number: 1, title: 1, labels: 1, state: 1 } }).toArray();
      const prs = new Map((await db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId, number: { $in: prKeys.map((k) => Number(k.slice(3))) } }, { projection: { number: 1, merged_sha: 1 } }).toArray()).map((p) => [`pr:${p.number}`, p]));

      const items = fixes.map((f) => {
        const pr = prs.get(f.to);
        const t = target.get(`commit:${pr?.merged_sha}`);
        const issue = issues.find((i) => i.number === Number(f.from.slice(6)));
        const confidence = f.confidence === 'verified' && t?.confidence === 'verified' ? 'verified' : 'unverified';
        return { issue: issue ? { number: issue.number, title: issue.title, labels: issue.labels, state: issue.state } : null, pr: Number(f.to.slice(3)), via: t?.via ?? null, commit: t?.commit.slice(7) ?? null, confidence };
      });
      return {
        release_id: tag,
        range: { from: rel.prev_release_id ?? null, to: tag },
        verified: items.filter((i) => i.confidence === 'verified'),
        unverified: items.filter((i) => i.confidence !== 'verified'),
        note: 'Lists fixes first included in this release range. Use the issue trace for inclusion in any release.',
      };
    });
  });
}
