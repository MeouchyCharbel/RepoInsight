import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenarioRepo, type ScenarioManifest } from '../src/fixtures/scenario.js';
import { GitHubClient } from '../src/ingest/github.js';
import { Importer } from '../src/ingest/importer.js';
import { IngestStore } from '../src/ingest/store.js';
import { type Ctx, setup, teardown } from './helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const API = 'https://api.github.com/repos/octo/demo';
const iso = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
const user = { id: 11, login: 'octocat' };

function fakeGitHub(m: ScenarioManifest, opts: { failComments?: boolean; editIssueOnSecondRun?: boolean } = {}) {
  let run = 0;
  const routes = (path: string, query: URLSearchParams): { status?: number; body: unknown; link?: string } => {
    if (path === '') return { body: { id: 9001, private: false, full_name: 'octo/demo', default_branch: 'main', description: 'demo', owner: { id: 1 } } };
    if (path === '/releases') return { body: [{ tag_name: 'v2.4.1', name: 'v2.4.1', body: '## Security\n\n`tls.min_version` is now `"1.2"`.', draft: false, prerelease: false, published_at: iso(13), target_commitish: 'main' }, { tag_name: 'v9.0.0', draft: true }] };
    if (path === '/issues') {
      const items = [
        { number: 81, title: 'TLS setting regression', body: 'Default should be 1.2', state: 'closed', labels: [{ name: 'security' }], user, created_at: iso(6), updated_at: iso(9), closed_at: iso(9) },
        { number: 95, title: 'a PR in the issues list', pull_request: {}, user, created_at: iso(7), updated_at: iso(9) },
      ];
      if (run >= 1 && opts.editIssueOnSecondRun) items[0] = { ...items[0]!, body: 'Edited later', updated_at: iso(20) };
      return query.get('page') === '2' ? { body: [] } : { body: items };
    }
    if (path === '/pulls') {
      return { body: [
        { number: 95, title: 'Raise default TLS minimum version', body: 'Fixes #81', state: 'closed', labels: [], user, base: { ref: 'main' }, head: { ref: 'fix', sha: m.f2 }, merged_at: iso(9), merge_commit_sha: m.S95, created_at: iso(7), updated_at: iso(9) },
        // Open PR: GitHub still reports a test-merge merge_commit_sha, which must be ignored.
        { number: 97, title: 'HTTP/3', body: '', state: 'open', labels: [], user, base: { ref: 'main' }, head: { ref: 'h3', sha: m.h1 }, merged_at: null, merge_commit_sha: 'f'.repeat(40), created_at: iso(16), updated_at: iso(16) },
      ] };
    }
    if (path === '/pulls/95/commits') return { body: [{ sha: m.f1 }, { sha: m.f2 }] };
    if (path === '/pulls/95/reviews') return { body: [{ id: 302, body: 'Matches the advisory.', state: 'APPROVED', user, submitted_at: iso(8) }, { id: 303, body: '', state: 'COMMENTED', user }] };
    if (path === '/issues/comments') {
      if (opts.failComments) return { status: 500, body: {} };
      // Two pages to exercise pagination.
      return query.get('page') === '2'
        ? { body: [{ id: 2, issue_url: `${API}/issues/95`, body: 'PR conversation comment', user, created_at: iso(9), updated_at: iso(9) }] }
        : { body: [{ id: 1, issue_url: `${API}/issues/81`, body: 'Confirmed regression', user, created_at: iso(7), updated_at: iso(7) }], link: `<${API}/issues/comments?page=2&per_page=100>; rel="next"` };
    }
    if (path === '/pulls/comments') return { body: [{ id: 5, pull_request_url: `${API}/pulls/95`, path: 'src/tls/config.go', line: 4, body: 'Use a constant', user, created_at: iso(8), updated_at: iso(8) }] };
    return { status: 404, body: {} };
  };
  const fetchFn = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/repos/octo/demo') run++;
    const r = routes(u.pathname.replace('/repos/octo/demo', ''), u.searchParams);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.link ? { link: r.link } : {} });
  }) as typeof fetch;
  return new GitHubClient({ fetchFn, sleep: async () => {}, maxAttempts: 2 });
}

describe('repository import (mocked GitHub API + real Git history)', () => {
  let ctx: Ctx;
  let dataDir: string;
  let m: ScenarioManifest;
  const importer = (gh: GitHubClient) =>
    new Importer(ctx.db, new IngestStore(ctx.db, ctx.client), { dataDir, github: gh, cloneUrl: () => m.dir });

  beforeAll(async () => {
    ctx = await setup();
    dataDir = mkdtempSync(join(tmpdir(), 'ri-import-'));
    m = await buildScenarioRepo(dataDir);
  });
  afterAll(async () => {
    await teardown(ctx);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs an initial import and records per-step progress', async () => {
    const imp = importer(fakeGitHub(m));
    const job = await imp.run(await imp.createJob('octo/demo'));
    expect(job.kind).toBe('initial');
    expect(job.status).toBe('succeeded');
    const repoId = job.repo_id!;
    const n = (c: string, f = {}) => ctx.db.collection(c).countDocuments({ repo_id: repoId, ...f });
    expect(await n('commits')).toBe(15);
    expect(await n('issues')).toBe(1); // the PR item in the issues list is skipped
    expect(await n('pull_requests')).toBe(2);
    expect(await n('comments')).toBe(4); // 1 review with body, 2 conversation, 1 review comment
    expect(await n('releases')).toBe(1); // draft skipped
    expect(await n('document_revisions', { source_id: 'docs/tls.md' })).toBe(3);
    expect(job.steps.comments).toMatchObject({ status: 'succeeded', processed: 2 });

    const pr95 = await ctx.db.collection('pull_requests').findOne({ repo_id: repoId, number: 95 });
    expect(pr95).toMatchObject({ merged_sha: m.S95, closes_issues: [81], head_commits: [m.f1, m.f2] });
    expect((await ctx.db.collection('pull_requests').findOne({ repo_id: repoId, number: 97 }))!.merged_sha).toBeNull();
    // Release target comes from the Git tag, not from target_commitish ("main").
    expect((await ctx.db.collection('releases').findOne({ repo_id: repoId }))!.target_sha).toBe(m.tags['v2.4.1']);
    // Conversation comments on PRs are attached to the PR thread.
    expect(await ctx.db.collection('comments').countDocuments({ repo_id: repoId, thread_key: 'pr:95', comment_id: '2' })).toBe(1);
  });

  it('re-import is incremental and creates no duplicates', async () => {
    const before = await ctx.db.collection('outbox').countDocuments();
    const imp = importer(fakeGitHub(m, { editIssueOnSecondRun: true }));
    const job = await imp.run(await imp.createJob('octo/demo'));
    expect(job.kind).toBe('update');
    expect(job.since).not.toBeNull();
    expect(job.steps.commits).toMatchObject({ applied: 0, duplicate: 15 });
    expect(job.steps.docs!.applied).toBe(0);
    const repoId = job.repo_id!;
    expect(await ctx.db.collection('repositories').countDocuments({ provider_id: 9001 })).toBe(1);
    expect(await ctx.db.collection('issues').findOne({ repo_id: repoId, number: 81 })).toMatchObject({ body: 'Edited later', revision: 2 });
    // Only the edited issue produced a new canonical event (plus the derived guidance re-classification).
    const fresh = await ctx.db.collection('outbox').find({}).sort({ created_at: 1 }).skip(before).toArray();
    expect(fresh.map((e) => e.type).sort()).toEqual(['guidance.updated', 'issue.updated']);
  });

  it('records a failed step and still completes independent steps', async () => {
    const imp = importer(fakeGitHub(m, { failComments: true }));
    const job = await imp.run(await imp.createJob('octo/demo'));
    expect(job.status).toBe('partial');
    expect(job.steps.comments).toMatchObject({ status: 'failed', error: 'GitHub request failed (500)' });
    expect(job.steps.docs!.status).toBe('succeeded');
    const stored = await ctx.db.collection('import_jobs').findOne({ job_id: job.job_id });
    expect(stored).toMatchObject({ status: 'partial' });
  });

  it('rejects invalid repository names', async () => {
    const imp = importer(fakeGitHub(m));
    await expect(imp.createJob('octo/demo/../x')).rejects.toThrow(/owner\/name/);
    await expect(imp.createJob('octo/$where')).rejects.toThrow();
  });
});

describe('synthetic scenario history', () => {
  let dir: string;
  let m: ScenarioManifest;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ri-scenario-'));
    m = await buildScenarioRepo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('produces the merge strategies the tracing tests rely on', async () => {
    const { GitRepo } = await import('../src/ingest/git.js');
    const commits = new Map((await new GitRepo(join(m.dir, '.git')).commits()).map((c) => [c.sha, c]));
    expect(commits.get(m.M20)!.parent_shas).toHaveLength(2); // merge commit
    expect(commits.get(m.S95)!.parent_shas).toEqual([m.M20]); // squash: single parent on main
    expect(commits.get(m.R1)!.parent_shas).toEqual([m.c4]); // rebased onto newer main
    expect(m.R1).not.toBe(m.r1);
    expect(commits.get(m.B1)!.cherry_picked_from).toBe(m.S95); // verified backport trailer
    expect(commits.get(m.B2)!.cherry_picked_from).toBeNull(); // edited backport, no trailer
    // Generation numbers increase along parents.
    for (const c of commits.values()) for (const p of c.parent_shas) expect(c.generation).toBeGreaterThan(commits.get(p)!.generation);
  });
});
