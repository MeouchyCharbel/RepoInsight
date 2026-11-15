import type { Db, MongoClient } from 'mongodb';
import type { CommentDoc, IssueDoc } from '../../types.js';
import type { StreamEvent } from '../kafka.js';

export const ACTIVITY_CONSUMER = 'ri-activity-projector';
const LATE_WINDOW_MS = 48 * 3600 * 1000;
const ALL = '*';

type Counter = 'opened' | 'closed' | 'reopened' | 'comments';
const COUNTERS: Record<string, Counter> = {
  'issue.opened': 'opened',
  'issue.closed': 'closed',
  'issue.reopened': 'reopened',
  'comment.added': 'comments',
};

/**
 * Issue-activity dashboard projection (report 10.1): daily counters per (repo_id, day, label).
 * The processed-event marker and the counter increments commit in one MongoDB transaction, so a
 * replay cannot double-count. Events older than 48 h mark the bucket dirty; recomputeDay()
 * rebuilds it from canonical records.
 */
export class ActivityProjector {
  constructor(
    private db: Db,
    private client: MongoClient,
    private now: () => number = Date.now,
  ) {}

  async handle(ev: StreamEvent): Promise<'counted' | 'duplicate' | 'ignored'> {
    const counter = COUNTERS[ev.type];
    const p = ev.payload as Record<string, unknown> & { repo_id: string; occurred_at?: string };
    if (!counter || !p.occurred_at) return 'ignored';
    if (ev.type === 'comment.added' && !String(p.thread_key).startsWith('issue:')) return 'ignored';

    let labels = (p.labels as string[] | undefined) ?? null;
    if (!labels) {
      const n = Number(String(p.thread_key).split(':')[1]);
      labels = (await this.db.collection<IssueDoc>('issues').findOne({ repo_id: p.repo_id, number: n }))?.labels ?? [];
    }
    const day = p.occurred_at.slice(0, 10);
    const late = this.now() - Date.parse(p.occurred_at) > LATE_WINDOW_MS;

    const s = this.client.startSession();
    try {
      await s.withTransaction(async () => {
        await this.db.collection('processed_events').insertOne({ consumer: ACTIVITY_CONSUMER, event_id: ev.event_id, at: new Date() }, { session: s });
        for (const label of [ALL, ...labels!]) {
          await this.db.collection('issue_activity_daily').updateOne(
            { repo_id: p.repo_id, day, label },
            { $inc: { [counter]: 1 }, $set: { updated_at: new Date(), ...(late ? { dirty: true } : {}) } },
            { upsert: true, session: s },
          );
        }
      }, { writeConcern: { w: 'majority' } });
      return 'counted';
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return 'duplicate';
      throw e;
    } finally {
      await s.endSession();
    }
  }

  /** Recomputes one day's buckets from canonical issues and comments (nightly repair job). */
  async recomputeDay(repoId: string, day: string): Promise<void> {
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const issues = await this.db.collection<IssueDoc>('issues').find({ repo_id: repoId }).toArray();
    const labelsOf = new Map(issues.map((i) => [i.number, i.labels]));
    const buckets = new Map<string, Record<Counter, number>>();
    const add = (labels: string[], c: Counter) => {
      for (const l of [ALL, ...labels]) {
        const b = buckets.get(l) ?? { opened: 0, closed: 0, reopened: 0, comments: 0 };
        b[c]++;
        buckets.set(l, b);
      }
    };
    for (const i of issues) {
      if (i.created_at >= start && i.created_at < end) add(i.labels, 'opened');
      if (i.closed_at && i.closed_at >= start && i.closed_at < end) add(i.labels, 'closed');
    }
    const comments = await this.db.collection<CommentDoc>('comments').find({ repo_id: repoId, thread_key: /^issue:/, created_at: { $gte: start, $lt: end } }).toArray();
    for (const c of comments) add(labelsOf.get(Number(c.thread_key.split(':')[1])) ?? [], 'comments');

    await this.db.collection('issue_activity_daily').deleteMany({ repo_id: repoId, day });
    if (buckets.size) {
      await this.db.collection('issue_activity_daily').insertMany(
        [...buckets].map(([label, b]) => ({ repo_id: repoId, day, label, ...b, dirty: false, recomputed_at: new Date(), updated_at: new Date() })),
      );
    }
  }
}
