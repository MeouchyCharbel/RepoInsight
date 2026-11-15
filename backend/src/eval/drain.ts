// Measures how long the running worker takes to project an event backlog (outbox -> Kafka ->
// search, activity and graph projectors). Start it together with `npm run worker`.
// Usage: npm run bench:drain
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config.js';
import { connectMongo } from '../db.js';
import { environment, services, writeResult } from './common.js';

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  const { os } = services(config, db, client);
  const outbox = db.collection('outbox');
  const backlog = await outbox.countDocuments({ published_at: null });
  const newest = (await outbox.find({}).sort({ created_at: -1 }).limit(1).toArray())[0]?.created_at as Date | undefined;
  const consumers = ['ri-search-projector', 'ri-activity-projector', 'ri-graph-projector'];
  const start = performance.now();
  const reached: Record<string, number | null> = { relay: null, ...Object.fromEntries(consumers.map((c) => [c, null])) };
  const samples: { t_s: number; unpublished: number; index_docs: number }[] = [];

  for (;;) {
    const t = (performance.now() - start) / 1000;
    const unpublished = await outbox.countDocuments({ published_at: null });
    if (reached.relay === null && unpublished === 0) reached.relay = t;
    for (const c of consumers) {
      const s = await db.collection('projection_state').findOne({ consumer: c });
      if (reached[c] === null && newest && s && s.last_event_created_at >= newest) reached[c] = t;
    }
    const indexDocs = Number((await os.count({ index: 'ri-chunks' })).body.count);
    if (samples.length === 0 || t - samples.at(-1)!.t_s >= 10) samples.push({ t_s: Math.round(t), unpublished, index_docs: indexDocs });
    if (Object.values(reached).every((v) => v !== null) || t > 1800) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const env = await environment(db, os);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  const result = {
    kind: 'projection-drain',
    run_at: new Date().toISOString(),
    methodology: 'Backlog of unpublished outbox events, worker started at t=0 with one consumer per group (6 partitions on ri.changes). Completion = consumer has processed an event created at or after the newest outbox row. 1 s polling. Graph projector re-classifies the whole repository per event (prototype simplification), which dominates its time.',
    environment: env,
    backlog_events: backlog,
    seconds_to_catch_up: Object.fromEntries(Object.entries(reached).map(([k, v]) => [k, round(v)])),
    events_per_second: Object.fromEntries(Object.entries(reached).map(([k, v]) => [k, v ? Math.round(backlog / v) : null])),
    index_matches_mongodb: env.dataset.index_documents === env.dataset.chunks,
    samples,
  };
  console.log(JSON.stringify({ backlog, seconds: result.seconds_to_catch_up, eps: result.events_per_second, index_matches_mongodb: result.index_matches_mongodb }, null, 2));
  console.log(`Saved ${writeResult('drain', result)}`);
} finally {
  await client.close();
}
