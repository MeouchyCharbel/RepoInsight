import type { Client } from '@opensearch-project/opensearch';
import type { Db, Filter } from 'mongodb';
import { TransientError } from '../stream/consumer.js';
import type { ChunkDoc, IssueDoc, PullRequestDoc, RepositoryDoc } from '../types.js';

/**
 * OpenSearch projection of `chunks` (report Section 8). It is derived data: every document can be
 * rebuilt from MongoDB, and search results are always re-checked against MongoDB before use.
 * Writes go through an alias so a rebuilt index can be swapped in atomically.
 */
export const CHUNKS_MAPPING = {
  settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' },
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      chunk_id: { type: 'keyword' },
      repo_id: { type: 'keyword' },
      repo_full_name: { type: 'keyword' },
      visibility: { type: 'keyword' },
      acl_epoch: { type: 'integer' },
      source_type: { type: 'keyword' },
      source_id: { type: 'keyword' },
      revision: { type: 'integer' },
      section_anchor: { type: 'keyword' },
      heading_path: { type: 'text', analyzer: 'english' },
      line_start: { type: 'integer' },
      line_end: { type: 'integer' },
      text: { type: 'text', analyzer: 'english' },
      text_digest: { type: 'keyword' },
      thread_title: { type: 'text', analyzer: 'english' },
      thread_state: { type: 'keyword' },
      labels: { type: 'keyword' },
      config_keys: { type: 'keyword' },
      release_ids: { type: 'keyword' },
      is_latest: { type: 'boolean' },
      guidance_status: { type: 'keyword' },
      superseded_by_revision: { type: 'integer' },
      commit_sha: { type: 'keyword' },
      created_at: { type: 'date' },
      projected_at: { type: 'date' },
    },
  },
};

export type SearchDoc = Record<string, unknown> & { chunk_id: string };

type Parent = Pick<IssueDoc, 'labels' | 'title' | 'state' | 'revision'> | Pick<PullRequestDoc, 'labels' | 'title' | 'state' | 'revision'>;

/** Builds the indexed document; thread metadata comes from the parent's current canonical state. */
export function toSearchDoc(c: ChunkDoc, repo: Pick<RepositoryDoc, 'visibility' | 'acl_epoch' | 'full_name'>, parent: Parent | null): SearchDoc {
  return {
    chunk_id: c.chunk_id,
    repo_id: c.repo_id,
    repo_full_name: repo.full_name,
    visibility: repo.visibility,
    acl_epoch: repo.acl_epoch,
    source_type: c.source_type,
    source_id: c.source_id,
    revision: c.revision,
    section_anchor: c.section_anchor,
    heading_path: c.heading_path,
    line_start: c.line_start,
    line_end: c.line_end,
    text: c.text,
    text_digest: c.text_digest,
    thread_title: parent?.title ?? c.thread_title,
    thread_state: parent?.state ?? null,
    labels: parent?.labels ?? c.labels,
    config_keys: c.config_keys,
    release_ids: c.release_ids,
    is_latest: c.is_latest,
    guidance_status: c.guidance_status,
    superseded_by_revision: c.superseded_by_revision,
    commit_sha: c.commit_sha,
    created_at: c.created_at,
    projected_at: new Date(),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Network/availability failures from OpenSearch are transient (retry, never dead-letter). */
export function wrapTransient(e: unknown): never {
  const name = (e as { name?: string }).name ?? '';
  const status = (e as { meta?: { statusCode?: number } }).meta?.statusCode;
  if (/ConnectionError|TimeoutError|NoLivingConnectionsError/.test(name) || status === 429 || (status ?? 0) >= 500) throw new TransientError(name || 'search unavailable');
  throw e;
}

export class ChunkIndex {
  constructor(
    private os: Client,
    private db: Db,
    public alias: string,
  ) {}

  async ensure(): Promise<void> {
    const exists = (await this.os.indices.existsAlias({ index: `${this.alias}-*`, name: this.alias })).body;
    if (exists) return;
    await this.os.indices.create({ index: `${this.alias}-v1`, body: { ...CHUNKS_MAPPING, aliases: { [this.alias]: {} } } as never });
  }

  /**
   * Re-projects chunks of one source (or a thread: "issue:81" also covers "issue:81/comment:*")
   * from MongoDB. External versioning (version_type external_gte) rejects a write computed from an
   * older canonical state, so a delayed consumer cannot overwrite a newer projection.
   */
  async projectSource(repoId: string, sourceId: string, opts: { thread?: boolean } = {}): Promise<{ indexed: number; stale: number }> {
    const filter: Filter<ChunkDoc> = opts.thread
      ? { repo_id: repoId, source_id: { $regex: `^${escapeRe(sourceId)}(/|$)` } }
      : { repo_id: repoId, source_id: sourceId };
    const chunks = await this.db.collection<ChunkDoc>('chunks').find(filter).toArray();
    if (!chunks.length) return { indexed: 0, stale: 0 };
    return this.writeChunks(chunks);
  }

  async writeChunks(chunks: ChunkDoc[], versionOverride?: number): Promise<{ indexed: number; stale: number }> {
    const repoIds = [...new Set(chunks.map((c) => c.repo_id))];
    const repos = new Map((await this.db.collection<RepositoryDoc>('repositories').find({ repo_id: { $in: repoIds } }).toArray()).map((r) => [r.repo_id, r]));
    const latestRev = new Map<string, number>();
    for (const c of chunks) latestRev.set(`${c.repo_id}|${c.source_id}`, Math.max(latestRev.get(`${c.repo_id}|${c.source_id}`) ?? 0, c.revision));
    const parents = await this.loadParents(chunks);

    const body: object[] = [];
    for (const c of chunks) {
      const repo = repos.get(c.repo_id);
      if (!repo) continue;
      const parent = parents.get(`${c.repo_id}|${threadOf(c.source_id)}`) ?? null;
      // Newest revision of this source, then the parent thread revision (for label/title changes).
      const version = versionOverride ?? latestRev.get(`${c.repo_id}|${c.source_id}`)! * 1_000_000 + (parent?.revision ?? 0);
      body.push({ index: { _index: this.alias, _id: c.chunk_id, version, version_type: 'external_gte' } }, toSearchDoc(c, repo, parent));
    }
    if (!body.length) return { indexed: 0, stale: 0 };
    let res;
    try {
      res = await this.os.bulk({ body, refresh: false });
    } catch (e) {
      wrapTransient(e);
    }
    let stale = 0;
    for (const item of res.body.items as { index: { status: number; error?: { type: string } } }[]) {
      if (item.index.status === 409) stale++;
      else if (item.index.status >= 500 || item.index.status === 429) throw new TransientError(`bulk item ${item.index.status}`);
      else if (item.index.status >= 300) throw new Error(`bulk indexing rejected: ${item.index.error?.type ?? item.index.status}`);
    }
    return { indexed: body.length / 2 - stale, stale };
  }

  private async loadParents(chunks: ChunkDoc[]) {
    const out = new Map<string, Parent>();
    const want = (prefix: 'issue' | 'pr') =>
      [...new Set(chunks.map((c) => threadOf(c.source_id)).filter((t) => t.startsWith(`${prefix}:`)))].map((t) => Number(t.split(':')[1]));
    const repoId = chunks[0]!.repo_id;
    for (const [prefix, coll] of [['issue', 'issues'], ['pr', 'pull_requests']] as const) {
      const numbers = want(prefix);
      if (!numbers.length) continue;
      const rows = await this.db.collection<IssueDoc>(coll).find({ repo_id: repoId, number: { $in: numbers } }, { projection: { number: 1, labels: 1, title: 1, state: 1, revision: 1 } }).toArray();
      for (const r of rows) out.set(`${repoId}|${prefix}:${r.number}`, r);
    }
    return out;
  }

  /** Visibility/epoch change: update every projected document of the repository. */
  async updateRepoAccess(repoId: string): Promise<number> {
    const repo = await this.db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId });
    if (!repo) return 0;
    try {
      const res = await this.os.updateByQuery({
        index: this.alias,
        conflicts: 'proceed',
        refresh: true,
        body: {
          query: { term: { repo_id: repoId } },
          script: { source: 'ctx._source.visibility = params.v; ctx._source.acl_epoch = params.e', params: { v: repo.visibility, e: repo.acl_epoch } },
        },
      });
      return (res.body as { updated?: number }).updated ?? 0;
    } catch (e) {
      wrapTransient(e);
    }
  }

  /**
   * Rebuild from MongoDB (report 6.4): bulk-load a new versioned index, verify the document count,
   * atomically swap the alias, then catch up sources that changed during the rebuild. The old
   * index is kept for rollback.
   */
  async rebuild(): Promise<{ from: string | null; to: string; count: number }> {
    const started = new Date();
    const current = await this.currentIndex();
    const version = current ? Number(/-v(\d+)$/.exec(current)?.[1] ?? 0) + 1 : 1;
    const target = `${this.alias}-v${version}`;
    await this.os.indices.create({ index: target, body: CHUNKS_MAPPING as never });

    const writer = new ChunkIndex(this.os, this.db, target);
    const cursor = this.db.collection<ChunkDoc>('chunks').find({}).sort({ repo_id: 1, source_id: 1 });
    let batch: ChunkDoc[] = [];
    for await (const c of cursor) {
      batch.push(c);
      if (batch.length >= 500 && batch.at(-1)!.repo_id !== c.repo_id) {
        await writer.writeChunks(batch);
        batch = [];
      }
    }
    // Flush in per-repository groups (parent lookups are per repository).
    for (const repoId of new Set(batch.map((c) => c.repo_id))) await writer.writeChunks(batch.filter((c) => c.repo_id === repoId));
    await this.os.indices.refresh({ index: target });

    const expected = await this.db.collection('chunks').countDocuments();
    const count = Number((await this.os.count({ index: target })).body.count);
    if (count !== expected) throw new Error(`rebuild verification failed: ${count} of ${expected} documents`);

    const actions: object[] = [{ add: { index: target, alias: this.alias } }];
    if (current) actions.unshift({ remove: { index: current, alias: this.alias } });
    await this.os.indices.updateAliases({ body: { actions } });

    // Catch-up for changes committed while the bulk load ran.
    const changed = await this.db.collection<ChunkDoc>('chunks').find({ created_at: { $gte: started } }).toArray();
    for (const repoId of new Set(changed.map((c) => c.repo_id))) {
      for (const src of new Set(changed.filter((c) => c.repo_id === repoId).map((c) => c.source_id))) await this.projectSource(repoId, src);
    }
    return { from: current, to: target, count };
  }

  async currentIndex(): Promise<string | null> {
    const exists = (await this.os.indices.existsAlias({ index: `${this.alias}-*`, name: this.alias })).body;
    if (!exists) return null;
    const res = await this.os.indices.getAlias({ index: `${this.alias}-*`, name: this.alias });
    return Object.keys(res.body)[0] ?? null;
  }
}

/** "issue:81/comment:9" -> "issue:81"; documents map to themselves. */
export const threadOf = (sourceId: string) => sourceId.split('/comment:')[0]!;
