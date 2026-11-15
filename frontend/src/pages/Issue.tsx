import { Link, useParams } from 'react-router';
import { type Issue, type IssueTrace, useApi } from '../api';
import { Empty, ErrorState, formatDate, Labels, Loading, SafeMarkdown, StatusChip } from '../ui';

export function IssuePage() {
  const { repoId = '', number = '' } = useParams();
  const base = `/repos/${repoId}/issues/${number}`;
  const issue = useApi<Issue>(base);
  const comments = useApi<{ items: { comment_id: string; author_id: string; body: string; created_at: string }[] }>(`${base}/comments`);
  const revisions = useApi<{ items: { revision: number | null; state: string; title: string; source_updated_at: string; late: boolean }[] }>(`${base}/revisions`);
  const trace = useApi<IssueTrace>(`${base}/trace`);

  if (issue.loading && !issue.data) return <Loading />;
  if (issue.error || !issue.data) return <ErrorState error={issue.error} onRetry={issue.reload} />;
  const i = issue.data;

  return (
    <div className="stack">
      <p className="small"><Link to={`/repos/${repoId}`}>← Back to repository</Link></p>
      <div className="spread">
        <h1><span className="muted">#{i.number}</span> {i.title}</h1>
        <span className={`chip ${i.state === 'open' ? 'ok' : ''}`}>{i.state}</span>
      </div>
      <div className="row small"><Labels labels={i.labels} /><span className="muted">opened {formatDate(i.created_at)} · revision {i.revision}</span></div>

      <div className="grid-2">
        <div className="stack">
          <div className="card"><SafeMarkdown text={i.body || '_No description._'} /></div>
          <h2 className="section-title">Comments</h2>
          {comments.error ? <ErrorState error={comments.error} onRetry={comments.reload} /> : null}
          {comments.data && !comments.data.items.length && <Empty>No comments.</Empty>}
          {comments.data?.items.map((c) => (
            <div key={c.comment_id} className="card">
              <div className="muted small">{c.author_id} · {formatDate(c.created_at)}</div>
              <SafeMarkdown text={c.body} />
            </div>
          ))}
        </div>
        <aside className="stack">
          <h2 className="section-title">Revision history</h2>
          {revisions.data?.items.length ? (
            <ul className="list small">
              {revisions.data.items.map((r) => (
                <li key={r.source_updated_at} className="row">
                  <span className="chip">{r.revision ? `rev ${r.revision}` : 'late'}</span>
                  <span>{r.state}</span>
                  <span className="muted">{new Date(r.source_updated_at).toLocaleString()}</span>
                  {r.late && <span className="chip warn-outline" title="Arrived after a newer update; kept as history only">out of order</span>}
                </li>
              ))}
            </ul>
          ) : <p className="muted small">No recorded revisions.</p>}
        </aside>
      </div>

      <h2 className="section-title">Trace: issue → pull request → commit → release</h2>
      {trace.loading && <Loading label="Checking commit history…" />}
      {trace.error ? <ErrorState error={trace.error} onRetry={trace.reload} /> : null}
      {trace.data && <TraceView t={trace.data} />}
    </div>
  );
}

function TraceView({ t }: { t: IssueTrace }) {
  return (
    <div className="stack">
      <div className={`callout ${t.fixed_in?.status === 'verified' ? 'info' : 'warn'}`}>
        {t.fixed_in
          ? <>First fixed in <strong>{t.fixed_in.release_id}</strong> <StatusChip status={t.fixed_in.status} /> <span className="muted small">via {t.fixed_in.via.replace(/_/g, ' ')}</span></>
          : 'No release can be shown to contain a fix for this issue.'}
      </div>
      {t.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
      {t.fixes.map((f) => (
        <div key={f.pr.number} className="card">
          <div className="spread">
            <div><strong>PR #{f.pr.number}</strong> {f.pr.title}</div>
            <StatusChip status={f.confidence === 'verified' ? 'verified' : 'unverified'} />
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Link</dt><dd>{f.provenance.replace(/_/g, ' ')}</dd>
            <dt>Merged</dt><dd>{f.pr.merged_at ? formatDate(f.pr.merged_at) : 'not merged'}</dd>
            <dt>Merged commit</dt><dd className="mono">{f.merge.merged_sha?.slice(0, 12) ?? '—'} {f.merge.strategy && <span className="chip">{f.merge.strategy.replace(/_/g, ' ')} (inferred)</span>}</dd>
            <dt>PR commits</dt><dd className="mono small">{f.merge.head_commits.map((c) => c.slice(0, 8)).join(', ') || '—'}</dd>
          </dl>
          <p className="muted small">{f.merge.note}</p>
          <div style={{ marginTop: 8 }}>
            {f.releases.map((r) => (
              <div key={r.release_id} className="trace-release small">
                <strong>{r.release_id}</strong>
                <StatusChip status={r.status} />
                <span className="muted">{describeEvidence(r.via, r.evidence)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {t.mentions.map((m) => <p key={m.pr} className="small muted">PR #{m.pr}: {m.note}</p>)}
    </div>
  );
}

function describeEvidence(via: string | null, e: Record<string, unknown> | null): string {
  if (via === 'merged_commit') return `merged commit ${String(e?.commit).slice(0, 10)} is an ancestor of the release target`;
  if (via === 'backport') return `backport ${String(e?.backport_commit).slice(0, 10)} (${String(e?.provenance).replace(/_/g, ' ')}) is in the release`;
  if (via === 'candidate_backport') return `possible backport ${String(e?.candidate_commit).slice(0, 10)}: ${String(e?.reason)}`;
  if (e?.reason) return String(e.reason);
  return 'not in this release’s commit history';
}
