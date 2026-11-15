import { describe, expect, it } from 'vitest';
import { processWithRetry, type RawMessage, TransientError } from '../src/stream/consumer.js';
import { OutboxRelay } from '../src/stream/relay.js';
import { type Ctx, setup, teardown } from './helpers.js';
import { afterAll, beforeAll } from 'vitest';

const ev = { event_id: 'e1', type: 'issue.opened', key: 'r:issue:1', payload: { repo_id: 'r' }, created_at: new Date().toISOString() };
const msg = (value: string | null): RawMessage => ({ topic: 't', partition: 0, offset: '42', key: Buffer.from('r:issue:1'), value: value === null ? null : Buffer.from(value) });

function dlqMock() {
  const sent: { headers: Record<string, string>; value: string | null }[] = [];
  return { sent, dlq: { send: async (r: { messages: { headers: Record<string, string>; value: string | null }[] }) => void sent.push(...r.messages) } };
}
const opts = (dlq: ReturnType<typeof dlqMock>['dlq']) => ({ consumer: 'test', dlqTopic: 'dlq', dlq, sleep: async () => {} });

describe('consumer retries and dead-letter queue', () => {
  it('retries a failing handler and succeeds', async () => {
    let calls = 0;
    const { sent, dlq } = dlqMock();
    const r = await processWithRetry(async () => { if (++calls < 2) throw new Error('flaky'); }, msg(JSON.stringify(ev)), opts(dlq));
    expect(r).toBe('ok');
    expect(calls).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it('dead-letters after bounded attempts with diagnostics', async () => {
    let calls = 0;
    const { sent, dlq } = dlqMock();
    const r = await processWithRetry(async () => { calls++; throw new Error('mapping rejected'); }, msg(JSON.stringify(ev)), opts(dlq));
    expect(r).toBe('dead-lettered');
    expect(calls).toBe(3);
    expect(sent[0]!.headers).toMatchObject({ error: 'mapping rejected', consumer: 'test', original_topic: 't', original_offset: '42' });
  });

  it('dead-letters a poison message without calling the handler', async () => {
    let calls = 0;
    const { sent, dlq } = dlqMock();
    for (const bad of ['not json', '{"type":"x"}', null]) {
      expect(await processWithRetry(async () => void calls++, msg(bad), opts(dlq))).toBe('dead-lettered');
    }
    expect(calls).toBe(0);
    expect(sent.map((s) => s.headers.error)).toEqual(['unparseable event', 'unparseable event', 'unparseable event']);
  });

  it('never dead-letters transient infrastructure errors (redelivered instead)', async () => {
    const { sent, dlq } = dlqMock();
    await expect(processWithRetry(async () => { throw new TransientError('search unavailable'); }, msg(JSON.stringify(ev)), opts(dlq))).rejects.toBeInstanceOf(TransientError);
    expect(sent).toHaveLength(0);
  });
});

describe('outbox relay', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  afterAll(async () => teardown(ctx));

  it('keeps events when Kafka is unavailable and publishes them in order later', async () => {
    const outbox = ctx.db.collection('outbox');
    const base = Date.now();
    await outbox.insertMany([1, 2, 3].map((i) => ({ event_id: `relay-${i}`, topic: 'ri.changes', key: 'k', type: 't', payload: { repo_id: 'r', i }, created_at: new Date(base + i), published_at: null, attempts: 0 })));
    let down = true;
    const sent: string[] = [];
    const relay = new OutboxRelay(ctx.db, {
      sendBatch: async (b) => {
        if (down) throw new Error('broker unavailable');
        for (const t of b.topicMessages) for (const m of t.messages) sent.push(JSON.parse(m.value).event_id);
      },
    });
    await expect(relay.runOnce()).rejects.toThrow();
    expect(await outbox.countDocuments({ published_at: null, attempts: 1 })).toBe(3);

    down = false;
    expect(await relay.runOnce()).toBe(3);
    expect(sent).toEqual(['relay-1', 'relay-2', 'relay-3']);
    expect(await outbox.countDocuments({ published_at: null })).toBe(0);
    expect(await relay.runOnce()).toBe(0);
  });
});
