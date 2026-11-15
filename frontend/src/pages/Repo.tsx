import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, type Citation, describeError, type IssueSummary, type Repo, useApi } from '../api';
import { CitationCard, Empty, ErrorState, formatDate, Labels, Loading, StatusChip } from '../ui';

const TABS = [
  ['issues', 'Issues'],
  ['docs', 'Documentation'],
  ['releases', 'Releases'],
  ['guidance', 'Guidance'],
  ['activity', 'Activity'],
  ['members', 'Members'],
] as const;

export function RepoPage() {
  const { repoId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'issues';
  const repo = useApi<Repo>(`/repos/${repoId}`);

  if (repo.loading && !repo.data) return <Loading />;
  if (repo.error || !repo.data) return <ErrorState error={repo.error} onRetry={repo.reload} />;
  const r = repo.data;
  const tabs = TABS.filter(([k]) => k !== 'members' || r.your_role === 'admin');

  return (
    <div>
      <div className="spread">
        <div>
          <h1>{r.full_name}</h1>
          {r.description && <p className="muted">{r.description}</p>}
        </div>
        <div className="row">
          <span className={`chip ${r.visibility === 'private' ? 'warn' : ''}`}>{r.visibility}</span>
          {r.your_role && <span className="chip">role: {r.your_role}</span>}
        </div>
      </div>
      <nav className="tabs" aria-label="Repository sections">
        {tabs.map(([k, label]) => (
          <a key={k} href={`?tab=${k}`} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); setParams({ tab: k }); }}>{label}</a>
        ))}
      </nav>
      {tab === 'issues' && <IssuesTab repoId={repoId} />}
      {tab === 'docs' && <DocsTab repoId={repoId} />}
      {tab === 'releases' && <ReleasesTab repoId={repoId} />}
      {tab === 'guidance' && <GuidanceTab repoId={repoId} />}
      {tab === 'activity' && <ActivityTab repoId={repoId} />}
      {tab === 'members' && r.your_role === 'admin' && <MembersTab repoId={repoId} />}
    </div>
  );
}

function IssuesTab({ repoId }: { repoId: string }) {
  const [label, setLabel] = useState('');
  const [state, setState] = useState('');
  const [items, setItems] = useState<IssueSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<{ loading: boolean; error: unknown }>({ loading: true, error: null });

  const load = async (append: string | null) => {
    setStatus({ loading: true, error: null });
    const qs = new URLSearchParams({ limit: '20' });
    if (label.trim()) qs.set('label', label.trim());
    if (state) qs.set('state', state);
    if (append) qs.set('cursor', append);
    try {
      const r = await api<{ items: IssueSummary[]; next_cursor: string | null }>(`/repos/${repoId}/issues?${qs}`);
      setItems((prev) => (append ? [...prev, ...r.items] : r.items));
      setCursor(r.next_cursor);
      setStatus({ loading: false, error: null });
    } catch (error) {
      setStatus({ loading: false, error });
    }
  };
  useEffect(() => { void load(null); }, [repoId, state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <form className="filters" onSubmit={(e: FormEvent) => { e.preventDefault(); void load(null); }}>
        <label className="field">Label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. security" maxLength={64} /></label>
        <label className="field">State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any</option><option value="open">Open</option><option value="closed">Closed</option>
          </select>
        </label>
        <button>Apply</button>
      </form>
      {status.error ? <ErrorState error={status.error} onRetry={() => void load(null)} /> : null}
      {!status.loading && !status.error && !items.length && <Empty>No issues match these filters.</Empty>}
      <ul className="list">
        {items.map((i) => (
          <li key={i.number}>
            <Link className="card link" to={`/repos/${repoId}/issues/${i.number}`}>
              <div className="spread">
                <span><span className="muted">#{i.number}</span> <strong>{i.title}</strong></span>
                <span className={`chip ${i.state === 'open' ? 'ok' : ''}`}>{i.state}</span>
              </div>
              <div className="row small" style={{ marginTop: 6 }}>
                <Labels labels={i.labels} />
                {i.fixed_in_release && <span className={`chip ${i.fixed_in_status === 'verified' ? 'ok' : 'warn-outline'}`}>fixed in {i.fixed_in_release}{i.fixed_in_status === 'verified' ? '' : ' (unverified)'}</span>}
                <span className="muted">updated {formatDate(i.updated_at)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {status.loading && <Loading />}
      {cursor && !status.loading && <button onClick={() => void load(cursor)}>Load more</button>}
    </div>
  );
}

function DocsTab({ repoId }: { repoId: string }) {
  const { data, error, loading, reload } = useApi<{ items: { source_id: string; kind: string; latest_revision: number; updated_at: string }[] }>(`/repos/${repoId}/documents`);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data?.items.length) return <Empty>No documentation imported for this repository.</Empty>;
  return (
    <ul className="list">
      {data.items.map((d) => (
        <li key={d.source_id}>
          <Link className="card link" to={`/repos/${repoId}/doc?source=${encodeURIComponent(d.source_id)}`}>
            <div className="spread">
              <span className="mono">{d.source_id}</span>
              <span className="row small"><span className="chip">{d.kind === 'release_notes' ? 'release notes' : 'doc'}</span><span className="muted">rev {d.latest_revision}</span></span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

interface ReleaseRow { release_id: string; name: string; published_at: string; channel: string; target_sha: string | null; prev_release_id: string | null }
interface FixRow { issue: { number: number; title: string; labels: string[] } | null; pr: number; via: string | null; commit: string | null; confidence: string }

function ReleasesTab({ repoId }: { repoId: string }) {
  const { data, error, loading, reload } = useApi<{ items: ReleaseRow[] }>(`/repos/${repoId}/releases`);
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data?.items.length) return <Empty>No releases.</Empty>;
  return (
    <ul className="list">
      {data.items.map((r) => (
        <li key={r.release_id} className="card">
          <div className="spread">
            <div>
              <strong>{r.release_id}</strong> <span className="muted small">{formatDate(r.published_at)}</span>
              <div className="cite">target {r.target_sha?.slice(0, 10) ?? 'unknown'}{r.prev_release_id ? ` · range ${r.prev_release_id}..${r.release_id}` : ''}</div>
            </div>
            <div className="row">
              <span className={`chip ${r.channel === 'stable' ? '' : 'warn'}`}>{r.channel}</span>
              <button className="link" aria-expanded={open === r.release_id} onClick={() => setOpen(open === r.release_id ? null : r.release_id)}>
                {open === r.release_id ? 'Hide fixes' : 'Fixes in this release'}
              </button>
            </div>
          </div>
          {open === r.release_id && <ReleaseFixes repoId={repoId} tag={r.release_id} />}
        </li>
      ))}
    </ul>
  );
}

function ReleaseFixes({ repoId, tag }: { repoId: string; tag: string }) {
  const { data, error, loading, reload } = useApi<{ verified: FixRow[]; unverified: FixRow[]; note: string }>(`/repos/${repoId}/releases/${encodeURIComponent(tag)}/issues`);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const row = (f: FixRow) => (
    <li key={`${f.pr}-${f.issue?.number}`} className="row small">
      <StatusChip status={f.confidence} />
      {f.issue ? <Link to={`/repos/${repoId}/issues/${f.issue.number}`}>#{f.issue.number} {f.issue.title}</Link> : <span>unknown issue</span>}
      <span className="muted">via PR #{f.pr} · {f.via?.replace(/_/g, ' ')} · <span className="mono">{f.commit?.slice(0, 10)}</span></span>
    </li>
  );
  return (
    <div style={{ marginTop: 10 }}>
      {!data!.verified.length && !data!.unverified.length && <p className="muted small">No linked fixes first shipped in this release range.</p>}
      <ul className="list">{data!.verified.map(row)}{data!.unverified.map(row)}</ul>
      <p className="muted small" style={{ marginTop: 6 }}>{data!.note}</p>
    </div>
  );
}

interface Compare { topic: string; effective_release: { release_id: string; basis: string } | null; current: Citation[]; historical: Citation[]; why_changed: Citation[]; notes: string[] }

function GuidanceTab({ repoId }: { repoId: string }) {
  const [topic, setTopic] = useState('tls.min_version');
  const [path, setPath] = useState<string | null>(`/repos/${repoId}/guidance/compare?topic=tls.min_version`);
  const { data, error, loading, reload } = useApi<Compare>(path);
  return (
    <div className="stack">
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setPath(`/repos/${repoId}/guidance/compare?topic=${encodeURIComponent(topic.trim())}`); }}>
        <label className="field">Configuration key<input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. tls.min_version" /></label>
        <button className="primary">Compare</button>
      </form>
      {loading && <Loading />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && (
        <>
          <p className="muted small">Effective release: <strong>{data.effective_release?.release_id ?? 'none'}</strong>{data.effective_release ? ` (${data.effective_release.basis.replace(/_/g, ' ')})` : ''}</p>
          {data.notes.map((n) => <div key={n} className="callout warn">{n}</div>)}
          <h2 className="section-title">Current guidance</h2>
          {data.current.length ? data.current.map((c) => <CitationCard key={c.chunk_id} c={c} />) : <Empty>No current documentation mentions this key.</Empty>}
          <h2 className="section-title">Historical and superseded</h2>
          {data.historical.length ? data.historical.map((c) => <CitationCard key={c.chunk_id} c={c} />) : <Empty>No superseded guidance found.</Empty>}
          <h2 className="section-title">Why it changed</h2>
          {data.why_changed.length ? data.why_changed.map((c) => <CitationCard key={c.chunk_id} c={c} />) : <Empty>No linked release notes or pull requests.</Empty>}
        </>
      )}
    </div>
  );
}

interface Activity { items: { day: string; opened?: number; closed?: number; reopened?: number; comments?: number; dirty?: boolean }[]; as_of: string | null; last_event_lag_seconds: number | null; unpublished_events: number; note: string }

function ActivityTab({ repoId }: { repoId: string }) {
  const { data, error, loading, reload } = useApi<Activity>(`/repos/${repoId}/activity`);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="callout info small">
        As of {data!.as_of ? new Date(data!.as_of).toLocaleString() : 'never (worker not run yet)'}
        {data!.last_event_lag_seconds !== null && ` · last event lag ${data!.last_event_lag_seconds.toFixed(1)} s`}
        {data!.unpublished_events > 0 && ` · ${data!.unpublished_events} events waiting to be processed`}
        <div className="muted">{data!.note}</div>
      </div>
      {!data!.items.length ? <Empty>No activity counted yet.</Empty> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} className="small">
            <thead><tr>{['Day', 'Opened', 'Closed', 'Reopened', 'Comments', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: 6 }}>{h}</th>)}</tr></thead>
            <tbody>
              {data!.items.map((d) => (
                <tr key={d.day} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: 6 }}>{d.day}</td><td style={{ padding: 6 }}>{d.opened ?? 0}</td><td style={{ padding: 6 }}>{d.closed ?? 0}</td>
                  <td style={{ padding: 6 }}>{d.reopened ?? 0}</td><td style={{ padding: 6 }}>{d.comments ?? 0}</td>
                  <td style={{ padding: 6 }}>{d.dirty && <span className="chip warn-outline" title="Late events arrived; scheduled for recompute">recompute pending</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MembersTab({ repoId }: { repoId: string }) {
  const { data, error, loading, reload } = useApi<{ items: { username: string | null; role: string; source: string }[] }>(`/repos/${repoId}/permissions`);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('read');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e) });
    }
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <p className="muted small">Changes are committed before this page confirms them; a revoked member loses access on their next request.</p>
      <ul className="list">
        {data!.items.map((m) => (
          <li key={m.username ?? m.role} className="card spread">
            <span><strong>{m.username}</strong> <span className="chip">{m.role}</span></span>
            {m.username && <button onClick={() => void run(() => api(`/repos/${repoId}/permissions/${encodeURIComponent(m.username!)}`, { method: 'DELETE' }), `Access revoked for ${m.username}.`)}>Revoke</button>}
          </li>
        ))}
      </ul>
      <form className="filters card" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/repos/${repoId}/permissions`, { method: 'POST', body: { username: username.trim(), role } }), `Granted ${role} to ${username.trim()}.`); }}>
        <label className="field">Username<input value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} /></label>
        <label className="field">Role
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="read">read</option><option value="write">write</option><option value="admin">admin</option></select>
        </label>
        <button className="primary">Grant access</button>
      </form>
      {msg && <div className={`callout ${msg.ok ? 'info' : 'bad'}`} role="status">{msg.text}</div>}
    </div>
  );
}
