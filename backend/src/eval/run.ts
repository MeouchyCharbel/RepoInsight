// Reproducible retrieval evaluation over hand-labelled queries (eval/queries.json).
// Usage: npm run seed && npm run search:rebuild && npm run eval
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { connectMongo } from '../db.js';
import { environment, principal, ROOT, services, writeResult } from './common.js';

interface Judged {
  id: string;
  user: string;
  repo?: string;
  q: string;
  status?: 'current' | 'all';
  relevant: { source_id: string; anchor?: string }[];
}
const spec = JSON.parse(readFileSync(join(ROOT, 'eval', 'queries.json'), 'utf8')) as {
  queries: Judged[];
  leak_probes: { id: string; user: string; q: string }[];
  security_answers: { id: string; user: string; repo: string; q: string }[];
};

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  const { os, search } = services(config, db, client);
  const env = await environment(db, os);
  if (env.dataset.index_documents !== env.dataset.chunks) console.warn(`Warning: index has ${env.dataset.index_documents} documents but MongoDB has ${env.dataset.chunks} chunks; run the worker or npm run search:rebuild first.`);

  const perQuery = [];
  let recallSum = 0;
  let rrSum = 0;
  let checked = 0;
  let valid = 0;
  for (const j of spec.queries) {
    const p = await principal(db, j.user);
    const r = await search.search(p, { q: j.q, repo: j.repo, status: j.status ?? 'all', limit: 10 });
    const matches = (i: { source_id: string; section_anchor: string }, rel: Judged['relevant'][number]) => i.source_id === rel.source_id && (!rel.anchor || i.section_anchor === rel.anchor);
    const found = j.relevant.filter((rel) => r.items.some((i) => matches(i, rel)));
    const firstRank = r.items.findIndex((i) => j.relevant.some((rel) => matches(i, rel)));
    const recall = found.length / j.relevant.length;
    const rr = firstRank >= 0 ? 1 / (firstRank + 1) : 0;
    recallSum += recall;
    rrSum += rr;
    for (const i of r.items) {
      checked++;
      if ((await search.verifyCitation(p, i.repo_id, i.chunk_id)).valid) valid++;
    }
    perQuery.push({ id: j.id, q: j.q, recall_at_10: recall, reciprocal_rank: rr, first_relevant_rank: firstRank >= 0 ? firstRank + 1 : null, top3: r.items.slice(0, 3).map((i) => i.cite) });
  }

  // Leak probes: private content returned to a non-member is a failure.
  const privateRepos = new Set((await db.collection('repositories').find({ visibility: 'private' }, { projection: { repo_id: 1 } }).toArray()).map((r) => r.repo_id as string));
  const probes = [];
  for (const pr of spec.leak_probes) {
    const p = await principal(db, pr.user);
    const member = new Set(await (services(config, db, client).acl.memberRepoIds(p)));
    const r = await search.search(p, { q: pr.q, status: 'all', limit: 50 });
    const leaked = r.items.filter((i) => privateRepos.has(i.repo_id) && !member.has(i.repo_id)).length;
    probes.push({ id: pr.id, results: r.items.length, unauthorized_results: leaked });
  }

  // Security answers: a superseded or historical chunk presented as current guidance is a failure.
  const answers = [];
  for (const s of spec.security_answers) {
    const p = await principal(db, s.user);
    const a = (await search.answer(p, s.repo, s.q)) as { current: { marker: string; superseded_by: unknown; cite: string }[]; warnings: string[]; effective_release: { release_id: string } | null };
    const stale = a.current.filter((c) => c.marker !== 'current' || c.superseded_by).length;
    answers.push({ id: s.id, q: s.q, effective_release: a.effective_release?.release_id ?? null, current_citations: a.current.map((c) => c.cite), stale_current_citations: stale, withheld: a.current.length === 0, warnings: a.warnings });
  }

  const n = spec.queries.length;
  const result = {
    kind: 'retrieval-evaluation',
    run_at: new Date().toISOString(),
    methodology: 'Hand-labelled judgments (eval/queries.json) on the synthetic scenario; BM25 retrieval with permission pre-filter and MongoDB post-verification; top 10 per query. Small dataset: results show correctness of the pipeline, not production-scale relevance.',
    environment: env,
    metrics: {
      queries: n,
      recall_at_10: Math.round((recallSum / n) * 1000) / 1000,
      mrr: Math.round((rrSum / n) * 1000) / 1000,
      citation_valid_rate: checked ? Math.round((valid / checked) * 1000) / 1000 : null,
      citations_checked: checked,
      unauthorized_result_rate: probes.reduce((s, p) => s + p.unauthorized_results, 0) / Math.max(1, probes.reduce((s, p) => s + p.results, 0) || 1),
      unauthorized_results: probes.reduce((s, p) => s + p.unauthorized_results, 0),
      stale_security_advice_rate: answers.filter((a) => a.stale_current_citations > 0).length / answers.length,
    },
    per_query: perQuery,
    leak_probes: probes,
    security_answers: answers,
  };
  const file = writeResult('eval', result);
  console.log(JSON.stringify(result.metrics, null, 2));
  for (const q of perQuery) console.log(`${q.id} recall=${q.recall_at_10.toFixed(2)} rr=${q.reciprocal_rank.toFixed(2)}  ${q.q}`);
  console.log(`Saved ${file}`);
} finally {
  await client.close();
}
