'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  BusType,
  dateLabel,
  duration,
  errorMessage,
  money,
  timeLabel,
  travelDate,
  Trip,
  User,
} from '../lib/api';
import { Empty, Notice } from './ui';
import CitySelect, { RatingBadge } from './CitySelect';
import { arrivalDayOffset, recommendedOrder } from '../lib/journey';
import AssistantChat from './AssistantChat';

type Filters = {
  origin: string;
  destination: string;
  travel_date: string;
  bus_type: string;
  time_of_day: string;
  arrival_time_of_day: string;
  max_price: string;
};

export default function SearchPage({
  onBook,
  user,
  onSignIn,
}: {
  onBook: (trip: Trip) => void;
  user: User | null;
  onSignIn: () => void;
}) {
  const [filters, setFilters] = useState<Filters>({
    origin: 'Hyderabad',
    destination: 'Bangalore',
    travel_date: travelDate(1),
    bus_type: '',
    time_of_day: '',
    arrival_time_of_day: '',
    max_price: '',
  });
  const [applied, setApplied] = useState(filters);
  const [mode, setMode] = useState<'regular' | 'natural'>('regular');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('recommended');
  const requestNumber = useRef(0);

  useEffect(() => {
    let alive = true;
    const initial = { origin: 'Hyderabad', destination: 'Bangalore', travel_date: travelDate(1) };
    Promise.all([api<string[]>('/cities'), api<Trip[]>(`/trips?${new URLSearchParams(initial)}`)])
      .then(([list, results]) => {
        if (alive) {
          setCities(list);
          setTrips(results);
        }
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
  }, []);

  function change(key: keyof Filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const ticket = ++requestNumber.current;
    setLoading(true);
    setError('');
    setTrips([]);
    try {
      if (filters.origin.toLowerCase() === filters.destination.toLowerCase())
        throw new Error('Choose two different cities.');
      const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const results = await api<Trip[]>(`/trips?${params}`);
      if (ticket !== requestNumber.current) return;
      setTrips(results);
      setApplied(filters);
    } catch (error) {
      if (ticket === requestNumber.current) setError(errorMessage(error));
    } finally {
      if (ticket === requestNumber.current) setLoading(false);
    }
  }

  const results = [...trips].sort((a, b) =>
    sort === 'price'
      ? a.price_paise - b.price_paise
      : sort === 'departure'
        ? Date.parse(a.departure_at) - Date.parse(b.departure_at)
        : recommendedOrder(a, b),
  );

  return (
    <>
      <section className="intro">
        <span className="eyebrow">A simpler way to travel</span>
        <h1>
          Your next journey,
          <br />
          <span>one booking away.</span>
        </h1>
        <p>Find the right bus, book your seat, and travel with peace of mind.</p>
      </section>
      <section className="panel search-panel">
        <div className="panel-heading">
          <div>
            <h2>Where are you headed?</h2>
            <p>Choose a route or tell us what you have in mind.</p>
          </div>
          <div className="segmented" aria-label="Search mode">
            <button
              aria-pressed={mode === 'regular'}
              disabled={loading}
              onClick={() => setMode('regular')}
            >
              By route
            </button>
            <button
              aria-pressed={mode === 'natural'}
              disabled={loading}
              onClick={() => setMode('natural')}
            >
              Ask AI
            </button>
          </div>
        </div>
        <form onSubmit={search}>
          {mode === 'regular' && (
            <>
              <div className="form-grid route-search-grid">
                <CitySelect
                  label="From"
                  cities={cities}
                  value={filters.origin}
                  onChange={(city) => change('origin', city)}
                />
                <button
                  type="button"
                  className="button secondary swap-button"
                  aria-label="Swap From and To cities"
                  title="Swap cities"
                  onClick={() => {
                    setFilters((current) => ({
                      ...current,
                      origin: current.destination,
                      destination: current.origin,
                    }));
                  }}
                >
                  ⇄
                </button>
                <CitySelect
                  label="To"
                  cities={cities}
                  value={filters.destination}
                  onChange={(city) => change('destination', city)}
                />
                <label>
                  Travel date
                  <input
                    type="date"
                    required
                    min={travelDate()}
                    value={filters.travel_date}
                    onChange={(e) => change('travel_date', e.target.value)}
                  />
                </label>
                <button className="button" disabled={loading}>
                  {loading ? 'Searching…' : 'Search buses →'}
                </button>
              </div>
              <div className="filter-row">
                <label>
                  Bus type
                  <select
                    value={filters.bus_type}
                    onChange={(e) => change('bus_type', e.target.value)}
                  >
                    <option value="">All types</option>
                    {(['AC', 'Non-AC', 'Sleeper'] as BusType[]).map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Departure time
                  <select
                    value={filters.time_of_day}
                    onChange={(e) => change('time_of_day', e.target.value)}
                  >
                    <option value="">Any time</option>
                    <option value="morning">Morning · 6am–12pm</option>
                    <option value="afternoon">Afternoon · 12pm–5pm</option>
                    <option value="evening">Evening · 5pm–9pm</option>
                    <option value="night">Night · 9pm–6am</option>
                  </select>
                </label>
                <label>
                  Arrival time
                  <select
                    value={filters.arrival_time_of_day}
                    onChange={(e) => change('arrival_time_of_day', e.target.value)}
                  >
                    <option value="">Any time</option>
                    <option value="morning">Morning · 6am–12pm</option>
                    <option value="afternoon">Afternoon · 12pm–5pm</option>
                    <option value="evening">Evening · 5pm–9pm</option>
                    <option value="night">Night · 9pm–6am</option>
                  </select>
                </label>
                <label>
                  Maximum fare (₹)
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    value={filters.max_price}
                    onChange={(e) => change('max_price', e.target.value)}
                    placeholder="Any budget"
                  />
                </label>
              </div>
            </>
          )}
          <div hidden={mode !== 'natural'}>
            <AssistantChat cities={cities} user={user} onSignIn={onSignIn} />
          </div>
        </form>
      </section>
      {mode === 'regular' && (
        <section className="section" aria-live="polite" aria-busy={loading}>
          <div className="panel-heading">
            <div>
              <h2>
                {loading
                  ? 'Finding available buses…'
                  : `${results.length} ${results.length === 1 ? 'bus' : 'buses'} available`}
              </h2>
              <p>
                {applied.origin || 'Origin'} → {applied.destination || 'Destination'}
                {applied.travel_date && ` · ${dateLabel(applied.travel_date)}`}
              </p>
            </div>
            <label className="sort-label">
              Sort by
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="recommended">Recommended · highest rated</option>
                <option value="price">Lowest fare</option>
                <option value="departure">Earliest departure</option>
              </select>
            </label>
          </div>
          {error && <Notice>{error}</Notice>}
          {loading ? (
            <div className="loading panel">Checking routes and live seat availability…</div>
          ) : results.length ? (
            <div className="trip-list">
              {results.map((trip) => (
                <article className="panel trip-card" key={trip.id}>
                  <div className="bus-info">
                    <div className="bus-mark" aria-hidden="true">
                      ↗
                    </div>
                    <div>
                      <h3>{trip.bus_name}</h3>
                      <p>{trip.registration}</p>
                      <div className="chips">
                        <span className="badge">{trip.bus_type}</span>
                        <RatingBadge average={trip.average_rating} count={trip.rating_count} />
                        {trip.preference_match && (
                          <span className="badge preferred">Matches your preference</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="journey">
                    <div>
                      <small>Departure</small>
                      <strong>{timeLabel(trip.departure_at)}</strong>
                      <span>{trip.origin}</span>
                    </div>
                    <div className="journey-line">
                      <span>{duration(trip)}</span>
                      <div>────────→</div>
                      <span>{dateLabel(trip.departure_at)}</span>
                    </div>
                    <div>
                      <small>Arrival</small>
                      <strong>{timeLabel(trip.arrival_at)}</strong>
                      <span>{trip.destination}</span>
                      {trip.arrival_at.slice(0, 10) !== trip.departure_at.slice(0, 10) && (
                        <small>
                          +{arrivalDayOffset(trip.departure_at, trip.arrival_at)} day(s) ·{' '}
                          {dateLabel(trip.arrival_at)}
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="trip-price">
                    <strong>{money(trip.price_paise)}</strong>
                    <span>per passenger</span>
                    <span className={trip.available_seats <= 5 ? 'low-seats' : 'seats'}>
                      {trip.available_seats} seats left
                    </span>
                  </div>
                  <button className="button" onClick={() => onBook(trip)}>
                    Book ticket →
                  </button>
                </article>
              ))}
            </div>
          ) : (
            !error && (
              <Empty title="No buses match this search">
                Try another date, a different route, or fewer filters. You haven’t been booked on
                anything.
              </Empty>
            )
          )}
        </section>
      )}
      <div className="assurance">
        <span>✓ Clear fares, no payment required in this demo</span>
        <span>✓ Cancel before departure</span>
        <span>✓ Book up to 6 passengers together</span>
      </div>
    </>
  );
}
