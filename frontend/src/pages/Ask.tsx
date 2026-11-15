import { type FormEvent, useEffect, useState } from 'react';
import { api, type Citation, describeError, type Repo, useApi } from '../api';
import { CitationCard, Loading } from '../ui';

interface Answer {
  query_id: string;
  effective_release: { release_id: string; basis: string; security_epoch: number } | null;
  answer: string;
  current: Citation[];
  supporting: Citation[];
  historical: Citation[];
  warnings: string[];
  method: string;
}

export function AskPage() {
  const repos = useApi<{ items: Repo[] }>('/repos');
  const [repo, setRepo] = useState('');
  const [query, setQuery] = useState('What should tls.min_version be set to?');
  const [release, setRelease] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string | null; answer: Answer | null }>({ busy: false, error: null, answer: null });

  useEffect(() => {
    if (!repo && repos.data?.items[0]) setRepo(repos.data.items.find((r) => r.repo_id === 'acme-tls-proxy')?.repo_id ?? repos.data.items[0].repo_id);
  }, [repos.data, repo]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: null, answer: null });
    try {
      const answer = await api<Answer>('/answer', { method: 'POST', body: { repo_id: repo, query: query.trim(), ...(release.trim() ? { release: release.trim() } : {}) } });
      setState({ busy: false, error: null, answer });
    } catch (err) {
      setState({ busy: false, error: describeError(err), answer: null });
    }
  };

  const a = state.answer;
  const numbered = a ? [...a.current, ...a.supporting, ...a.historical] : [];
  const n = (c: Citation) => numbered.indexOf(c) + 1;

  return (
    <div className="stack">
      <h1>Ask</h1>
      <p className="muted">Answers are assembled only from verified excerpts you are allowed to read. Current guidance comes from the effective release; superseded guidance is listed separately.</p>
      <form className="stack card" onSubmit={submit}>
        <div className="filters">
          <label className="field">Repository
            <select value={repo} onChange={(e) => setRepo(e.target.value)} required>
              {repos.data?.items.map((r) => <option key={r.repo_id} value={r.repo_id}>{r.full_name}</option>)}
            </select>
          </label>
          <label className="field">Release (optional)<input value={release} onChange={(e) => setRelease(e.target.value)} placeholder="effective release" maxLength={100} /></label>
        </div>
        <label className="field">Question<textarea value={query} onChange={(e) => setQuery(e.target.value)} required maxLength={200} /></label>
        <div><button className="primary" disabled={state.busy || !repo}>{state.busy ? 'Checking sources…' : 'Ask'}</button></div>
      </form>
      {state.busy && <Loading label="Checking access, resolving the effective release and verifying citations…" />}
      {state.error && <div className="callout bad" role="alert">{state.error}</div>}
      {a && (
        <div className="stack" aria-live="polite">
          <p className="small muted">
            Effective release: <strong>{a.effective_release?.release_id ?? 'not resolvable'}</strong>
            {a.effective_release && ` (${a.effective_release.basis.replace(/_/g, ' ')}, security epoch ${a.effective_release.security_epoch})`} · {a.method}
          </p>
          {a.warnings.map((w) => <div key={w} className="callout warn" role="alert">{w}</div>)}
          <div className="card"><div style={{ whiteSpace: 'pre-wrap' }}>{a.answer}</div></div>
          {a.current.length > 0 && <h2 className="section-title">Current guidance</h2>}
          {a.current.map((c) => <CitationCard key={c.chunk_id} c={c} index={n(c)} />)}
          {a.supporting.length > 0 && <h2 className="section-title">Related discussion</h2>}
          {a.supporting.map((c) => <CitationCard key={c.chunk_id} c={c} index={n(c)} />)}
          {a.historical.length > 0 && <h2 className="section-title">Historical or superseded (do not apply)</h2>}
          {a.historical.map((c) => <CitationCard key={c.chunk_id} c={c} index={n(c)} />)}
        </div>
      )}
    </div>
  );
}
