import { randomBytes } from 'node:crypto';
import type { ClientSession, Db, Document, Filter, MongoClient } from 'mongodb';
import { audit } from '../audit.js';
import type {
  ChunkDoc,
  CommentDoc,
  CommitDoc,
  DocumentRevisionDoc,
  IssueDoc,
  OutboxDoc,
  PullRequestDoc,
  ReleaseDoc,
  RepositoryDoc,
} from '../types.js';
import { chunkId, chunkMarkdown, extractConfigKeys, sha256 } from './chunker.js';

/**
 * applied   = new current revision written (one outbox event emitted)
 * duplicate = identical content already stored (no event)
 * stale     = older than what is stored: kept as history only, current state untouched
 */
export type ApplyResult = 'applied' | 'duplicate' | 'stale';

type Versioned = { source_updated_at: Date };

export type IssueInput = Omit<IssueDoc, 'revision' | 'content_digest' | 'updated_at'> & Versioned;
export type PullRequestInput = Omit<PullRequestDoc, 'revision' | 'content_digest' | 'updated_at'>;
export type CommentInput = Omit<CommentDoc, 'revision' | 'content_digest' | 'updated_at'>;
export type ReleaseInput = Omit<ReleaseDoc, 'revision' | 'content_digest' | 'updated_at' | 'channel'> & { prerelease: boolean };
export interface DocRevisionInput {
  repo_id: string;
  source_id: string;
  revision: number;
  kind: 'doc' | 'release_notes';
  commit_sha: string | null;
  committed_at: Date;
  text: string;
}
export interface RepositoryInput {
  provider: 'github' | 'synthetic';
  provider_id: number;
  org_id: string;
  full_name: string;
  description?: string;
  visibility: 'public' | 'private';
  default_branch: string;
}

const digestOf = (v: unknown) => sha256(JSON.stringify(v));

/**
 * Canonical writes into MongoDB (the source of truth). Every accepted change is written in one
 * majority transaction together with its transactional-outbox event, so a committed change always
 * has a publish intent (report 6.4). Ordering uses the provider's updated_at per entity
 * (compare-and-set); no global order is assumed (report 6.2).
 */
export class IngestStore {
  constructor(
    private db: Db,
    private client: MongoClient,
  ) {}

  private async txn<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const s = this.client.startSession();
    try {
      let out!: T;
      await s.withTransaction(
        async () => {
          out = await fn(s);
        },
        { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' } },
      );
      return out;
    } finally {
      await s.endSession();
    }
  }

  /** Change topic keyed by repo_id:entity_type:entity_id, so one entity's events stay ordered. */
  private async emit(s: ClientSession, repoId: string, entity: string, revision: number | string, type: string, payload: Document, at: Date = new Date()) {
    const key = `${repoId}:${entity}`;
    await this.db.collection<OutboxDoc>('outbox').insertOne(
      {
        event_id: `${key}:${revision}`,
        topic: 'ri.changes',
        key,
        type,
        // occurred_at: source time of the change (used for activity buckets and lag).
        payload: { ...payload, repo_id: repoId, entity_key: key, revision, occurred_at: at.toISOString() },
        created_at: new Date(),
        published_at: null,
        attempts: 0,
      },
      { session: s },
    );
  }

  /** Compare-and-set on the provider timestamp, with a content digest to detect no-op updates. */
  private async versioned<T extends Versioned>(
    s: ClientSession,
    coll: string,
    filter: Document,
    data: T,
    digest: string,
    history?: string,
  ): Promise<{ result: ApplyResult; revision: number; prev: (T & { revision: number; content_digest: string }) | null }> {
    const c = this.db.collection(coll);
    const prev = (await c.findOne(filter, { session: s })) as (T & { revision: number; content_digest: string }) | null;
    const inTs = data.source_updated_at.getTime();
    if (prev) {
      // Records written without a provider timestamp (e.g. seeded) count as oldest.
      const curTs = prev.source_updated_at?.getTime() ?? 0;
      if (inTs < curTs) {
        if (history) {
          await this.db.collection(history).updateOne(
            { ...filter, source_updated_at: data.source_updated_at },
            { $setOnInsert: { ...data, content_digest: digest, revision: null, late: true } },
            { upsert: true, session: s },
          );
        }
        return { result: 'stale', revision: prev.revision, prev };
      }
      if (prev.content_digest === digest) {
        if (inTs > curTs) await c.updateOne(filter, { $set: { source_updated_at: data.source_updated_at } }, { session: s });
        return { result: 'duplicate', revision: prev.revision, prev };
      }
      // Same timestamp but different content (same-second edit): accept as the newer state.
    }
    const revision = (prev?.revision ?? 0) + 1;
    await c.updateOne(
      filter,
      { $set: { ...data, content_digest: digest, revision, updated_at: data.source_updated_at } },
      { upsert: true, session: s },
    );
    if (history) {
      await this.db.collection(history).updateOne(
        { ...filter, source_updated_at: data.source_updated_at },
        { $setOnInsert: { ...data, content_digest: digest, revision } },
        { upsert: true, session: s },
      );
    }
    return { result: 'applied', revision, prev };
  }

  /** Writes chunks for one source revision; when it is the latest, older revisions are demoted. */
  private async writeChunks(
    s: ClientSession,
    src: {
      repo_id: string;
      source_type: ChunkDoc['source_type'];
      source_id: string;
      revision: number;
      text: string;
      is_latest: boolean;
      guidance: ChunkDoc['guidance_status'];
      labels?: string[];
      thread_title?: string | null;
      commit_sha?: string | null;
    },
  ) {
    const chunks = this.db.collection<ChunkDoc>('chunks');
    const drafts = chunkMarkdown(src.text);
    if (drafts.length) {
      await chunks.bulkWrite(
        drafts.map((d) => {
          const doc: ChunkDoc = {
            repo_id: src.repo_id,
            chunk_id: chunkId(src.repo_id, src.source_id, src.revision, d.anchor, d.ordinal),
            source_type: src.source_type,
            source_id: src.source_id,
            revision: src.revision,
            section_anchor: d.anchor,
            heading_path: d.heading_path,
            ordinal: d.ordinal,
            line_start: d.line_start,
            line_end: d.line_end,
            text: d.text,
            text_digest: sha256(d.text),
            config_keys: extractConfigKeys(d.text),
            labels: src.labels ?? [],
            thread_title: src.thread_title ?? null,
            is_latest: src.is_latest,
            guidance_status: src.is_latest ? src.guidance : 'historical',
            superseded_by_revision: null,
            release_ids: [],
            commit_sha: src.commit_sha ?? null,
            created_at: new Date(),
          };
          return { updateOne: { filter: { repo_id: doc.repo_id, chunk_id: doc.chunk_id }, update: { $setOnInsert: doc }, upsert: true } };
        }),
        { session: s, ordered: true },
      );
    }
    if (src.is_latest) {
      await chunks.updateMany(
        { repo_id: src.repo_id, source_id: src.source_id, revision: { $lt: src.revision }, is_latest: true },
        { $set: { is_latest: false, guidance_status: 'historical', superseded_by_revision: src.revision } },
        { session: s },
      );
    }
  }

  // ---------------------------------------------------------------- repositories, branches, people

  /** Inserts (new random repo_id) or updates metadata. A provider visibility change bumps acl_epoch. */
  async upsertRepository(r: RepositoryInput): Promise<string> {
    return this.txn(async (s) => {
      const repos = this.db.collection<RepositoryDoc>('repositories');
      const cur = await repos.findOne({ provider: r.provider, provider_id: r.provider_id }, { session: s });
      const now = new Date();
      if (!cur) {
        // Random, non-monotonic internal id (report Section 4), mapped to the provider id.
        const repoId = `r${randomBytes(8).toString('hex')}`;
        await repos.insertOne({ ...r, repo_id: repoId, acl_epoch: 1, created_at: now, updated_at: now }, { session: s });
        await this.emit(s, repoId, 'repo', 1, 'repo.imported', { full_name: r.full_name, visibility: r.visibility });
        return repoId;
      }
      const update: Document = { $set: { ...r, updated_at: now } };
      if (cur.visibility !== r.visibility) {
        update.$inc = { acl_epoch: 1 };
        await this.emit(s, cur.repo_id, 'repo', `acl${cur.acl_epoch + 1}`, 'repo.visibility_changed', { visibility: r.visibility });
        await audit(this.db, { actor_id: 'system:import', action: 'repo.visibility_changed', repo_id: cur.repo_id, outcome: 'success', details: { visibility: r.visibility } }, s);
      }
      await repos.updateOne({ repo_id: cur.repo_id }, update, { session: s });
      return cur.repo_id;
    });
  }

  async upsertBranch(repoId: string, name: string, headSha: string) {
    await this.db
      .collection('branches')
      .updateOne({ repo_id: repoId, name }, { $set: { head_sha: headSha, updated_at: new Date() } }, { upsert: true });
  }

  async upsertContributors(list: { contributor_id: string; provider_login: string }[]) {
    if (!list.length) return;
    await this.db.collection('contributors').bulkWrite(
      list.map((c) => ({ updateOne: { filter: { contributor_id: c.contributor_id }, update: { $set: c }, upsert: true } })),
      { ordered: false },
    );
  }

  // ---------------------------------------------------------------- issues, PRs, comments

  async upsertIssue(i: IssueInput): Promise<ApplyResult> {
    return this.txn(async (s) => {
      const filter = { repo_id: i.repo_id, number: i.number };
      const digest = digestOf([i.title, i.body, i.state, [...i.labels].sort()]);
      const { result, revision, prev } = await this.versioned(s, 'issues', filter, i, digest, 'issue_revisions');
      if (result !== 'applied') return result;
      await this.writeChunks(s, {
        repo_id: i.repo_id,
        source_type: 'issue',
        source_id: `issue:${i.number}`,
        revision,
        text: i.body,
        is_latest: true,
        guidance: 'unknown',
        labels: i.labels,
        thread_title: i.title,
      });
      const type = !prev
        ? 'issue.opened'
        : prev.state !== 'closed' && i.state === 'closed'
          ? 'issue.closed'
          : prev.state === 'closed' && i.state === 'open'
            ? 'issue.reopened'
            : 'issue.updated';
      await this.emit(s, i.repo_id, `issue:${i.number}`, revision, type, { number: i.number, state: i.state, labels: i.labels }, i.source_updated_at);
      return result;
    });
  }

  async upsertPullRequest(p: PullRequestInput): Promise<ApplyResult> {
    return this.txn(async (s) => {
      const filter = { repo_id: p.repo_id, number: p.number };
      const digest = digestOf([p.title, p.body, p.state, p.merged_sha, [...p.labels].sort(), p.closes_issues, p.head_commits]);
      const { result, revision, prev } = await this.versioned(s, 'pull_requests', filter, p, digest);
      if (result !== 'applied') return result;
      await this.writeChunks(s, {
        repo_id: p.repo_id,
        source_type: 'pr',
        source_id: `pr:${p.number}`,
        revision,
        text: p.body,
        is_latest: true,
        guidance: 'unknown',
        labels: p.labels,
        thread_title: p.title,
      });
      const type = !prev ? 'pr.opened' : !prev.merged_sha && p.merged_sha ? 'pr.merged' : 'pr.updated';
      await this.emit(s, p.repo_id, `pr:${p.number}`, revision, type, {
        number: p.number,
        merged_sha: p.merged_sha,
        closes_issues: p.closes_issues,
      }, p.source_updated_at);
      return result;
    });
  }

  /** Comments are append-only per id; a late comment on a closed issue is still inserted. */
  async upsertComment(c: CommentInput): Promise<ApplyResult> {
    return this.txn(async (s) => {
      const filter = { repo_id: c.repo_id, thread_key: c.thread_key, comment_id: c.comment_id };
      const digest = digestOf([c.body, c.review_state ?? null]);
      const { result, revision, prev } = await this.versioned(s, 'comments', filter, c, digest);
      if (result !== 'applied') return result;
      const parent = c.thread_key.startsWith('pr:')
        ? await this.db.collection('pull_requests').findOne({ repo_id: c.repo_id, number: Number(c.thread_key.slice(3)) }, { session: s })
        : await this.db.collection('issues').findOne({ repo_id: c.repo_id, number: Number(c.thread_key.slice(6)) }, { session: s });
      await this.writeChunks(s, {
        repo_id: c.repo_id,
        source_type: 'comment',
        source_id: `${c.thread_key}/comment:${c.comment_id}`,
        revision,
        text: c.body,
        is_latest: true,
        guidance: 'unknown',
        labels: (parent?.labels as string[] | undefined) ?? [],
        thread_title: (parent?.title as string | undefined) ?? null,
      });
      await this.emit(s, c.repo_id, `${c.thread_key}:comment:${c.comment_id}`, revision, prev ? 'comment.edited' : 'comment.added', {
        thread_key: c.thread_key,
        comment_id: c.comment_id,
        kind: c.kind,
      }, prev ? c.source_updated_at : c.created_at);
      return result;
    });
  }

  // ---------------------------------------------------------------- releases and documents

  /** Release metadata plus its notes as a versioned document (source_id release/<tag>). */
  async upsertRelease(r: ReleaseInput): Promise<ApplyResult> {
    return this.txn(async (s) => {
      const { prerelease, ...rest } = r;
      const data = { ...rest, channel: prerelease ? ('pre' as const) : ('stable' as const) };
      const filter = { repo_id: r.repo_id, release_id: r.release_id };
      const digest = digestOf([r.name, r.body, r.target_sha, prerelease]);
      const { result, revision, prev } = await this.versioned(s, 'releases', filter, data, digest);
      if (result !== 'applied') return result;
      await this.docRevision(s, {
        repo_id: r.repo_id,
        source_id: `release/${r.release_id}`,
        revision,
        kind: 'release_notes',
        commit_sha: r.target_sha,
        committed_at: r.published_at,
        text: r.body,
      });
      await this.emit(s, r.repo_id, `release:${r.release_id}`, revision, prev ? 'release.updated' : 'release.published', {
        release_id: r.release_id,
        target_sha: r.target_sha,
        channel: data.channel,
      }, r.published_at);
      return result;
    });
  }

  async addDocumentRevision(d: DocRevisionInput): Promise<ApplyResult> {
    return this.txn((s) => this.docRevision(s, d));
  }

  /**
   * Appends revision n. The latest pointer moves only if n is newer; an older revision arriving
   * late is stored as history (its chunks are historical) and returns 'stale'.
   */
  private async docRevision(s: ClientSession, d: DocRevisionInput): Promise<ApplyResult> {
    const revs = this.db.collection<DocumentRevisionDoc>('document_revisions');
    if (await revs.findOne({ repo_id: d.repo_id, source_id: d.source_id, revision: d.revision }, { session: s })) return 'duplicate';

    const digest = sha256(d.text);
    await this.db
      .collection('blobs')
      .updateOne({ digest }, { $setOnInsert: { digest, text: d.text, size: Buffer.byteLength(d.text), created_at: new Date() } }, { upsert: true, session: s });
    await revs.insertOne(
      { repo_id: d.repo_id, source_id: d.source_id, revision: d.revision, kind: d.kind, commit_sha: d.commit_sha, committed_at: d.committed_at, source_digest: digest, created_at: new Date() },
      { session: s },
    );

    const docs = this.db.collection('documents');
    const ptr = await docs.findOne({ repo_id: d.repo_id, source_id: d.source_id }, { session: s });
    const isLatest = !ptr || d.revision > (ptr.latest_revision as number);
    if (isLatest) {
      await docs.updateOne(
        { repo_id: d.repo_id, source_id: d.source_id },
        { $set: { kind: d.kind, latest_revision: d.revision, latest_digest: digest, latest_commit_sha: d.commit_sha, updated_at: new Date() } },
        { upsert: true, session: s },
      );
    }
    await this.writeChunks(s, {
      repo_id: d.repo_id,
      source_type: d.kind,
      source_id: d.source_id,
      revision: d.revision,
      text: d.text,
      is_latest: isLatest,
      guidance: 'current',
      commit_sha: d.commit_sha,
    });
    await this.emit(s, d.repo_id, `doc:${d.source_id}`, d.revision, 'document.changed', { source_id: d.source_id, revision: d.revision, is_latest: isLatest, kind: d.kind }, d.committed_at);
    return isLatest ? 'applied' : 'stale';
  }

  // ---------------------------------------------------------------- commits

  /**
   * Commits are immutable Git objects: insert-if-absent by (repo_id, sha), so re-imports add only
   * new ones. Returns the number inserted.
   */
  async upsertCommits(repoId: string, commits: Omit<CommitDoc, 'repo_id'>[]): Promise<number> {
    let inserted = 0;
    const coll = this.db.collection<CommitDoc>('commits');
    for (let i = 0; i < commits.length; i += 1000) {
      const batch = commits.slice(i, i + 1000);
      const res = await coll.bulkWrite(
        batch.map((c) => ({
          updateOne: { filter: { repo_id: repoId, sha: c.sha } as Filter<CommitDoc>, update: { $setOnInsert: { ...c, repo_id: repoId } }, upsert: true },
        })),
        { ordered: false },
      );
      inserted += res.upsertedCount;
    }
    if (inserted > 0) {
      const head = commits.at(-1)?.sha ?? 'none';
      await this.txn((s) => this.emit(s, repoId, 'commits', `${head}:${inserted}`, 'commits.ingested', { inserted, total: commits.length }));
    }
    return inserted;
  }
}
