import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectMongo, ensureIndexes } from './db.js';
import { GitHubClient } from './ingest/github.js';
import { searchClient } from './search/client.js';

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
const db = client.db(config.MONGO_DB);
await ensureIndexes(db);

const app = await buildApp({
  db,
  client,
  cookieSecure: config.COOKIE_SECURE,
  logger: true,
  dataDir: config.DATA_DIR,
  github: new GitHubClient({ token: config.GITHUB_TOKEN }),
  search: { client: searchClient({ url: config.OPENSEARCH_URL, username: config.OPENSEARCH_APP_USER, password: config.OPENSEARCH_APP_PASSWORD, dataDir: config.DATA_DIR }), alias: 'ri-chunks' },
  queryLog: { salt: config.QUERY_LOG_SALT, rawText: config.QUERY_LOG_RAW_TEXT },
});
// Loopback only; the frontend dev server proxies /api to this port.
await app.listen({ host: '127.0.0.1', port: config.API_PORT });

const shutdown = async () => {
  await app.close();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
