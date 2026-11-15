import type { Db } from 'mongodb';
import { extractConfigKeys } from '../ingest/chunker.js';
import { CommitGraph } from '../trace/graph.js';
import type { ChunkDoc, CommentDoc, DocumentRevisionDoc, EdgeDoc, IssueDoc, OutboxDoc, PullRequestDoc, ReleaseDoc, Supersession } from '../types.js';
import { isSecurityRelease, resolveEffective } from './release.js';

/**
 * Current-vs-historical guidance (report 9.2). The classification is recomputed from a
 * conservative base and can only downgrade evidence, never upgrade it:
 *  - base: latest document revisions are "current", older ones "historical"; discussions
 *    (issues, PRs, comments) are "unknown" unless superseded;
 *  - explicit: an older revision is superseded by the newer revision (verified);
 *  - security-epoch rule: evidence mentioning a configuration key that a later security release on
 *    the effective line changed is "historical", unless it is part of the effective release's docs;
 *  - config-key match: discussions older than the current docs for the same key are flagged
 *    "possibly outdated" (candidate only).
 */
export class GuidanceService {
  constructor(private db: Db) {}

  async reclassify(repoId: string): Promise<{ changed: string[]; effective: string | null }> {
    const eff = await resolveEffective(this.db, repoId).catch(() => null);
    const graph = new CommitGraph(this.db, repoId);
    const releases = await this.db.collection<ReleaseDoc>('releases').find({ repo_id: repoId }).toArray();

    // Security releases on the effective line, with the configuration keys their notes change.
    const security: { id: string; at: Date; keys: string[] }[] = [];
    for (const r of releases) {
      if (!eff || !r.target_sha || r.channel !== 'stable' || !isSecurityRelease(r.body)) continue;
      if ((await graph.isAncestor(r.target_sha, eff.target_sha)) === 'yes') security.push({ id: r.release_id, at: r.published_at, keys: extractConfigKeys(r.body) });
    }
    security.sort((a, b) => +b.at - +a.at);
    await this.db.collection('releases').updateMany({ repo_id: repoId }, { $set: { effective: false } });
    if (eff) await this.db.collection('releases').updateOne({ repo_id: repoId, release_id: eff.release_id }, { $set: { effective: true, security_epoch: eff.security_epoch } });

    const chunks = await this.db.collection<ChunkDoc>('chunks').find({ repo_id: repoId }).toArray();
    const time = await this.sourceTimes(repoId);
    const sourceTime = (c: ChunkDoc) => time.get(`${c.source_type}|${c.source_id}|${c.revision}`) ?? time.get(`${c.source_type}|${c.source_id}`) ?? c.created_at;

    // Current documentation in the effective release, per configuration key (earliest revision time).
    const currentDocKey = new Map<string, { at: Date; ref: string }>();
    for (const c of chunks) {
      if (c.source_type !== 'doc' || !c.is_latest || !eff || !c.release_ids.includes(eff.release_id)) continue;
      for (const k of c.config_keys) {
        const at = sourceTime(c);
        if (!currentDocKey.has(k) || at < currentDocKey.get(k)!.at) currentDocKey.set(k, { at, ref: `${c.source_id}@rev${c.revision}#${c.section_anchor}` });
      }
    }
    const notesChunk = new Map<string, string>(); // release id -> notes chunk id
    for (const c of chunks) if (c.source_type === 'release_notes') notesChunk.set(c.source_id.slice(8), c.chunk_id);

    const changed = new Set<string>();
    const edges: Omit<EdgeDoc, 'repo_id' | 'created_at' | 'updated_at'>[] = [];
    for (const c of chunks) {
      const isDoc = c.source_type === 'doc' || c.source_type === 'release_notes';
      let status: ChunkDoc['guidance_status'] = c.is_latest ? (isDoc ? 'current' : 'unknown') : 'historical';
      let sup: Supersession | null = c.is_latest ? null : { kind: 'revision', ref: `${c.source_id}@rev${c.superseded_by_revision}`, reason: 'newer_revision', confidence: 'verified' };
      let outdated = false;

      const inEffectiveDocs = !!eff && c.release_ids.includes(eff.release_id);
      if (status !== 'historical' && c.source_type !== 'release_notes' && !inEffectiveDocs) {
        const at = sourceTime(c);
        const s = security.find((r) => at < r.at && r.keys.some((k) => c.config_keys.includes(k)));
        if (s) {
          status = 'historical';
          sup = { kind: 'release', ref: s.id, reason: 'security_epoch', confidence: 'verified' };
        }
      }
      if (status === 'unknown') {
        const at = sourceTime(c);
        const match = c.config_keys.map((k) => currentDocKey.get(k)).find((d) => d && at < d.at);
        if (match) {
          outdated = true;
          sup = { kind: 'revision', ref: match.ref, reason: 'config_key_match', confidence: 'candidate' };
        }
      }

      if (sup) {
        const from = sup.kind === 'release' ? (notesChunk.get(sup.ref) ? `chunk:${notesChunk.get(sup.ref)}` : `release:${sup.ref}`) : `revision:${sup.ref}`;
        edges.push({ from, relation: 'GUIDANCE_SUPERSEDES', to: `chunk:${c.chunk_id}`, provenance: sup.reason, confidence: sup.confidence === 'verified' ? 'verified' : 'unverified', status: 'active' });
      }
      const inEffective = !!eff && (c.release_ids.includes(eff.release_id) && (c.source_type === 'doc' || c.source_type === 'release_notes')) && c.is_latest !== false && status === 'current';
      const same = 'superseded_by' in c && c.guidance_status === status && JSON.stringify(c.superseded_by ?? null) === JSON.stringify(sup) && (c.possibly_outdated ?? false) === outdated && (c.in_effective_release ?? false) === inEffective;
      if (!same) {
        await this.db.collection<ChunkDoc>('chunks').updateOne({ repo_id: repoId, chunk_id: c.chunk_id }, { $set: { guidance_status: status, superseded_by: sup, possibly_outdated: outdated, in_effective_release: inEffective } });
        changed.add(c.source_id);
      }
    }
    await this.writeEdges(repoId, edges);

    if (changed.size) {
      const ids = [...changed].sort();
      const stamp = `${eff?.release_id ?? 'none'}:${Date.now()}`;
      await this.db.collection<OutboxDoc>('outbox').insertOne({
        event_id: `${repoId}:guidance:${stamp}`, topic: 'ri.changes', key: `${repoId}:guidance`, type: 'guidance.updated',
        payload: { repo_id: repoId, source_ids: ids, effective_release: eff?.release_id ?? null, occurred_at: new Date().toISOString() },
        created_at: new Date(), published_at: null, attempts: 0,
      });
    }
    return { changed: [...changed], effective: eff?.release_id ?? null };
  }

  /** Source time of each piece of evidence (when it was written), not ingestion time. */
  private async sourceTimes(repoId: string) {
    const t = new Map<string, Date>();
    for (const i of await this.db.collection<IssueDoc>('issues').find({ repo_id: repoId }, { projection: { number: 1, created_at: 1 } }).toArray()) t.set(`issue|issue:${i.number}`, i.created_at);
    for (const p of await this.db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId }, { projection: { number: 1, created_at: 1 } }).toArray()) t.set(`pr|pr:${p.number}`, p.created_at);
    for (const c of await this.db.collection<CommentDoc>('comments').find({ repo_id: repoId }, { projection: { thread_key: 1, comment_id: 1, created_at: 1 } }).toArray()) t.set(`comment|${c.thread_key}/comment:${c.comment_id}`, c.created_at);
    for (const r of await this.db.collection<DocumentRevisionDoc>('document_revisions').find({ repo_id: repoId }).toArray()) t.set(`${r.kind}|${r.source_id}|${r.revision}`, r.committed_at);
    return t;
  }

  private async writeEdges(repoId: string, next: Omit<EdgeDoc, 'repo_id' | 'created_at' | 'updated_at'>[]) {
    const coll = this.db.collection<EdgeDoc>('edges');
    const now = new Date();
    const keep = next.map((e) => ({ repo_id: repoId, from: e.from, relation: e.relation, to: e.to }));
    for (const e of next) await coll.updateOne({ repo_id: repoId, from: e.from, relation: e.relation, to: e.to }, { $set: { ...e, repo_id: repoId, updated_at: now }, $setOnInsert: { created_at: now } }, { upsert: true });
    await coll.updateMany({ repo_id: repoId, relation: 'GUIDANCE_SUPERSEDES', status: { $ne: 'invalidated' }, ...(keep.length ? { $nor: keep } : {}) }, { $set: { status: 'invalidated', updated_at: now } });
  }
}
