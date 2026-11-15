import { loadConfig } from '../config.js';
import { connectMongo, ensureIndexes } from '../db.js';
import { ingestScenario } from '../fixtures/scenario.js';
import { IngestStore } from '../ingest/store.js';
import { seedDemo } from './demo.js';

const config = loadConfig();
if (!config.DEMO_USER_PASSWORD) throw new Error('Set DEMO_USER_PASSWORD in .env (npm run env:init generates one).');
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  await seedDemo(db, config.DEMO_USER_PASSWORD, { issues: false });
  const m = await ingestScenario(db, new IngestStore(db, client), config.DATA_DIR);
  const counts = await Promise.all(
    ['commits', 'issues', 'pull_requests', 'comments', 'releases', 'document_revisions', 'chunks', 'outbox'].map(async (c) => `${c}=${await db.collection(c).countDocuments()}`),
  );
  console.log(`Seeded synthetic demo data into "${config.MONGO_DB}" (Git scenario at ${m.dir}).`);
  console.log(`  ${counts.join(' ')}`);
  console.log('  Users: alice, bob, carol, ops (password: DEMO_USER_PASSWORD in .env)');
} finally {
  await client.close();
}
