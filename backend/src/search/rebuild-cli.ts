// Rebuilds the OpenSearch projection from MongoDB into a new versioned index and swaps the alias.
// Usage: npm run search:rebuild
import { loadConfig } from '../config.js';
import { connectMongo } from '../db.js';
import { searchClient } from './client.js';
import { ChunkIndex } from './index.js';

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const os = searchClient({ url: config.OPENSEARCH_URL, username: config.OPENSEARCH_APP_USER, password: config.OPENSEARCH_APP_PASSWORD, dataDir: config.DATA_DIR });
  const t0 = Date.now();
  const r = await new ChunkIndex(os, client.db(config.MONGO_DB), 'ri-chunks').rebuild();
  console.log(`Rebuilt ${r.count} documents into ${r.to} (previous: ${r.from ?? 'none'}, kept for rollback) in ${Date.now() - t0} ms.`);
} finally {
  await client.close();
}
