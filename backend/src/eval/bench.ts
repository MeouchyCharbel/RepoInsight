// Benchmarks: search and answer latency (in-process service calls against the local stack) and
// end-to-end indexing delay (needs `npm run worker` running). Records environment and dataset.
// Usage: npm run bench -- [--iterations 200] [--index-samples 20]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config.js';
import { connectMongo } from '../db.js';
import { IngestStore } from '../ingest/store.js';
import type { RepositoryDoc } from '../types.js';
import { environment, percentile, principal, ROOT, services, writeResult } from './common.js';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const ITER = arg('iterations', 200);
const INDEX_SAMPLES = arg('index-samples', 20);
const spec = JSON.parse(readFileSync(join(ROOT, 'eval', 'queries.json'), 'utf8')) as { queries: { user: string; repo?: string; q: string }[]; security_answers: { user: string; repo: string; q: string }[] };

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  const { os, search } = services(config, db, client);
  const env = await environment(db, os);
  const users = new Map<string, Awaited<ReturnType<typeof principal>>>();
  for (const u of ['carol', 'bob']) users.set(u, await principal(db, u));

  // Warm-up (connections, caches), then measured runs.
  for (let i = 0; i < 20; i++) {
    const q = spec.queries[i % spec.queries.length]!;
    await search.search(users.get(q.user)!, { q: q.q, repo: q.repo, status: 'current', limit: 10 });
  }
  const totals: number[] = [];
  const stages: Record<string, number[]> = { acl: [], search: [], verify: [], final_acl: [] };
  for (let i = 0; i < ITER; i++) {
    const q = spec.queries[i % spec.queries.length]!;
    const r = await search.search(users.get(q.user)!, { q: q.q, repo: q.repo, status: 'current', limit: 10 });
    totals.push(r.timings.total!);
    for (const k of Object.keys(stages)) stages[k]!.push(r.timings[k]!);
  }
  const answerTimes: number[] = [];
  for (let i = 0; i < Math.max(10, Math.floor(ITER / 5)); i++) {
    const s = spec.security_answers[i % 2]!; // public-repository security questions
    const t = performance.now();
    await search.answer(users.get(s.user)!, s.repo, s.q);
    answerTimes.push(performance.now() - t);
  }

  // Indexing delay: canonical write -> searchable in OpenSearch, through outbox, Kafka and projector.
  const delays: number[] = [];
  let indexing: Record<string, unknown>;
  const state = await db.collection('projection_state').findOne({ consumer: 'ri-search-projector' });
  const store = new IngestStore(db, client);
  const sandbox = 'bench-sandbox';
  await db.collection<RepositoryDoc>('repositories').updateOne(
    { repo_id: sandbox },
    { $setOnInsert: { repo_id: sandbox, org_id: 'o_bench', full_name: 'bench/sandbox', description: 'Synthetic benchmark writes', visibility: 'public', default_branch: 'main', acl_epoch: 1, created_at: new Date(), updated_at: new Date() } },
    { upsert: true },
  );
  const base = Date.now();
  let timedOut = false;
  for (let i = 0; i < INDEX_SAMPLES && !timedOut; i++) {
    const number = base % 1_000_000 + i;
    const t = performance.now();
    await store.upsertIssue({ repo_id: sandbox, number, title: `Benchmark write ${i}`, body: `Indexing delay probe ${base}-${i}.`, state: 'open', labels: ['bench'], author_id: 'u_ops', created_at: new Date(), closed_at: null, source_updated_at: new Date() });
    for (;;) {
      const c = Number((await os.count({ index: 'ri-chunks', body: { query: { term: { source_id: `issue:${number}` } } } })).body.count);
      if (c > 0 && (await os.count({ index: 'ri-chunks', body: { query: { bool: { filter: [{ term: { repo_id: sandbox } }, { term: { source_id: `issue:${number}` } }] } } } })).body.count) {
        delays.push(performance.now() - t);
        break;
      }
      if (performance.now() - t > 30_000) {
        timedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  indexing = timedOut && !delays.length
    ? { measured: false, reason: 'No projection within 30 s: start the worker (npm run worker) to measure indexing delay.', worker_last_seen: state?.last_processed_at ?? null }
    : { measured: true, samples: delays.length, note: 'Includes the 1 s OpenSearch refresh interval and 50 ms polling granularity.', p50_ms: percentile(delays, 50), p95_ms: percentile(delays, 95), max_ms: percentile(delays, 100) };

  const result = {
    kind: 'benchmark',
    run_at: new Date().toISOString(),
    methodology: `Sequential in-process calls (no HTTP layer), ${ITER} search requests cycling ${spec.queries.length} evaluation queries after 20 warm-up requests; answers cycle 2 security questions. Indexing delay = canonical MongoDB write until the chunk is countable in OpenSearch via the running worker. Single client, no concurrency: these are latency measurements, not throughput or capacity results.`,
    environment: env,
    search_latency_ms: { samples: totals.length, p50: percentile(totals, 50), p95: percentile(totals, 95), p99: percentile(totals, 99), stages_p50: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, percentile(v, 50)])) },
    answer_latency_ms: { samples: answerTimes.length, p50: percentile(answerTimes, 50), p95: percentile(answerTimes, 95), p99: percentile(answerTimes, 99) },
    indexing_delay: indexing,
  };
  const file = writeResult('bench', result);
  console.log(JSON.stringify({ search: result.search_latency_ms, answer: result.answer_latency_ms, indexing: result.indexing_delay }, null, 2));
  console.log(`Saved ${file}`);
} finally {
  await client.close();
}
