'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  BookingGroup,
  dateLabel,
  errorMessage,
  money,
  timeLabel,
  Trip,
  TripSeat,
} from '../lib/api';
import { holdTime, useSeatHold } from '../lib/seat-hold';
import { Modal, Notice } from './ui';
import SeatMap from './SeatMap';

export default function BookingDialog({
  trip,
  onClose,
  onBooked,
}: {
  trip: Trip;
  onClose: () => void;
  onBooked: (group: BookingGroup) => void;
}) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seats, setSeats] = useState<TripSeat[]>([]);
  const [seatsLoading, setSeatsLoading] = useState(true);
  const [selectedSeats, setSelectedSeats] = useState<TripSeat[]>([]);
  const [passengers, setPassengers] = useState<
    Record<number, { passenger_name: string; passenger_age: string }>
  >({});
  const requestKey = useRef('');
  const seatHold = useSeatHold(
    trip,
    selectedSeats.length > 0,
    selectedSeats.map((seat) => seat.id),
  );

  useEffect(() => {
    let alive = true;
    api<TripSeat[]>(`/trips/${trip.id}/seats`)
      .then((result) => {
        if (alive) setSeats(result);
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
  }, [trip.id]);

  function edited() {
    requestKey.current = '';
    setError('');
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!seatHold.hold || seatHold.status !== 'active') {
      setError('Hold a seat before confirming this booking.');
      return;
    }
    setBusy(true);
    setError('');
    requestKey.current ||= crypto.randomUUID();
    try {
      const group = await api<BookingGroup>('/booking-groups', {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey.current },
        body: JSON.stringify({
          trip_id: trip.id,
          hold_id: seatHold.hold.id,
          passengers: selectedSeats.map((seat) => ({
            seat_id: seat.id,
            passenger_name: passengers[seat.id]?.passenger_name || '',
            passenger_age: Number(passengers[seat.id]?.passenger_age),
          })),
          phone,
          expected_price_paise: trip.price_paise,
        }),
      });
      onBooked(group);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Complete your booking" onClose={onClose} busy={busy}>
      <div className="booking-summary">
        <span className="badge">{trip.bus_type}</span>
        <h3>
          {trip.origin} → {trip.destination}
        </h3>
        <p>
          {trip.bus_name} · Departs {dateLabel(trip.departure_at)} · {timeLabel(trip.departure_at)}{' '}
          IST
        </p>
        <p>
          Arrives {dateLabel(trip.arrival_at)} · {timeLabel(trip.arrival_at)} IST
        </p>
      </div>
      <section className="checkout-seats" aria-labelledby="choose-seat-heading">
        <h3 id="choose-seat-heading">1. Choose seats</h3>
        <p className="small-note">Select up to 6 seats for this booking.</p>
        {seatsLoading ? (
          <p className="small-note">Loading the seat map…</p>
        ) : seats.length ? (
          <SeatMap
            seats={seats}
            selectedId={null}
            selectedIds={selectedSeats.map((seat) => seat.id)}
            onSelect={(seat) => {
              const alreadySelected = selectedSeats.some((item) => item.id === seat.id);
              if (!alreadySelected && selectedSeats.length >= 6) {
                setError('You can book up to 6 tickets at a time.');
                return;
              }
              setSelectedSeats((current) =>
                alreadySelected
                  ? current.filter((item) => item.id !== seat.id)
                  : [...current, seat],
              );
              if (alreadySelected)
                setPassengers((current) => {
                  const next = { ...current };
                  delete next[seat.id];
                  return next;
                });
              requestKey.current = '';
              setError('');
            }}
          />
        ) : (
          <Notice>No seat layout is available for this bus.</Notice>
        )}
      </section>
      {seatHold.status === 'active' && (
        <Notice tone="info">
          <strong>
            Seats {seatHold.hold?.seats.map((seat) => seat.label).join(', ')} are held for you
          </strong>{' '}
          · Complete your booking within{' '}
          <span className="hold-time" aria-live="polite">
            {holdTime(seatHold.remaining)}
          </span>
          .
        </Notice>
      )}
      {seatHold.status === 'loading' && (
        <Notice tone="info">Holding {selectedSeats.length} selected seat(s) for you…</Notice>
      )}
      {(seatHold.status === 'error' || seatHold.status === 'expired') && (
        <Notice>
          {seatHold.error}{' '}
          <button type="button" className="text-button" onClick={seatHold.retry}>
            Hold a seat again
          </button>
        </Notice>
      )}
      <form onSubmit={submit}>
        <h3 className="checkout-step-heading">2. Passenger details</h3>
        <fieldset disabled={busy || seatHold.status !== 'active'} className="form-stack">
          {selectedSeats.map((seat, index) => (
            <div className="passenger-entry" key={seat.id}>
              <strong>Passenger {index + 1} · Seat {seat.label}</strong>
              <div className="two-columns passenger-fields">
                <label>
                  Full name
                  <input
                    autoComplete={index === 0 ? 'name' : 'off'}
                    value={passengers[seat.id]?.passenger_name || ''}
                    onChange={(event) => {
                      setPassengers((current) => ({
                        ...current,
                        [seat.id]: {
                          passenger_name: event.target.value,
                          passenger_age: current[seat.id]?.passenger_age || '',
                        },
                      }));
                      edited();
                    }}
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </label>
                <label>
                  Age
                  <input
                    type="number"
                    value={passengers[seat.id]?.passenger_age || ''}
                    onChange={(event) => {
                      setPassengers((current) => ({
                        ...current,
                        [seat.id]: {
                          passenger_name: current[seat.id]?.passenger_name || '',
                          passenger_age: event.target.value,
                        },
                      }));
                      edited();
                    }}
                    required
                    min={1}
                    max={120}
                  />
                </label>
              </div>
            </div>
          ))}
          <label>
            Contact phone number
            <input
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                edited();
              }}
              required
              pattern="\+?[0-9][0-9 \-]{8,18}"
              placeholder="9876543210"
            />
          </label>
        </fieldset>
        <div className="fare-line">
          <span>
            {selectedSeats.length} passenger{selectedSeats.length === 1 ? '' : 's'} · Total fare
          </span>
          <strong>{money(trip.price_paise * selectedSeats.length)}</strong>
        </div>
        <p className="small-note">
          The hold is not a booking. It is released if you go back or the timer ends. No payment is
          collected in this demo.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Go back
          </button>
          <button
            className="button"
            disabled={busy || seatHold.status !== 'active' || selectedSeats.length === 0}
          >
            {busy
              ? 'Confirming…'
              : `Confirm ${selectedSeats.length || ''} ticket${selectedSeats.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
