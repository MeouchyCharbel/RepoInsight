import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Envelope, Inbox } from '../src/ingest/inbox.js';
import { IngestStore } from '../src/ingest/store.js';
import { DEMO } from '../src/seed/demo.js';
import { type Ctx, login, setup, teardown } from './helpers.js';

const PRIV = DEMO.privateRepo;
const PUB = DEMO.publicRepo;
const at = (h: number) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();

describe('durable inbox and the six streaming events', () => {
  let ctx: Ctx;
  let inbox: Inbox;
  let n = 0;
  const env = (event: Envelope['event'], delivery_id = `d-${++n}`) => ({ provider: 'synthetic' as const, delivery_id, event }) as Envelope;

  beforeAll(async () => {
    ctx = await setup();
    inbox = new Inbox(ctx.db, new IngestStore(ctx.db, ctx.client), ctx.app.acl);
  });
  afterAll(async () => teardown(ctx));

  it('treats a repeated delivery id as a no-op', async () => {
    const e = env({ type: 'issue.opened', repo_id: PUB, issue: { number: 700, title: 'x', body: 'y', state: 'open', labels: [], author_id: 'u_bob', created_at: at(1) as never, updated_at: at(1) as never } }, 'same-id');
    expect(await inbox.receive(e)).toEqual({ status: 'applied' });
    expect(await inbox.receive(e)).toEqual({ status: 'duplicate' });
    // Redelivery under a new id is still blocked by the entity key + revision check.
    expect(await inbox.receive({ ...e, delivery_id: 'other-id' })).toEqual({ status: 'duplicate' });
    expect(await ctx.db.collection('outbox').countDocuments({ key: `${PUB}:issue:700` })).toBe(1);
  });

  it('applies issue opened/closed, comment added, document changed and release published', async () => {
    const results = [
      await inbox.receive(env({ type: 'issue.closed', repo_id: PUB, issue: { number: 700, title: 'x', body: 'y', state: 'closed', labels: [], author_id: 'u_bob', created_at: at(1) as never, updated_at: at(2) as never } })),
      await inbox.receive(env({ type: 'comment.added', repo_id: PUB, thread_key: 'issue:700', comment: { id: 'c1', body: 'late but kept', author_id: 'u_bob', created_at: at(3) as never, updated_at: at(3) as never } })),
      await inbox.receive(env({ type: 'document.changed', repo_id: PUB, source_id: 'docs/inbox.md', revision: 1, commit_sha: null, committed_at: at(4) as never, text: '# Inbox\n\nText.' })),
      await inbox.receive(env({ type: 'release.published', repo_id: PUB, release: { tag: 'v9.9.9', name: 'v9.9.9', body: '# Notes', target_sha: null, published_at: at(5) as never, prerelease: false } })),
    ];
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    const types = (await ctx.db.collection('outbox').find({ topic: 'ri.changes' }).toArray()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['issue.closed', 'comment.added', 'document.changed', 'release.published']));
  });

  it('access revoked: a grant older than the latest revoke is ignored', async () => {
    const bob = await login(ctx.app, 'bob');
    const read = () => ctx.app.inject({ url: `/repos/${PRIV}/issues/3`, headers: { cookie: bob } });
    expect((await read()).statusCode).toBe(200);
    const now = Date.now();
    expect(await inbox.receive(env({ type: 'access.revoked', repo_id: PRIV, principal_id: 'u_bob', seq: now + 2000 }))).toEqual({ status: 'applied' });
    expect((await read()).statusCode).toBe(404);
    // Out-of-order: an older grant arrives after the revoke.
    expect(await inbox.receive(env({ type: 'access.granted', repo_id: PRIV, principal_id: 'u_bob', role: 'read', seq: now + 1000 }))).toEqual({ status: 'ignored' });
    expect((await read()).statusCode).toBe(404);
    expect(await ctx.db.collection('audit_log').countDocuments({ repo_id: PRIV, outcome: 'denied', 'details.reason': 'stale_sequence' })).toBe(1);
  });

  it('records deliveries for unknown repositories as failed', async () => {
    const e = env({ type: 'access.revoked', repo_id: 'no-such-repo', principal_id: 'u_bob', seq: 1 });
    await expect(inbox.receive(e)).rejects.toThrow();
    expect(await ctx.db.collection('inbox').findOne({ delivery_id: e.delivery_id })).toMatchObject({ status: 'failed' });
  });

  it('re-applies deliveries that were recorded but never applied (crash recovery)', async () => {
    const e = env({ type: 'issue.opened', repo_id: PUB, issue: { number: 701, title: 'crash', body: 'b', state: 'open', labels: [], author_id: 'u_bob', created_at: at(6) as never, updated_at: at(6) as never } });
    await ctx.db.collection('inbox').insertOne({ provider: e.provider, delivery_id: e.delivery_id, type: e.event.type, repo_id: PUB, payload: e.event, status: 'received', received_at: new Date(Date.now() - 60_000) });
    expect(await inbox.reprocessPending()).toBe(1);
    expect(await ctx.db.collection('issues').countDocuments({ repo_id: PUB, number: 701 })).toBe(1);
  });

  it('exposes the intake endpoint to platform admins only', async () => {
    const body = env({ type: 'access.revoked', repo_id: PRIV, principal_id: 'u_carol', seq: Date.now() });
    const carol = await login(ctx.app, 'carol');
    const ops = await login(ctx.app, 'ops');
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/deliveries', payload: body, headers: { cookie: carol } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/deliveries', payload: body, headers: { cookie: ops } })).statusCode).toBe(200);
  });
});
