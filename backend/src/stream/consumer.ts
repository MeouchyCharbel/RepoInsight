import type { Consumer, Kafka, Producer } from 'kafkajs';
import type { Db } from 'mongodb';
import type { StreamEvent } from './kafka.js';

export type Handler = (ev: StreamEvent) => Promise<unknown>;

export interface RawMessage {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
}

/** Infrastructure errors: never dead-letter; let Kafka redeliver once the dependency is back. */
export class TransientError extends Error {}

export interface DlqSender {
  send(record: { topic: string; messages: { key: string | null; value: string | null; headers: Record<string, string> }[] }): Promise<unknown>;
}

export interface RetryOptions {
  consumer: string;
  dlqTopic: string;
  dlq: DlqSender;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Processes one message with bounded retries. Unparseable (poison) messages and handler errors
 * that persist after `attempts` go to the dead-letter topic with diagnostics, so one bad event
 * cannot block its partition. TransientError is re-thrown: the offset is not committed and the
 * message is redelivered later (no loss while OpenSearch or MongoDB is unavailable).
 */
export async function processWithRetry(handler: Handler, msg: RawMessage, opts: RetryOptions): Promise<'ok' | 'dead-lettered'> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadLetter = (error: string) =>
    opts.dlq.send({
      topic: opts.dlqTopic,
      messages: [{
        key: msg.key?.toString() ?? null,
        value: msg.value?.toString() ?? null,
        headers: { error: error.slice(0, 300), consumer: opts.consumer, original_topic: msg.topic, original_partition: String(msg.partition), original_offset: msg.offset },
      }],
    });

  let ev: StreamEvent;
  try {
    ev = JSON.parse(msg.value?.toString() ?? '');
    if (!ev || typeof ev.event_id !== 'string' || typeof ev.type !== 'string' || typeof ev.payload?.repo_id !== 'string') throw new Error('invalid event shape');
  } catch {
    await deadLetter('unparseable event');
    return 'dead-lettered';
  }

  const attempts = opts.attempts ?? 3;
  for (let a = 1; ; a++) {
    try {
      await handler(ev);
      return 'ok';
    } catch (e) {
      if (e instanceof TransientError) throw e;
      if (a >= attempts) {
        await deadLetter(e instanceof Error ? e.message : 'handler failed');
        return 'dead-lettered';
      }
      await sleep((opts.baseDelayMs ?? 200) * 2 ** (a - 1));
    }
  }
}

/** Records how far a consumer has got, for dashboard watermarks and lag reporting. */
export async function recordWatermark(db: Db, consumer: string, ev: StreamEvent) {
  await db.collection('projection_state').updateOne(
    { consumer },
    {
      $set: { last_event_id: ev.event_id, last_event_created_at: new Date(ev.created_at), last_processed_at: new Date() },
      $inc: { processed: 1 },
    },
    { upsert: true },
  );
}

/**
 * Consumer group runner. Offsets are committed by KafkaJS only after eachMessage resolves, i.e.
 * after the idempotent projection write (at-least-once; no exactly-once claim).
 */
export async function runConsumer(
  kafka: Kafka,
  db: Db,
  dlqProducer: Producer,
  opts: { groupId: string; topics: string[]; handler: Handler; dlqTopic: string; fromBeginning?: boolean },
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: opts.groupId, retry: { retries: 8, initialRetryTime: 500 } });
  await consumer.connect();
  await consumer.subscribe({ topics: opts.topics, fromBeginning: opts.fromBeginning ?? true });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const handler: Handler = async (ev) => {
        await opts.handler(ev);
        await recordWatermark(db, opts.groupId, ev);
      };
      await processWithRetry(handler, { topic, partition, offset: message.offset, key: message.key, value: message.value }, { consumer: opts.groupId, dlqTopic: opts.dlqTopic, dlq: dlqProducer });
    },
  });
  return consumer;
}
