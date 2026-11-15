import type { Db } from 'mongodb';
import { HttpError } from '../errors.js';
import { CommitGraph } from '../trace/graph.js';
import type { ReleaseDoc, RepositoryDoc } from '../types.js';

/** A release is security-relevant when its notes contain a "Security" section. */
export const isSecurityRelease = (body: string) => /^#{1,6}\s*security\b/im.test(body);

export interface EffectiveRelease {
  release_id: string;
  target_sha: string;
  published_at: Date;
  security_epoch: number; // number of security releases contained in this release
  basis: 'requested' | 'latest_stable_on_default_branch' | 'latest_stable_published';
}

/** The release authority could not be read: callers must not give current security guidance. */
export class ReleaseUnavailableError extends Error {}

/**
 * Effective-release resolver (report 9.2). Chosen by policy from authoritative MongoDB state, never
 * by search recency: an explicitly requested release, otherwise the newest stable release whose
 * target is on the default branch (proven by ancestry), otherwise the latest stable release.
 * Returns null when the repository has no usable release.
 */
export async function resolveEffective(db: Db, repoId: string, requested?: string): Promise<EffectiveRelease | null> {
  try {
    const rels = await db.collection<ReleaseDoc>('releases', { readConcern: { level: 'majority' } }).find({ repo_id: repoId }).toArray();
    const graph = new CommitGraph(db, repoId);
    let chosen: ReleaseDoc | undefined;
    let basis: EffectiveRelease['basis'];
    if (requested) {
      chosen = rels.find((r) => r.release_id === requested);
      if (!chosen) throw new HttpError(400, 'unknown_release', 'Unknown release');
      basis = 'requested';
    } else {
      const repo = await db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId });
      const head = await db.collection<{ head_sha: string }>('branches').findOne({ repo_id: repoId, name: repo?.default_branch ?? 'main' });
      const stable = rels.filter((r) => r.channel === 'stable' && r.target_sha);
      let bestGen = -1;
      if (head) {
        for (const r of stable) {
          const node = await graph.get(r.target_sha!);
          if (node && node.gen > bestGen && (await graph.isAncestor(r.target_sha!, head.head_sha)) === 'yes') {
            chosen = r;
            bestGen = node.gen;
          }
        }
      }
      basis = 'latest_stable_on_default_branch';
      if (!chosen) {
        chosen = stable.sort((a, b) => +b.published_at - +a.published_at)[0];
        basis = 'latest_stable_published';
      }
    }
    if (!chosen?.target_sha) return null;
    let epoch = 0;
    for (const r of rels) {
      if (r.target_sha && isSecurityRelease(r.body) && (await graph.isAncestor(r.target_sha, chosen.target_sha)) === 'yes') epoch++;
    }
    return { release_id: chosen.release_id, target_sha: chosen.target_sha, published_at: chosen.published_at, security_epoch: epoch, basis };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new ReleaseUnavailableError();
  }
}
