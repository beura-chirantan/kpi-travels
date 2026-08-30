'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  Booking,
  dateLabel,
  errorMessage,
  money,
  timeLabel,
  travelDate,
  Trip,
  TripSeat,
} from '../lib/api';
import { Modal, Notice } from './ui';
import SeatMap from './SeatMap';

export default function RescheduleDialog({
  booking,
  onClose,
  onSaved,
}: {
  booking: Booking;
  onClose: () => void;
  onSaved: (booking: Booking) => void;
}) {
  const [date, setDate] = useState(booking.trip.departure_at.slice(0, 10));
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loadedDate, setLoadedDate] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seats, setSeats] = useState<TripSeat[]>([]);
  const [selectedSeat, setSelectedSeat] = useState<TripSeat | null>(null);
  const [seatsLoading, setSeatsLoading] = useState(false);
  const requestKey = useRef('');
  useEffect(() => {
    let alive = true;
    if (!date) return;
    const params = new URLSearchParams({
      origin: booking.trip.origin,
      destination: booking.trip.destination,
      travel_date: date,
    });
    api<Trip[]>(`/trips?${params}`)
      .then((rows) => {
        if (alive) {
          setTrips(rows.filter((trip) => trip.id !== booking.trip_id));
          setLoadedDate(date);
        }
      })
      .catch((error) => {
        if (alive) {
          setError(errorMessage(error));
          setLoadedDate(date);
        }
      });
    return () => {
      alive = false;
    };
  }, [booking.trip.origin, booking.trip.destination, booking.trip_id, date]);
  const loading = loadedDate !== date;
  const target = !loading && trips.find((trip) => trip.id === Number(selected));
  useEffect(() => {
    if (!target) return;
    let alive = true;
    Promise.resolve()
      .then(() => {
        if (!alive) return [];
        setSeatsLoading(true);
        setSelectedSeat(null);
        return api<TripSeat[]>(`/trips/${target.id}/seats`);
      })
      .then((rows) => {
        if (alive) setSeats(rows);
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason));
      })
      .finally(() => {
        if (alive) setSeatsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!target || !selectedSeat) return;
    setBusy(true);
    setError('');
    requestKey.current ||= crypto.randomUUID();
    try {
      const result = await api<Booking>(`/bookings/${booking.id}/reschedule`, {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey.current },
        body: JSON.stringify({
          trip_id: target.id,
          seat_id: selectedSeat.id,
          expected_trip_id: booking.trip_id,
          expected_price_paise: target.price_paise,
        }),
      });
      onSaved(result);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Reschedule ticket" onClose={onClose} busy={busy}>
      <div className="booking-summary">
        <h3>
          {booking.trip.origin} → {booking.trip.destination}
        </h3>
        <p>
          Current: {dateLabel(booking.trip.departure_at)} · {timeLabel(booking.trip.departure_at)} ·{' '}
          {booking.trip.bus_name}
        </p>
        <p>
          {booking.passenger_name} · Current fare {money(booking.total_paise)}
        </p>
      </div>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="form-stack">
          <label>
            New departure date
            <input
              type="date"
              required
              min={travelDate()}
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setSelected('');
                setTrips([]);
                setError('');
                requestKey.current = '';
              }}
            />
          </label>
          {loading ? (
            <p role="status">Finding departures…</p>
          ) : trips.length ? (
            <label>
              Choose new bus / departure
              <select
                required
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setSelectedSeat(null);
                  setError('');
                  requestKey.current = '';
                }}
              >
                <option value="">Select a departure</option>
                {trips.map((trip) => (
                  <option key={trip.id} value={trip.id}>
                    {trip.bus_name} · {timeLabel(trip.departure_at)} · {money(trip.price_paise)} ·{' '}
                    {trip.available_seats} seats
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>No other available departures on this date. Choose another day.</p>
          )}
        </fieldset>
        {target && (
          <>
            <div className="booking-summary">
              <p>
                Departure: {dateLabel(target.departure_at)} · {timeLabel(target.departure_at)} IST
              </p>
              <p>
                Arrival: {dateLabel(target.arrival_at)} · {timeLabel(target.arrival_at)} IST
              </p>
              <strong>New fare: {money(target.price_paise)}</strong>
              <p>
                {target.price_paise === booking.total_paise
                  ? 'No fare difference.'
                  : `${money(Math.abs(target.price_paise - booking.total_paise))} ${target.price_paise > booking.total_paise ? 'higher' : 'lower'} than your current fare.`}
              </p>
            </div>
            <h3 className="checkout-step-heading">Choose a seat on the new bus</h3>
            {seatsLoading ? (
              <p className="small-note">Loading the seat map…</p>
            ) : (
              <SeatMap
                seats={seats}
                selectedId={selectedSeat?.id || null}
                onSelect={setSelectedSeat}
              />
            )}
          </>
        )}
        <p className="small-note">
          Your passenger and booking reference stay the same. The original seat is released only
          after the new seat is secured. No payments or refunds are processed in this demo.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Keep original
          </button>
          <button className="button" disabled={busy || !target || !selectedSeat}>
            {busy ? 'Rescheduling…' : 'Confirm reschedule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
