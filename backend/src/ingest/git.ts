import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { CommitDoc } from '../types.js';

const run = promisify(execFile);
const MAX_PATHS = 100;
const MAX_DOC_BYTES = 1024 * 1024;
const DOC_RE = /(^|\/)(README|CHANGELOG|SECURITY|CONTRIBUTING|UPGRADING|MIGRATION)[^/]*\.md$|^docs?\/.+\.(md|markdown)$/i;
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.github)\//;

/**
 * Reads real Git history (report 5.2/5.3): commit DAG, tags and per-file document revisions.
 * Commands run without a shell (execFile + argument arrays); prompts are disabled.
 */
export class GitRepo {
  constructor(public gitDir: string) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', ['--git-dir', this.gitDir, ...args], {
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });
    return stdout;
  }

  /** Blobless bare clone (commits and trees only; file contents fetched on demand), or fetch. */
  static async cloneOrFetch(url: string, gitDir: string): Promise<GitRepo> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (existsSync(gitDir)) {
      await run('git', ['--git-dir', gitDir, 'fetch', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], { env, windowsHide: true });
    } else {
      mkdirSync(dirname(gitDir), { recursive: true });
      await run('git', ['clone', '--bare', '--filter=blob:none', '--quiet', url, gitDir], { env, windowsHide: true });
    }
    return new GitRepo(gitDir);
  }

  async branches(): Promise<{ name: string; sha: string }[]> {
    const out = await this.git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']);
    return lines(out).map((l) => {
      const [name, sha] = l.split('\t');
      return { name: name!, sha: sha! };
    });
  }

  /** Tag -> commit sha (annotated tags are peeled). */
  async tags(): Promise<Map<string, string>> {
    const out = await this.git(['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(*objectname)', 'refs/tags']);
    const map = new Map<string, string>();
    for (const l of lines(out)) {
      const [name, obj, peeled] = l.split('\t');
      map.set(name!, peeled || obj!);
    }
    return map;
  }

  /**
   * All commits reachable from any branch or tag, oldest first (topological), with generation
   * numbers: generation = 1 + max(parent generations).
   */
  async commits(): Promise<Omit<CommitDoc, 'repo_id'>[]> {
    const out = await this.git([
      'log', '--branches', '--tags', '--topo-order', '--reverse', '--no-renames', '--name-only',
      '--format=%x1e%H%x1f%P%x1f%ae%x1f%cI%x1f%B%x1f',
    ]);
    const gen = new Map<string, number>();
    const result: Omit<CommitDoc, 'repo_id'>[] = [];
    for (const rec of out.split('\x1e').slice(1)) {
      const [sha, parents, email, date, message, files] = rec.split('\x1f');
      const parent_shas = parents!.trim() ? parents!.trim().split(' ') : [];
      const generation = 1 + Math.max(0, ...parent_shas.map((p) => gen.get(p) ?? 0));
      gen.set(sha!, generation);
      const paths = lines(files ?? '');
      const trailer = /\(cherry picked from commit ([0-9a-f]{40})\)/.exec(message!);
      result.push({
        sha: sha!,
        parent_shas,
        generation,
        author_id: `email:${email!.toLowerCase()}`,
        committed_at: new Date(date!),
        message: message!.trim().slice(0, 4000),
        changed_paths: paths.slice(0, MAX_PATHS),
        changed_paths_truncated: paths.length > MAX_PATHS,
        cherry_picked_from: trailer ? trailer[1]! : null,
      });
    }
    return result;
  }

  /** Markdown documentation paths at a ref (README, CHANGELOG, SECURITY, docs/**). */
  async docPaths(ref: string): Promise<string[]> {
    const out = await this.git(['ls-tree', '-r', '--name-only', ref]);
    return lines(out).filter((p) => DOC_RE.test(p) && !VENDORED.test(p));
  }

  /** Commits that touched a path on a ref, oldest first; revision n = position in this list. */
  async fileHistory(ref: string, path: string): Promise<{ sha: string; date: Date }[]> {
    const out = await this.git(['log', '--format=%H%x1f%cI', '--reverse', ref, '--', path]);
    return lines(out).map((l) => {
      const [sha, date] = l.split('\x1f');
      return { sha: sha!, date: new Date(date!) };
    });
  }

  /**
   * `git patch-id --stable` of a non-merge commit: a hash of its diff that ignores line numbers,
   * the mechanism `git cherry` uses to recognise equivalent commits. Null for merges/empty diffs.
   */
  async patchId(sha: string): Promise<string | null> {
    const diff = await this.git(['show', '--format=', '--no-color', '--no-ext-diff', sha]);
    if (!diff.trim()) return null;
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn('git', ['--git-dir', this.gitDir, 'patch-id', '--stable'], { windowsHide: true });
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(s) : reject(new Error('git patch-id failed'))));
      p.stdin.end(diff);
    });
    return out.trim().split(' ')[0] || null;
  }

  /** File content at a commit, or null when absent (deleted) or larger than 1 MB. */
  async show(sha: string, path: string): Promise<string | null> {
    try {
      const size = Number((await this.git(['cat-file', '-s', `${sha}:${path}`])).trim());
      if (size > MAX_DOC_BYTES) return null;
      return await this.git(['show', `${sha}:${path}`]);
    } catch {
      return null;
    }
  }
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
