import { type ReactNode, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { api, type Citation, describeError, type Marker } from './api';
import { useAuth } from './auth';

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">RepoInsight</Link>
        {user && (
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Repositories</NavLink>
            <NavLink to="/search">Search</NavLink>
            <NavLink to="/ask">Ask</NavLink>
          </nav>
        )}
        {user && (
          <div className="user">
            <span>{user.username}</span>
            <button className="link" onClick={() => void logout().then(() => nav('/login'))}>Sign out</button>
          </div>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted" role="status">{label}</p>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="callout bad" role="alert">
      <div className="spread">
        <span>{describeError(error)}</span>
        {onRetry && <button onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="callout info muted">{children}</div>;
}

const MARKER: Record<Marker, [string, string, string]> = {
  current: ['ok', 'Current', 'Part of the current guidance'],
  superseded: ['warn', 'Superseded', 'Replaced by newer guidance; do not apply'],
  historical: ['', 'Historical', 'Older revision kept for history'],
  possibly_outdated: ['warn-outline', 'Possibly outdated', 'Older than the current documentation for the same setting (unverified)'],
  unknown: ['', 'Discussion', 'Discussion; not classified as guidance'],
};

export function MarkerChip({ marker }: { marker: Marker }) {
  const [cls, text, title] = MARKER[marker];
  return <span className={`chip ${cls}`} title={title}>{text}</span>;
}

const STATUS: Record<string, [string, string]> = {
  verified: ['ok', 'Verified'],
  unverified: ['warn-outline', 'Unverified'],
  not_included: ['', 'Not included'],
  unknown: ['', 'Unknown'],
};
export function StatusChip({ status }: { status: string }) {
  const [cls, text] = STATUS[status] ?? ['', status];
  return <span className={`chip ${cls}`}>{text}</span>;
}

export function Labels({ labels }: { labels: string[] }) {
  return <>{labels.map((l) => <span key={l} className="chip label">{l}</span>)}</>;
}

/** Untrusted repository text: raw HTML is not rendered, images are dropped, links open safely. */
export function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        disallowedElements={['img']}
        unwrapDisallowed
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a> }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Where a citation can be opened in the UI. */
export function sourceLink(c: Pick<Citation, 'repo_id' | 'source_type' | 'source_id' | 'revision' | 'line_start' | 'line_end'>): string | null {
  if (c.source_type === 'doc' || c.source_type === 'release_notes') {
    return `/repos/${c.repo_id}/doc?source=${encodeURIComponent(c.source_id)}&rev=${c.revision}&lines=${c.line_start}-${c.line_end}`;
  }
  const m = /^issue:(\d+)/.exec(c.source_id);
  return m ? `/repos/${c.repo_id}/issues/${m[1]}` : null;
}

export function CitationCard({ c, index }: { c: Citation; index?: number }) {
  const [check, setCheck] = useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; msg?: string }>({ state: 'idle' });
  const link = sourceLink(c);
  const verify = async () => {
    setCheck({ state: 'busy' });
    try {
      const r = await api<{ valid: boolean; reason: string | null }>('/citations/verify', { method: 'POST', body: { repo_id: c.repo_id, chunk_id: c.chunk_id } });
      setCheck(r.valid ? { state: 'ok', msg: `Lines ${c.line_start}-${c.line_end} match revision ${c.revision}` } : { state: 'bad', msg: `Not verified (${r.reason ?? 'mismatch'})` });
    } catch (e) {
      setCheck({ state: 'bad', msg: describeError(e) });
    }
  };
  return (
    <article className="card">
      <div className="spread">
        <div className="row">
          {index !== undefined && <span className="chip">[{index}]</span>}
          <MarkerChip marker={c.marker} />
          <span className="small muted">{c.repo_full_name}</span>
        </div>
        <div className="row">{c.release_ids.slice(0, 4).map((r) => <span key={r} className="chip label">{r}</span>)}</div>
      </div>
      <div style={{ marginTop: 6 }}>
        <strong>{c.thread_title ?? (c.heading_path.length ? c.heading_path.join(' › ') : c.source_id)}</strong>
      </div>
      <div className="cite">{c.cite}</div>
      {c.snippet && <div className="snippet">{c.snippet}</div>}
      {c.superseded_by && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          Superseded by {c.superseded_by.ref} ({c.superseded_by.reason.replace(/_/g, ' ')}
          {c.superseded_by.confidence === 'candidate' ? ', unverified match' : ''})
        </p>
      )}
      <div className="row small">
        {link && <Link to={link}>Open source</Link>}
        <button className="link" onClick={() => void verify()} disabled={check.state === 'busy'}>
          {check.state === 'busy' ? 'Verifying…' : 'Verify citation'}
        </button>
        {check.state === 'ok' && <span className="chip ok" role="status">✓ {check.msg}</span>}
        {check.state === 'bad' && <span className="chip bad" role="status">{check.msg}</span>}
      </div>
    </article>
  );
}

export function formatDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
