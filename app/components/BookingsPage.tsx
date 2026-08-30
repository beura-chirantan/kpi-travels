'use client';

import { useEffect, useState } from 'react';
import {
  api,
  Booking,
  dateLabel,
  downloadTicket,
  errorMessage,
  money,
  timeLabel,
} from '../lib/api';
import { Empty, Modal, Notice, PageHeading } from './ui';
import RescheduleDialog from './RescheduleDialog';
import RatingDialog from './RatingDialog';

export default function BookingsPage({ onSearch }: { onSearch: () => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('All');
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState('');
  const [rescheduling, setRescheduling] = useState<Booking | null>(null);
  const [rating, setRating] = useState<Booking | null>(null);
  const [downloading, setDownloading] = useState('');
  function updateBooking(result: Booking) {
    setBookings((current) =>
      current.map((booking) => (booking.id === result.id ? result : booking)),
    );
  }
  async function download(booking: Booking) {
    setDownloading(booking.id);
    setError('');
    try {
      await downloadTicket(booking.id);
      setMessage('Your PDF ticket has been downloaded.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setDownloading('');
    }
  }
  useEffect(() => {
    let alive = true;
    api<Booking[]>('/bookings')
      .then((data) => {
        if (alive) setBookings(data);
      })
      .catch((error) => {
        if (alive) setError(errorMessage(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refresh]);
  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<Booking>(`/bookings/${cancelling.id}/cancel`, { method: 'POST' });
      setBookings((current) =>
        current.map((booking) => (booking.id === result.id ? result : booking)),
      );
      setCancelling(null);
      setMessage('Booking cancelled. Your seat is available for other travellers again.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const visible = bookings.filter((booking) => filter === 'All' || booking.status === filter);
  return (
    <>
      <PageHeading
        eyebrow="Your journeys"
        title="My bookings"
        description="All your tickets, in one place."
      >
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError('');
            setRefresh((current) => current + 1);
          }}
        >
          ↻ Refresh
        </button>
        <button className="button" onClick={onSearch}>
          Find a bus →
        </button>
      </PageHeading>
      {message && <Notice tone="success">{message}</Notice>}
      {error && !cancelling && (
        <Notice>
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setLoading(true);
              setError('');
              setRefresh((n) => n + 1);
            }}
          >
            Retry
          </button>
        </Notice>
      )}
      <div className="panel-heading">
        <div className="segmented">
          {['All', 'Confirmed', 'Cancelled'].map((value) => (
            <button key={value} aria-pressed={value === filter} onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>
        <span className="muted">{visible.length} bookings</span>
      </div>
      {loading ? (
        <div className="loading panel">Loading your tickets…</div>
      ) : visible.length ? (
        <div className="booking-list">
          {visible.map((booking) => (
            <article className="panel ticket-card" key={booking.id}>
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Booking #{booking.id.slice(0, 8).toUpperCase()}</span>
                  <h2>
                    {booking.trip.origin} → {booking.trip.destination}
                  </h2>
                </div>
                <span className={`badge ${booking.status === 'Cancelled' ? 'cancelled' : ''}`}>
                  {booking.status}
                </span>
              </div>
              <div className="ticket-details">
                <div>
                  <span>Departure</span>
                  <strong>{dateLabel(booking.trip.departure_at)}</strong>
                  <p>{timeLabel(booking.trip.departure_at)} IST</p>
                </div>
                <div>
                  <span>Arrival</span>
                  <strong>{dateLabel(booking.trip.arrival_at)}</strong>
                  <p>{timeLabel(booking.trip.arrival_at)} IST</p>
                </div>
                <div>
                  <span>Bus</span>
                  <strong>{booking.trip.bus_name}</strong>
                  <p>{booking.trip.bus_type}</p>
                </div>
                <div>
                  <span>Passenger</span>
                  <strong>{booking.passenger_name}</strong>
                  <p>Age {booking.passenger_age} · 1 seat</p>
                </div>
                <div>
                  <span>Seat number</span>
                  <strong>{booking.seat?.seat_label || 'Not assigned'}</strong>
                  <p>{booking.seat ? `${booking.seat.deck} deck` : 'Ask bus staff'}</p>
                </div>
                <div>
                  <span>Booked fare</span>
                  <strong>{money(booking.total_paise)}</strong>
                  <p>No payment collected</p>
                </div>
              </div>
              {booking.trip.cancellation_reason && (
                <Notice>
                  Departure cancelled by the operator: {booking.trip.cancellation_reason}
                </Notice>
              )}
              {booking.reschedule_count > 0 && (
                <p className="small-note">
                  Rescheduled {booking.reschedule_count} time(s) · download a fresh ticket for this
                  itinerary.
                </p>
              )}
              <div className="ticket-actions">
                <button
                  className="button secondary small-button"
                  disabled={Boolean(downloading)}
                  onClick={() => download(booking)}
                >
                  {downloading === booking.id ? 'Downloading…' : '↓ Download PDF ticket'}
                </button>
                {booking.can_reschedule && (
                  <button
                    className="button secondary small-button"
                    onClick={() => {
                      setError('');
                      setRescheduling(booking);
                    }}
                  >
                    Reschedule
                  </button>
                )}
                {booking.can_rate ? (
                  <button
                    className="button secondary small-button"
                    onClick={() => setRating(booking)}
                  >
                    {booking.rating
                      ? `★ ${booking.rating.stars}/5 · Edit rating`
                      : '☆ Rate this bus'}
                  </button>
                ) : (
                  booking.status === 'Confirmed' && (
                    <span className="small-note">Rate this bus after arrival</span>
                  )
                )}
              </div>
              <div className="ticket-bottom">
                <span>Booked {dateLabel(booking.created_at)}</span>
                {booking.can_cancel ? (
                  <button
                    className="text-button danger-text"
                    onClick={() => {
                      setError('');
                      setCancelling(booking);
                    }}
                  >
                    Cancel booking
                  </button>
                ) : (
                  <span>
                    {booking.status === 'Cancelled'
                      ? 'Seat released'
                      : 'Departure passed · cancellation closed'}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        !error && (
          <Empty
            title={
              filter === 'All'
                ? 'Your next journey starts here'
                : `No ${filter.toLowerCase()} bookings`
            }
          >
            Search for a bus and confirm your first ticket.
          </Empty>
        )
      )}
      {cancelling && (
        <Modal title="Cancel this booking?" onClose={() => setCancelling(null)} busy={busy}>
          <p>
            {cancelling.passenger_name} · {cancelling.trip.origin} → {cancelling.trip.destination}
          </p>
          <p className="small-note">
            Your seat will be released immediately. This demo does not process payments or refunds.
          </p>
          {error && <Notice>{error}</Notice>}
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setCancelling(null)}
              disabled={busy}
            >
              Keep booking
            </button>
            <button className="button danger" onClick={cancel} disabled={busy}>
              {busy ? 'Cancelling…' : 'Yes, cancel booking'}
            </button>
          </div>
        </Modal>
      )}
      {rescheduling && (
        <RescheduleDialog
          key={rescheduling.id}
          booking={rescheduling}
          onClose={() => setRescheduling(null)}
          onSaved={(result) => {
            updateBooking(result);
            setRescheduling(null);
            setMessage(
              'Ticket rescheduled. Your original seat has been released. Download the updated ticket.',
            );
          }}
        />
      )}
      {rating && (
        <RatingDialog
          key={rating.id}
          booking={rating}
          onClose={() => setRating(null)}
          onSaved={(result) => {
            updateBooking(result);
            setRating(null);
            setMessage('Your bus rating has been saved and is visible to the administrator.');
          }}
        />
      )}
    </>
  );
}
