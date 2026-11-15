import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to the API (same origin via the /api proxy; the session cookie is httpOnly). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('ri:unauthenticated'));
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Request failed');
  }
  return data as T;
}

/** Messages shown to users; a 404 never says whether the item exists. */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong.';
  if (e.status === 404) return "Not found, or you don't have access to it.";
  if (e.status === 403) return "You don't have permission to do that.";
  if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (e.status === 0 || e.status >= 500) return e.message || 'The service is temporarily unavailable.';
  return e.message;
}

export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    api<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState({ data: null, error, loading: false }));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ---- API shapes (subset used by the UI)

export type Marker = 'current' | 'historical' | 'superseded' | 'possibly_outdated' | 'unknown';
export interface Supersession { kind: 'revision' | 'release'; ref: string; reason: string; confidence: 'verified' | 'candidate' }
export interface Citation {
  chunk_id: string; repo_id: string; repo_full_name: string; source_type: 'doc' | 'release_notes' | 'issue' | 'pr' | 'comment';
  source_id: string; revision: number; commit_sha: string | null; section_anchor: string; heading_path: string[];
  line_start: number; line_end: number; cite: string; marker: Marker; release_ids: string[];
  superseded_by: Supersession | null; thread_title: string | null; labels: string[]; snippet?: string;
}
export interface Repo { repo_id: string; full_name: string; description: string | null; visibility: 'public' | 'private'; default_branch: string; your_role?: string | null }
export interface IssueSummary { number: number; title: string; state: 'open' | 'closed'; labels: string[]; updated_at: string; fixed_in_release: string | null; fixed_in_status: 'verified' | 'unverified' | null }
export interface Issue extends IssueSummary { body: string; author_id: string; revision: number; created_at: string }
export interface ReleaseInclusion { release_id: string; published_at: string; channel: string; status: 'verified' | 'unverified' | 'not_included' | 'unknown'; via: string | null; evidence: Record<string, unknown> | null }
export interface IssueTrace {
  issue: { number: number; title: string; state: string; labels: string[] };
  fixes: { pr: { number: number; title: string; state: string; merged_at: string | null }; provenance: string; confidence: string; merge: { merged_sha: string | null; strategy: string | null; head_commits: string[]; note: string }; releases: ReleaseInclusion[] }[];
  mentions: { pr: number; note: string }[];
  fixed_in: { release_id: string; status: 'verified' | 'unverified'; via: string } | null;
  notes: string[];
  traversal: { nodes_visited: number };
}
