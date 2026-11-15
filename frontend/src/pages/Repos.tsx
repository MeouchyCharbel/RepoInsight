import { Link } from 'react-router';
import { type Repo, useApi } from '../api';
import { Empty, ErrorState, Loading } from '../ui';

export function ReposPage() {
  const { data, error, loading, reload } = useApi<{ items: Repo[] }>('/repos');
  return (
    <div className="stack">
      <h1>Repositories</h1>
      <p className="muted">Repositories you can read. Private repositories appear only while you are a member.</p>
      {loading && <Loading />}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && !data.items.length && <Empty>No repositories yet. Run <code>npm run seed</code> or import one.</Empty>}
      <ul className="list">
        {data?.items.map((r) => (
          <li key={r.repo_id}>
            <Link className="card link" to={`/repos/${r.repo_id}`}>
              <div className="spread">
                <strong>{r.full_name}</strong>
                <span className={`chip ${r.visibility === 'private' ? 'warn' : ''}`}>{r.visibility}</span>
              </div>
              {r.description && <p className="muted small" style={{ margin: '4px 0 0' }}>{r.description}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
