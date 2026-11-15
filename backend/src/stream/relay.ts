import type { Db, ObjectId } from 'mongodb';
import type { OutboxDoc } from '../types.js';
import type { StreamEvent } from './kafka.js';

export interface BatchSender {
  sendBatch(batch: { topicMessages: { topic: string; messages: { key: string; value: string }[] }[]; acks: number }): Promise<unknown>;
}

/**
 * Transactional-outbox relay (report 6.4): publishes committed outbox rows to Kafka in creation
 * order and marks them published only after the broker acknowledged them (acks=all). A crash
 * between send and mark republishes the rows: delivery is at-least-once and consumers are
 * idempotent. While Kafka is down, canonical writes continue and the outbox simply grows.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(
    private db: Db,
    private producer: BatchSender,
    private opts: { batchSize?: number; topicMap?: Record<string, string> } = {},
  ) {}

  async runOnce(): Promise<number> {
    const outbox = this.db.collection<OutboxDoc & { _id: ObjectId }>('outbox');
    const rows = await outbox.find({ published_at: null }).sort({ created_at: 1, _id: 1 }).limit(this.opts.batchSize ?? 200).toArray();
    if (!rows.length) return 0;

    // Rows of one topic keep their order; one entity always maps to one partition via its key.
    const byTopic = new Map<string, { key: string; value: string }[]>();
    for (const r of rows) {
      const topic = this.opts.topicMap?.[r.topic] ?? r.topic;
      const ev: StreamEvent = { event_id: r.event_id, type: r.type, key: r.key, payload: r.payload as StreamEvent['payload'], created_at: r.created_at.toISOString() };
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic)!.push({ key: r.key, value: JSON.stringify(ev) });
    }
    const ids = rows.map((r) => r._id);
    try {
      await this.producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })), acks: -1 });
    } catch (e) {
      await outbox.updateMany({ _id: { $in: ids } }, { $inc: { attempts: 1 }, $set: { last_error: 'publish failed' } });
      throw e;
    }
    await outbox.updateMany({ _id: { $in: ids } }, { $set: { published_at: new Date() } });
    return rows.length;
  }

  /** Polls continuously; on failure backs off exponentially (max 30 s). */
  start(intervalMs = 300, onError?: (e: unknown) => void) {
    const tick = async () => {
      let delay = intervalMs;
      try {
        while ((await this.runOnce()) > 0);
        this.failures = 0;
      } catch (e) {
        this.failures++;
        delay = Math.min(30_000, intervalMs * 2 ** this.failures);
        onError?.(e);
      }
      if (this.timer !== null) this.timer = setTimeout(tick, delay);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
