import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import type { PullRequestDoc } from '../types.js';
import { GitRepo } from './git.js';
import { GitHubClient, GitHubError, NAME_RE, RateLimitError } from './github.js';
import type { ApplyResult, IngestStore } from './store.js';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export interface StepProgress {
  status: StepStatus;
  processed: number;
  applied: number;
  duplicate: number;
  stale: number;
  error?: string;
}
export interface ImportJob {
  job_id: string;
  repo_full_name: string;
  repo_id: string | null;
  kind: 'initial' | 'update';
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'paused';
  since: Date | null; // lower bound used for incremental endpoints
  steps: Record<string, StepProgress>;
  started_at: Date;
  finished_at: Date | null;
  resume_after: Date | null;
  error: string | null;
}

const STEPS = ['repository', 'git', 'branches', 'commits', 'releases', 'issues', 'pulls', 'comments', 'review_comments', 'docs'] as const;
type Step = (typeof STEPS)[number];
const DEPENDENCIES: Partial<Record<Step, Step[]>> = {
  git: ['repository'],
  branches: ['git'],
  commits: ['git'],
  releases: ['git'],
  issues: ['repository'],
  pulls: ['repository'],
  comments: ['pulls'],
  review_comments: ['pulls'],
  docs: ['git'],
};
const SKEW_MS = 5 * 60 * 1000; // overlap window for "since" to tolerate clock skew
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
const MAX_DOC_REVISIONS = 10;
const MAX_PR_DETAILS = 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
type GhUser = { id: number; login: string } | null;

export interface ImporterOptions {
  dataDir: string;
  github: GitHubClient;
  cloneUrl?: (owner: string, name: string) => string;
}

/**
 * Initial and incremental import of one public GitHub repository (report 6.1). Each step records
 * progress and failure independently; dependent steps are skipped when a prerequisite fails.
 * Re-running is safe: every write is idempotent (entity keys + revision checks).
 */
export class Importer {
  constructor(
    private db: Db,
    private store: IngestStore,
    private opts: ImporterOptions,
  ) {}

  private jobs() {
    return this.db.collection<ImportJob>('import_jobs');
  }

  async createJob(fullName: string): Promise<ImportJob> {
    const [owner, name, extra] = fullName.split('/');
    if (!owner || !name || extra !== undefined || !NAME_RE.test(owner) || !NAME_RE.test(name)) {
      throw new GitHubError(400, 'Repository must be "owner/name"', false);
    }
    const last = await this.jobs().findOne(
      { repo_full_name: fullName, status: { $in: ['succeeded', 'partial'] } },
      { sort: { started_at: -1 } },
    );
    const job: ImportJob = {
      job_id: randomUUID(),
      repo_full_name: fullName,
      repo_id: last?.repo_id ?? null,
      kind: last ? 'update' : 'initial',
      status: 'running',
      since: last ? new Date(last.started_at.getTime() - SKEW_MS) : null,
      steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'pending', processed: 0, applied: 0, duplicate: 0, stale: 0 }])),
      started_at: new Date(),
      finished_at: null,
      resume_after: null,
      error: null,
    };
    await this.jobs().insertOne(job);
    return job;
  }

  async run(job: ImportJob): Promise<ImportJob> {
    const [owner, name] = job.repo_full_name.split('/') as [string, string];
    const gh = this.opts.github;
    const ctx: { repoId?: string; defaultBranch?: string; git?: GitRepo; tags?: Map<string, string> } = {};
    const people = new Map<number, string>();
    const user = (u: GhUser) => {
      if (!u) return 'gh:ghost';
      people.set(u.id, u.login);
      return `gh:${u.id}`;
    };
    const since = job.since ? `&since=${job.since.toISOString()}` : '';

    const handlers: Record<Step, (p: StepProgress) => Promise<void>> = {
      repository: async () => {
        const { data: r } = await gh.request<any>(`/repos/${owner}/${name}`);
        // Only public repositories are imported; private projects in the demo are synthetic.
        if (r.private) throw new GitHubError(403, 'Private repositories are not imported', false);
        ctx.defaultBranch = r.default_branch;
        ctx.repoId = await this.store.upsertRepository({
          provider: 'github',
          provider_id: r.id,
          org_id: `gh:${r.owner.id}`,
          full_name: r.full_name,
          description: r.description ?? undefined,
          visibility: 'public',
          default_branch: r.default_branch,
        });
        job.repo_id = ctx.repoId;
        await this.jobs().updateOne({ job_id: job.job_id }, { $set: { repo_id: ctx.repoId } });
      },
      git: async () => {
        const url = this.opts.cloneUrl?.(owner, name) ?? `https://github.com/${owner}/${name}.git`;
        ctx.git = await GitRepo.cloneOrFetch(url, join(this.opts.dataDir, 'git', `${ctx.repoId}.git`));
        ctx.tags = await ctx.git.tags();
      },
      branches: async (p) => {
        for (const b of await ctx.git!.branches()) {
          await this.store.upsertBranch(ctx.repoId!, b.name, b.sha);
          p.processed++;
          p.applied++;
        }
      },
      commits: async (p) => {
        const commits = await ctx.git!.commits();
        p.processed = commits.length;
        p.applied = await this.store.upsertCommits(ctx.repoId!, commits);
        p.duplicate = p.processed - p.applied;
      },
      releases: async (p) => {
        for await (const r of gh.paginate<any>(`/repos/${owner}/${name}/releases`)) {
          if (r.draft) continue;
          count(p, await this.store.upsertRelease({
            repo_id: ctx.repoId!,
            release_id: r.tag_name,
            name: r.name ?? r.tag_name,
            body: r.body ?? '',
            target_sha: ctx.tags!.get(r.tag_name) ?? null,
            published_at: new Date(r.published_at ?? r.created_at),
            prerelease: !!r.prerelease,
            source_updated_at: new Date(r.published_at ?? r.created_at),
          }));
        }
      },
      issues: async (p) => {
        for await (const i of gh.paginate<any>(`/repos/${owner}/${name}/issues?state=all&sort=updated&direction=asc${since}`)) {
          if (i.pull_request) continue; // the issues endpoint also lists PRs
          count(p, await this.store.upsertIssue({
            repo_id: ctx.repoId!,
            number: i.number,
            title: i.title,
            body: i.body ?? '',
            state: i.state,
            labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
            author_id: user(i.user),
            created_at: new Date(i.created_at),
            closed_at: i.closed_at ? new Date(i.closed_at) : null,
            source_updated_at: new Date(i.updated_at),
          }));
        }
      },
      pulls: async (p) => {
        let details = 0;
        // The pulls endpoint has no "since"; it is sorted by update time and stops at the bound.
        for await (const pr of gh.paginate<any>(`/repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc`)) {
          if (job.since && new Date(pr.updated_at) < job.since) break;
          let headCommits: string[] = [];
          if (pr.merged_at && details < MAX_PR_DETAILS) {
            details++;
            for await (const c of gh.paginate<any>(`/repos/${owner}/${name}/pulls/${pr.number}/commits`)) headCommits.push(c.sha);
            for await (const rv of gh.paginate<any>(`/repos/${owner}/${name}/pulls/${pr.number}/reviews`)) {
              if (!rv.body) continue;
              const ts = new Date(rv.submitted_at ?? pr.updated_at);
              await this.store.upsertComment({
                repo_id: ctx.repoId!, thread_key: `pr:${pr.number}`, comment_id: `review-${rv.id}`, kind: 'review',
                author_id: user(rv.user), body: rv.body, review_state: rv.state, created_at: ts, source_updated_at: ts,
              });
            }
          } else headCommits = [pr.head?.sha].filter(Boolean);
          const text = `${pr.title}\n${pr.body ?? ''}`;
          count(p, await this.store.upsertPullRequest({
            repo_id: ctx.repoId!,
            number: pr.number,
            title: pr.title,
            body: pr.body ?? '',
            state: pr.state,
            labels: (pr.labels ?? []).map((l: any) => l.name),
            author_id: user(pr.user),
            base_ref: pr.base?.ref ?? '',
            head_ref: pr.head?.ref ?? '',
            head_sha: pr.head?.sha ?? '',
            merged_at: pr.merged_at ? new Date(pr.merged_at) : null,
            merged_sha: pr.merged_at ? pr.merge_commit_sha : null,
            closes_issues: [...new Set([...text.matchAll(CLOSING)].map((m) => Number(m[1])))],
            head_commits: headCommits,
            created_at: new Date(pr.created_at),
            source_updated_at: new Date(pr.updated_at),
          }));
        }
      },
      comments: async (p) => {
        const prs = await this.prNumbers(ctx.repoId!);
        for await (const c of gh.paginate<any>(`/repos/${owner}/${name}/issues/comments?sort=updated&direction=asc${since}`)) {
          const n = Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? '')?.[1]);
          if (!n) continue;
          count(p, await this.store.upsertComment({
            repo_id: ctx.repoId!, thread_key: prs.has(n) ? `pr:${n}` : `issue:${n}`, comment_id: String(c.id), kind: 'issue_comment',
            author_id: user(c.user), body: c.body ?? '', created_at: new Date(c.created_at), source_updated_at: new Date(c.updated_at),
          }));
        }
      },
      review_comments: async (p) => {
        for await (const c of gh.paginate<any>(`/repos/${owner}/${name}/pulls/comments?sort=updated&direction=asc${since}`)) {
          const n = Number(/\/pulls\/(\d+)$/.exec(c.pull_request_url ?? '')?.[1]);
          if (!n) continue;
          count(p, await this.store.upsertComment({
            repo_id: ctx.repoId!, thread_key: `pr:${n}`, comment_id: String(c.id), kind: 'review_comment',
            author_id: user(c.user), body: c.body ?? '', file_path: c.path ?? null, diff_line: c.line ?? c.original_line ?? null,
            created_at: new Date(c.created_at), source_updated_at: new Date(c.updated_at),
          }));
        }
      },
      docs: async (p) => {
        await importDocs(this.store, ctx.git!, ctx.repoId!, ctx.defaultBranch!, p);
      },
    };

    let paused: RateLimitError | null = null;
    for (const step of STEPS) {
      const prog = job.steps[step]!;
      const blocked = (DEPENDENCIES[step] ?? []).some((d) => job.steps[d]!.status !== 'succeeded');
      if (paused || blocked) {
        prog.status = 'skipped';
        continue;
      }
      prog.status = 'running';
      await this.saveStep(job, step);
      try {
        await handlers[step](prog);
        prog.status = 'succeeded';
      } catch (e) {
        prog.status = 'failed';
        prog.error = safeMessage(e);
        if (e instanceof RateLimitError) {
          paused = e;
          job.resume_after = e.resetAt;
        }
      }
      await this.saveStep(job, step);
    }
    await this.store.upsertContributors([...people].map(([id, login]) => ({ contributor_id: `gh:${id}`, provider_login: login })));

    const statuses = Object.values(job.steps).map((s) => s.status);
    job.status = paused ? 'paused' : statuses.every((s) => s === 'succeeded') ? 'succeeded' : job.steps.repository!.status === 'succeeded' ? 'partial' : 'failed';
    job.finished_at = new Date();
    job.error = paused ? paused.message : (job.steps.repository!.error ?? null);
    await this.jobs().updateOne({ job_id: job.job_id }, { $set: { status: job.status, steps: job.steps, finished_at: job.finished_at, resume_after: job.resume_after, error: job.error } });
    return job;
  }

  private saveStep(job: ImportJob, step: string) {
    return this.jobs().updateOne({ job_id: job.job_id }, { $set: { [`steps.${step}`]: job.steps[step] } });
  }

  private async prNumbers(repoId: string) {
    const rows = await this.db.collection<PullRequestDoc>('pull_requests').find({ repo_id: repoId }, { projection: { number: 1 } }).toArray();
    return new Set(rows.map((r) => r.number));
  }
}

/** Documentation revisions from Git history: revision n = n-th commit that touched the file. */
export async function importDocs(store: IngestStore, git: GitRepo, repoId: string, ref: string, p: StepProgress) {
  for (const path of (await git.docPaths(ref)).slice(0, 200)) {
    const history = await git.fileHistory(ref, path);
    const first = Math.max(0, history.length - MAX_DOC_REVISIONS);
    for (let i = first; i < history.length; i++) {
      const h = history[i]!;
      const text = await git.show(h.sha, path);
      if (text === null) continue;
      count(p, await store.addDocumentRevision({ repo_id: repoId, source_id: path, revision: i + 1, kind: 'doc', commit_sha: h.sha, committed_at: h.date, text }));
    }
  }
}

function count(p: StepProgress, r: ApplyResult) {
  p.processed++;
  p[r]++;
}

/** Error text stored on jobs: our own messages only, never raw upstream bodies or tokens. */
function safeMessage(e: unknown): string {
  if (e instanceof GitHubError) return e.message;
  if (e instanceof Error && /git/i.test(e.message)) return 'Git operation failed';
  return 'Unexpected error (see server log)';
}
