'use client';

import { useEffect, useState } from 'react';
import AdminPage from './components/AdminPage';
import BookingDialog from './components/BookingDialog';
import BookingsPage from './components/BookingsPage';
import DashboardPage from './components/DashboardPage';
import SearchPage from './components/SearchPage';
import ProfilePage from './components/ProfilePage';
import { Modal, Notice } from './components/ui';
import { api, ApiError, BookingGroup, errorMessage, travelDate, Trip, User } from './lib/api';
import { staffError } from './lib/staff';

type Page = 'search' | 'bookings' | 'profile' | 'dashboard' | 'manage';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>('search');
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState('customer@kpi.test');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [pendingTrip, setPendingTrip] = useState<Trip | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [aiConfigured, setAiConfigured] = useState(false);
  const [staffDate, setStaffDate] = useState(travelDate());

  useEffect(() => {
    let alive = true;
    api<User>('/auth/me')
      .then((result) => {
        if (alive) {
          setUser(result);
          if (result.role === 'admin') setPage('manage');
        }
      })
      .catch((error) => {
        if (alive && !(error instanceof ApiError && error.status === 401))
          setError(errorMessage(error));
      })
      .finally(() => {
        if (alive) setAuthLoading(false);
      });
    api<{ ai_configured: boolean }>('/health')
      .then((result) => {
        if (alive) setAiConfigured(result.ai_configured);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  function navigate(next: Page) {
    setMessage('');
    setError('');
    if ((next === 'bookings' || next === 'profile') && !user) {
      setPendingTrip(null);
      setLoginError('');
      setLoginOpen(true);
      return;
    }
    setPage(next);
  }

  function selectTrip(trip: Trip) {
    if (!user) {
      setPendingTrip(trip);
      setLoginOpen(true);
      setLoginError('');
    } else if (user.role === 'customer') setSelectedTrip(trip);
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLoginError('');
    try {
      const result = await api<User>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setUser(result);
      setLoginOpen(false);
      setPassword('');
      setError('');
      setMessage('');
      if (result.role === 'admin') {
        setStaffDate(travelDate());
        setPage('manage');
      } else if (pendingTrip) {
        setPage('search');
        setSelectedTrip(pendingTrip);
      } else setPage('search');
      setPendingTrip(null);
    } catch (error) {
      setLoginError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
      setPage('search');
      setSelectedTrip(null);
      setPendingTrip(null);
      setMessage('');
    } catch (error) {
      setError(user?.role === 'admin' ? staffError(error) : errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function booked(group: BookingGroup) {
    setSelectedTrip(null);
    setPage('bookings');
    setMessage(
      `${group.ticket_count} ${group.ticket_count === 1 ? 'ticket' : 'tickets'} confirmed! Your ${group.ticket_count === 1 ? 'ticket is' : 'tickets are'} shown below.`,
    );
  }
  const admin = user?.role === 'admin';
  const navigation: [Page, string][] = admin
    ? [
        ['manage', 'Trips & buses'],
        ['dashboard', 'Daily report'],
      ]
    : [
        ['search', 'Find a bus'],
        ['bookings', 'My bookings'],
        ['profile', 'Profile'],
      ];

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <header className={`topbar ${admin ? 'staff-topbar' : ''}`}>
        <button
          className="brand"
          onClick={() => navigate(admin ? 'manage' : 'search')}
          aria-label="KPi Travels home"
        >
          <span className="brand-mark">K</span>KPi Travels
        </button>
        <nav aria-label="Main navigation">
          {navigation.map(([value, label]) => (
            <button
              key={value}
              disabled={authLoading}
              className={page === value ? 'nav-active' : ''}
              aria-current={page === value ? 'page' : undefined}
              onClick={() => navigate(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="account">
          {user ? (
            <>
              <div>
                <strong>{user.name}</strong>
                <span>{user.role === 'admin' ? 'Bus staff' : 'Customer'}</span>
              </div>
              <button className="button secondary small-button" onClick={logout} disabled={busy}>
                Sign out
              </button>
            </>
          ) : (
            <button
              className="button secondary"
              disabled={authLoading}
              onClick={() => {
                setPendingTrip(null);
                setLoginError('');
                setLoginOpen(true);
              }}
            >
              {authLoading ? 'Connecting…' : 'Sign in'}
            </button>
          )}
        </div>
      </header>
      <main className={`container ${admin ? 'staff-area' : ''}`} id="main-content">
        {error && <Notice>{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        {page === 'search' && (
          <SearchPage
            onBook={selectTrip}
            user={user}
            onSignIn={() => {
              setPendingTrip(null);
              setLoginError('');
              setLoginOpen(true);
            }}
          />
        )}
        {page === 'bookings' && user?.role === 'customer' && (
          <BookingsPage onSearch={() => navigate('search')} />
        )}
        {page === 'profile' && user?.role === 'customer' && (
          <ProfilePage
            user={user}
            onUpdated={(updated) => {
              setUser(updated);
              setEmail(updated.email);
            }}
          />
        )}
        {page === 'manage' && admin && <AdminPage date={staffDate} onDateChange={setStaffDate} />}
        {page === 'dashboard' && admin && (
          <DashboardPage
            initialDate={travelDate()}
            onTrips={(date) => {
              setStaffDate(date);
              navigate('manage');
            }}
          />
        )}
        <footer>
          <span>KPi Travels · Bus booking made simple</span>
          <span>
            {admin
              ? 'All times are in Indian time (IST)'
              : `${aiConfigured ? 'AI search configured' : 'AI not configured · offline helper available'} · All travel times in IST`}
          </span>
        </footer>
      </main>
      {loginOpen && (
        <Modal
          title="Welcome to KPi Travels"
          onClose={() => {
            setLoginOpen(false);
            setPendingTrip(null);
          }}
          busy={busy}
        >
          <p className="modal-description">
            {pendingTrip
              ? 'Sign in as a customer to complete your booking.'
              : 'Sign in to book a journey or manage your bus services.'}
          </p>
          <form onSubmit={login}>
            <fieldset className="form-stack" disabled={busy}>
              <label>
                Email address
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </fieldset>
            {loginError && <Notice>{loginError}</Notice>}
            <button className="button full-width" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
          <div className="demo-accounts">
            <span className="eyebrow">Local assessment demo</span>
            <p>Choose an account to fill the demo credentials.</p>
            <div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setEmail('customer@kpi.test');
                  setPassword('TravelDemo123!');
                }}
              >
                Customer demo
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setEmail('admin@kpi.test');
                  setPassword('TravelDemo123!');
                }}
              >
                Admin demo
              </button>
            </div>
            <small>Demo password: TravelDemo123! · Use sample passenger details only.</small>
          </div>
        </Modal>
      )}
      {selectedTrip && user?.role === 'customer' && (
        <BookingDialog
          key={selectedTrip.id}
          trip={selectedTrip}
          onClose={() => setSelectedTrip(null)}
          onBooked={booked}
        />
      )}
    </>
  );
}
