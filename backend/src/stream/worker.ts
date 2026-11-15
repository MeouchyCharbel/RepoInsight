// Background worker: outbox relay -> Kafka -> projectors (search, activity), plus inbox repair.
// Usage: npm run worker
import { loadConfig } from '../config.js';
import { connectMongo, ensureIndexes } from '../db.js';
import { IngestStore } from '../ingest/store.js';
import { Inbox } from '../ingest/inbox.js';
import { AclService } from '../acl/service.js';
import { searchClient } from '../search/client.js';
import { ChunkIndex } from '../search/index.js';
import { runConsumer } from './consumer.js';
import { createProducer, kafkaClient, TOPICS } from './kafka.js';
import { ActivityProjector } from './projectors/activity.js';
import { ACTIVITY_CONSUMER } from './projectors/activity.js';
import { SearchProjector } from './projectors/search.js';
import { OutboxRelay } from './relay.js';

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
const db = client.db(config.MONGO_DB);
await ensureIndexes(db);

const os = searchClient({ url: config.OPENSEARCH_URL, username: config.OPENSEARCH_APP_USER, password: config.OPENSEARCH_APP_PASSWORD, dataDir: config.DATA_DIR });
const index = new ChunkIndex(os, db, 'ri-chunks');
await index.ensure();

const kafka = kafkaClient(config, 'ri-worker');
const producer = createProducer(kafka);
await producer.connect();

const relay = new OutboxRelay(db, producer);
relay.start(300, (e) => console.error('[relay] publish failed; retrying with backoff:', (e as Error).message));

const search = new SearchProjector(index);
const activity = new ActivityProjector(db, client);
const consumers = [
  await runConsumer(kafka, db, producer, { groupId: 'ri-search-projector', topics: [TOPICS.changes, TOPICS.permissions], handler: (ev) => search.handle(ev), dlqTopic: TOPICS.dlq }),
  await runConsumer(kafka, db, producer, { groupId: ACTIVITY_CONSUMER, topics: [TOPICS.changes], handler: (ev) => activity.handle(ev), dlqTopic: TOPICS.dlq }),
];

// Deliveries recorded but never applied (crash between record and apply).
const inbox = new Inbox(db, new IngestStore(db, client), new AclService(db, client));
const repair = setInterval(() => inbox.reprocessPending().catch((e) => console.error('[inbox]', (e as Error).message)), 30_000);

console.log('Worker running: outbox relay, search projector, activity projector.');
const shutdown = async () => {
  clearInterval(repair);
  relay.stop();
  for (const c of consumers) await c.disconnect();
  await producer.disconnect();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
