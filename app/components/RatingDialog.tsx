'use client';

import { useState } from 'react';
import { api, Booking, errorMessage } from '../lib/api';
import { Modal, Notice } from './ui';

export default function RatingDialog({
  booking,
  onClose,
  onSaved,
}: {
  booking: Booking;
  onClose: () => void;
  onSaved: (booking: Booking) => void;
}) {
  const [stars, setStars] = useState(booking.rating?.stars.toString() || '');
  const [comment, setComment] = useState(booking.rating?.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<Booking>(`/bookings/${booking.id}/rating`, {
          method: 'PUT',
          body: JSON.stringify({ stars: Number(stars), comment }),
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Rate ${booking.trip.bus_name}`} onClose={onClose} busy={busy}>
      <p>
        Rate your completed journey. Your rating contributes to this bus’s recommendation score.
      </p>
      <form onSubmit={save}>
        <fieldset className="form-stack" disabled={busy}>
          <label>
            Your rating
            <select value={stars} required onChange={(event) => setStars(event.target.value)}>
              <option value="">Choose 1–5 stars</option>
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={value}>
                  {'★'.repeat(value)} · {value} / 5
                </option>
              ))}
            </select>
          </label>
          <label>
            Feedback (optional)
            <textarea
              maxLength={1000}
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="How was the bus and your journey?"
            />
          </label>
        </fieldset>
        <p className="small-note">
          The administrator can see your rating, name and feedback. Do not include contact or
          payment details. Updating your rating replaces it; it does not add another vote.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Back
          </button>
          <button className="button" disabled={busy}>
            {busy ? 'Saving…' : 'Save rating'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
