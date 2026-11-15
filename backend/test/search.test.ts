import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestScenario } from '../src/fixtures/scenario.js';
import { resolveEffective } from '../src/guidance/release.js';
import { IngestStore } from '../src/ingest/store.js';
import { ChunkIndex } from '../src/search/index.js';
import { DEMO } from '../src/seed/demo.js';
import { type Ctx, login, setup, teardown, testSearch } from './helpers.js';

const PUB = DEMO.publicRepo;
const PRIV = DEMO.privateRepo;
type Item = { source_id: string; repo_id: string; marker: string; revision: number; cite: string; chunk_id: string; superseded_by: { ref: string; reason: string } | null; release_ids: string[] };

describe('permission-safe search, citations and current-vs-historical guidance', () => {
  const alias = `ri-test-search-${Date.now().toString(36)}`;
  let ctx: Ctx;
  let os: Client;
  let dir: string;
  const cookie: Record<string, string> = {};
  const get = async (user: string, url: string) => ctx.app.inject({ url, headers: { cookie: cookie[user]! } });
  const post = async (user: string, url: string, payload: object) => ctx.app.inject({ method: 'POST', url, payload, headers: { cookie: cookie[user]! } });
  const search = async (user: string, qs: string): Promise<Item[]> => {
    const r = await get(user, `/search?${qs}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().items;
  };

  beforeAll(async () => {
    ctx = await setup({ searchAlias: alias });
    await ctx.db.collection('issues').deleteMany({ repo_id: PUB });
    await ctx.db.collection('chunks').deleteMany({ repo_id: PUB });
    dir = mkdtempSync(join(tmpdir(), 'ri-search-'));
    await ingestScenario(ctx.db, new IngestStore(ctx.db, ctx.client), dir); // graph + guidance classification
    os = testSearch();
    const index = new ChunkIndex(os, ctx.db, alias);
    await index.ensure();
    await index.rebuild(); // projection from MongoDB
    for (const u of ['alice', 'bob', 'carol', 'ops']) cookie[u] = await login(ctx.app, u);
  }, 90_000);
  afterAll(async () => {
    await os.indices.delete({ index: `${alias}-*` }).catch(() => {});
    await teardown(ctx);
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the effective release by policy (newest stable on the default branch)', async () => {
    expect(await resolveEffective(ctx.db, PUB)).toMatchObject({ release_id: 'v2.4.1', basis: 'latest_stable_on_default_branch', security_epoch: 1 });
    // v2.2.9 was published later but is on a maintenance branch: not the effective release.
    expect((await resolveEffective(ctx.db, PUB, 'v2.2.9'))!.basis).toBe('requested');
    expect(await resolveEffective(ctx.db, PRIV)).toBeNull();
  });

  it('classifies evidence: current docs, superseded revisions, security-epoch rule', async () => {
    const chunk = (source_id: string, revision?: number) => ctx.db.collection('chunks').findOne({ repo_id: PUB, source_id, ...(revision ? { revision } : {}), section_anchor: { $in: ['secure-defaults', ''] } });
    expect(await chunk('docs/tls.md', 3)).toMatchObject({ guidance_status: 'current', release_ids: ['v2.4.1'] });
    expect(await chunk('docs/tls.md', 1)).toMatchObject({ guidance_status: 'historical', superseded_by: { kind: 'revision', reason: 'newer_revision' } });
    expect(await chunk('issue:12')).toMatchObject({ guidance_status: 'historical', superseded_by: { kind: 'release', ref: 'v2.4.1', reason: 'security_epoch' } });
    expect(await chunk('issue:12/comment:4410')).toMatchObject({ guidance_status: 'historical' });
    // Unrelated discussion is untouched.
    expect(await chunk('issue:90')).toMatchObject({ guidance_status: 'unknown', superseded_by: null });
    expect(await ctx.db.collection('edges').countDocuments({ repo_id: PUB, relation: 'GUIDANCE_SUPERSEDES', to: { $regex: '^chunk:' }, status: 'active' })).toBeGreaterThan(2);
  });

  it('incremental (one thread) re-classification matches a full pass', async () => {
    const at = new Date(Date.UTC(2026, 9, 4));
    await new IngestStore(ctx.db, ctx.client).upsertComment({ repo_id: PUB, thread_key: 'issue:12', comment_id: 'inc-1', kind: 'issue_comment', author_id: 'u_bob', body: 'Still using `tls.min_version: "1.0"` here.', created_at: at, source_updated_at: at });
    const { GuidanceService } = await import('../src/guidance/classify.js');
    const g = new GuidanceService(ctx.db);
    const before = await ctx.db.collection('chunks').find({ repo_id: PUB, source_id: { $not: /^issue:12/ } }, { projection: { _id: 0, chunk_id: 1, guidance_status: 1, superseded_by: 1 } }).toArray();
    await g.reclassify(PUB, { thread: 'issue:12' });
    const incremental = await ctx.db.collection('chunks').findOne({ repo_id: PUB, source_id: 'issue:12/comment:inc-1' });
    expect(incremental).toMatchObject({ guidance_status: 'historical', superseded_by: { ref: 'v2.4.1', reason: 'security_epoch' } });
    const after = await ctx.db.collection('chunks').find({ repo_id: PUB, source_id: { $not: /^issue:12/ } }, { projection: { _id: 0, chunk_id: 1, guidance_status: 1, superseded_by: 1 } }).toArray();
    expect(after).toEqual(before); // other evidence untouched
    expect((await g.reclassify(PUB)).changed).not.toContain('issue:12/comment:inc-1'); // full pass agrees
  });

  it('returns current, cited results first; status=current hides superseded evidence', async () => {
    const items = await search('carol', `q=${encodeURIComponent('TLS minimum version')}&repo=${PUB}&status=current`);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.marker === 'current' || i.marker === 'unknown' || i.marker === 'possibly_outdated')).toBe(true);
    expect(items[0]).toMatchObject({ source_id: 'docs/tls.md', revision: 3, cite: expect.stringMatching(/^docs\/tls\.md@rev3#secure-defaults L\d+-\d+$/) });
    const all = await search('carol', `q=${encodeURIComponent('allow TLS 1.0 for legacy clients')}&repo=${PUB}&status=all&limit=20`);
    expect(all.some((i) => i.source_id === 'issue:12' && i.marker === 'superseded' && i.superseded_by?.ref === 'v2.4.1')).toBe(true);
  });

  it('filters by label, release and source type', async () => {
    expect((await search('carol', `q=tls&repo=${PUB}&label=security&status=all`)).every((i) => i.source_id.startsWith('issue:') || i.source_id.startsWith('pr:'))).toBe(true);
    const v240 = await search('carol', `q=tls&repo=${PUB}&release=v2.4.0&status=all`);
    expect(v240.length).toBeGreaterThan(0);
    expect(v240.every((i) => i.release_ids.includes('v2.4.0'))).toBe(true);
    expect(v240.some((i) => i.source_id === 'docs/tls.md' && i.revision === 2)).toBe(true);
    expect((await search('carol', `q=tls&repo=${PUB}&type=release_notes`)).every((i) => i.source_id.startsWith('release/'))).toBe(true);
  });

  it('never returns private content to non-members, including across repositories', async () => {
    const carol = await search('carol', `q=${encodeURIComponent('tls.min_version gateway mutual')}&status=all`);
    expect(carol.some((i) => i.repo_id === PRIV)).toBe(false);
    const bob = await search('bob', `q=${encodeURIComponent('tls.min_version gateway mutual')}&status=all`);
    expect(bob.some((i) => i.repo_id === PRIV)).toBe(true);
    expect((await get('carol', `/search?q=tls&repo=${PRIV}`)).statusCode).toBe(404);
  });

  it('drops hits from a stale projection (repository made private, index not yet updated)', async () => {
    await ctx.db.collection('repositories').updateOne({ repo_id: PUB }, { $set: { visibility: 'private' }, $inc: { acl_epoch: 1 } });
    const r = await get('carol', `/search?q=tls`);
    expect(r.json().items.some((i: Item) => i.repo_id === PUB)).toBe(false);
    expect(r.body).not.toMatch(/total/);
    const logged = await ctx.db.collection('query_logs').findOne({ query_id: r.json().query_id });
    expect(logged!.dropped.unauthorized).toBeGreaterThan(0);
    await ctx.db.collection('repositories').updateOne({ repo_id: PUB }, { $set: { visibility: 'public' }, $inc: { acl_epoch: 1 } });
  });

  it('applies revocation immediately even though the index is unchanged', async () => {
    const q = `q=${encodeURIComponent('payments gateway')}&status=all`;
    expect((await search('bob', q)).some((i) => i.repo_id === PRIV)).toBe(true);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/repos/${PRIV}/permissions/bob`, headers: { cookie: cookie.alice! } })).statusCode).toBe(200);
    expect((await search('bob', q)).some((i) => i.repo_id === PRIV)).toBe(false);
    await post('alice', `/repos/${PRIV}/permissions`, { username: 'bob', role: 'read' });
  });

  it('drops hits whose canonical chunk no longer matches the index', async () => {
    const before = await search('carol', `q=cipher&repo=${PUB}`);
    const target = before.find((i) => i.source_id === 'docs/ciphers.md')!;
    await ctx.db.collection('chunks').updateOne({ chunk_id: target.chunk_id }, { $set: { text_digest: 'tampered' } });
    expect((await search('carol', `q=cipher&repo=${PUB}`)).some((i) => i.chunk_id === target.chunk_id)).toBe(false);
    await ctx.db.collection('chunks').updateOne({ chunk_id: target.chunk_id }, { $set: { text_digest: (await os.get({ index: alias, id: target.chunk_id })).body._source!.text_digest } });
  });

  it('verifies citations against the immutable source revision', async () => {
    const [doc] = await search('carol', `q=${encodeURIComponent('TLS minimum version')}&repo=${PUB}&status=current`);
    const ok = (await post('carol', '/citations/verify', { repo_id: PUB, chunk_id: doc!.chunk_id })).json();
    expect(ok).toMatchObject({ valid: true, citation: { cite: doc!.cite } });
    expect(ok.text).toContain('tls.min_version');
    const issue = await ctx.db.collection('chunks').findOne({ repo_id: PUB, source_id: 'issue:81' });
    expect((await post('carol', '/citations/verify', { repo_id: PUB, chunk_id: issue!.chunk_id })).json().valid).toBe(true);
    await ctx.db.collection('chunks').updateOne({ chunk_id: issue!.chunk_id }, { $set: { text: 'forged text' } });
    expect((await post('carol', '/citations/verify', { repo_id: PUB, chunk_id: issue!.chunk_id })).json()).toMatchObject({ valid: false, reason: 'content_mismatch' });
    await ctx.db.collection('chunks').updateOne({ chunk_id: issue!.chunk_id }, { $set: { text: issue!.text } });
    const priv = await ctx.db.collection('chunks').findOne({ repo_id: PRIV });
    expect((await post('carol', '/citations/verify', { repo_id: PRIV, chunk_id: priv!.chunk_id })).statusCode).toBe(404);
  });

  it('compares current guidance with historical decisions, with the reason it changed', async () => {
    const r = await get('carol', `/repos/${PUB}/guidance/compare?topic=tls.min_version&from=v1.0.0`);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c.effective_release).toMatchObject({ release_id: 'v2.4.1' });
    expect(c.current.map((x: Item) => x.cite)).toEqual([expect.stringMatching(/^docs\/tls\.md@rev3#secure-defaults/)]);
    const hist = c.historical.map((x: Item) => x.source_id);
    expect(hist).toEqual(expect.arrayContaining(['docs/tls.md', 'issue:12', 'issue:12/comment:4410']));
    expect(c.historical.filter((x: Item) => x.source_id === 'docs/tls.md').every((x: Item) => x.revision === 1)).toBe(true); // from v1.0.0
    const why = c.why_changed.map((x: Item) => x.source_id);
    expect(why).toEqual(expect.arrayContaining(['release/v2.4.1', 'pr:95', 'pr:95/comment:review-302']));
  });

  it('answers with current verified evidence first and never presents superseded advice as current', async () => {
    const r = await post('carol', '/answer', { repo_id: PUB, query: 'What should tls.min_version be set to?' });
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.effective_release.release_id).toBe('v2.4.1');
    expect(a.current.length).toBeGreaterThan(0);
    expect(a.current.every((c: Item) => c.marker === 'current')).toBe(true);
    expect(a.current.some((c: Item) => c.source_id === 'issue:12')).toBe(false);
    expect(a.answer).toMatch(/^Current guidance \(effective release v2\.4\.1\):/);
    expect(a.answer).toContain('"1.2"');
    expect(a.historical.some((c: Item) => c.source_id.startsWith('issue:12'))).toBe(true);
    expect(a.warnings.join(' ')).toMatch(/superseded by a security change/);
  });

  it('withholds security configuration when no release can be verified', async () => {
    const r = await post('bob', '/answer', { repo_id: PRIV, query: 'Which TLS version does the payments gateway require?' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().current).toEqual([]);
    expect(r.json().warnings.join(' ')).toMatch(/cannot be verified/);
    expect(r.json().answer).toMatch(/^No current, verified guidance/);
  });

  it('logs queries pseudonymously and exposes aggregates to platform admins only', async () => {
    const log = await ctx.db.collection('query_logs').findOne({ endpoint: 'answer' });
    expect(log).toMatchObject({ query_text: null, effective_release: expect.any(String) });
    expect(log!.principal).not.toMatch(/u_/);
    expect(log!.query_hash).toHaveLength(32);
    expect((await get('carol', '/analytics/queries')).statusCode).toBe(403);
    const agg = (await get('ops', '/analytics/queries')).json();
    expect(agg.items.some((i: { endpoint: string }) => i.endpoint === 'search')).toBe(true);
  });

  it('treats query syntax as plain text and validates input', async () => {
    expect((await get('carol', `/search?q=${encodeURIComponent('tls AND _exists_:* OR visibility:private')}`)).statusCode).toBe(200);
    expect((await get('carol', `/search?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
    expect((await get('carol', '/search?q=tls&type=secret')).statusCode).toBe(400);
    expect((await get('carol', '/search?q=tls&visibility=private')).statusCode).toBe(400);
  });
});
