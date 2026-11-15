import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { HttpError, parse } from '../errors.js';
import { markerOf } from '../search/service.js';
import type { ChunkDoc, CommentDoc, DocumentRevisionDoc, IssueDoc } from '../types.js';
import { repoIdSchema } from '../validation.js';

const repoParams = z.object({ repoId: repoIdSchema });
const issueParams = z.object({ repoId: repoIdSchema, number: z.coerce.number().int().min(1).max(1e9) });
const docQuery = z.strictObject({
  source_id: z.string().min(1).max(300).regex(/^[^\u0000$]+$/),
  revision: z.coerce.number().int().min(1).max(1e6).optional(),
});

/** Read-only views of documents, revisions and issue threads (all access-checked). */
export async function docRoutes(app: FastifyInstance) {
  const { db, acl } = app;
  app.addHook('preHandler', requireAuth);

  app.get('/repos/:repoId/documents', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => ({
      items: await db
        .collection('documents')
        .find({ repo_id: repoId }, { projection: { _id: 0, source_id: 1, kind: 1, latest_revision: 1, updated_at: 1 } })
        .sort({ kind: 1, source_id: 1 })
        .limit(500)
        .toArray(),
    }));
  });

  /** One revision (latest by default) with its text, chunk map and the revision history. */
  app.get('/repos/:repoId/document', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    const q = parse(docQuery, req.query);
    return acl.withRead(req.principal!, repoId, async () => {
      const ptr = await db.collection('documents').findOne({ repo_id: repoId, source_id: q.source_id });
      if (!ptr) throw new HttpError(404, 'not_found', 'Document not found');
      const revision = q.revision ?? (ptr.latest_revision as number);
      const revs = await db.collection<DocumentRevisionDoc>('document_revisions').find({ repo_id: repoId, source_id: q.source_id }).sort({ revision: -1 }).toArray();
      const rev = revs.find((r) => r.revision === revision);
      if (!rev) throw new HttpError(404, 'not_found', 'Revision not found');
      const blob = await db.collection<{ digest: string; text: string }>('blobs').findOne({ digest: rev.source_digest });
      const chunks = await db.collection<ChunkDoc>('chunks').find({ repo_id: repoId, source_id: q.source_id }).sort({ revision: -1, line_start: 1 }).toArray();
      const releasesOf = (n: number) => [...new Set(chunks.filter((c) => c.revision === n).flatMap((c) => c.release_ids))].sort();
      return {
        source_id: q.source_id,
        kind: rev.kind,
        revision,
        latest_revision: ptr.latest_revision,
        commit_sha: rev.commit_sha,
        committed_at: rev.committed_at,
        text: blob?.text ?? '',
        chunks: chunks
          .filter((c) => c.revision === revision)
          .map((c) => ({
            chunk_id: c.chunk_id, section_anchor: c.section_anchor, heading_path: c.heading_path, line_start: c.line_start, line_end: c.line_end,
            marker: markerOf(c), guidance_status: c.guidance_status, superseded_by: c.superseded_by ?? null, release_ids: c.release_ids, config_keys: c.config_keys,
          })),
        revisions: revs.map((r) => ({ revision: r.revision, commit_sha: r.commit_sha, committed_at: r.committed_at, release_ids: releasesOf(r.revision) })),
      };
    });
  });

  app.get('/repos/:repoId/issues/:number/comments', async (req) => {
    const { repoId, number } = parse(issueParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => ({
      items: (await db.collection<CommentDoc>('comments').find({ repo_id: repoId, thread_key: `issue:${number}` }).sort({ created_at: 1 }).limit(500).toArray()).map((c) => ({
        comment_id: c.comment_id, kind: c.kind, author_id: c.author_id, body: c.body, created_at: c.created_at, updated_at: c.updated_at, revision: c.revision,
      })),
    }));
  });

  /** Issue revision history, including late (older) updates kept as history only. */
  app.get('/repos/:repoId/issues/:number/revisions', async (req) => {
    const { repoId, number } = parse(issueParams, req.params);
    return acl.withRead(req.principal!, repoId, async () => ({
      items: (await db.collection<IssueDoc & { late?: boolean }>('issue_revisions').find({ repo_id: repoId, number }).sort({ source_updated_at: -1 }).limit(200).toArray()).map((r) => ({
        revision: r.revision, title: r.title, state: r.state, labels: r.labels, source_updated_at: r.source_updated_at, late: r.late ?? false,
      })),
    }));
  });
}
