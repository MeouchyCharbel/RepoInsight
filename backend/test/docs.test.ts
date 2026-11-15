import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestScenario } from '../src/fixtures/scenario.js';
import { IngestStore } from '../src/ingest/store.js';
import { DEMO } from '../src/seed/demo.js';
import { type Ctx, login, setup, teardown } from './helpers.js';

const PUB = DEMO.publicRepo;

describe('document history and issue thread APIs', () => {
  let ctx: Ctx;
  let dir: string;
  let carol: string;
  const get = (url: string, cookie = carol) => ctx.app.inject({ url, headers: { cookie } });

  beforeAll(async () => {
    ctx = await setup();
    await ctx.db.collection('issues').deleteMany({ repo_id: PUB });
    await ctx.db.collection('chunks').deleteMany({ repo_id: PUB });
    dir = mkdtempSync(join(tmpdir(), 'ri-docs-'));
    await ingestScenario(ctx.db, new IngestStore(ctx.db, ctx.client), dir);
    carol = await login(ctx.app, 'carol');
  }, 60_000);
  afterAll(async () => {
    await teardown(ctx);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists documents and returns a revision with text, chunk map and history', async () => {
    const list = (await get(`/repos/${PUB}/documents`)).json().items;
    expect(list.map((d: { source_id: string }) => d.source_id)).toEqual(expect.arrayContaining(['docs/tls.md', 'release/v2.4.1']));
    const latest = (await get(`/repos/${PUB}/document?source_id=docs/tls.md`)).json();
    expect(latest).toMatchObject({ revision: 3, latest_revision: 3 });
    expect(latest.text).toContain('"1.2"');
    expect(latest.revisions.map((r: { revision: number }) => r.revision)).toEqual([3, 2, 1]);
    expect(latest.revisions[2].release_ids).toEqual(['v1.0.0', 'v2.2.9', 'v2.3.5']);
    const old = (await get(`/repos/${PUB}/document?source_id=docs/tls.md&revision=1`)).json();
    expect(old.chunks.find((c: { section_anchor: string }) => c.section_anchor === 'secure-defaults')).toMatchObject({ marker: 'superseded' });
    expect((await get(`/repos/${PUB}/document?source_id=docs/none.md`)).statusCode).toBe(404);
  });

  it('returns issue comments and revision history', async () => {
    expect((await get(`/repos/${PUB}/issues/12/comments`)).json().items[0]).toMatchObject({ comment_id: '4410' });
    expect((await get(`/repos/${PUB}/issues/81/revisions`)).json().items.length).toBeGreaterThan(0);
  });

  it('enforces repository access on every view', async () => {
    for (const url of [`/repos/${DEMO.privateRepo}/documents`, `/repos/${DEMO.privateRepo}/document?source_id=docs/payments.md`, `/repos/${DEMO.privateRepo}/issues/3/comments`]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    const bob = await login(ctx.app, 'bob');
    expect((await get(`/repos/${DEMO.privateRepo}/document?source_id=docs/payments.md`, bob)).statusCode).toBe(200);
  });
});
