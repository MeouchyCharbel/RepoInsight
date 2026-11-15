import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestStore } from '../src/ingest/store.js';
import { DEMO } from '../src/seed/demo.js';
import { type Ctx, setup, teardown } from './helpers.js';

const REPO = DEMO.publicRepo;
const t = (d: number) => new Date(Date.UTC(2026, 10, d));
const base = { repo_id: REPO, title: 'Store test', labels: ['bug'], author_id: 'u_bob', created_at: t(1), closed_at: null };

describe('canonical store: ordering, duplicates and revisions', () => {
  let ctx: Ctx;
  let store: IngestStore;
  beforeAll(async () => {
    ctx = await setup();
    store = new IngestStore(ctx.db, ctx.client);
  });
  afterAll(async () => teardown(ctx));
  const outbox = (key: string) => ctx.db.collection('outbox').find({ key }).sort({ created_at: 1 }).toArray();

  it('applies an issue once; the same event three times is one business action', async () => {
    const ev = { ...base, number: 500, body: 'first', state: 'open' as const, source_updated_at: t(2) };
    expect(await store.upsertIssue(ev)).toBe('applied');
    expect(await store.upsertIssue(ev)).toBe('duplicate');
    expect(await store.upsertIssue(ev)).toBe('duplicate');
    expect(await outbox(`${REPO}:issue:500`)).toHaveLength(1);
    expect(await ctx.db.collection('chunks').countDocuments({ source_id: 'issue:500' })).toBe(1);
  });

  it('keeps the newer state when "closed" arrives before an older edit', async () => {
    const closed = { ...base, number: 501, body: 'v2', state: 'closed' as const, source_updated_at: t(5) };
    const olderEdit = { ...base, number: 501, body: 'v1', state: 'open' as const, source_updated_at: t(4) };
    expect(await store.upsertIssue(closed)).toBe('applied');
    expect(await store.upsertIssue(olderEdit)).toBe('stale');
    const issue = await ctx.db.collection('issues').findOne({ repo_id: REPO, number: 501 });
    expect(issue).toMatchObject({ state: 'closed', body: 'v2', revision: 1 });
    // The late revision is kept as history only.
    const hist = await ctx.db.collection('issue_revisions').find({ repo_id: REPO, number: 501 }).toArray();
    expect(hist.map((h) => h.late ?? false).sort()).toEqual([false, true]);
    expect((await outbox(`${REPO}:issue:501`)).map((e) => e.type)).toEqual(['issue.opened']);
  });

  it('emits issue.closed and demotes the previous revision chunks', async () => {
    await store.upsertIssue({ ...base, number: 502, body: 'open body', state: 'open', source_updated_at: t(2) });
    await store.upsertIssue({ ...base, number: 502, body: 'closing body', state: 'closed', source_updated_at: t(3) });
    expect((await outbox(`${REPO}:issue:502`)).map((e) => e.type)).toEqual(['issue.opened', 'issue.closed']);
    const chunks = await ctx.db.collection('chunks').find({ source_id: 'issue:502' }).sort({ revision: 1 }).toArray();
    expect(chunks.map((c) => [c.revision, c.is_latest, c.guidance_status])).toEqual([[1, false, 'historical'], [2, true, 'unknown']]);
  });

  it('document rev 7 then rev 6: latest stays 7, rev 6 is history', async () => {
    const rev = (revision: number, text: string) =>
      store.addDocumentRevision({ repo_id: REPO, source_id: 'docs/order.md', revision, kind: 'doc', commit_sha: null, committed_at: t(revision), text });
    expect(await rev(7, '# Order\n\nRevision seven uses `app.mode`.')).toBe('applied');
    expect(await rev(6, '# Order\n\nRevision six.')).toBe('stale');
    expect(await rev(7, '# Order\n\nRevision seven uses `app.mode`.')).toBe('duplicate');
    const ptr = await ctx.db.collection('documents').findOne({ repo_id: REPO, source_id: 'docs/order.md' });
    expect(ptr!.latest_revision).toBe(7);
    const chunks = await ctx.db.collection('chunks').find({ source_id: 'docs/order.md' }).toArray();
    expect(chunks.find((c) => c.revision === 7)).toMatchObject({ is_latest: true, guidance_status: 'current', config_keys: ['app.mode'] });
    expect(chunks.find((c) => c.revision === 6)).toMatchObject({ is_latest: false, guidance_status: 'historical' });
    // Revision text is content-addressed and stored once.
    const r7 = await ctx.db.collection('document_revisions').findOne({ source_id: 'docs/order.md', revision: 7 });
    expect(await ctx.db.collection('blobs').countDocuments({ digest: r7!.source_digest })).toBe(1);
  });

  it('inserts a late comment on a closed issue and ignores a duplicate comment', async () => {
    const c = { repo_id: REPO, thread_key: 'issue:501', comment_id: '77', kind: 'issue_comment' as const, author_id: 'u_bob', body: 'late comment', created_at: t(9), source_updated_at: t(9) };
    expect(await store.upsertComment(c)).toBe('applied');
    expect(await store.upsertComment(c)).toBe('duplicate');
    expect(await ctx.db.collection('comments').countDocuments({ thread_key: 'issue:501' })).toBe(1);
  });

  it('never stores merged_sha for an unmerged PR and inserts commits only once', async () => {
    await store.upsertPullRequest({
      repo_id: REPO, number: 600, title: 'open', body: '', state: 'open', labels: [], author_id: 'u_bob', base_ref: 'main', head_ref: 'x',
      head_sha: 'a'.repeat(40), head_commits: [], merged_at: null, merged_sha: null, closes_issues: [], created_at: t(1), source_updated_at: t(1),
    });
    expect((await ctx.db.collection('pull_requests').findOne({ number: 600 }))!.merged_sha).toBeNull();
    const commit = { sha: 'b'.repeat(40), parent_shas: [], generation: 1, author_id: 'x', committed_at: t(1), message: 'm', changed_paths: [], changed_paths_truncated: false, cherry_picked_from: null };
    expect(await store.upsertCommits(REPO, [commit])).toBe(1);
    expect(await store.upsertCommits(REPO, [commit])).toBe(0);
  });

  it('bumps acl_epoch when the provider reports a visibility change', async () => {
    const input = { provider: 'github' as const, provider_id: 4242, org_id: 'o', full_name: 'o/v', visibility: 'public' as const, default_branch: 'main' };
    const id = await store.upsertRepository(input);
    expect(id).toMatch(/^r[0-9a-f]{16}$/);
    expect(await store.upsertRepository(input)).toBe(id);
    await store.upsertRepository({ ...input, visibility: 'private' });
    expect((await ctx.db.collection('repositories').findOne({ repo_id: id }))!.acl_epoch).toBe(2);
  });
});
