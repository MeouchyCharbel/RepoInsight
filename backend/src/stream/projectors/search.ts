import type { ChunkIndex } from '../../search/index.js';
import type { StreamEvent } from '../kafka.js';

/**
 * Search projector: each event names an entity; the projector re-reads that entity's current
 * canonical chunks from MongoDB and writes them to OpenSearch. Duplicate, delayed and
 * out-of-order events are therefore harmless (the projection is a function of current state,
 * guarded by external versions).
 */
export class SearchProjector {
  constructor(private index: ChunkIndex) {}

  async handle(ev: StreamEvent): Promise<string> {
    const p = ev.payload as Record<string, unknown> & { repo_id: string };
    const repo = p.repo_id;
    switch (ev.type) {
      case 'issue.opened':
      case 'issue.closed':
      case 'issue.reopened':
      case 'issue.updated':
        await this.index.projectSource(repo, `issue:${p.number}`, { thread: true });
        return 'projected';
      case 'pr.opened':
      case 'pr.merged':
      case 'pr.updated':
        await this.index.projectSource(repo, `pr:${p.number}`, { thread: true });
        return 'projected';
      case 'comment.added':
      case 'comment.edited':
        await this.index.projectSource(repo, `${p.thread_key}/comment:${p.comment_id}`);
        return 'projected';
      case 'document.changed':
        await this.index.projectSource(repo, String(p.source_id));
        return 'projected';
      case 'release.published':
      case 'release.updated':
        await this.index.projectSource(repo, `release/${p.release_id}`);
        return 'projected';
      case 'release.tagged':
        // Release containment of documentation revisions changed (chunk release_ids).
        for (const src of (p.source_ids as string[] | undefined) ?? []) await this.index.projectSource(repo, src);
        return 'projected';
      case 'repo.visibility_changed':
      case 'access.granted':
      case 'access.revoked':
        // Membership is never projected into the index (the query-time filter reads MongoDB);
        // visibility and acl_epoch are, so they are refreshed here.
        await this.index.updateRepoAccess(repo);
        return 'access-updated';
      default:
        return 'ignored';
    }
  }
}
