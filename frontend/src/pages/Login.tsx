import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { describeError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only same-app relative paths are accepted as a redirect target.
  const next = params.get('next')?.startsWith('/') && !params.get('next')!.startsWith('//') ? params.get('next')! : '/';

  if (user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      nav(next, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" style={{ maxWidth: 380, margin: '40px auto' }} onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted small">Demo users: alice, bob, carol, ops (password in your local .env).</p>
      <label className="field">
        Username
        <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} />
      </label>
      <label className="field">
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} />
      </label>
      {error && <div className="callout bad" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
