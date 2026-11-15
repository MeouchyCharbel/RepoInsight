import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Db } from 'mongodb';
import { GitRepo } from '../ingest/git.js';
import { importDocs, type StepProgress } from '../ingest/importer.js';
import type { IngestStore } from '../ingest/store.js';
import { DEMO } from '../seed/demo.js';
import { TraceBuilder } from '../trace/builder.js';

const run = promisify(execFile);

/**
 * Deterministic synthetic repository for the TLS story (report 5.2 and 11.4). A real Git
 * repository is built so release inclusion can be proven from actual history:
 *
 *   PR #20  merge commit      (merged_sha = the merge commit)
 *   PR #95  squash merge      (fixes #81; head commits f1, f2 are NOT on main)
 *   PR #96  rebase merge      (original r1, r2 rewritten as R1, R2 on main)
 *   PR #97  open, unmerged
 *   v2.3.5  verified backport of the squash commit (cherry-pick -x trailer)
 *   v2.2.9  edited backport without trailer (must stay unverified)
 *
 * Issue #12 recommends the obsolete `tls.min_version: "1.0"`; v2.4.1 changes the secure default.
 */
export interface ScenarioManifest {
  dir: string;
  c1: string;
  c2: string;
  feature20: string;
  M20: string;
  f1: string;
  f2: string;
  S95: string;
  r1: string;
  r2: string;
  c4: string;
  R1: string;
  R2: string;
  B1: string;
  B2: string;
  h1: string;
  tags: Record<string, string>;
}

const day = (d: number, h = 12) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const date = (d: number, h = 12) => new Date(day(d, h));

const TLS_V1 = `# TLS configuration

## Secure defaults

Set \`tls.min_version\` to \`"1.0"\` so that legacy clients can connect.

\`\`\`yaml
tls.min_version: "1.0"
\`\`\`

## Certificates

Place certificates in \`/etc/proxy/certs\`.
`;
const TLS_V2 = `${TLS_V1}


## Cipher suites

See [ciphers](ciphers.md) for the supported cipher suites.
`;
const TLS_V3 = TLS_V2.replace(
  'Set `tls.min_version` to `"1.0"` so that legacy clients can connect.\n\n```yaml\ntls.min_version: "1.0"\n```',
  'Since v2.4.1, `tls.min_version` defaults to `"1.2"`. TLS 1.0 and 1.1 are no longer supported\nbecause they are vulnerable to downgrade attacks. Do not lower this value.\n\n```yaml\ntls.min_version: "1.2"\n```',
);
const CONFIG_V1 = `package tls

// MinVersion is the lowest TLS version accepted.
const MinVersion = "1.0"
`;
const CONFIG_V2 = CONFIG_V1.replace('"1.0"', '"1.2"');

export async function buildScenarioRepo(baseDir: string): Promise<ScenarioManifest> {
  const dir = resolve(baseDir, 'fixtures', 'acme-tls-proxy');
  rmSync(dir, { recursive: true, force: true }); // generated content only
  mkdirSync(dir, { recursive: true });

  let current = day(1);
  const env = () => ({
    ...process.env,
    GIT_AUTHOR_NAME: 'Alice Example', GIT_AUTHOR_EMAIL: 'alice@example.test',
    GIT_COMMITTER_NAME: 'Alice Example', GIT_COMMITTER_EMAIL: 'alice@example.test',
    GIT_AUTHOR_DATE: current, GIT_COMMITTER_DATE: current, GIT_TERMINAL_PROMPT: '0',
  });
  const git = async (...args: string[]) =>
    (await run('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, env: env(), windowsHide: true })).stdout.trim();
  const write = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
  };
  const commit = async (when: string, msg: string, files: Record<string, string>) => {
    current = when;
    write(files);
    await git('add', '-A');
    await git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const tag = async (name: string, when: string) => {
    current = when;
    await git('tag', '-a', name, '-m', `Release ${name}`);
  };

  await git('init', '-q', '-b', 'main');
  const c1 = await commit(day(1), 'Initial import', {
    'README.md': '# acme/tls-proxy\n\nA TLS-terminating proxy (synthetic demo repository).\n',
    'docs/tls.md': TLS_V1,
    'src/tls/config.go': CONFIG_V1,
  });
  await tag('v1.0.0', day(1, 13));
  const c2 = await commit(day(3), 'Add security policy and cipher docs link', { 'SECURITY.md': '# Security policy\n\nReport vulnerabilities to security@example.test.\n', 'docs/tls.md': TLS_V2 });

  // PR #20: ordinary merge commit.
  await git('checkout', '-q', '-b', 'feature/cipher-docs');
  const feature20 = await commit(day(4), 'Document cipher suites', { 'docs/ciphers.md': '# Cipher suites\n\nTLS_AES_128_GCM_SHA256 and TLS_AES_256_GCM_SHA384 are supported.\n' });
  await git('checkout', '-q', 'main');
  current = day(5);
  await git('merge', '-q', '--no-ff', 'feature/cipher-docs', '-m', 'Merge pull request #20 from acme/feature/cipher-docs');
  const M20 = await git('rev-parse', 'HEAD');
  await tag('v2.4.0', day(6));

  // PR #95: squash merge; the branch commits never reach main.
  await git('checkout', '-q', '-b', 'fix/tls-default');
  const f1 = await commit(day(7), 'Raise TLS minimum version to 1.2', { 'src/tls/config.go': CONFIG_V2 });
  const f2 = await commit(day(8), 'Update TLS docs', { 'docs/tls.md': TLS_V3 });
  await git('checkout', '-q', 'main');
  current = day(9);
  await git('merge', '-q', '--squash', 'fix/tls-default');
  await git('commit', '-q', '-m', 'Raise default TLS minimum version to 1.2 (#95)\n\nFixes #81');
  const S95 = await git('rev-parse', 'HEAD');

  // PR #96: rebase merge; r1/r2 are rewritten onto main as R1/R2.
  await git('checkout', '-q', '-b', 'feat/ocsp');
  const r1 = await commit(day(10), 'Add OCSP stapling', { 'src/tls/ocsp.go': 'package tls\n\n// Stapling enables OCSP stapling.\nconst Stapling = true\n' });
  const r2 = await commit(day(10, 14), 'Document OCSP stapling', { 'docs/ocsp.md': '# OCSP stapling\n\nEnabled by default.\n' });
  await git('checkout', '-q', 'main');
  const c4 = await commit(day(11), 'Clarify README', { 'README.md': '# acme/tls-proxy\n\nA TLS-terminating proxy (synthetic demo repository).\n\nSee docs/tls.md.\n' });
  current = day(12);
  await git('cherry-pick', r1, r2);
  const R2 = await git('rev-parse', 'HEAD');
  const R1 = await git('rev-parse', 'HEAD~1');
  await tag('v2.4.1', day(13));

  // Verified backport: cherry-pick -x adds "(cherry picked from commit <sha>)".
  await git('checkout', '-q', '-b', 'release/2.3.x', 'v1.0.0');
  current = day(14);
  await git('cherry-pick', '-x', S95);
  const B1 = await git('rev-parse', 'HEAD');
  await tag('v2.3.5', day(14, 13));

  // Edited backport without trailer or PR link: must stay unverified.
  await git('checkout', '-q', '-b', 'release/2.2.x', 'v1.0.0');
  current = day(15);
  await git('cherry-pick', '--no-commit', S95);
  write({ 'src/tls/config.go': CONFIG_V2.replace('accepted.', 'accepted (2.2.x backport, adjusted).') });
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Backport TLS default to 2.2');
  const B2 = await git('rev-parse', 'HEAD');
  await tag('v2.2.9', day(15, 13));

  // PR #97: open, never merged.
  await git('checkout', '-q', '-b', 'feat/http3', 'main');
  const h1 = await commit(day(16), 'Experimental HTTP/3 listener', { 'src/http3.go': 'package proxy\n' });
  await git('checkout', '-q', 'main');

  const repo = new GitRepo(join(dir, '.git'));
  const tags = Object.fromEntries(await repo.tags());
  return { dir, c1, c2, feature20, M20, f1, f2, S95, r1, r2, c4, R1, R2, B1, B2, h1, tags };
}

/** Ingests the scenario (Git history + synthetic GitHub entities) through the normal store. */
export async function ingestScenario(db: Db, store: IngestStore, baseDir: string): Promise<ScenarioManifest> {
  const m = await buildScenarioRepo(baseDir);
  const repo = DEMO.publicRepo;
  const git = new GitRepo(join(m.dir, '.git'));

  for (const b of await git.branches()) await store.upsertBranch(repo, b.name, b.sha);
  await store.upsertCommits(repo, await git.commits());

  const issue = (number: number, title: string, body: string, labels: string[], opened: number, closed: number | null, author = 'u_carol') =>
    store.upsertIssue({ repo_id: repo, number, title, body, labels, author_id: author, state: closed ? 'closed' : 'open', created_at: date(opened), closed_at: closed ? date(closed) : null, source_updated_at: date(closed ?? opened) });
  await issue(12, 'Allow TLS 1.0 for legacy clients', 'Old Android clients fail the handshake.\n\nWorkaround: set `tls.min_version: "1.0"` in the proxy config.', ['security', 'question'], 2, 3);
  await issue(81, 'TLS setting regression', 'v2.4.0 still accepts TLS 1.0 by default. The default `tls.min_version` should be `"1.2"`.', ['security', 'bug'], 6, 9, 'u_alice');
  await issue(90, 'Document cipher suite configuration', 'The docs do not explain how to restrict cipher suites.', ['docs'], 11, null, 'u_bob');

  const comment = (thread: string, id: string, body: string, d: number, author = 'u_bob', extra: { kind?: 'issue_comment' | 'review_comment' | 'review'; file_path?: string; diff_line?: number } = {}) =>
    store.upsertComment({ repo_id: repo, thread_key: thread, comment_id: id, kind: extra.kind ?? 'issue_comment', author_id: author, body, file_path: extra.file_path ?? null, diff_line: extra.diff_line ?? null, created_at: date(d), source_updated_at: date(d) });
  await comment('issue:12', '4410', 'Confirmed: setting `tls.min_version: "1.0"` fixes the handshake for old clients.', 3);
  await comment('issue:81', '9001', 'This is a security regression; TLS 1.0 must not be the default.', 7, 'u_alice');

  const pr = (number: number, title: string, body: string, opts: { merged?: { sha: string; day: number }; head: string[]; headRef: string; labels?: string[]; closes?: number[]; opened: number }) =>
    store.upsertPullRequest({
      repo_id: repo, number, title, body, labels: opts.labels ?? [], author_id: 'u_alice', state: opts.merged ? 'closed' : 'open', base_ref: 'main', head_ref: opts.headRef,
      head_sha: opts.head.at(-1)!, head_commits: opts.head, merged_at: opts.merged ? date(opts.merged.day) : null, merged_sha: opts.merged?.sha ?? null,
      closes_issues: opts.closes ?? [], created_at: date(opts.opened), source_updated_at: date(opts.merged?.day ?? opts.opened),
    });
  await pr(20, 'Document cipher suites', 'Adds docs/ciphers.md.', { merged: { sha: m.M20, day: 5 }, head: [m.feature20], headRef: 'feature/cipher-docs', labels: ['docs'], opened: 4 });
  await pr(95, 'Raise default TLS minimum version to 1.2', 'Fixes #81.\n\nTLS 1.0/1.1 are vulnerable to downgrade attacks, so the default `tls.min_version` becomes `"1.2"`.', { merged: { sha: m.S95, day: 9 }, head: [m.f1, m.f2], headRef: 'fix/tls-default', labels: ['security'], closes: [81], opened: 7 });
  await pr(96, 'OCSP stapling', 'Adds OCSP stapling support.', { merged: { sha: m.R2, day: 12 }, head: [m.r1, m.r2], headRef: 'feat/ocsp', opened: 10 });
  await pr(97, 'Experimental HTTP/3 listener', 'Work in progress.', { head: [m.h1], headRef: 'feat/http3', opened: 16 });
  await comment('pr:95', 'review-302', 'Defaulting to 1.2 matches the security advisory; older clients must upgrade.', 8, 'u_bob', { kind: 'review_comment', file_path: 'src/tls/config.go', diff_line: 4 });

  const release = (tag: string, body: string, d: number) =>
    store.upsertRelease({ repo_id: repo, release_id: tag, name: tag, body, target_sha: m.tags[tag] ?? null, published_at: date(d, 14), prerelease: false, source_updated_at: date(d, 14) });
  await release('v1.0.0', '# v1.0.0\n\nFirst release.', 1);
  await release('v2.4.0', '# v2.4.0\n\n## Documentation\n\n- Cipher suite documentation (#20).', 6);
  await release('v2.4.1', '# v2.4.1\n\n## Security\n\n- `tls.min_version` now defaults to `"1.2"` (#95, fixes #81). TLS 1.0 is no longer supported.\n\n## Features\n\n- OCSP stapling (#96).', 13);
  await release('v2.3.5', '# v2.3.5\n\n## Security\n\n- Backport: `tls.min_version` defaults to `"1.2"`.', 14);
  await release('v2.2.9', '# v2.2.9\n\n## Security\n\n- TLS default hardened for the 2.2 line.', 15);

  const p: StepProgress = { status: 'running', processed: 0, applied: 0, duplicate: 0, stale: 0 };
  await importDocs(store, git, repo, 'main', p);

  await db.collection('repositories').updateOne({ repo_id: repo }, { $set: { git_dir: join(m.dir, '.git') } });
  await new TraceBuilder(db).rebuildRepo(repo);

  // Private synthetic repository content (used to prove nothing private leaks).
  const priv = DEMO.privateRepo;
  await store.upsertIssue({ repo_id: priv, number: 3, title: 'PRIVATE: rotate payment gateway credentials', body: 'Synthetic private issue used to test that private data never leaks.', state: 'open', labels: ['security'], author_id: 'u_alice', created_at: date(11), closed_at: null, source_updated_at: date(11) });
  await store.upsertIssue({ repo_id: priv, number: 4, title: 'PRIVATE: invoice rounding bug', body: 'Synthetic private issue.', state: 'closed', labels: ['bug'], author_id: 'u_bob', created_at: date(9), closed_at: date(9), source_updated_at: date(9) });
  await store.addDocumentRevision({ repo_id: priv, source_id: 'docs/payments.md', revision: 1, kind: 'doc', commit_sha: null, committed_at: date(10), text: '# Payments gateway\n\n## TLS\n\nPRIVATE: the gateway requires `tls.min_version` `"1.3"` and mutual TLS.\n' });
  return m;
}
