'use client';

import { useCallback, useEffect, useState } from 'react';
import SystemHealthPage from '../components/SystemHealthPage';
import IncidentsPage from '../components/IncidentsPage';
import { api, ApiError, errorMessage } from '../lib/api';
import { Notice } from '../components/ui';

type DeveloperUser = { email: string; role: 'developer' };

export default function DeveloperPortal() {
  const [developer, setDeveloper] = useState<DeveloperUser | null>(null);
  const [email, setEmail] = useState('developer@kpi.test');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'health' | 'incidents'>('health');
  const requireSignIn = useCallback(() => {
    setDeveloper(null);
    setError('Your developer session ended. Please sign in again.');
  }, []);

  useEffect(() => {
    let alive = true;
    api<DeveloperUser>('/developer/me')
      .then((result) => {
        if (alive) setDeveloper(result);
      })
      .catch((problem) => {
        if (alive && !(problem instanceof ApiError && problem.status === 401))
          setError(errorMessage(problem));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<DeveloperUser>('/developer/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setDeveloper(result);
      setPassword('');
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await api('/developer/logout', { method: 'POST' });
      setDeveloper(null);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="developer-access loading">Checking developer access…</main>;

  if (!developer)
    return (
      <main className="developer-access">
        <section className="panel developer-login" aria-labelledby="developer-login-heading">
          <span className="brand-mark" aria-hidden="true">
            K
          </span>
          <span className="eyebrow">Private developer portal</span>
          <h1 id="developer-login-heading">System health access</h1>
          <p>This login is separate from customer and bus-staff accounts.</p>
          <form onSubmit={signIn}>
            <fieldset className="form-stack" disabled={busy}>
              <label>
                Developer email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                Developer password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </fieldset>
            {error && <Notice>{error}</Notice>}
            <button className="button full-width" disabled={busy}>
              {busy ? 'Signing in…' : 'Open developer portal →'}
            </button>
          </form>
        </section>
      </main>
    );

  return (
    <>
      <header className="topbar developer-topbar">
        <div className="brand">
          <span className="brand-mark">K</span>KPi Developer
        </div>
        <div className="account">
          <div>
            <strong>{developer.email}</strong>
            <span>Developer</span>
          </div>
          <button className="button secondary small-button" disabled={busy} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="container developer-area" id="main-content">
        <nav className="segmented developer-tabs" aria-label="Developer portal sections">
          <button aria-pressed={tab === 'health'} onClick={() => setTab('health')}>
            System health
          </button>
          <button aria-pressed={tab === 'incidents'} onClick={() => setTab('incidents')}>
            Incidents
          </button>
        </nav>
        {error && <Notice>{error}</Notice>}
        {tab === 'health' ? (
          <SystemHealthPage onUnauthorized={requireSignIn} />
        ) : (
          <IncidentsPage onUnauthorized={requireSignIn} />
        )}
        <footer>
          <span>KPi Travels · Private developer observability</span>
          <span>Not part of customer or bus-staff portals</span>
        </footer>
      </main>
    </>
  );
}
