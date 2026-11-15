import type { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestStore } from '../src/ingest/store.js';
import { ChunkIndex } from '../src/search/index.js';
import { DEMO } from '../src/seed/demo.js';
import type { StreamEvent } from '../src/stream/kafka.js';
import { ActivityProjector } from '../src/stream/projectors/activity.js';
import { SearchProjector } from '../src/stream/projectors/search.js';
import type { ChunkDoc, OutboxDoc } from '../src/types.js';
import { type Ctx, login, setup, teardown, testSearch } from './helpers.js';

const PUB = DEMO.publicRepo;
const PRIV = DEMO.privateRepo;
const t = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const toEvent = (o: OutboxDoc): StreamEvent => ({ event_id: o.event_id, type: o.type, key: o.key, payload: o.payload as StreamEvent['payload'], created_at: o.created_at.toISOString() });


describe('search projector (OpenSearch)', () => {
  let ctx: Ctx;
  let os: Client;
  let index: ChunkIndex;
  let projector: SearchProjector;
  let store: IngestStore;
  const alias = `ri-test-${Date.now().toString(36)}`;
  const events = async (key: string) => (await ctx.db.collection<OutboxDoc>('outbox').find({ key }).sort({ created_at: 1 }).toArray()).map(toEvent);
  const docs = async (q: object) => {
    await os.indices.refresh({ index: alias });
    return (await os.search({ index: alias, body: { query: q, size: 100 } })).body.hits.hits.map((h) => h._source as Record<string, unknown>);
  };

  beforeAll(async () => {
    ctx = await setup();
    os = testSearch();
    index = new ChunkIndex(os, ctx.db, alias);
    await index.ensure();
    projector = new SearchProjector(index);
    store = new IngestStore(ctx.db, ctx.client);
  });
  afterAll(async () => {
    await os.indices.delete({ index: `${alias}-*` });
    await teardown(ctx);
  });

  it('projects an issue and its comments with current thread labels', async () => {
    await store.upsertIssue({ repo_id: PUB, number: 800, title: 'Projection test', body: 'Body about `tls.min_version`.', state: 'open', labels: ['bug'], author_id: 'u_bob', created_at: t(1), closed_at: null, source_updated_at: t(1) });
    await store.upsertComment({ repo_id: PUB, thread_key: 'issue:800', comment_id: 'c1', kind: 'issue_comment', author_id: 'u_bob', body: 'A comment.', created_at: t(2), source_updated_at: t(2) });
    for (const ev of [...(await events(`${PUB}:issue:800`)), ...(await events(`${PUB}:issue:800:comment:c1`))]) await projector.handle(ev);

    const hits = await docs({ prefix: { source_id: 'issue:800' } });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.visibility === 'public' && (h.labels as string[]).includes('bug'))).toBe(true);
    expect(hits.find((h) => h.source_type === 'issue')).toMatchObject({ config_keys: ['tls.min_version'], is_latest: true, thread_title: 'Projection test' });
  });

  it('is idempotent: re-processing the same events changes nothing', async () => {
    for (const ev of await events(`${PUB}:issue:800`)) await projector.handle(ev);
    expect(await docs({ prefix: { source_id: 'issue:800' } })).toHaveLength(2);
  });

  it('a delayed consumer cannot overwrite a newer projection', async () => {
    const before = await ctx.db.collection<ChunkDoc>('chunks').find({ source_id: 'issue:800' }).toArray(); // snapshot at rev 1
    await store.upsertIssue({ repo_id: PUB, number: 800, title: 'Projection test', body: 'Edited body.', state: 'closed', labels: ['bug', 'security'], author_id: 'u_bob', created_at: t(1), closed_at: t(3), source_updated_at: t(3) });
    for (const ev of await events(`${PUB}:issue:800`)) await projector.handle(ev); // includes the closing event
    const res = await index.writeChunks(before); // stale write computed from the rev-1 snapshot
    expect(res.stale).toBe(1);
    const hits = await docs({ term: { source_id: 'issue:800' } });
    expect(hits.find((h) => h.revision === 1)).toMatchObject({ is_latest: false, guidance_status: 'historical' });
    expect(hits.find((h) => h.revision === 2)).toMatchObject({ is_latest: true, thread_state: 'closed' });
    // Labels changed on the parent: the comment document picked them up.
    expect((await docs({ term: { source_id: 'issue:800/comment:c1' } }))[0]!.labels).toEqual(['bug', 'security']);
  });

  it('updates visibility and acl_epoch of every projected document on access events', async () => {
    await store.addDocumentRevision({ repo_id: PRIV, source_id: 'docs/secret.md', revision: 1, kind: 'doc', commit_sha: null, committed_at: t(1), text: '# Secret\n\nPRIVATE text.' });
    for (const ev of await events(`${PRIV}:doc:docs/secret.md`)) await projector.handle(ev);
    expect((await docs({ term: { repo_id: PRIV } }))[0]).toMatchObject({ visibility: 'private' });
    await ctx.db.collection('repositories').updateOne({ repo_id: PRIV }, { $set: { visibility: 'public' }, $inc: { acl_epoch: 1 } });
    await projector.handle({ event_id: 'v1', type: 'repo.visibility_changed', key: PRIV, payload: { repo_id: PRIV }, created_at: new Date().toISOString() });
    expect((await docs({ term: { repo_id: PRIV } }))[0]).toMatchObject({ visibility: 'public', acl_epoch: 2 });
    await ctx.db.collection('repositories').updateOne({ repo_id: PRIV }, { $set: { visibility: 'private' }, $inc: { acl_epoch: 1 } });
    await projector.handle({ event_id: 'v2', type: 'repo.visibility_changed', key: PRIV, payload: { repo_id: PRIV }, created_at: new Date().toISOString() });
  });

  it('rebuilds the projection from MongoDB into a new index and swaps the alias', async () => {
    const first = await index.currentIndex();
    const r = await index.rebuild();
    expect(r.from).toBe(first);
    expect(r.to).toBe(`${alias}-v2`);
    expect(r.count).toBe(await ctx.db.collection('chunks').countDocuments());
    expect(await index.currentIndex()).toBe(`${alias}-v2`);
    expect((await os.indices.exists({ index: first! })).body).toBe(true); // kept for rollback
  });
});

describe('activity projector and dashboard', () => {
  let ctx: Ctx;
  let projector: ActivityProjector;
  const now = t(20).getTime();
  const ev = (id: string, type: string, number: number, at: Date, labels: string[] | undefined = ['bug'], thread?: string): StreamEvent => ({
    event_id: id, type, key: `${PUB}:issue:${number}`, created_at: new Date(now).toISOString(),
    payload: { repo_id: PUB, number, labels, thread_key: thread, occurred_at: at.toISOString() },
  });
  const bucket = (day: string, label = '*') => ctx.db.collection('issue_activity_daily').findOne({ repo_id: PUB, day, label });

  beforeAll(async () => {
    ctx = await setup();
    projector = new ActivityProjector(ctx.db, ctx.client, () => now);
  });
  afterAll(async () => teardown(ctx));

  it('counts each event once, even when replayed three times', async () => {
    const events = [ev('a1', 'issue.opened', 900, t(19)), ev('a2', 'issue.closed', 900, t(19, 15)), ev('a3', 'comment.added', 81, t(19, 16), undefined, 'issue:81')];
    for (let i = 0; i < 3; i++) for (const e of events) await projector.handle(e);
    expect(await bucket('2026-11-19')).toMatchObject({ opened: 1, closed: 1, comments: 1 });
    expect(await bucket('2026-11-19', 'bug')).toMatchObject({ opened: 1, closed: 1 });
    // Comment labels come from the parent issue (#81 has "bug" in the seed).
    expect((await bucket('2026-11-19', 'bug'))!.comments).toBe(1);
  });

  it('counts out-of-order events (closed before opened)', async () => {
    await projector.handle(ev('b2', 'issue.closed', 901, t(19, 18)));
    await projector.handle(ev('b1', 'issue.opened', 901, t(19, 17)));
    expect(await bucket('2026-11-19')).toMatchObject({ opened: 2, closed: 2 });
  });

  it('marks buckets for late events dirty and repairs them from canonical data', async () => {
    await projector.handle(ev('c1', 'issue.opened', 81, new Date(Date.UTC(2026, 9, 10, 12))));
    const day = '2026-10-10';
    expect(await bucket(day)).toMatchObject({ opened: 1, dirty: true });
    await projector.recomputeDay(PUB, day);
    // Canonical seed data: issue #81 was created on 2026-10-10.
    expect(await bucket(day)).toMatchObject({ opened: 1, dirty: false });
  });

  it('serves the dashboard with a watermark and enforces repository access', async () => {
    await ctx.db.collection('projection_state').updateOne({ consumer: 'ri-activity-projector' }, { $set: { last_processed_at: new Date(now), last_event_created_at: new Date(now - 4000) } }, { upsert: true });
    const bob = await login(ctx.app, 'bob');
    const carol = await login(ctx.app, 'carol');
    const res = await ctx.app.inject({ url: `/repos/${PUB}/activity`, headers: { cookie: bob } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ last_event_lag_seconds: 4 });
    expect(res.json().as_of).toBeTruthy();
    expect((await ctx.app.inject({ url: `/repos/${PRIV}/activity`, headers: { cookie: carol } })).statusCode).toBe(404);
  });
});
