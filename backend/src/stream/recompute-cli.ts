// Repairs issue-activity counters from canonical data (dirty buckets, or events without timestamps).
// Usage: npm run activity:recompute            (dirty buckets only)
//        npm run activity:recompute -- --all   (every day with activity)
import { loadConfig } from '../config.js';
import { connectMongo } from '../db.js';
import type { CommentDoc, IssueDoc } from '../types.js';
import { ActivityProjector } from './projectors/activity.js';

const config = loadConfig();
const client = await connectMongo(config.MONGO_URL);
try {
  const db = client.db(config.MONGO_DB);
  const projector = new ActivityProjector(db, client);
  const days = new Set<string>(); // "repo|day"
  if (process.argv.includes('--all')) {
    const day = (d?: Date | null) => d?.toISOString().slice(0, 10);
    for (const i of await db.collection<IssueDoc>('issues').find({}, { projection: { repo_id: 1, created_at: 1, closed_at: 1 } }).toArray()) {
      for (const d of [day(i.created_at), day(i.closed_at)]) if (d) days.add(`${i.repo_id}|${d}`);
    }
    for (const c of await db.collection<CommentDoc>('comments').find({ thread_key: /^issue:/ }, { projection: { repo_id: 1, created_at: 1 } }).toArray()) {
      days.add(`${c.repo_id}|${day(c.created_at)}`);
    }
  } else {
    for (const b of await db.collection('issue_activity_daily').find({ dirty: true }).toArray()) days.add(`${b.repo_id}|${b.day}`);
  }
  for (const key of days) {
    const [repo, d] = key.split('|') as [string, string];
    await projector.recomputeDay(repo, d);
  }
  console.log(`Recomputed ${days.size} repository-day bucket set(s) from canonical data.`);
} finally {
  await client.close();
}
