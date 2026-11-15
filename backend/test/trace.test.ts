import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestScenario, type ScenarioManifest } from '../src/fixtures/scenario.js';
import { IngestStore } from '../src/ingest/store.js';
import { DEMO } from '../src/seed/demo.js';
import { TraceBuilder } from '../src/trace/builder.js';
import { CommitGraph } from '../src/trace/graph.js';
import { type Ctx, login, setup, teardown } from './helpers.js';

const REPO = DEMO.publicRepo;

describe('issue -> PR -> commit -> release tracing (real Git scenario)', () => {
  let ctx: Ctx;
  let dir: string;
  let m: ScenarioManifest;
  let builder: TraceBuilder;
  const edge = (from: string, relation: string, to: string) => ctx.db.collection('edges').findOne({ repo_id: REPO, from, relation, to, status: 'active' });

  beforeAll(async () => {
    ctx = await setup();
    // The scenario replaces the minimal seed issues of the public repository.
    await ctx.db.collection('issues').deleteMany({ repo_id: REPO });
    await ctx.db.collection('chunks').deleteMany({ repo_id: REPO });
    dir = mkdtempSync(join(tmpdir(), 'ri-trace-'));
    m = await ingestScenario(ctx.db, new IngestStore(ctx.db, ctx.client), dir); // also builds the graph
    builder = new TraceBuilder(ctx.db);
  }, 60_000);
  afterAll(async () => {
    await teardown(ctx);
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers ancestry from the commit DAG with generation pruning', async () => {
    const g = new CommitGraph(ctx.db, REPO);
    const t = m.tags;
    expect(await g.isAncestor(m.S95, t['v2.4.1']!)).toBe('yes'); // squash commit is on main
    expect(await g.isAncestor(m.f1, t['v2.4.1']!)).toBe('no'); // squashed head commit never reached main
    expect(await g.isAncestor(m.S95, t['v2.4.0']!)).toBe('no'); // fix came after v2.4.0
    expect(await g.isAncestor(m.r1, t['v2.4.1']!)).toBe('no'); // pre-rebase commit
    expect(await g.isAncestor(m.R2, t['v2.4.1']!)).toBe('yes'); // rebased commit
    expect(await g.isAncestor(m.feature20, t['v2.4.0']!)).toBe('yes'); // via merge commit's 2nd parent
    expect(await g.isAncestor(m.S95, t['v2.3.5']!)).toBe('no'); // backport branch has a different commit
    expect(await g.isAncestor(t['v2.4.1']!, m.c1)).toBe('no'); // generation rule: immediate
    expect(await g.isAncestor('0'.repeat(40), t['v2.4.1']!)).toBe('unknown'); // missing history
    expect(await new CommitGraph(ctx.db, REPO, { nodes: 1, ms: 1000 }).isAncestor(m.c1, t['v2.4.1']!)).toBe('unknown'); // budget
  });

  it('stores typed edges; head commits are context only and open PRs have no merged commit', async () => {
    expect(await edge('issue:81', 'ISSUE_FIXED_BY_PR', 'pr:95')).toMatchObject({ provenance: 'closing_keyword_in_merged_pr', confidence: 'verified' });
    expect(await edge('pr:95', 'PR_MERGED_AS_COMMIT', `commit:${m.S95}`)).toBeTruthy();
    expect(await edge('pr:95', 'PR_CONTAINS_COMMIT', `commit:${m.f1}`)).toBeTruthy();
    expect(await ctx.db.collection('edges').countDocuments({ repo_id: REPO, from: 'pr:97', relation: 'PR_MERGED_AS_COMMIT' })).toBe(0);
  });

  it('classifies merge, squash and rebase merges', async () => {
    const prs = ctx.db.collection('pull_requests');
    const strategy = async (n: number) => builder.mergeStrategy(REPO, (await prs.findOne({ repo_id: REPO, number: n })) as never);
    expect(await strategy(20)).toBe('merge_commit');
    expect(await strategy(95)).toBe('squash');
    expect(await strategy(96)).toBe('rebase');
  });

  it('links backports only with evidence', async () => {
    expect(await edge(`commit:${m.B1}`, 'COMMIT_BACKPORT_OF', `commit:${m.S95}`)).toMatchObject({ provenance: 'cherry_pick_trailer', confidence: 'verified' });
    expect(await edge(`commit:${m.B2}`, 'COMMIT_BACKPORT_OF', `commit:${m.S95}`)).toMatchObject({ provenance: 'same_files_and_backport_message', confidence: 'unverified' });
  });

  it('materialises release ranges from the DAG (prev..target)', async () => {
    expect(await ctx.db.collection('releases').findOne({ repo_id: REPO, release_id: 'v2.4.1' })).toMatchObject({ prev_release_id: 'v2.4.0' });
    expect(await ctx.db.collection('releases').findOne({ repo_id: REPO, release_id: 'v2.3.5' })).toMatchObject({ prev_release_id: 'v1.0.0' });
    expect(await edge('release:v2.4.1', 'RELEASE_CONTAINS_COMMIT', `commit:${m.S95}`)).toMatchObject({ provenance: 'dag_range:v2.4.0..v2.4.1' });
    expect(await edge('release:v2.4.1', 'RELEASE_CONTAINS_COMMIT', `commit:${m.R2}`)).toBeTruthy();
    expect(await edge('release:v2.4.0', 'RELEASE_CONTAINS_COMMIT', `commit:${m.M20}`)).toBeTruthy();
    expect(await edge('release:v2.4.0', 'RELEASE_CONTAINS_COMMIT', `commit:${m.S95}`)).toBeNull();
    expect(await edge('release:v2.3.5', 'RELEASE_CONTAINS_COMMIT', `commit:${m.B1}`)).toBeTruthy();
  });

  it('traces issue #81 to releases with explicit evidence', async () => {
    const t = (await builder.traceIssue(REPO, 81))!;
    expect(t.fixed_in).toEqual({ release_id: 'v2.4.1', status: 'verified', via: 'merged_commit' });
    const rel = Object.fromEntries(t.fixes[0]!.releases.map((r) => [r.release_id, r]));
    expect(rel['v1.0.0']!.status).toBe('not_included');
    expect(rel['v2.4.0']!.status).toBe('not_included');
    expect(rel['v2.4.1']).toMatchObject({ status: 'verified', via: 'merged_commit', evidence: { commit: m.S95, method: 'commit_dag_ancestry' } });
    expect(rel['v2.3.5']).toMatchObject({ status: 'verified', via: 'backport', evidence: { backport_commit: m.B1, provenance: 'cherry_pick_trailer' } });
    expect(rel['v2.2.9']).toMatchObject({ status: 'unverified', via: 'candidate_backport' });
    expect(t.fixes[0]!.merge).toMatchObject({ merged_sha: m.S95, strategy: 'squash', head_commits: [m.f1, m.f2] });
    const issue = await ctx.db.collection('issues').findOne({ repo_id: REPO, number: 81 });
    expect(issue).toMatchObject({ fixed_in_release: 'v2.4.1', fixed_in_status: 'verified' });
  });

  it('never claims a fix without a closing link', async () => {
    const t = (await builder.traceIssue(REPO, 12))!;
    expect(t.fixed_in).toBeNull();
    expect(t.notes.join(' ')).toMatch(/no fix release can be claimed/);
  });

  it('tags documentation revisions with the releases that contain them', async () => {
    const rev = async (revision: number) =>
      (await ctx.db.collection('chunks').findOne({ repo_id: REPO, source_id: 'docs/tls.md', revision, section_anchor: 'secure-defaults' }))!.release_ids.sort();
    expect(await rev(3)).toEqual(['v2.4.1']);
    expect(await rev(2)).toEqual(['v2.4.0']);
    expect(await rev(1)).toEqual(['v1.0.0', 'v2.2.9', 'v2.3.5']); // backport branches never got the new docs
  });

  it('resolves a pending edge when the referenced issue arrives', async () => {
    const store = new IngestStore(ctx.db, ctx.client);
    const at = new Date(Date.UTC(2026, 9, 20));
    await store.upsertPullRequest({ repo_id: REPO, number: 130, title: 'Fix late issue', body: 'Closes #131', state: 'open', labels: [], author_id: 'u_bob', base_ref: 'main', head_ref: 'x', head_sha: m.h1, head_commits: [m.h1], merged_at: null, merged_sha: null, closes_issues: [131], created_at: at, source_updated_at: at });
    await builder.buildPrEdges(REPO, 130);
    expect(await ctx.db.collection('edges').findOne({ repo_id: REPO, from: 'issue:131', to: 'pr:130' })).toMatchObject({ status: 'pending', confidence: 'unverified' });
    await store.upsertIssue({ repo_id: REPO, number: 131, title: 'Late issue', body: 'x', state: 'open', labels: [], author_id: 'u_bob', created_at: at, closed_at: null, source_updated_at: at });
    expect(await builder.handle({ event_id: 'e', type: 'issue.opened', key: `${REPO}:issue:131`, created_at: at.toISOString(), payload: { repo_id: REPO, number: 131 } })).toBe('pending-resolved');
    expect(await ctx.db.collection('edges').findOne({ repo_id: REPO, from: 'issue:131', to: 'pr:130' })).toMatchObject({ status: 'active' });
    // Unmerged PR: no release may claim the fix.
    expect((await builder.traceIssue(REPO, 131))!.fixed_in).toBeNull();
  });

  it('recomputes containment when a tag moves (history rewrite)', async () => {
    const releases = ctx.db.collection('releases');
    await releases.updateOne({ repo_id: REPO, release_id: 'v2.4.1' }, { $set: { target_sha: m.M20 } });
    await builder.computeRelease(REPO, 'v2.4.1');
    expect(await edge('release:v2.4.1', 'RELEASE_CONTAINS_COMMIT', `commit:${m.S95}`)).toBeNull();
    const stale = await ctx.db.collection('edges').findOne({ repo_id: REPO, from: 'release:v2.4.1', to: `commit:${m.S95}` });
    expect(stale!.status).toBe('invalidated');
    await releases.updateOne({ repo_id: REPO, release_id: 'v2.4.1' }, { $set: { target_sha: m.tags['v2.4.1'] } });
    await builder.computeRelease(REPO, 'v2.4.1');
    expect(await edge('release:v2.4.1', 'RELEASE_CONTAINS_COMMIT', `commit:${m.S95}`)).toBeTruthy();
  });

  it('serves traces and release fix lists through the API with access control', async () => {
    const carol = await login(ctx.app, 'carol');
    const trace = await ctx.app.inject({ url: `/repos/${REPO}/issues/81/trace`, headers: { cookie: carol } });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().fixed_in).toMatchObject({ release_id: 'v2.4.1', status: 'verified' });
    const fixes = (await ctx.app.inject({ url: `/repos/${REPO}/releases/v2.4.1/issues`, headers: { cookie: carol } })).json();
    expect(fixes.verified.map((i: { issue: { number: number } }) => i.issue.number)).toEqual([81]);
    const backport = (await ctx.app.inject({ url: `/repos/${REPO}/releases/v2.3.5/issues`, headers: { cookie: carol } })).json();
    expect(backport.verified[0]).toMatchObject({ pr: 95, via: 'backport:cherry_pick_trailer', commit: m.B1 });
    const candidate = (await ctx.app.inject({ url: `/repos/${REPO}/releases/v2.2.9/issues`, headers: { cookie: carol } })).json();
    expect(candidate.verified).toEqual([]);
    expect(candidate.unverified[0]).toMatchObject({ pr: 95, confidence: 'unverified' });
    // Private repository: identical 404 for non-members.
    expect((await ctx.app.inject({ url: `/repos/${DEMO.privateRepo}/issues/3/trace`, headers: { cookie: carol } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/repos/${REPO}/releases/..%2Fx/issues`, headers: { cookie: carol } })).statusCode).toBe(400);
  });
});
