import { performance } from 'node:perf_hooks';
import type { Client } from '@opensearch-project/opensearch';
import type { Db } from 'mongodb';
import type { AclService, RepoAccess } from '../acl/service.js';
import { HttpError } from '../errors.js';
import { type EffectiveRelease, ReleaseUnavailableError, resolveEffective } from '../guidance/release.js';
import { sha256 } from '../ingest/chunker.js';
import type { ChunkDoc, CommentDoc, DocumentRevisionDoc, EdgeDoc, IssueDoc, Principal, PullRequestDoc, RepositoryDoc, Supersession } from '../types.js';
import { wrapTransient } from './index.js';
import type { QueryLog } from './querylog.js';

export interface SearchParams {
  q: string;
  repo?: string;
  label?: string;
  release?: string;
  types?: ChunkDoc['source_type'][];
  status: 'current' | 'all';
  limit: number;
}

export type Marker = 'current' | 'historical' | 'superseded' | 'possibly_outdated' | 'unknown';

export interface Citation {
  chunk_id: string;
  repo_id: string;
  repo_full_name: string;
  source_type: ChunkDoc['source_type'];
  source_id: string;
  revision: number;
  commit_sha: string | null;
  section_anchor: string;
  heading_path: string[];
  line_start: number;
  line_end: number;
  text_digest: string;
  cite: string; // e.g. docs/tls.md@rev3#secure-defaults L5-10
  marker: Marker;
  guidance_status: ChunkDoc['guidance_status'];
  is_latest: boolean;
  release_ids: string[];
  superseded_by: Supersession | null;
  thread_title: string | null;
  labels: string[];
}

export interface SearchItem extends Citation {
  score: number;
  snippet: string;
}

export interface SearchResult {
  items: SearchItem[];
  dropped: { unauthorized: number; stale: number };
  aclEpochs: Record<string, number>;
  timings: Record<string, number>;
}

const MAX_PRIVATE_SCOPE = 1000;
const SECURITY_QUERY = /\b(security|tls|ssl|cve|vulnerab\w*|auth\w*|password|cipher\w*|secret|token|encrypt\w*)\b/i;

export function markerOf(c: Pick<ChunkDoc, 'guidance_status' | 'superseded_by' | 'possibly_outdated'>): Marker {
  if (c.guidance_status === 'historical') return c.superseded_by ? 'superseded' : 'historical';
  if (c.possibly_outdated) return 'possibly_outdated';
  return c.guidance_status;
}

export function citeOf(c: Pick<ChunkDoc, 'source_id' | 'revision' | 'section_anchor' | 'line_start' | 'line_end'>) {
  return `${c.source_id}@rev${c.revision}${c.section_anchor ? `#${c.section_anchor}` : ''} L${c.line_start}-${c.line_end}`;
}

function snippetOf(text: string, q: string): string {
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter((t) => t.length >= 3);
  const lines = text.split('\n');
  const hit = (l: string) => terms.some((t) => l.toLowerCase().includes(t));
  // Prefer a body line over a heading, so the excerpt carries the actual statement.
  let i = lines.findIndex((l) => hit(l) && !/^\s*#/.test(l));
  if (i < 0) i = Math.max(0, lines.findIndex(hit));
  const s = lines.slice(Math.max(0, i - 1), i + 2).join('\n').trim();
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

/**
 * Permission-safe retrieval (report 5.4 / 9.4):
 *  1. pre-filter in the query: public OR repositories where MongoDB says the caller is a member;
 *  2. post-verify every hit against authoritative MongoDB state (access, canonical chunk, digest);
 *  3. linearizable re-check of every repository before the response is returned.
 * Snippets and citations are built from canonical MongoDB text, never from the index, and no hit
 * totals are returned (they could count documents the caller may not see).
 */
export class SearchService {
  constructor(
    private db: Db,
    private os: Client | null,
    public alias: string,
    private acl: AclService,
    private log: QueryLog,
  ) {}

  async search(p: Principal, params: SearchParams): Promise<SearchResult> {
    if (!this.os) throw new HttpError(503, 'search_unavailable', 'Full-text search is temporarily unavailable. Repository and issue pages still work.');
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    let member: string[] = [];
    if (params.repo) await this.acl.requireRead(p, params.repo);
    else {
      member = await this.acl.memberRepoIds(p);
      if (member.length > MAX_PRIVATE_SCOPE) throw new HttpError(400, 'scope_too_broad', 'Too many private repositories in scope; narrow the search to a repository.');
    }
    timings.acl = performance.now() - t0;

    const filter: object[] = [
      params.repo
        ? { term: { repo_id: params.repo } }
        : { bool: { should: [{ term: { visibility: 'public' } }, { terms: { repo_id: member } }], minimum_should_match: 1 } },
    ];
    if (params.label) filter.push({ term: { labels: params.label } });
    if (params.release) filter.push({ term: { release_ids: params.release } });
    if (params.types?.length) filter.push({ terms: { source_type: params.types } });
    if (params.status === 'current') filter.push({ term: { is_latest: true } }, { terms: { guidance_status: ['current', 'unknown'] } });

    const t1 = performance.now();
    let hits: { _id: string; _score: number; _source: { repo_id: string; text_digest: string } }[];
    try {
      const res = await this.os.search({
        index: this.alias,
        body: {
          size: Math.min(50, params.limit * 3), // over-fetch: some hits may be dropped by verification
          _source: ['repo_id', 'text_digest'],
          query: {
            bool: {
              // multi_match treats the input as plain text (no query-string syntax is interpreted)
              must: [{ multi_match: { query: params.q, fields: ['thread_title^0.7', 'heading_path^2', 'text', 'config_keys^2'], type: 'best_fields' } }],
              filter,
              // Current, documented guidance ranks above discussion (report 9.4).
              should: [
                { term: { guidance_status: { value: 'current', boost: 3 } } },
                { term: { in_effective_release: { value: true, boost: 3 } } },
                { term: { is_latest: { value: true, boost: 0.5 } } },
              ],
            },
          },
        } as never,
      });
      hits = res.body.hits.hits as never;
    } catch (e) {
      wrapTransient(e);
    }
    timings.search = performance.now() - t1;

    // Post-verification against MongoDB.
    const t2 = performance.now();
    const canonical = new Map(
      (await this.db.collection<ChunkDoc>('chunks').find({ chunk_id: { $in: hits.map((h) => h._id) } }).toArray()).map((c) => [c.chunk_id, c]),
    );
    const access = new Map<string, RepoAccess | null>();
    const dropped = { unauthorized: 0, stale: 0 };
    const kept: { c: ChunkDoc; score: number }[] = [];
    for (const h of hits) {
      const repoId = h._source.repo_id;
      if (!access.has(repoId)) access.set(repoId, await this.acl.resolve(p, repoId));
      if (!access.get(repoId)) {
        dropped.unauthorized++; // e.g. index still says "public" after the repository became private
        continue;
      }
      const c = canonical.get(h._id);
      if (!c || c.repo_id !== repoId || c.text_digest !== h._source.text_digest) {
        dropped.stale++;
        continue;
      }
      if (params.status === 'current' && (!c.is_latest || c.guidance_status === 'historical')) {
        dropped.stale++; // projection lags behind a newer revision
        continue;
      }
      if (params.release && !c.release_ids.includes(params.release)) {
        dropped.stale++;
        continue;
      }
      kept.push({ c, score: h._score });
    }
    let items = await this.toItems(kept.slice(0, params.limit), params.q);
    timings.verify = performance.now() - t2;

    // Final re-check before anything leaves the server (one linearizable fence per request).
    const t3 = performance.now();
    const aclEpochs: Record<string, number> = {};
    const finals = await this.acl.finalCheck(p, [...new Set(items.map((i) => i.repo_id))]);
    for (const [repoId, fresh] of finals) {
      if (!fresh) {
        dropped.unauthorized += items.filter((i) => i.repo_id === repoId).length;
        items = items.filter((i) => i.repo_id !== repoId);
      } else aclEpochs[repoId] = fresh.aclEpoch;
    }
    timings.final_acl = performance.now() - t3;
    timings.total = performance.now() - t0;
    return { items, dropped, aclEpochs, timings };
  }

  private async toItems(rows: { c: ChunkDoc; score: number }[], q: string): Promise<SearchItem[]> {
    const names = new Map(
      (await this.db.collection<RepositoryDoc>('repositories').find({ repo_id: { $in: [...new Set(rows.map((r) => r.c.repo_id))] } }, { projection: { repo_id: 1, full_name: 1 } }).toArray()).map((r) => [r.repo_id, r.full_name]),
    );
    return rows.map(({ c, score }) => ({ ...this.citation(c, names.get(c.repo_id) ?? c.repo_id), score, snippet: snippetOf(c.text, q) }));
  }

  citation(c: ChunkDoc, fullName: string): Citation {
    return {
      chunk_id: c.chunk_id, repo_id: c.repo_id, repo_full_name: fullName, source_type: c.source_type, source_id: c.source_id,
      revision: c.revision, commit_sha: c.commit_sha, section_anchor: c.section_anchor, heading_path: c.heading_path,
      line_start: c.line_start, line_end: c.line_end, text_digest: c.text_digest, cite: citeOf(c), marker: markerOf(c),
      guidance_status: c.guidance_status, is_latest: c.is_latest, release_ids: c.release_ids, superseded_by: c.superseded_by ?? null,
      thread_title: c.thread_title, labels: c.labels,
    };
  }

  // ------------------------------------------------------------------ citations

  /**
   * Re-derives the cited lines from the immutable source revision and checks them against the
   * chunk's digest. Issue bodies are checked against their stored revision; PRs and comments can
   * only be checked while the cited revision is still the stored one.
   */
  async verifyCitation(p: Principal, repoId: string, chunkId: string): Promise<{ valid: boolean; reason: string | null; citation: Citation | null; text: string | null }> {
    await this.acl.requireRead(p, repoId);
    const r = await this.checkCitation(repoId, chunkId);
    await this.acl.requireRead(p, repoId, { final: true });
    return r;
  }

  /**
   * Content check only. Callers must already have checked access and must re-check it before
   * responding (answer and compare do both once per request instead of once per citation).
   */
  private async checkCitation(repoId: string, chunkId: string): Promise<{ valid: boolean; reason: string | null; citation: Citation | null; text: string | null }> {
    const c = await this.db.collection<ChunkDoc>('chunks').findOne({ repo_id: repoId, chunk_id: chunkId });
    if (!c) return { valid: false, reason: 'unknown_chunk', citation: null, text: null };
    const source = await this.sourceText(c);
    const repo = await this.db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId });
    const citation = this.citation(c, repo?.full_name ?? repoId);
    if (source === null) return { valid: false, reason: 'source_revision_unavailable', citation, text: null };
    const slice = source.replace(/\r\n?/g, '\n').split('\n').slice(c.line_start - 1, c.line_end).join('\n');
    const valid = sha256(slice) === c.text_digest && slice === c.text;
    return { valid, reason: valid ? null : 'content_mismatch', citation, text: valid ? slice : null };
  }

  private async sourceText(c: ChunkDoc): Promise<string | null> {
    const repo = c.repo_id;
    switch (c.source_type) {
      case 'doc':
      case 'release_notes': {
        const rev = await this.db.collection<DocumentRevisionDoc>('document_revisions').findOne({ repo_id: repo, source_id: c.source_id, revision: c.revision });
        const blob = rev ? await this.db.collection<{ digest: string; text: string }>('blobs').findOne({ digest: rev.source_digest }) : null;
        return blob?.text ?? null;
      }
      case 'issue': {
        const r = await this.db.collection<IssueDoc>('issue_revisions').findOne({ repo_id: repo, number: Number(c.source_id.slice(6)), revision: c.revision });
        return r?.body ?? null;
      }
      case 'pr': {
        const pr = await this.db.collection<PullRequestDoc>('pull_requests').findOne({ repo_id: repo, number: Number(c.source_id.slice(3)) });
        return pr && pr.revision === c.revision ? pr.body : null;
      }
      case 'comment': {
        const [thread, id] = c.source_id.split('/comment:');
        const cm = await this.db.collection<CommentDoc>('comments').findOne({ repo_id: repo, thread_key: thread, comment_id: id });
        return cm && cm.revision === c.revision ? cm.body : null;
      }
    }
  }

  /** Citations of one access-checked repository (the caller performs the final re-check). */
  private async verified(_p: Principal, cits: Citation[]) {
    const out: Citation[] = [];
    let valid = 0;
    for (const c of cits) {
      const v = await this.checkCitation(c.repo_id, c.chunk_id);
      if (v.valid) {
        valid++;
        out.push(c);
      }
    }
    return { citations: out, checked: cits.length, valid };
  }

  // ------------------------------------------------------------------ guidance comparison

  async compare(p: Principal, repoId: string, topic: string, from?: string, to?: string) {
    const access = await this.acl.requireRead(p, repoId);
    const eff = await resolveEffective(this.db, repoId, to && to !== 'effective' ? to : undefined);
    const repo = await this.db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId });
    const name = repo?.full_name ?? repoId;
    const chunks = await this.db.collection<ChunkDoc>('chunks').find({ repo_id: repoId, config_keys: topic }).toArray();

    const current = chunks.filter((c) => c.guidance_status === 'current' && c.is_latest && c.source_type === 'doc' && eff && c.release_ids.includes(eff.release_id));
    const historical = chunks.filter((c) => c.guidance_status === 'historical' && (!from || c.source_type !== 'doc' || c.release_ids.includes(from)));

    // Why it changed: notes of the superseding releases, and the PR threads behind the change.
    const edges = this.db.collection<EdgeDoc>('edges');
    const releasesWhy = new Set(historical.filter((c) => c.superseded_by?.kind === 'release').map((c) => c.superseded_by!.ref));
    const commits = new Set(current.map((c) => c.commit_sha).filter(Boolean).map((s) => `commit:${s}`));
    for (const r of releasesWhy) for (const e of await edges.find({ repo_id: repoId, from: `release:${r}`, relation: 'RELEASE_CONTAINS_COMMIT', status: 'active' }).toArray()) commits.add(e.to);
    const prs = (await edges.find({ repo_id: repoId, relation: 'PR_MERGED_AS_COMMIT', status: 'active', to: { $in: [...commits] } }).toArray()).map((e) => e.from);
    const prChunks = await this.db.collection<ChunkDoc>('chunks').find({ repo_id: repoId, is_latest: true, source_id: { $regex: `^(${prs.map((k) => k.replace(':', '\\:')).join('|') || 'none'})(/|$)` } }).toArray();
    const relevantPrs = new Set(prChunks.filter((c) => c.config_keys.includes(topic)).map((c) => c.source_id.split('/')[0]));
    const why = [
      ...(await this.db.collection<ChunkDoc>('chunks').find({ repo_id: repoId, source_type: 'release_notes', source_id: { $in: [...releasesWhy].map((r) => `release/${r}`) }, config_keys: topic }).toArray()),
      ...prChunks.filter((c) => relevantPrs.has(c.source_id.split('/')[0]!)),
    ];

    const [cur, hist, whyV] = [
      await this.verified(p, current.map((c) => this.citation(c, name))),
      await this.verified(p, historical.map((c) => this.citation(c, name))),
      await this.verified(p, why.map((c) => this.citation(c, name))),
    ];
    await this.acl.requireRead(p, repoId, { final: true });
    await this.log.write({
      endpoint: 'compare', principalId: p.userId, repoIds: [repoId], tenantId: repo?.org_id ?? 'unknown', query: topic, filters: { from, to },
      aclEpochs: { [repoId]: access.aclEpoch }, effectiveRelease: eff?.release_id ?? null, indexAlias: 'mongodb', latencyMs: {},
      resultCount: cur.citations.length + hist.citations.length, dropped: { unauthorized: 0, stale: 0 },
      citations: { checked: cur.checked + hist.checked + whyV.checked, valid: cur.valid + hist.valid + whyV.valid },
    });
    return {
      topic,
      effective_release: eff ? { release_id: eff.release_id, basis: eff.basis, security_epoch: eff.security_epoch } : null,
      acl_epoch: access.aclEpoch,
      current: cur.citations,
      historical: hist.citations,
      why_changed: whyV.citations,
      notes: eff ? [] : ['No effective release could be resolved; current guidance cannot be confirmed.'],
    };
  }

  // ------------------------------------------------------------------ extractive answer

  /**
   * Answer pipeline (report 9.4) without an LLM: fresh ACL check and effective-release resolution,
   * permission-scoped retrieval, verification of every cited line range, current evidence first,
   * superseded evidence clearly separated, and a final ACL + release re-check before responding.
   */
  async answer(p: Principal, repoId: string, query: string, release?: string, attempt = 1): Promise<Record<string, unknown>> {
    const t0 = performance.now();
    const access = await this.acl.requireRead(p, repoId, { final: true });
    let eff: EffectiveRelease | null = null;
    let releaseUnavailable = false;
    try {
      eff = await resolveEffective(this.db, repoId, release);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (!(e instanceof ReleaseUnavailableError)) throw e;
      releaseUnavailable = true;
    }

    const r = await this.search(p, { q: query, repo: repoId, status: 'all', limit: 20 });
    const isCurrentGuidance = (i: SearchItem) =>
      i.marker === 'current' && !!eff && (i.source_type === 'release_notes' || i.release_ids.includes(eff.release_id));
    // Current guidance must also be relevant: within half of the best current score, at most 3.
    const currentAll = r.items.filter(isCurrentGuidance);
    const best = Math.max(0, ...currentAll.map((i) => i.score));
    const current = currentAll.filter((i) => i.score >= best * 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
    const supporting = r.items.filter((i) => !current.includes(i) && !isCurrentGuidance(i) && (i.marker === 'unknown' || i.marker === 'current'));
    const historical = r.items.filter((i) => i.marker === 'historical' || i.marker === 'superseded' || i.marker === 'possibly_outdated');

    const security = SECURITY_QUERY.test(query) || r.items.some((i) => i.labels.includes('security'));
    const warnings: string[] = [];
    let cur = await this.verified(p, current.slice(0, 5));
    if (security && !eff) {
      warnings.push(releaseUnavailable
        ? 'The release authority is unavailable, so current security guidance cannot be verified. No configuration is recommended.'
        : 'This repository has no resolvable release, so current security guidance cannot be verified. No configuration is recommended.');
      cur = { citations: [], checked: cur.checked, valid: cur.valid };
    }
    const sup = await this.verified(p, supporting.slice(0, 3));
    const hist = await this.verified(p, historical.slice(0, 3));
    if (cur.checked > cur.valid || sup.checked > sup.valid || hist.checked > hist.valid) warnings.push('Some candidate evidence failed citation verification and was omitted.');
    if (hist.citations.some((c) => c.labels.includes('security') || c.superseded_by?.reason === 'security_epoch')) {
      warnings.push('Older guidance on this topic was superseded by a security change; do not apply it.');
    }

    const bySnippet = new Map(r.items.map((i) => [i.chunk_id, i.snippet]));
    const numbered = [...cur.citations, ...sup.citations, ...hist.citations];
    const n = (c: Citation) => numbered.indexOf(c) + 1;
    const lines: string[] = [];
    if (cur.citations.length) {
      lines.push(`Current guidance (effective release ${eff!.release_id}):`);
      for (const c of cur.citations) lines.push(`- ${bySnippet.get(c.chunk_id)} [${n(c)}]`);
    } else {
      lines.push('No current, verified guidance was found for this question.');
    }
    if (sup.citations.length) {
      lines.push('Related discussion (context, not configuration advice):');
      for (const c of sup.citations) lines.push(`- ${c.thread_title ?? c.source_id}: ${bySnippet.get(c.chunk_id)} [${n(c)}]`);
    }
    if (hist.citations.length) {
      lines.push('Historical or superseded guidance (do not apply):');
      for (const c of hist.citations) lines.push(`- ${bySnippet.get(c.chunk_id)} [${n(c)}] - ${c.superseded_by ? `superseded by ${c.superseded_by.ref} (${c.superseded_by.reason})` : 'historical'}`);
    }

    // Final authoritative re-checks: access (linearizable) and release policy.
    await this.acl.requireRead(p, repoId, { final: true });
    if (!releaseUnavailable) {
      const again = await resolveEffective(this.db, repoId, release).catch(() => null);
      if ((again?.release_id ?? null) !== (eff?.release_id ?? null)) {
        if (attempt < 2) return this.answer(p, repoId, query, release, attempt + 1);
        throw new HttpError(409, 'release_changed', 'The effective release changed while answering. Please retry.');
      }
    }

    const repo = await this.db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId });
    const queryId = await this.log.write({
      endpoint: 'answer', principalId: p.userId, repoIds: [repoId], tenantId: repo?.org_id ?? 'unknown', query, filters: { release },
      aclEpochs: { [repoId]: access.aclEpoch }, effectiveRelease: eff?.release_id ?? null, indexAlias: this.alias,
      latencyMs: { ...r.timings, total: performance.now() - t0 }, resultCount: numbered.length, dropped: r.dropped,
      citations: { checked: cur.checked + sup.checked + hist.checked, valid: cur.valid + sup.valid + hist.valid },
      failure: cur.citations.length ? null : 'no_current_guidance',
    });
    return {
      query_id: queryId,
      repo_id: repoId,
      effective_release: eff ? { release_id: eff.release_id, basis: eff.basis, security_epoch: eff.security_epoch } : null,
      answer: lines.join('\n'),
      current: cur.citations,
      supporting: sup.citations,
      historical: hist.citations,
      warnings,
      method: 'extractive (no generative model): ranked, verified excerpts only',
    };
  }
}
