import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AclService } from '../src/acl/service.js';
import { connectMongo } from '../src/db.js';
import { DEMO } from '../src/seed/demo.js';
import { type Ctx, config, login, setup, teardown } from './helpers.js';

const PRIV = DEMO.privateRepo;
const PUB = DEMO.publicRepo;

describe('repository access control', () => {
  let ctx: Ctx;
  const cookies: Record<string, string> = {};
  const get = (user: string, url: string) => ctx.app.inject({ url, headers: { cookie: cookies[user]! } });
  const send = (user: string, method: 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url, payload, headers: { cookie: cookies[user]! } });

  beforeAll(async () => {
    ctx = await setup();
    for (const u of ['alice', 'bob', 'carol', 'ops']) cookies[u] = await login(ctx.app, u);
  });
  afterAll(async () => teardown(ctx));

  it('lets any signed-in user read a public repository', async () => {
    expect((await get('carol', `/repos/${PUB}`)).statusCode).toBe(200);
    expect((await get('carol', `/repos/${PUB}/issues`)).json().items.length).toBe(3);
  });

  it('lets members read a private repository', async () => {
    const res = await get('bob', `/repos/${PRIV}/issues/3`);
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toContain('PRIVATE');
  });

  it('answers a non-member exactly as if the private repository did not exist', async () => {
    const priv = await get('carol', `/repos/${PRIV}`);
    const missing = await get('carol', '/repos/does-not-exist');
    expect(priv.statusCode).toBe(404);
    expect(priv.json()).toEqual(missing.json());
    for (const url of [`/repos/${PRIV}/issues`, `/repos/${PRIV}/issues/3`, `/repos/${PRIV}/issues?label=security`]) {
      const r = await get('carol', url);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('PRIVATE');
    }
  });

  it('excludes private repositories from listings of non-members', async () => {
    const carol = (await get('carol', '/repos')).json().items.map((r: { repo_id: string }) => r.repo_id);
    const bob = (await get('bob', '/repos')).json().items.map((r: { repo_id: string }) => r.repo_id);
    expect(carol).toEqual([PUB]);
    expect(bob).toEqual(expect.arrayContaining([PUB, PRIV]));
  });

  it('gives a platform admin no implicit read access', async () => {
    expect((await get('ops', `/repos/${PRIV}/issues/3`)).statusCode).toBe(404);
  });

  it('only lets repository admins manage access', async () => {
    expect((await send('bob', 'POST', `/repos/${PRIV}/permissions`, { username: 'carol', role: 'read' })).statusCode).toBe(403);
    expect((await send('carol', 'POST', `/repos/${PRIV}/permissions`, { username: 'carol', role: 'admin' })).statusCode).toBe(404);
    expect((await get('alice', `/repos/${PRIV}/permissions`)).statusCode).toBe(200);
  });

  it('revocation takes effect immediately, even with a warm cache', async () => {
    // Warm bob's cached decision.
    expect((await get('bob', `/repos/${PRIV}/issues/3`)).statusCode).toBe(200);
    const before = (await ctx.db.collection('repositories').findOne({ repo_id: PRIV }))!.acl_epoch;

    const revoke = await send('alice', 'DELETE', `/repos/${PRIV}/permissions/bob`);
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().acl_epoch).toBe(before + 1);

    const after = await get('bob', `/repos/${PRIV}/issues/3`);
    expect(after.statusCode).toBe(404);
    expect(after.body).not.toContain('PRIVATE');
    const list = (await get('bob', '/repos')).json().items.map((r: { repo_id: string }) => r.repo_id);
    expect(list).not.toContain(PRIV);
  });

  it('records revocation in the outbox and audit log in the same transaction', async () => {
    const ev = await ctx.db.collection('outbox').findOne({ type: 'access.revoked', key: PRIV });
    expect(ev).toMatchObject({ topic: 'ri.permissions', published_at: null, payload: { principal_id: 'u_bob', role: null } });
    const au = await ctx.db.collection('audit_log').findOne({ action: 'access.revoked', repo_id: PRIV });
    expect(au).toMatchObject({ actor_id: 'u_alice', target: 'u_bob', outcome: 'success' });
  });

  it('grants access again and lets a platform admin manage it (audited)', async () => {
    const res = await send('ops', 'POST', `/repos/${PRIV}/permissions`, { username: 'bob', role: 'read' });
    expect(res.statusCode).toBe(200);
    expect((await get('bob', `/repos/${PRIV}/issues/3`)).statusCode).toBe(200);
    expect(await ctx.db.collection('audit_log').countDocuments({ action: 'access.granted', actor_id: 'u_ops' })).toBe(1);
  });

  it('hides a repository from non-members once it is made private', async () => {
    expect((await get('carol', `/repos/${PUB}`)).statusCode).toBe(200);
    // alice is not a member of the public repo; ops (platform admin) changes visibility.
    expect((await send('ops', 'PATCH', `/repos/${PUB}/visibility`, { visibility: 'private' })).statusCode).toBe(200);
    expect((await get('carol', `/repos/${PUB}/issues`)).statusCode).toBe(404);
    await send('ops', 'PATCH', `/repos/${PUB}/visibility`, { visibility: 'public' });
    expect((await get('carol', `/repos/${PUB}/issues`)).statusCode).toBe(200);
  });

  it('rejects malformed identifiers and query operators', async () => {
    for (const url of ['/repos/..%2Fadmin', '/repos/ACME', `/repos/${PUB}/issues?label[$ne]=x`, `/repos/${PUB}/issues?limit=1000`, `/repos/${PUB}/issues?cursor=%%%`]) {
      expect((await get('carol', url)).statusCode, url).toBe(400);
    }
  });

  it('paginates with a keyset cursor', async () => {
    const p1 = (await get('carol', `/repos/${PUB}/issues?limit=2`)).json();
    expect(p1.items.map((i: { number: number }) => i.number)).toEqual([90, 81]);
    const p2 = (await get('carol', `/repos/${PUB}/issues?limit=2&cursor=${p1.next_cursor}`)).json();
    expect(p2.items.map((i: { number: number }) => i.number)).toEqual([12]);
    expect(p2.next_cursor).toBeNull();
  });

  it('marks API responses as not cacheable', async () => {
    expect((await get('bob', `/repos/${PRIV}`)).headers['cache-control']).toBe('no-store');
  });
});

describe('fail closed when the access authority is unavailable', () => {
  let ctx: Ctx;
  let cookie: string;

  beforeAll(async () => {
    // The ACL service gets its own client, closed below, simulating an unreachable authority
    // while sessions (on the main client) still resolve.
    const aclClient = await connectMongo(config.MONGO_URL);
    ctx = await setup({ acl: (db) => new AclService(aclClient.db(db.databaseName), aclClient, { timeoutMs: 200, cacheTtlMs: 30_000 }) });
    cookie = await login(ctx.app, 'bob');
    // Warm the cache first: a cached "allow" must not be used without a fresh epoch check.
    expect((await ctx.app.inject({ url: `/repos/${PRIV}/issues/3`, headers: { cookie } })).statusCode).toBe(200);
    await aclClient.close();
  });
  afterAll(async () => teardown(ctx));

  it('denies with 503 and returns no repository data', async () => {
    for (const url of [`/repos/${PRIV}/issues/3`, `/repos/${PUB}`, '/repos']) {
      const res = await ctx.app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error.code).toBe('authorization_unavailable');
      expect(res.body).not.toContain('PRIVATE');
    }
  });
});
