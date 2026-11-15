import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEXES } from '../src/db.js';
import { type Ctx, setup, teardown } from './helpers.js';

describe('MongoDB schema', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  afterAll(async () => teardown(ctx));

  it('creates every declared index', async () => {
    for (const [name, specs] of Object.entries(INDEXES)) {
      const keys = (await ctx.db.collection(name).indexes()).map((i) => JSON.stringify(i.key));
      for (const s of specs) expect(keys, name).toContain(JSON.stringify(s.key));
    }
  });

  it('starts every repository-scoped unique key with repo_id', () => {
    const global = new Set(['users', 'sessions', 'blobs', 'inbox', 'outbox', 'processed_events', 'contributors', 'import_jobs', 'repositories']);
    for (const [name, specs] of Object.entries(INDEXES)) {
      if (global.has(name)) continue;
      for (const s of specs.filter((x) => x.unique)) expect(Object.keys(s.key)[0], name).toBe('repo_id');
    }
  });

  it('rejects duplicate entities (idempotent upserts rely on this)', async () => {
    const issue = { repo_id: 'acme-tls-proxy', number: 81, title: 'dup' };
    await expect(ctx.db.collection('issues').insertOne(issue)).rejects.toThrow(/duplicate key/);
  });

  it('runs a multi-document transaction on the replica set', async () => {
    const s = ctx.client.startSession();
    await s.withTransaction(async () => {
      await ctx.db.collection('outbox').insertOne({ event_id: 'txn-test', created_at: new Date(), published_at: null }, { session: s });
    });
    await s.endSession();
    expect(await ctx.db.collection('outbox').countDocuments({ event_id: 'txn-test' })).toBe(1);
  });
});
