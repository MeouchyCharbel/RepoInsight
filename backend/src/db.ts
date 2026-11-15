import { MongoClient, type Db, type IndexDescription } from 'mongodb';

export async function connectMongo(url: string): Promise<MongoClient> {
  const client = new MongoClient(url, {
    appName: 'repoinsight-api',
    writeConcern: { w: 'majority' },
    readConcern: { level: 'majority' },
    readPreference: 'primary',
    serverSelectionTimeoutMS: 3000,
  });
  await client.connect();
  return client;
}

/**
 * Collections and indexes from report Sections 7.2 and 8. Every repository-scoped
 * index starts with repo_id (the proposed shard-key prefix). Collections used by
 * later phases are created now so the schema is visible in one place.
 */
export const INDEXES: Record<string, IndexDescription[]> = {
  users: [{ key: { username: 1 }, unique: true }, { key: { user_id: 1 }, unique: true }],
  sessions: [
    { key: { token_hash: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 },
  ],
  repositories: [
    { key: { repo_id: 1 }, unique: true },
    { key: { visibility: 1, full_name: 1 } },
    { key: { provider: 1, provider_id: 1 }, unique: true, partialFilterExpression: { provider_id: { $exists: true } } },
  ],
  contributors: [{ key: { contributor_id: 1 }, unique: true }],
  permissions: [
    { key: { repo_id: 1, principal_id: 1 }, unique: true },
    { key: { principal_id: 1, repo_id: 1 } }, // readable-repository set for a user
  ],
  issues: [
    { key: { repo_id: 1, number: 1 }, unique: true },
    { key: { repo_id: 1, labels: 1, updated_at: -1 } },
    { key: { repo_id: 1, state: 1, updated_at: -1 } },
    { key: { repo_id: 1, updated_at: -1, number: -1 } },
    { key: { repo_id: 1, fixed_in_release: 1, updated_at: -1 } },
  ],
  // Keyed by provider timestamp so a late, older revision is kept as history without a number clash.
  issue_revisions: [{ key: { repo_id: 1, number: 1, source_updated_at: 1 }, unique: true }],
  pull_requests: [
    { key: { repo_id: 1, number: 1 }, unique: true },
    { key: { repo_id: 1, merged_sha: 1 } },
  ],
  comments: [
    { key: { repo_id: 1, thread_key: 1, comment_id: 1 }, unique: true },
    { key: { repo_id: 1, thread_key: 1, created_at: 1 } },
  ],
  commits: [
    { key: { repo_id: 1, sha: 1 }, unique: true },
    { key: { repo_id: 1, changed_paths: 1, committed_at: -1 } },
    { key: { repo_id: 1, patch_id: 1 } },
  ],
  branches: [{ key: { repo_id: 1, name: 1 }, unique: true }],
  releases: [
    { key: { repo_id: 1, release_id: 1 }, unique: true },
    { key: { repo_id: 1, effective: 1 } },
    { key: { repo_id: 1, published_at: -1 } },
  ],
  documents: [{ key: { repo_id: 1, source_id: 1 }, unique: true }], // latest-revision pointer
  document_revisions: [{ key: { repo_id: 1, source_id: 1, revision: -1 }, unique: true }],
  chunks: [
    { key: { repo_id: 1, chunk_id: 1 }, unique: true },
    { key: { repo_id: 1, source_id: 1, revision: 1 } },
    { key: { repo_id: 1, config_keys: 1 } },
    { key: { repo_id: 1, source_id: 1, is_latest: 1 } },
  ],
  blobs: [{ key: { digest: 1 }, unique: true }], // content-addressed text (replaces object storage)
  edges: [
    { key: { repo_id: 1, from: 1, relation: 1, to: 1 }, unique: true },
    { key: { repo_id: 1, to: 1, relation: 1 } },
  ],
  inbox: [{ key: { provider: 1, delivery_id: 1 }, unique: true }, { key: { status: 1, received_at: 1 } }],
  outbox: [{ key: { event_id: 1 }, unique: true }, { key: { published_at: 1, created_at: 1 } }],
  processed_events: [{ key: { consumer: 1, event_id: 1 }, unique: true }],
  import_jobs: [{ key: { job_id: 1 }, unique: true }, { key: { repo_full_name: 1, started_at: -1 } }],
  issue_activity_daily: [{ key: { repo_id: 1, day: 1, label: 1 }, unique: true }],
  query_logs: [
    { key: { tenant_id: 1, day: 1, query_id: 1 } },
    { key: { created_at: 1 }, expireAfterSeconds: 30 * 24 * 3600 }, // raw logs: 30-day TTL
  ],
  audit_log: [{ key: { at: -1 } }, { key: { actor_id: 1, at: -1 } }, { key: { repo_id: 1, at: -1 } }],
};

export async function ensureIndexes(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    await db.collection(name).createIndexes(specs);
  }
}
