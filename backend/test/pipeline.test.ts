import type { Client } from '@opensearch-project/opensearch';
import type { Admin, Consumer, Kafka, Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestStore } from '../src/ingest/store.js';
import { ChunkIndex } from '../src/search/index.js';
import { DEMO } from '../src/seed/demo.js';
import { runConsumer } from '../src/stream/consumer.js';
import { createProducer, kafkaClient } from '../src/stream/kafka.js';
import { SearchProjector } from '../src/stream/projectors/search.js';
import { OutboxRelay } from '../src/stream/relay.js';
import { type Ctx, config, setup, teardown, testSearch } from './helpers.js';

/** End-to-end through the real broker: MongoDB outbox -> Kafka -> consumer -> OpenSearch. */
describe('streaming pipeline (real Kafka)', () => {
  const run = Date.now().toString(36);
  const topics = { changes: `ri-test-changes-${run}`, permissions: `ri-test-perms-${run}`, dlq: `ri-test-dlq-${run}` };
  const alias = `ri-test-pipe-${run}`;
  let ctx: Ctx;
  let kafka: Kafka;
  let admin: Admin;
  let producer: Producer;
  let consumer: Consumer;
  let os: Client;
  let relay: OutboxRelay;

  beforeAll(async () => {
    ctx = await setup();
    kafka = kafkaClient(config, `ri-test-${run}`);
    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: Object.values(topics).map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })), waitForLeaders: true });
    producer = createProducer(kafka);
    await producer.connect();
    os = testSearch();
    const index = new ChunkIndex(os, ctx.db, alias);
    await index.ensure();
    const projector = new SearchProjector(index);
    consumer = await runConsumer(kafka, ctx.db, producer, { groupId: `ri-test-group-${run}`, topics: [topics.changes, topics.permissions], handler: (ev) => projector.handle(ev), dlqTopic: topics.dlq });
    relay = new OutboxRelay(ctx.db, producer, { topicMap: { 'ri.changes': topics.changes, 'ri.permissions': topics.permissions } });
    // Earlier seed rows are published too (to the test topics) - harmless and idempotent.
    while ((await relay.runOnce()) > 0);
  }, 90_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await producer?.disconnect();
    await admin?.deleteTopics({ topics: Object.values(topics) }).catch(() => {});
    await admin?.disconnect();
    await os?.indices.delete({ index: `${alias}-*` }).catch(() => {});
    await teardown(ctx);
  });

  it('indexes a newly written issue via the outbox and Kafka', async () => {
    const store = new IngestStore(ctx.db, ctx.client);
    const written = Date.now();
    await store.upsertIssue({ repo_id: DEMO.publicRepo, number: 950, title: 'Pipeline issue', body: 'Indexed through Kafka.', state: 'open', labels: ['ops'], author_id: 'u_bob', created_at: new Date(), closed_at: null, source_updated_at: new Date() });
    expect(await relay.runOnce()).toBe(1);

    let found = 0;
    for (let i = 0; i < 60 && !found; i++) {
      await os.indices.refresh({ index: alias });
      found = Number((await os.count({ index: alias, body: { query: { term: { source_id: 'issue:950' } } } })).body.count);
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }
    expect(found).toBe(1);
    // Observed end-to-end delay for this single event on this machine (not a benchmark).
    console.log(`[pipeline] write -> searchable: ${Date.now() - written} ms`);
    const state = await ctx.db.collection('projection_state').findOne({ consumer: `ri-test-group-${run}` });
    expect(state?.last_event_id).toBeTruthy();
  }, 30_000);

  it('routes a poison message to the dead-letter topic without blocking the partition', async () => {
    await producer.send({ topic: topics.changes, messages: [{ key: 'poison', value: '{not json' }] });
    const dlqConsumer = kafka.consumer({ groupId: `ri-test-dlq-reader-${run}` });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: topics.dlq, fromBeginning: true });
    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no DLQ message')), 20_000);
      void dlqConsumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timer);
          resolve(Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])));
        },
      });
    });
    await dlqConsumer.disconnect();
    expect(headers).toMatchObject({ error: 'unparseable event', original_topic: topics.changes });
  }, 30_000);
});
