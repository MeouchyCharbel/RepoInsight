import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, MongoClient } from 'mongodb';
import { AclService } from '../acl/service.js';
import type { Config } from '../config.js';
import { searchClient } from '../search/client.js';
import { QueryLog } from '../search/querylog.js';
import { SearchService } from '../search/service.js';
import type { Principal, UserDoc } from '../types.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function services(config: Config, db: Db, client: MongoClient) {
  const os = searchClient({ url: config.OPENSEARCH_URL, username: config.OPENSEARCH_APP_USER, password: config.OPENSEARCH_APP_PASSWORD, dataDir: config.DATA_DIR });
  const acl = new AclService(db, client);
  const log = new QueryLog(db, { salt: config.QUERY_LOG_SALT, rawText: false });
  return { os, acl, search: new SearchService(db, os, 'ri-chunks', acl, log) };
}

export async function principal(db: Db, username: string): Promise<Principal> {
  const u = await db.collection<UserDoc>('users').findOne({ username });
  if (!u) throw new Error(`User ${username} not found (run npm run seed)`);
  return { userId: u.user_id, username: u.username, isPlatformAdmin: u.is_platform_admin };
}

/** Test environment and dataset size, recorded with every result file. */
export async function environment(db: Db, os: ReturnType<typeof services>['os']) {
  const docker = (() => {
    try {
      return execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const count = (c: string) => db.collection(c).countDocuments();
  return {
    machine: { cpu: cpus()[0]?.model ?? 'unknown', logical_cores: cpus().length, memory_gb: Math.round(totalmem() / 1e9), os: `${platform()} ${release()}` },
    software: { node: process.version, docker_engine: docker, mongodb: '8.0.12', opensearch: '2.19.2', kafka: '3.9.1 (KRaft)' },
    topology: 'single-node MongoDB replica set, single OpenSearch node, single Kafka broker (Docker Desktop, WSL 2)',
    dataset: {
      repositories: await count('repositories'), issues: await count('issues'), pull_requests: await count('pull_requests'),
      comments: await count('comments'), document_revisions: await count('document_revisions'), chunks: await count('chunks'),
      commits: await count('commits'), outbox_events: await count('outbox'),
      unpublished_events: await db.collection('outbox').countDocuments({ published_at: null }),
      index_documents: Number((await os.count({ index: 'ri-chunks' })).body.count),
    },
  };
}

export function writeResult(kind: string, data: object): string {
  const dir = join(ROOT, 'bench', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! * 10) / 10 : null;
};
