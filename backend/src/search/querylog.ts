import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';

export interface QueryLogEntry {
  endpoint: 'search' | 'answer' | 'compare';
  principalId: string;
  repoIds: string[];
  tenantId: string;
  query: string;
  filters: Record<string, unknown>;
  aclEpochs: Record<string, number>;
  effectiveRelease?: string | null;
  indexAlias: string;
  latencyMs: Record<string, number>;
  resultCount: number;
  dropped: { unauthorized: number; stale: number };
  citations?: { checked: number; valid: number };
  failure?: string | null;
}

/**
 * Query logging (report Section 12). Users are pseudonymised with an HMAC; raw query text is not
 * stored unless explicitly enabled (only a hash, for grouping). Raw logs expire after 30 days
 * (TTL index); aggregates are computed on read.
 */
export class QueryLog {
  constructor(
    private db: Db,
    private opts: { salt: string; rawText: boolean },
  ) {}

  pseudonym(principalId: string) {
    return createHmac('sha256', this.opts.salt).update(principalId).digest('hex').slice(0, 24);
  }

  async write(e: QueryLogEntry): Promise<string> {
    const queryId = randomUUID();
    const now = new Date();
    const watermark = await this.db.collection('projection_state').findOne({ consumer: 'ri-search-projector' });
    const normalized = e.query.trim().toLowerCase().replace(/\s+/g, ' ');
    await this.db.collection('query_logs').insertOne({
      query_id: queryId,
      tenant_id: e.tenantId,
      day: now.toISOString().slice(0, 10),
      created_at: now,
      endpoint: e.endpoint,
      principal: this.pseudonym(e.principalId),
      repo_ids: e.repoIds,
      filters: e.filters,
      query_hash: createHash('sha256').update(normalized).digest('hex').slice(0, 32),
      query_text: this.opts.rawText ? e.query : null,
      acl_epochs: e.aclEpochs,
      effective_release: e.effectiveRelease ?? null,
      retrieval_version: e.indexAlias,
      index_watermark: watermark?.last_processed_at ?? null,
      latency_ms: e.latencyMs,
      result_count: e.resultCount,
      dropped: e.dropped,
      citations: e.citations ?? null,
      failure: e.failure ?? null,
    });
    return queryId;
  }

  /** Daily aggregates for the analytics endpoint. */
  async summary(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.collection('query_logs').find({ created_at: { $gte: since } }, { projection: { day: 1, endpoint: 1, latency_ms: 1, result_count: 1, dropped: 1, citations: 1, failure: 1 } }).limit(20_000).toArray();
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(`${r.day}|${r.endpoint}`, [...(groups.get(`${r.day}|${r.endpoint}`) ?? []), r]);
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : null;
    };
    return [...groups].map(([key, rs]) => {
      const [day, endpoint] = key.split('|');
      const lat = rs.map((r) => Number(r.latency_ms?.total ?? 0));
      const checked = rs.reduce((n, r) => n + (r.citations?.checked ?? 0), 0);
      return {
        day,
        endpoint,
        queries: rs.length,
        zero_result_rate: rs.filter((r) => r.result_count === 0).length / rs.length,
        dropped_unauthorized: rs.reduce((n, r) => n + (r.dropped?.unauthorized ?? 0), 0),
        dropped_stale: rs.reduce((n, r) => n + (r.dropped?.stale ?? 0), 0),
        citation_valid_rate: checked ? rs.reduce((n, r) => n + (r.citations?.valid ?? 0), 0) / checked : null,
        failures: rs.filter((r) => r.failure).length,
        latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) },
      };
    }).sort((a, b) => String(b.day).localeCompare(String(a.day)));
  }
}
