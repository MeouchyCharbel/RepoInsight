import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { AclService } from '../src/acl/service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectMongo, ensureIndexes } from '../src/db.js';
import { seedDemo } from '../src/seed/demo.js';
import { searchClient } from '../src/search/client.js';
import type { Client } from '@opensearch-project/opensearch';

export const config = loadConfig();
export const TEST_DB = `${config.MONGO_DB}_test`;
// Random per run; never a real credential.
export const PASSWORD = `test-${Math.random().toString(36).slice(2)}-pw`;

export interface Ctx {
  client: MongoClient;
  db: Db;
  app: FastifyInstance;
}

/** Fresh test database (collections dropped), indexes, synthetic seed and an app instance. */
export async function setup(overrides: { rateLimit?: { global: number; login: number }; acl?: (db: Db, c: MongoClient) => AclService; searchAlias?: string } = {}): Promise<Ctx> {
  const client = await connectMongo(config.MONGO_URL);
  const db = client.db(TEST_DB);
  for (const c of await db.collections()) await c.drop();
  await ensureIndexes(db);
  await seedDemo(db, PASSWORD);
  const app = await buildApp({
    db,
    client,
    rateLimit: overrides.rateLimit ?? { global: 10_000, login: 10_000 },
    acl: overrides.acl?.(db, client),
    search: overrides.searchAlias ? { client: testSearch(), alias: overrides.searchAlias } : undefined,
    queryLog: { salt: config.QUERY_LOG_SALT, rawText: false },
  });
  return { client, db, app };
}

export async function teardown(ctx: Ctx) {
  await ctx.app.close();
  await ctx.client.close();
}

/** Logs in and returns the Cookie header value. */
export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login ${username} failed: ${res.statusCode}`);
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0]! : raw!;
  return header.split(';')[0]!;
}

/** OpenSearch client with the least-privilege application user (indices ri-* only). */
export function testSearch(): Client {
  return searchClient({ url: config.OPENSEARCH_URL, username: config.OPENSEARCH_APP_USER, password: config.OPENSEARCH_APP_PASSWORD, dataDir: config.DATA_DIR });
}
