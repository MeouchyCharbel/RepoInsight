import type { Db } from 'mongodb';
import type { CommitDoc } from '../types.js';

export type Ancestry = 'yes' | 'no' | 'unknown';

interface Node {
  sha: string;
  parents: string[];
  gen: number;
}

export interface Budget {
  nodes: number;
  ms: number;
}

/** Max-heap of commits by generation number. */
class GenHeap {
  private a: Node[] = [];
  get size() {
    return this.a.length;
  }
  push(n: Node) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.gen >= a[i]!.gen) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.gen > a[m]!.gen) m = l;
        if (r < a.length && a[r]!.gen > a[m]!.gen) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Commit DAG queries over MongoDB `commits` (report 5.3). Generation numbers prune walks:
 * a commit can only be an ancestor of commits with a strictly higher generation. Every walk has a
 * node and time budget; when exhausted (or commits are missing) the answer is "unknown", never a
 * guess.
 */
export class CommitGraph {
  private cache = new Map<string, Node | null>();
  visited = 0;

  constructor(
    private db: Db,
    private repoId: string,
    private budget: Budget = { nodes: 50_000, ms: 3_000 },
  ) {}

  private async load(shas: string[]) {
    const missing = [...new Set(shas)].filter((s) => !this.cache.has(s));
    if (!missing.length) return;
    const rows = await this.db
      .collection<CommitDoc>('commits')
      .find({ repo_id: this.repoId, sha: { $in: missing } }, { projection: { sha: 1, parent_shas: 1, generation: 1 } })
      .toArray();
    for (const r of rows) this.cache.set(r.sha, { sha: r.sha, parents: r.parent_shas, gen: r.generation });
    for (const s of missing) if (!this.cache.has(s)) this.cache.set(s, null);
  }

  async get(sha: string): Promise<Node | null> {
    await this.load([sha]);
    return this.cache.get(sha) ?? null;
  }

  /** Is `a` an ancestor of (or equal to) `b`? */
  async isAncestor(a: string, b: string): Promise<Ancestry> {
    const [ca, cb] = [await this.get(a), await this.get(b)];
    if (!ca || !cb) return 'unknown';
    if (a === b) return 'yes';
    if (cb.gen <= ca.gen) return 'no'; // generation rule: immediate answer
    const started = Date.now();
    const seen = new Set<string>([b]);
    const heap = new GenHeap();
    heap.push(cb);
    let missing = false;
    while (heap.size) {
      const n = heap.pop()!;
      if (++this.visited > this.budget.nodes || Date.now() - started > this.budget.ms) return 'unknown';
      await this.load(n.parents);
      for (const p of n.parents) {
        if (p === a) return 'yes';
        if (seen.has(p)) continue;
        seen.add(p);
        const pn = this.cache.get(p);
        if (!pn) {
          missing = true;
          continue;
        }
        if (pn.gen > ca.gen) heap.push(pn); // nodes at or below gen(a) cannot reach a
      }
    }
    return missing ? 'unknown' : 'no';
  }

  /**
   * Commits reachable from `target` but not from `prev` (like `git log prev..target`), using
   * two-colour painting in generation order. `complete` is false if the budget ran out or
   * history was missing.
   */
  async range(target: string, prev: string | null): Promise<{ shas: string[]; complete: boolean }> {
    const T = 1;
    const P = 2;
    const flags = new Map<string, number>();
    const heap = new GenHeap();
    const queued = new Set<string>();
    let targetOnly = 0; // queued nodes not (yet) reachable from prev
    const started = Date.now();
    const out: string[] = [];
    let complete = true;

    const enqueue = async (sha: string, f: number) => {
      const before = flags.get(sha) ?? 0;
      const after = before | f;
      if (queued.has(sha)) {
        if (!(before & P) && after & P) targetOnly--;
        flags.set(sha, after);
        return;
      }
      if (before === after && before !== 0) return; // already processed with these colours
      const n = await this.get(sha);
      if (!n) {
        if (!(after & P)) complete = false; // history needed for the answer is missing
        return;
      }
      flags.set(sha, after);
      queued.add(sha);
      if (!(after & P)) targetOnly++;
      heap.push(n);
    };

    await enqueue(target, T);
    if (prev) await enqueue(prev, P);
    while (heap.size && targetOnly > 0) {
      if (++this.visited > this.budget.nodes || Date.now() - started > this.budget.ms) return { shas: out, complete: false };
      const n = heap.pop()!;
      queued.delete(n.sha);
      const f = flags.get(n.sha)!;
      if (!(f & P)) targetOnly--;
      if (f === T) out.push(n.sha);
      await this.load(n.parents);
      for (const p of n.parents) await enqueue(p, f);
    }
    return { shas: out, complete };
  }
}
