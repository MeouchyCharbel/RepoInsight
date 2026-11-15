import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { type Marker, useApi } from '../api';
import { ErrorState, formatDate, Loading, MarkerChip, SafeMarkdown } from '../ui';

interface DocResponse {
  source_id: string;
  kind: string;
  revision: number;
  latest_revision: number;
  commit_sha: string | null;
  committed_at: string;
  text: string;
  chunks: { chunk_id: string; section_anchor: string; heading_path: string[]; line_start: number; line_end: number; marker: Marker; superseded_by: { ref: string; reason: string } | null; release_ids: string[] }[];
  revisions: { revision: number; commit_sha: string | null; committed_at: string; release_ids: string[] }[];
}

export function DocPage() {
  const { repoId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? '';
  const rev = params.get('rev');
  const [from, to] = (params.get('lines') ?? '').split('-').map(Number);
  const [view, setView] = useState<'source' | 'rendered'>('source');
  const { data, error, loading, reload } = useApi<DocResponse>(source ? `/repos/${repoId}/document?source_id=${encodeURIComponent(source)}${rev ? `&revision=${rev}` : ''}` : null);
  const lines = useMemo(() => (data?.text ?? '').replace(/\r\n?/g, '\n').split('\n'), [data]);

  useEffect(() => {
    if (from) document.getElementById(`L${from}`)?.scrollIntoView({ block: 'center' });
  }, [data, from]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;
  const old = data.revision !== data.latest_revision;

  return (
    <div className="stack">
      <p className="small"><Link to={`/repos/${repoId}?tab=docs`}>← Documentation</Link></p>
      <div className="spread">
        <h1 className="mono" style={{ fontSize: '1.15rem' }}>{data.source_id}</h1>
        <span className="chip">revision {data.revision} of {data.latest_revision}</span>
      </div>
      <p className="muted small">Commit <span className="mono">{data.commit_sha?.slice(0, 12) ?? '—'}</span> · {formatDate(data.committed_at)}</p>
      {old && (
        <div className="callout warn">
          You are viewing an older revision. <button className="link" onClick={() => setParams({ source, rev: String(data.latest_revision) })}>Show latest</button>
        </div>
      )}

      <div className="grid-2">
        <div className="stack">
          <div className="row" role="group" aria-label="View">
            <button className={view === 'source' ? 'primary' : ''} onClick={() => setView('source')} aria-pressed={view === 'source'}>Source with line numbers</button>
            <button className={view === 'rendered' ? 'primary' : ''} onClick={() => setView('rendered')} aria-pressed={view === 'rendered'}>Rendered</button>
          </div>
          {view === 'source' ? (
            <div className="source" aria-label="Document source">
              {lines.map((l, i) => {
                const n = i + 1;
                return (
                  <div key={n} id={`L${n}`} className={`line ${from && to && n >= from && n <= to ? 'hl' : ''}`}>
                    <span className="no">{n}</span>
                    <span className="tx">{l || ' '}</span>
                  </div>
                );
              })}
            </div>
          ) : <div className="card"><SafeMarkdown text={data.text} /></div>}
        </div>
        <aside className="stack">
          <h2 className="section-title">Revisions</h2>
          <ul className="list small">
            {data.revisions.map((r) => (
              <li key={r.revision}>
                <button className={`link ${r.revision === data.revision ? 'active' : ''}`} aria-current={r.revision === data.revision} onClick={() => setParams({ source, rev: String(r.revision) })}>
                  rev {r.revision}
                </button>{' '}
                <span className="muted">{formatDate(r.committed_at)}</span>{' '}
                {r.release_ids.map((x) => <span key={x} className="chip label">{x}</span>)}
              </li>
            ))}
          </ul>
          <h2 className="section-title">Sections</h2>
          <ul className="list small">
            {data.chunks.map((c) => (
              <li key={c.chunk_id}>
                <button className="link" onClick={() => setParams({ source, rev: String(data.revision), lines: `${c.line_start}-${c.line_end}` })}>
                  {c.heading_path.join(' › ') || '(top)'} · L{c.line_start}-{c.line_end}
                </button>{' '}
                <MarkerChip marker={c.marker} />
                {c.superseded_by && <div className="muted">superseded by {c.superseded_by.ref}</div>}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
