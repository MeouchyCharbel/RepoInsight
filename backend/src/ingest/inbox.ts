import type { Db } from 'mongodb';
import { z } from 'zod';
import type { AclService } from '../acl/service.js';
import { HttpError } from '../errors.js';
import { sha256 } from './chunker.js';
import type { ApplyResult, IngestStore } from './store.js';

const date = z.coerce.date();
const repoId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const issue = z.object({
  number: z.number().int().min(1),
  title: z.string().max(500),
  body: z.string().max(200_000),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string().max(64)).max(50),
  author_id: z.string().max(100),
  created_at: date,
  updated_at: date,
});

/** The six streaming events of the brief (plus edits), in a provider-neutral webhook shape. */
export const deliverySchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['issue.opened', 'issue.closed', 'issue.edited']), repo_id: repoId, issue }),
  z.object({
    type: z.literal('comment.added'),
    repo_id: repoId,
    thread_key: z.string().regex(/^(issue|pr):\d{1,9}$/),
    comment: z.object({ id: z.string().max(64), body: z.string().max(200_000), author_id: z.string().max(100), created_at: date, updated_at: date }),
  }),
  z.object({
    type: z.literal('document.changed'),
    repo_id: repoId,
    source_id: z.string().min(1).max(300).regex(/^[^\u0000$]+$/),
    revision: z.number().int().min(1),
    commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
    committed_at: date,
    text: z.string().max(1_000_000),
  }),
  z.object({
    type: z.literal('release.published'),
    repo_id: repoId,
    release: z.object({ tag: z.string().min(1).max(100), name: z.string().max(200), body: z.string().max(200_000), target_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(), published_at: date, prerelease: z.boolean() }),
  }),
  z.object({
    type: z.enum(['access.revoked', 'access.granted']),
    repo_id: repoId,
    principal_id: z.string().max(100),
    role: z.enum(['read', 'write', 'admin']).optional(),
    seq: z.number().int().min(0),
  }),
]);

export const envelopeSchema = z.object({
  provider: z.enum(['github', 'synthetic']),
  delivery_id: z.string().min(1).max(100), // e.g. GitHub's X-GitHub-Delivery GUID
  event: deliverySchema,
});
export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Durable inbox (report 6.4): the delivery is recorded before it is applied; a repeated
 * delivery_id is a no-op. Application itself is idempotent, so redelivery under a new id is also
 * harmless. Deliveries left in "received" (crash between record and apply) are re-applied by
 * reprocessPending().
 */
export class Inbox {
  constructor(
    private db: Db,
    private store: IngestStore,
    private acl: AclService,
  ) {}

  async receive(raw: unknown): Promise<{ status: 'duplicate' | ApplyResult | 'ignored' }> {
    // Validate here as well as at the route: deliveries are untrusted external input.
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Invalid delivery');
    const env = parsed.data;
    const inbox = this.db.collection('inbox');
    try {
      await inbox.insertOne({
        provider: env.provider,
        delivery_id: env.delivery_id,
        type: env.event.type,
        repo_id: env.event.repo_id,
        payload: env.event,
        payload_digest: sha256(JSON.stringify(env.event)),
        status: 'received',
        received_at: new Date(),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return { status: 'duplicate' };
      throw e;
    }
    return this.applyRecorded(env);
  }

  async reprocessPending(olderThanMs = 30_000): Promise<number> {
    const rows = await this.db
      .collection('inbox')
      .find({ status: 'received', received_at: { $lt: new Date(Date.now() - olderThanMs) } })
      .limit(500)
      .toArray();
    for (const r of rows) await this.applyRecorded({ provider: r.provider, delivery_id: r.delivery_id, event: deliverySchema.parse(r.payload) });
    return rows.length;
  }

  private async applyRecorded(env: Envelope) {
    const key = { provider: env.provider, delivery_id: env.delivery_id };
    try {
      const status = await this.apply(env.event);
      await this.db.collection('inbox').updateOne(key, { $set: { status: 'applied', result: status, applied_at: new Date() } });
      return { status };
    } catch (e) {
      await this.db.collection('inbox').updateOne(key, { $set: { status: 'failed', error: e instanceof HttpError ? e.message : 'apply failed' }, $inc: { attempts: 1 } });
      throw e;
    }
  }

  private async apply(ev: z.infer<typeof deliverySchema>): Promise<ApplyResult | 'ignored'> {
    const exists = await this.db.collection('repositories').countDocuments({ repo_id: ev.repo_id }, { limit: 1 });
    if (!exists) throw new HttpError(400, 'unknown_repository', 'Unknown repository');
    switch (ev.type) {
      case 'issue.opened':
      case 'issue.closed':
      case 'issue.edited': {
        const { updated_at, ...i } = ev.issue;
        return this.store.upsertIssue({ ...i, repo_id: ev.repo_id, closed_at: i.state === 'closed' ? updated_at : null, source_updated_at: updated_at });
      }
      case 'comment.added':
        return this.store.upsertComment({
          repo_id: ev.repo_id, thread_key: ev.thread_key, comment_id: ev.comment.id, kind: 'issue_comment',
          author_id: ev.comment.author_id, body: ev.comment.body, created_at: ev.comment.created_at, source_updated_at: ev.comment.updated_at,
        });
      case 'document.changed':
        return this.store.addDocumentRevision({ repo_id: ev.repo_id, source_id: ev.source_id, revision: ev.revision, kind: 'doc', commit_sha: ev.commit_sha, committed_at: ev.committed_at, text: ev.text });
      case 'release.published':
        return this.store.upsertRelease({
          repo_id: ev.repo_id, release_id: ev.release.tag, name: ev.release.name, body: ev.release.body, target_sha: ev.release.target_sha,
          published_at: ev.release.published_at, prerelease: ev.release.prerelease, source_updated_at: ev.release.published_at,
        });
      case 'access.granted':
      case 'access.revoked': {
        const role = ev.type === 'access.granted' ? (ev.role ?? 'read') : null;
        const r = await this.acl.applyProviderPermission(ev.repo_id, ev.principal_id, role, ev.seq);
        return r.ignored ? 'ignored' : 'applied';
      }
    }
  }
}
