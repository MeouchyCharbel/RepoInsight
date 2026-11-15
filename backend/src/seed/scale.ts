// Synthetic scale dataset, sized after the brief's optional prototype dataset (100 repositories,
// ~2,000 issues/docs, ~10,000 chunks). All content is generated (seeded PRNG); nothing is real.
// Every record goes through the normal store, so each change produces a real outbox event.
// Usage: npm run seed:scale -- [--repos 100]
import { loadConfig } from '../config.js';
import { connectMongo, ensureIndexes } from '../db.js';
import { IngestStore } from '../ingest/store.js';
import type { PermissionDoc, RepositoryDoc } from '../types.js';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const REPOS = arg('repos', 100);
const ISSUES_PER_REPO = 18;
const DOCS_PER_REPO = 2;
const DOC_REVISIONS = 4;

// Deterministic PRNG (mulberry32) so the dataset is reproducible.
let seed = 19;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const TOPICS = ['cache', 'timeout', 'proxy', 'tls', 'retry', 'logging', 'auth', 'rate limit', 'webhook', 'database pool', 'memory', 'startup', 'config reload', 'metrics', 'dns'] as const;
const VERBS = ['fails', 'hangs', 'leaks', 'is slow', 'crashes', 'returns 500', 'ignores the setting', 'logs too much'] as const;
const KEYS = ['cache.ttl', 'http.timeout', 'proxy.max_conns', 'retry.max_attempts', 'log.level', 'auth.session_ttl', 'pool.size', 'metrics.port'] as const;
const LABELS = ['bug', 'docs', 'security', 'performance', 'question', 'enhancement'] as const;
const sentence = () => `The ${pick(TOPICS)} ${pick(VERBS)} when \`${pick(KEYS)}\` is set to ${Math.floor(rand() * 500)}.`;
const para = (n: number) => Array.from({ length: n }, sentence).join(' ');

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
const t0 = Date.now();
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  const store = new IngestStore(db, client);
  const day = (d: number) => new Date(Date.UTC(2026, 8, 1) + d * 86_400_000);
  const counts = { repos: 0, issue_events: 0, comments: 0, doc_revisions: 0 };

  for (let r = 1; r <= REPOS; r++) {
    const repoId = `gen-${String(r).padStart(3, '0')}`;
    const isPrivate = r % 10 === 0; // 10% private; bob is a member, carol is not
    await db.collection<RepositoryDoc>('repositories').updateOne(
      { repo_id: repoId },
      { $setOnInsert: { repo_id: repoId, org_id: `o_gen${r % 7}`, full_name: `synthetic/project-${r}`, description: 'Generated scale-test repository', visibility: isPrivate ? 'private' : 'public', default_branch: 'main', acl_epoch: 1, created_at: new Date(), updated_at: new Date() } },
      { upsert: true },
    );
    if (isPrivate) {
      await db.collection<PermissionDoc>('permissions').updateOne({ repo_id: repoId, principal_id: 'u_bob' }, { $set: { role: 'read', source: 'direct', acl_epoch: 1, seq: 0, updated_at: new Date() } }, { upsert: true });
    }
    counts.repos++;

    for (let n = 1; n <= ISSUES_PER_REPO; n++) {
      const labels = [pick(LABELS), ...(rand() < 0.3 ? [pick(LABELS)] : [])].filter((v, i, a) => a.indexOf(v) === i);
      const title = `${pick(TOPICS)} ${pick(VERBS)} in ${pick(['production', 'staging', 'tests', 'the CLI'])}`;
      const opened = day(Math.floor(rand() * 60));
      const base = { repo_id: repoId, number: n, title, labels, author_id: 'u_gen', created_at: opened };
      // Lifecycle: opened, edited, closed (three canonical changes, three events).
      await store.upsertIssue({ ...base, body: para(3), state: 'open', closed_at: null, source_updated_at: opened });
      const edited = new Date(opened.getTime() + 3_600_000);
      await store.upsertIssue({ ...base, body: `${para(3)}\n\nUpdate: ${sentence()}`, state: 'open', closed_at: null, source_updated_at: edited });
      const closed = new Date(opened.getTime() + 2 * 86_400_000);
      await store.upsertIssue({ ...base, body: `${para(3)}\n\nUpdate: ${sentence()}`, state: 'closed', closed_at: closed, source_updated_at: closed });
      counts.issue_events += 3;
      for (let c = 1; c <= 3; c++) {
        const at = new Date(opened.getTime() + c * 7_200_000);
        await store.upsertComment({ repo_id: repoId, thread_key: `issue:${n}`, comment_id: `g${c}`, kind: 'issue_comment', author_id: 'u_gen', body: para(2), created_at: at, source_updated_at: at });
        counts.comments++;
      }
    }
    for (let d = 1; d <= DOCS_PER_REPO; d++) {
      for (let rev = 1; rev <= DOC_REVISIONS; rev++) {
        const sections = Array.from({ length: 6 }, (_, s) => `## ${pick(TOPICS)} section ${s + 1}\n\n${para(4)}\n\n\`\`\`yaml\n${pick(KEYS)}: ${Math.floor(rand() * 100)}\n\`\`\``).join('\n\n');
        await store.addDocumentRevision({ repo_id: repoId, source_id: `docs/guide-${d}.md`, revision: rev, kind: 'doc', commit_sha: null, committed_at: day(rev * 10 + d), text: `# Guide ${d}\n\n${sections}\n` });
        counts.doc_revisions++;
      }
    }
    if (r % 10 === 0) console.log(`  ${r}/${REPOS} repositories (${Math.round((Date.now() - t0) / 1000)} s)`);
  }

  const total = {
    issues: await db.collection('issues').countDocuments({ repo_id: /^gen-/ }),
    documents: await db.collection('documents').countDocuments({ repo_id: /^gen-/ }),
    chunks: await db.collection('chunks').countDocuments({ repo_id: /^gen-/ }),
    events: await db.collection('outbox').countDocuments({ key: /^gen-/ }),
  };
  console.log(JSON.stringify({ generated: counts, stored: total, seconds: Math.round((Date.now() - t0) / 1000) }));
} finally {
  await client.close();
}
