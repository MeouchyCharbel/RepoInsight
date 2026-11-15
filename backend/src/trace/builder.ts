import { createHash } from 'node:crypto';
import type { Db, Filter } from 'mongodb';
import { GitRepo } from '../ingest/git.js';
import type { StreamEvent } from '../stream/kafka.js';
import type { ChunkDoc, CommitDoc, DocumentRevisionDoc, EdgeDoc, IssueDoc, OutboxDoc, PullRequestDoc, Relation, ReleaseDoc, RepositoryDoc } from '../types.js';
import { type Ancestry, type Budget, CommitGraph } from './graph.js';

interface BranchDoc {
  repo_id: string;
  name: string;
  head_sha: string;
}

const MENTION = /(?:^|[^\w&])#(\d{1,9})\b/g;
const BACKPORT_PR = /\bback-?port(?:ed)?(?:\s+of)?\s+#(\d{1,9})\b/i;

export type InclusionStatus = 'verified' | 'unverified' | 'not_included' | 'unknown';

export interface ReleaseInclusion {
  release_id: string;
  published_at: Date;
  channel: string;
  status: InclusionStatus;
  via: 'merged_commit' | 'backport' | 'candidate_backport' | null;
  evidence: Record<string, unknown> | null;
}

export interface IssueTrace {
  issue: { number: number; title: string; state: string; labels: string[] };
  fixes: {
    pr: { number: number; title: string; state: string; merged_at: Date | null };
    provenance: string;
    confidence: EdgeDoc['confidence'];
    merge: { merged_sha: string | null; strategy: string | null; strategy_basis: 'inferred'; head_commits: string[]; note: string };
    releases: ReleaseInclusion[];
  }[];
  mentions: { pr: number; note: string }[];
  fixed_in: { release_id: string; status: 'verified' | 'unverified'; via: string } | null;
  notes: string[];
  traversal: { nodes_visited: number; budget: Budget };
}

/**
 * Builds and queries the relationship graph (report Section 5): typed edges in MongoDB, release
 * inclusion proven by commit-DAG ancestry from the PR's merged commit (never from head commits,
 * dates or tag names), and backports linked only with explicit evidence.
 */
export class TraceBuilder {
  constructor(
    private db: Db,
    private budget: Budget = { nodes: 50_000, ms: 3_000 },
  ) {}

  private edges() {
    return this.db.collection<EdgeDoc>('edges');
  }

  /** Upserts the new edge set of a scope and invalidates edges of that scope that disappeared. */
  private async replaceEdges(repoId: string, scope: Filter<EdgeDoc>, next: Omit<EdgeDoc, 'repo_id' | 'created_at' | 'updated_at'>[]) {
    const now = new Date();
    const keep: Filter<EdgeDoc>[] = [];
    for (const e of next) {
      const key = { repo_id: repoId, from: e.from, relation: e.relation, to: e.to };
      keep.push(key);
      await this.edges().updateOne(key, { $set: { ...e, repo_id: repoId, updated_at: now }, $setOnInsert: { created_at: now } }, { upsert: true });
    }
    await this.edges().updateMany(
      { repo_id: repoId, ...scope, status: { $ne: 'invalidated' }, ...(keep.length ? { $nor: keep } : {}) },
      { $set: { status: 'invalidated', updated_at: now } },
    );
  }

  // ------------------------------------------------------------------ PR edges

  async buildPrEdges(repoId: string, number: number): Promise<void> {
    const pr = await this.db.collection<PullRequestDoc>('pull_requests').findOne({ repo_id: repoId, number });
    if (!pr) return;
    const issues = new Set(
      (await this.db.collection<IssueDoc>('issues').find({ repo_id: repoId }, { projection: { number: 1 } }).toArray()).map((i) => i.number),
    );
    const commitExists = async (sha: string) => (await this.db.collection('commits').countDocuments({ repo_id: repoId, sha }, { limit: 1 })) > 0;
    const out: Omit<EdgeDoc, 'repo_id' | 'created_at' | 'updated_at'>[] = [];
    const prKey = `pr:${number}`;

    for (const n of pr.closes_issues) {
      out.push({
        from: `issue:${n}`, relation: 'ISSUE_FIXED_BY_PR', to: prKey,
        provenance: pr.merged_sha ? 'closing_keyword_in_merged_pr' : 'closing_keyword_in_unmerged_pr',
        confidence: pr.merged_sha ? 'verified' : 'unverified',
        status: issues.has(n) ? 'active' : 'pending',
      });
    }
    const mentioned = new Set([...`${pr.title}\n${pr.body}`.matchAll(MENTION)].map((m) => Number(m[1])));
    for (const n of mentioned) {
      if (pr.closes_issues.includes(n) || n === number || !issues.has(n)) continue;
      out.push({ from: `issue:${n}`, relation: 'ISSUE_MENTIONS_PR', to: prKey, provenance: 'text_mention', confidence: 'weak', status: 'active' });
    }
    if (pr.merged_sha) {
      out.push({ from: prKey, relation: 'PR_MERGED_AS_COMMIT', to: `commit:${pr.merged_sha}`, provenance: 'provider_merge_record', confidence: 'verified', status: (await commitExists(pr.merged_sha)) ? 'active' : 'pending' });
    }
    for (const h of pr.head_commits) {
      out.push({ from: prKey, relation: 'PR_CONTAINS_COMMIT', to: `commit:${h}`, provenance: 'provider_pr_commit_list', confidence: 'verified', status: (await commitExists(h)) ? 'active' : 'pending' });
    }
    await this.replaceEdges(repoId, { $or: [{ to: prKey, relation: { $in: ['ISSUE_FIXED_BY_PR', 'ISSUE_MENTIONS_PR'] } }, { from: prKey }] }, out);
  }

  /** An entity arrived: edges waiting for it become active (report 6.2 placeholders). */
  async resolvePending(repoId: string, node: string): Promise<number> {
    const res = await this.edges().updateMany({ repo_id: repoId, status: 'pending', $or: [{ to: node }, { from: node }] }, { $set: { status: 'active', updated_at: new Date() } });
    return res.modifiedCount;
  }

  /**
   * Merge strategy, for display only (inclusion never depends on it): two parents = merge commit;
   * merged_sha among the head commits = fast-forward; same subject as the last head commit =
   * rebase; otherwise squash.
   */
  async mergeStrategy(repoId: string, pr: PullRequestDoc): Promise<string | null> {
    if (!pr.merged_sha) return null;
    const commits = this.db.collection<CommitDoc>('commits');
    const merged = await commits.findOne({ repo_id: repoId, sha: pr.merged_sha });
    if (!merged) return 'unknown';
    if (merged.parent_shas.length > 1) return 'merge_commit';
    if (pr.head_commits.includes(pr.merged_sha)) return 'fast_forward';
    const last = await commits.findOne({ repo_id: repoId, sha: pr.head_commits.at(-1) ?? '' });
    const subject = (m: string) => m.split('\n')[0]!.trim();
    if (last && subject(last.message) === subject(merged.message)) return 'rebase';
    return 'squash';
  }

  // ------------------------------------------------------------------ backports

  /**
   * COMMIT_BACKPORT_OF in order of strength (report 5.2): cherry-pick trailer, backport PR link,
   * identical patch-id (all "verified"); a commit off the default branch that touches the same
   * files and says "backport" but has a different patch-id is only a "candidate" (unverified).
   */
  async detectBackports(repoId: string): Promise<void> {
    const commits = this.db.collection<CommitDoc>('commits');
    const prs = await this.db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId, merged_sha: { $ne: null } }).toArray();
    const out: Omit<EdgeDoc, 'repo_id' | 'created_at' | 'updated_at'>[] = [];
    const linked = new Set<string>();
    const add = (from: string, to: string, provenance: string, confidence: 'verified' | 'unverified') => {
      if (linked.has(from + to)) return;
      linked.add(from + to);
      out.push({ from: `commit:${from}`, relation: 'COMMIT_BACKPORT_OF', to: `commit:${to}`, provenance, confidence, status: 'active' });
    };

    for (const c of await commits.find({ repo_id: repoId, cherry_picked_from: { $ne: null } }).toArray()) add(c.sha, c.cherry_picked_from!, 'cherry_pick_trailer', 'verified');

    const byNumber = new Map(prs.map((p) => [p.number, p]));
    for (const p of prs) {
      const m = BACKPORT_PR.exec(`${p.title}\n${p.body}`);
      const orig = m ? byNumber.get(Number(m[1])) : undefined;
      if (orig?.merged_sha && orig.merged_sha !== p.merged_sha) add(p.merged_sha!, orig.merged_sha, 'backport_pr_link', 'verified');
    }

    // Patch-id / candidate matching for fix commits (merged commits of PRs that close issues).
    const repo = await this.db.collection<RepositoryDoc & { git_dir?: string }>('repositories').findOne({ repo_id: repoId });
    const git = repo?.git_dir ? new GitRepo(repo.git_dir) : null;
    const head = (await this.db.collection<BranchDoc>('branches').findOne({ repo_id: repoId, name: repo?.default_branch ?? 'main' }))?.head_sha;
    const graph = new CommitGraph(this.db, repoId, this.budget);
    const originals = (await commits.find({ repo_id: repoId, sha: { $in: prs.filter((p) => p.closes_issues.length).map((p) => p.merged_sha!) } }).toArray()).filter((c) => c.parent_shas.length === 1);
    const patchId = async (c: CommitDoc) => {
      if (c.patch_id !== undefined || !git) return c.patch_id ?? null;
      const id = await git.patchId(c.sha).catch(() => null);
      await commits.updateOne({ repo_id: repoId, sha: c.sha }, { $set: { patch_id: id } });
      c.patch_id = id;
      return id;
    };
    for (const o of originals) {
      if (!o.changed_paths.length || !head) continue;
      const candidates = await commits.find({ repo_id: repoId, sha: { $ne: o.sha }, changed_paths: { $in: o.changed_paths }, 'parent_shas.1': { $exists: false } }).toArray();
      for (const c of candidates) {
        if (linked.has(c.sha + o.sha) || (await graph.isAncestor(c.sha, head)) !== 'no') continue; // only commits off the default branch
        const [pc, po] = [await patchId(c), await patchId(o)];
        if (pc && po && pc === po) add(c.sha, o.sha, 'patch_id_match', 'verified');
        else if (/\b(back-?port|cherry[- ]?pick)/i.test(c.message)) add(c.sha, o.sha, 'same_files_and_backport_message', 'unverified');
      }
    }
    await this.replaceEdges(repoId, { relation: 'COMMIT_BACKPORT_OF' }, out);
  }

  // ------------------------------------------------------------------ releases

  /**
   * Materialises RELEASE_CONTAINS_COMMIT for PR merge commits and backport commits in the range
   * prev..target (report 5.3), tags documentation revisions with the release, and sets
   * prev_release_id. Recomputed when a tag moves.
   */
  async computeRelease(repoId: string, releaseId: string): Promise<void> {
    const releases = this.db.collection<ReleaseDoc>('releases');
    const rel = await releases.findOne({ repo_id: repoId, release_id: releaseId });
    if (!rel) return;
    const graph = new CommitGraph(this.db, repoId, this.budget);
    const relKey = `release:${releaseId}`;
    if (!rel.target_sha || !(await graph.get(rel.target_sha))) {
      await this.replaceEdges(repoId, { from: relKey, relation: 'RELEASE_CONTAINS_COMMIT' }, []);
      return;
    }

    // Previous release = the nearest other release whose target is an ancestor of this target.
    let prev: { id: string; sha: string; gen: number } | null = null;
    for (const r of await releases.find({ repo_id: repoId, release_id: { $ne: releaseId }, target_sha: { $ne: null } }).toArray()) {
      const node = await graph.get(r.target_sha!);
      if (!node || (prev && node.gen <= prev.gen)) continue;
      if ((await graph.isAncestor(r.target_sha!, rel.target_sha)) === 'yes' && r.target_sha !== rel.target_sha) prev = { id: r.release_id, sha: r.target_sha!, gen: node.gen };
    }
    const range = await graph.range(rel.target_sha, prev?.sha ?? null);

    const prMerged = new Set((await this.db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId, merged_sha: { $ne: null } }, { projection: { merged_sha: 1 } }).toArray()).map((p) => p.merged_sha!));
    const backports = new Set((await this.edges().find({ repo_id: repoId, relation: 'COMMIT_BACKPORT_OF', status: 'active' }).toArray()).map((e) => e.from.slice(7)));
    const out = range.shas
      .filter((s) => prMerged.has(s) || backports.has(s))
      .map((s) => ({
        from: relKey, relation: 'RELEASE_CONTAINS_COMMIT' as Relation, to: `commit:${s}`,
        provenance: `dag_range:${prev?.id ?? 'root'}..${releaseId}`,
        confidence: (range.complete ? 'verified' : 'unverified') as EdgeDoc['confidence'],
        status: 'active' as const,
      }));
    await this.replaceEdges(repoId, { from: relKey, relation: 'RELEASE_CONTAINS_COMMIT' }, out);
    await releases.updateOne({ repo_id: repoId, release_id: releaseId }, { $set: { prev_release_id: prev?.id ?? null } });
    await this.tagDocuments(repoId, rel, graph);
  }

  /** A release contains revision n of a document if n is the newest revision whose commit is in it. */
  private async tagDocuments(repoId: string, rel: ReleaseDoc, graph: CommitGraph) {
    const chunks = this.db.collection<ChunkDoc>('chunks');
    const revs = await this.db.collection<DocumentRevisionDoc>('document_revisions').find({ repo_id: repoId, kind: 'doc' }).sort({ source_id: 1, revision: -1 }).toArray();
    const bySource = new Map<string, DocumentRevisionDoc[]>();
    for (const r of revs) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
    const changed: string[] = [];

    for (const [source, list] of bySource) {
      let chosen: number | null = null;
      for (const r of list) {
        if (!r.commit_sha) continue;
        const a: Ancestry = await graph.isAncestor(r.commit_sha, rel.target_sha!);
        if (a === 'yes') {
          chosen = r.revision;
          break;
        }
      }
      const pulled = await chunks.updateMany({ repo_id: repoId, source_id: source, release_ids: rel.release_id, ...(chosen ? { revision: { $ne: chosen } } : {}) }, { $pull: { release_ids: rel.release_id } });
      const added = chosen ? await chunks.updateMany({ repo_id: repoId, source_id: source, revision: chosen }, { $addToSet: { release_ids: rel.release_id } }) : { modifiedCount: 0 };
      if (pulled.modifiedCount || added.modifiedCount) changed.push(source);
    }
    const notes = await chunks.updateMany({ repo_id: repoId, source_id: `release/${rel.release_id}` }, { $addToSet: { release_ids: rel.release_id } });
    if (notes.modifiedCount) changed.push(`release/${rel.release_id}`);

    if (changed.length) {
      // Search documents carry release_ids, so the search projector re-projects these sources.
      const digest = createHash('sha256').update(`${rel.target_sha}|${changed.sort().join('|')}`).digest('hex').slice(0, 16);
      await this.db.collection<OutboxDoc>('outbox').updateOne(
        { event_id: `${repoId}:release-tag:${rel.release_id}:${digest}` },
        { $setOnInsert: { event_id: `${repoId}:release-tag:${rel.release_id}:${digest}`, topic: 'ri.changes', key: `${repoId}:release:${rel.release_id}`, type: 'release.tagged', payload: { repo_id: repoId, release_id: rel.release_id, source_ids: changed, occurred_at: new Date().toISOString() }, created_at: new Date(), published_at: null, attempts: 0 } },
        { upsert: true },
      );
    }
  }

  // ------------------------------------------------------------------ issue trace

  /** Full bug-to-release trace with explicit evidence per release. */
  async traceIssue(repoId: string, number: number): Promise<IssueTrace | null> {
    const issue = await this.db.collection<IssueDoc>('issues').findOne({ repo_id: repoId, number });
    if (!issue) return null;
    const graph = new CommitGraph(this.db, repoId, this.budget);
    const releases = await this.db.collection<ReleaseDoc>('releases').find({ repo_id: repoId }).sort({ published_at: 1 }).toArray();
    const links = await this.edges().find({ repo_id: repoId, from: `issue:${number}`, status: 'active', relation: { $in: ['ISSUE_FIXED_BY_PR', 'ISSUE_MENTIONS_PR'] } }).toArray();
    const backportEdges = await this.edges().find({ repo_id: repoId, relation: 'COMMIT_BACKPORT_OF', status: 'active' }).toArray();
    const notes: string[] = [];
    const trace: IssueTrace = {
      issue: { number: issue.number, title: issue.title, state: issue.state, labels: issue.labels },
      fixes: [],
      mentions: [],
      fixed_in: null,
      notes,
      traversal: { nodes_visited: 0, budget: this.budget },
    };

    for (const link of links) {
      const prNumber = Number(link.to.slice(3));
      if (link.relation === 'ISSUE_MENTIONS_PR') {
        trace.mentions.push({ pr: prNumber, note: 'Mentioned only; a mention is never treated as proof of a fix.' });
        continue;
      }
      const pr = await this.db.collection<PullRequestDoc>('pull_requests').findOne({ repo_id: repoId, number: prNumber });
      if (!pr) continue;
      const fix: IssueTrace['fixes'][number] = {
        pr: { number: pr.number, title: pr.title, state: pr.state, merged_at: pr.merged_at },
        provenance: link.provenance,
        confidence: link.confidence,
        merge: {
          merged_sha: pr.merged_sha,
          strategy: await this.mergeStrategy(repoId, pr),
          strategy_basis: 'inferred',
          head_commits: pr.head_commits,
          note: 'Head commits are review context only; release inclusion is checked for the merged commit.',
        },
        releases: [],
      };
      if (!pr.merged_sha) notes.push(`PR #${pr.number} is not merged, so no release can contain this fix.`);
      const verifiedBackports = backportEdges.filter((e) => e.to === `commit:${pr.merged_sha}` && e.confidence === 'verified');
      const candidateBackports = backportEdges.filter((e) => e.to === `commit:${pr.merged_sha}` && e.confidence !== 'verified');

      for (const rel of releases) {
        const base = { release_id: rel.release_id, published_at: rel.published_at, channel: rel.channel };
        if (!pr.merged_sha || !rel.target_sha) {
          fix.releases.push({ ...base, status: pr.merged_sha ? 'unknown' : 'not_included', via: null, evidence: rel.target_sha ? null : { reason: 'release target commit unknown' } });
          continue;
        }
        const direct = await graph.isAncestor(pr.merged_sha, rel.target_sha);
        if (direct === 'yes') {
          fix.releases.push({ ...base, status: 'verified', via: 'merged_commit', evidence: { commit: pr.merged_sha, method: 'commit_dag_ancestry', release_target: rel.target_sha } });
          continue;
        }
        let done = false;
        for (const b of verifiedBackports) {
          if ((await graph.isAncestor(b.from.slice(7), rel.target_sha)) === 'yes') {
            fix.releases.push({ ...base, status: 'verified', via: 'backport', evidence: { backport_commit: b.from.slice(7), provenance: b.provenance, method: 'commit_dag_ancestry' } });
            done = true;
            break;
          }
        }
        if (done) continue;
        for (const b of candidateBackports) {
          if ((await graph.isAncestor(b.from.slice(7), rel.target_sha)) === 'yes') {
            fix.releases.push({ ...base, status: 'unverified', via: 'candidate_backport', evidence: { candidate_commit: b.from.slice(7), provenance: b.provenance, reason: 'patch differs and no cherry-pick trailer or backport PR link' } });
            done = true;
            break;
          }
        }
        if (done) continue;
        fix.releases.push({ ...base, status: direct === 'unknown' ? 'unknown' : 'not_included', via: null, evidence: direct === 'unknown' ? { reason: 'history incomplete or traversal budget exhausted' } : null });
      }
      trace.fixes.push(fix);
    }

    const all = trace.fixes.flatMap((f) => f.releases.map((r) => ({ ...r, verifiedLink: f.confidence === 'verified' })));
    const firstVerified = all.filter((r) => r.status === 'verified' && r.verifiedLink).sort((a, b) => +a.published_at - +b.published_at)[0];
    const firstUnverified = all.filter((r) => r.status === 'verified' || r.status === 'unverified').sort((a, b) => +a.published_at - +b.published_at)[0];
    if (firstVerified) trace.fixed_in = { release_id: firstVerified.release_id, status: 'verified', via: firstVerified.via! };
    else if (firstUnverified) trace.fixed_in = { release_id: firstUnverified.release_id, status: 'unverified', via: firstUnverified.via ?? 'unknown' };
    if (!trace.fixes.length) notes.push('No pull request is linked to this issue by a closing keyword; no fix release can be claimed.');
    if (all.some((r) => r.status === 'unknown')) notes.push('Some releases could not be checked (missing history or traversal budget); they are reported as unknown.');
    trace.traversal.nodes_visited = graph.visited;
    return trace;
  }

  /** Writes the derived issue.fixed_in_release / fixed_in_status fields from the trace. */
  async updateIssueFix(repoId: string, number: number): Promise<void> {
    const t = await this.traceIssue(repoId, number);
    if (!t) return;
    const update = t.fixed_in
      ? { $set: { fixed_in_release: t.fixed_in.release_id, fixed_in_status: t.fixed_in.status } }
      : { $unset: { fixed_in_release: '', fixed_in_status: '' } };
    await this.db.collection('issues').updateOne({ repo_id: repoId, number }, update);
  }

  // ------------------------------------------------------------------ orchestration

  /** Full, idempotent rebuild of one repository's graph (used by seed, import and repair). */
  async rebuildRepo(repoId: string): Promise<void> {
    for (const pr of await this.db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId }, { projection: { number: 1 } }).toArray()) await this.buildPrEdges(repoId, pr.number);
    await this.detectBackports(repoId);
    for (const r of await this.db.collection<ReleaseDoc>('releases').find({ repo_id: repoId }).sort({ published_at: 1 }).toArray()) await this.computeRelease(repoId, r.release_id);
    await this.updateLinkedIssues(repoId);
  }

  private async updateLinkedIssues(repoId: string) {
    const linked = await this.edges().distinct('from', { repo_id: repoId, relation: 'ISSUE_FIXED_BY_PR' });
    for (const from of linked) await this.updateIssueFix(repoId, Number(String(from).slice(6)));
  }

  /** Graph projector: incremental updates per event (idempotent; safe to replay). */
  async handle(ev: StreamEvent): Promise<string> {
    const p = ev.payload as Record<string, unknown> & { repo_id: string };
    const repo = p.repo_id;
    switch (ev.type) {
      case 'pr.opened':
      case 'pr.updated':
      case 'pr.merged':
        await this.buildPrEdges(repo, Number(p.number));
        await this.detectBackports(repo);
        for (const n of (p.closes_issues as number[] | undefined) ?? []) await this.updateIssueFix(repo, n);
        return 'pr-edges';
      case 'issue.opened':
        await this.resolvePending(repo, `issue:${p.number}`);
        await this.updateIssueFix(repo, Number(p.number));
        return 'pending-resolved';
      case 'release.published':
      case 'release.updated':
        await this.computeRelease(repo, String(p.release_id));
        await this.updateLinkedIssues(repo);
        return 'release-computed';
      case 'commits.ingested':
        // New history can complete pending edges, backports and release ranges (tags may have moved).
        for (const e of await this.edges().find({ repo_id: repo, status: 'pending', to: /^commit:/ }).toArray()) await this.resolvePendingCommit(repo, e.to);
        await this.rebuildRepo(repo);
        return 'rebuilt';
      default:
        return 'ignored';
    }
  }

  private async resolvePendingCommit(repoId: string, node: string) {
    if (await this.db.collection('commits').countDocuments({ repo_id: repoId, sha: node.slice(7) }, { limit: 1 })) await this.resolvePending(repoId, node);
  }
}
