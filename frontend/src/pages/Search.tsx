import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Citation, type Repo, useApi } from '../api';
import { CitationCard, Empty, ErrorState, Loading } from '../ui';

const TYPES = [
  ['', 'All sources'],
  ['doc', 'Documentation'],
  ['release_notes', 'Release notes'],
  ['issue,comment', 'Issues and comments'],
  ['pr,comment', 'Pull requests and reviews'],
] as const;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const repos = useApi<{ items: Repo[] }>('/repos');
  const [form, setForm] = useState({
    q: params.get('q') ?? '',
    repo: params.get('repo') ?? '',
    label: params.get('label') ?? '',
    release: params.get('release') ?? '',
    type: params.get('type') ?? '',
    status: params.get('status') ?? 'all',
  });
  const qs = params.get('q') ? `/search?${params.toString()}` : null;
  const { data, error, loading, reload } = useApi<{ query_id: string; items: Citation[] }>(qs);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (v.trim()) next[k] = v.trim();
    setParams(next);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="stack">
      <h1>Search</h1>
      <form className="stack" onSubmit={submit} role="search">
        <div className="row">
          <label className="visually-hidden" htmlFor="q">Search query</label>
          <input id="q" value={form.q} onChange={set('q')} placeholder="e.g. default TLS minimum version" maxLength={200} style={{ flex: 1, minWidth: 200 }} />
          <button className="primary">Search</button>
        </div>
        <div className="filters">
          <label className="field">Repository
            <select value={form.repo} onChange={set('repo')}>
              <option value="">All readable repositories</option>
              {repos.data?.items.map((r) => <option key={r.repo_id} value={r.repo_id}>{r.full_name}</option>)}
            </select>
          </label>
          <label className="field">Source type
            <select value={form.type} onChange={set('type')}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className="field">Label<input value={form.label} onChange={set('label')} placeholder="e.g. security" maxLength={64} /></label>
          <label className="field">Release<input value={form.release} onChange={set('release')} placeholder="e.g. v2.4.1" maxLength={100} /></label>
          <label className="field">Show
            <select value={form.status} onChange={set('status')}>
              <option value="all">Current and historical (marked)</option>
              <option value="current">Current only</option>
            </select>
          </label>
        </div>
      </form>
      {loading && <Loading label="Searching…" />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && !data.items.length && <Empty>No results you can access match this search.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <p className="muted small">Every result was re-checked against your current access and the stored source before being shown.</p>
          {data.items.map((c) => <CitationCard key={c.chunk_id} c={c} />)}
        </>
      )}
    </div>
  );
}
