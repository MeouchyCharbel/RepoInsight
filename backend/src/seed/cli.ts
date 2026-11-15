import { loadConfig } from '../config.js';
import { connectMongo, ensureIndexes } from '../db.js';
import { seedDemo } from './demo.js';

const config = loadConfig();
if (!config.DEMO_USER_PASSWORD) throw new Error('Set DEMO_USER_PASSWORD in .env (npm run env:init generates one).');
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  await seedDemo(db, config.DEMO_USER_PASSWORD);
  console.log(`Seeded synthetic demo data into "${config.MONGO_DB}". Users: alice, bob, carol, ops.`);
} finally {
  await client.close();
}
