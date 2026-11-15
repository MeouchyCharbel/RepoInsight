import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import type { Config } from '../config.js';

export const TOPICS = { changes: 'ri.changes', permissions: 'ri.permissions', dlq: 'ri.changes.dlq' };

/** SASL/PLAIN on the loopback-only client listener (no TLS: development only). */
export function kafkaClient(cfg: Pick<Config, 'KAFKA_BROKERS' | 'KAFKA_APP_USER' | 'KAFKA_APP_PASSWORD'>, clientId: string) {
  return new Kafka({
    clientId,
    brokers: cfg.KAFKA_BROKERS.split(','),
    sasl: { mechanism: 'plain', username: cfg.KAFKA_APP_USER, password: cfg.KAFKA_APP_PASSWORD },
    ssl: false,
    logLevel: logLevel.ERROR,
    retry: { retries: 5, initialRetryTime: 300 },
  });
}

/** Idempotent producer (acks=all, one in-flight request) so broker retries cannot reorder or duplicate. */
export function createProducer(kafka: Kafka): Producer {
  return kafka.producer({ idempotent: true, maxInFlightRequests: 1, createPartitioner: Partitioners.DefaultPartitioner });
}

export interface StreamEvent {
  event_id: string;
  type: string;
  key: string;
  payload: Record<string, unknown> & { repo_id: string; occurred_at?: string };
  created_at: string;
}
