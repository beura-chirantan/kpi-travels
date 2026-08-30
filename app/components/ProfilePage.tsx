'use client';

import { useState } from 'react';
import { api, errorMessage, User } from '../lib/api';
import { Notice, PageHeading } from './ui';

export default function ProfilePage({
  user,
  onUpdated,
}: {
  user: User;
  onUpdated: (user: User) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const updated = await api<User>('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ name, email, phone: phone.trim() || null }),
      });
      setName(updated.name);
      setEmail(updated.email);
      setPhone(updated.phone || '');
      onUpdated(updated);
      setSaved(true);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Your account"
        title="My profile"
        description="Keep your contact details correct for your bookings and account."
      />
      <section className="profile-layout">
        <aside className="panel profile-summary">
          <span className="profile-avatar" aria-hidden="true">
            {(user.name.trim()[0] || 'C').toUpperCase()}
          </span>
          <h2>{user.name}</h2>
          <p>{user.email}</p>
          <span className="badge">Customer</span>
          <p className="small-note">
            The name shown in the top-right corner comes from this profile.
          </p>
        </aside>
        <form className="panel profile-form" onSubmit={submit}>
          <div>
            <h2>Basic details</h2>
            <p>These details belong to the signed-in customer account.</p>
          </div>
          <fieldset className="form-stack" disabled={busy}>
            <label>
              Full name
              <input
                type="text"
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={160}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <label>
              Phone number
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                minLength={9}
                maxLength={20}
                placeholder="For example, 98765 43210"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
          </fieldset>
          <p className="small-note">
            If you change the email address, use the new email the next time you sign in. Your
            password does not change.
          </p>
          {saved && <Notice tone="success">Profile saved. The header has been updated.</Notice>}
          {error && <Notice>{error}</Notice>}
          <div className="modal-actions">
            <button className="button" disabled={busy}>
              {busy ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
