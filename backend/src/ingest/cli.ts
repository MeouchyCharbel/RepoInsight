// Usage: npm run import -- owner/name   (public repositories only; set GITHUB_TOKEN for higher limits)
import { loadConfig } from '../config.js';
import { connectMongo, ensureIndexes } from '../db.js';
import { GitHubClient } from './github.js';
import { Importer } from './importer.js';
import { IngestStore } from './store.js';

const repo = process.argv[2];
if (!repo) throw new Error('Usage: npm run import -- owner/name');
const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  const gh = new GitHubClient({ token: config.GITHUB_TOKEN });
  const importer = new Importer(db, new IngestStore(db, client), { dataDir: config.DATA_DIR, github: gh });
  const job = await importer.run(await importer.createJob(repo));
  console.log(`${job.kind} import of ${repo}: ${job.status} (repo_id ${job.repo_id})`);
  for (const [name, s] of Object.entries(job.steps)) {
    console.log(`  ${name.padEnd(16)} ${s.status.padEnd(9)} processed=${s.processed} applied=${s.applied} dup=${s.duplicate} stale=${s.stale}${s.error ? ` error="${s.error}"` : ''}`);
  }
  console.log(`  GitHub requests=${gh.stats.requests} retries=${gh.stats.retries} rate-limit waits=${gh.stats.rateLimitWaits}`);
  if (job.resume_after) console.log(`  Paused by rate limit; re-run after ${job.resume_after.toISOString()}`);
} finally {
  await client.close();
}
