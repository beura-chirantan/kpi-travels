'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, SeatHold, Trip } from './api';

type HoldStatus = 'idle' | 'loading' | 'active' | 'expired' | 'error';

export function holdTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function useSeatHold(
  trip: Trip | null,
  enabled = true,
  selection?: number | number[] | null,
) {
  const [hold, setHold] = useState<SeatHold | null>(null);
  const [status, setStatus] = useState<HoldStatus>('idle');
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const currentId = useRef<string | null>(null);
  const tripId = trip?.id;
  const tripPrice = trip?.price_paise;
  const seatIds = (Array.isArray(selection) ? [...selection] : selection ? [selection] : []).sort(
    (a, b) => a - b,
  );
  const selectionKey = seatIds.join(',');

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!tripId || !tripPrice || !enabled) return;
    let alive = true;
    const requestedSeatIds = selectionKey.split(',').filter(Boolean).map(Number);
    Promise.resolve()
      .then(() => {
        if (!alive) return null;
        setHold(null);
        setError('');
        setStatus('loading');
        return api<SeatHold>('/seat-holds', {
          method: 'POST',
          body: JSON.stringify({
            trip_id: tripId,
            seat_ids: requestedSeatIds.length ? requestedSeatIds : undefined,
            expected_price_paise: tripPrice,
          }),
        });
      })
      .then((result) => {
        if (!result) return;
        if (!alive) {
          void api<void>(`/seat-holds/${encodeURIComponent(result.id)}`, { method: 'DELETE' }).catch(
            () => {},
          );
          return;
        }
        currentId.current = result.id;
        setHold(result);
        setRemaining(Math.max(0, Math.ceil((new Date(result.expires_at).getTime() - Date.now()) / 1000)));
        setStatus('active');
      })
      .catch((reason) => {
        if (!alive) return;
        setError(errorMessage(reason));
        setStatus('error');
      });
    return () => {
      alive = false;
      const holdId = currentId.current;
      currentId.current = null;
      if (holdId)
        void api<void>(`/seat-holds/${encodeURIComponent(holdId)}`, { method: 'DELETE' }).catch(
          () => {},
        );
    };
  }, [tripId, tripPrice, selectionKey, enabled, attempt]);

  useEffect(() => {
    if (!hold || status !== 'active') return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((new Date(hold.expires_at).getTime() - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        const holdId = currentId.current;
        currentId.current = null;
        setStatus('expired');
        setError('Your seat hold expired. Hold the seat again to continue.');
        if (holdId)
          void api<void>(`/seat-holds/${encodeURIComponent(holdId)}`, { method: 'DELETE' }).catch(
            () => {},
          );
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [hold, status]);

  return { hold, status, error, remaining, retry };
}
