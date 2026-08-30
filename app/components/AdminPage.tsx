'use client';

import { useEffect, useState } from 'react';
import {
  api,
  Bus,
  BusType,
  dateLabel,
  money,
  SeatDefinition,
  timeLabel,
  travelDate,
  Trip,
} from '../lib/api';
import { Empty, Modal, Notice, PageHeading } from './ui';
import CitySelect, { RatingBadge } from './CitySelect';
import BusReviewsDialog from './BusReviewsDialog';
import SeatLayoutEditor from './SeatLayoutEditor';
import { WEEKDAYS } from '../lib/journey';
import { inferTemplate, LayoutTemplate, makeLayout } from '../lib/seats';
import {
  selectedTripCount,
  selectedWeekdayPrices,
  staffError,
  staffTripStatus,
  weeklyPlanConflict,
  weeklyTripCount,
} from '../lib/staff';

type BusForm = {
  name: string;
  registration: string;
  bus_type: BusType;
  total_seats: number;
  layout: SeatDefinition[];
};
type TripForm = {
  bus_id: number;
  origin: string;
  destination: string;
  departure_at: string;
  arrival_at: string;
  price: string;
  active: boolean;
};
const freshTrip = (busId: number): TripForm => ({
  bus_id: busId,
  origin: 'Hyderabad',
  destination: 'Bangalore',
  departure_at: `${travelDate(1)}T07:00`,
  arrival_at: `${travelDate(1)}T15:00`,
  price: '850',
  active: true,
});
const freshWeekly = () => {
  const day = (new Date(`${travelDate(1)}T12:00:00+05:30`).getUTCDay() + 6) % 7;
  return {
    start_date: travelDate(1),
    end_date: travelDate(56),
    days: WEEKDAYS.map((_, index) => ({ day: index, selected: index === day, price: '850' })),
    arrival_day_offset: 0,
    departure_time: '07:00',
    arrival_time: '15:00',
  };
};

export default function AdminPage({
  date,
  onDateChange: setDate,
}: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  const [buses, setBuses] = useState<Bus[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tab, setTab] = useState<'trips' | 'fleet'>('trips');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busEditor, setBusEditor] = useState<Bus | 'new' | null>(null);
  const [tripEditor, setTripEditor] = useState<Trip | 'new' | null>(null);
  const [busForm, setBusForm] = useState<BusForm>({
    name: '',
    registration: '',
    bus_type: 'AC',
    total_seats: 40,
    layout: makeLayout('seater_2x2', 40),
  });
  const [layoutTemplate, setLayoutTemplate] = useState<LayoutTemplate>('seater_2x2');
  const [tripForm, setTripForm] = useState<TripForm>(freshTrip(0));
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [cities, setCities] = useState<string[]>([]);
  const [repeatWeekly, setRepeatWeekly] = useState(true);
  const [weekly, setWeekly] = useState(freshWeekly);
  const [cancelling, setCancelling] = useState<Trip | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [reviewBus, setReviewBus] = useState<Bus | null>(null);
  const [busFilter, setBusFilter] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([api<Bus[]>('/admin/buses'), api<Trip[]>('/admin/trips'), api<string[]>('/cities')])
      .then(([fleet, services, cityList]) => {
        if (alive) {
          setBuses(fleet);
          setTrips(services);
          setCities(cityList);
        }
      })
      .catch((error) => {
        if (alive) setError(staffError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  function editBus(bus: Bus | 'new') {
    setFormError('');
    setBusEditor(bus);
    if (bus === 'new') {
      setLayoutTemplate('seater_2x2');
      setBusForm({
        name: '',
        registration: '',
        bus_type: 'AC',
        total_seats: 40,
        layout: makeLayout('seater_2x2', 40),
      });
    } else {
      setLayoutTemplate(inferTemplate(bus.layout, bus.bus_type));
      setBusForm({
        name: bus.name,
        registration: bus.registration,
        bus_type: bus.bus_type,
        total_seats: bus.total_seats,
        layout: bus.layout,
      });
    }
  }
  function editTrip(trip: Trip | 'new') {
    setFormError('');
    setTripEditor(trip);
    setRepeatWeekly(trip === 'new');
    setWeekly(freshWeekly());
    setTripForm(
      trip === 'new'
        ? freshTrip(Number(busFilter) || buses[0]?.id || 0)
        : {
            bus_id: trip.bus_id,
            origin: trip.origin,
            destination: trip.destination,
            departure_at: trip.departure_at.slice(0, 16),
            arrival_at: trip.arrival_at.slice(0, 16),
            price: (trip.price_paise / 100).toString(),
            active: trip.active,
          },
    );
  }
  async function save(event: React.FormEvent, kind: 'bus' | 'trip') {
    event.preventDefault();
    if (kind === 'trip' && tripEditor === 'new' && repeatWeekly && weeklyConflictMessage) {
      setFormError(weeklyConflictMessage);
      return;
    }
    setBusy(true);
    setFormError('');
    const editor = kind === 'bus' ? busEditor : tripEditor;
    const isWeekly = kind === 'trip' && editor === 'new' && repeatWeekly;
    const path = isWeekly
      ? '/admin/weekly-schedules'
      : `/admin/${kind === 'bus' ? 'buses' : 'trips'}${editor && editor !== 'new' ? `/${editor.id}` : ''}`;
    const body =
      kind === 'bus'
        ? busForm
        : isWeekly
          ? {
              ...weekly,
              days: selectedWeekdayPrices(weekly.days),
              bus_id: tripForm.bus_id,
              origin: tripForm.origin,
              destination: tripForm.destination,
            }
          : {
              ...tripForm,
              departure_at: `${tripForm.departure_at}:00+05:30`,
              arrival_at: `${tripForm.arrival_at}:00+05:30`,
              price: tripForm.price,
            };
    try {
      const saved = await api<{ trip_count?: number }>(path, {
        method: editor === 'new' ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      setBusEditor(null);
      setTripEditor(null);
      setSuccess(
        isWeekly
          ? `${saved.trip_count} trips added. The last date is ${dateLabel(weekly.end_date)}. You can change or cancel each trip separately.`
          : `${kind === 'bus' ? 'Bus' : 'Trip'} saved successfully.`,
      );
      if (kind === 'trip') setDate(isWeekly ? '' : tripForm.departure_at.slice(0, 10));
      setTab(kind === 'trip' ? 'trips' : 'fleet');
      // A save should return staff to the complete list. Keeping the edited bus
      // selected here made unrelated buses look as though they had disappeared.
      setBusFilter('');
      setError('');
      setLoading(true);
      setRefresh((current) => current + 1);
    } catch (error) {
      setFormError(staffError(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancelTrip(event: React.FormEvent) {
    event.preventDefault();
    if (!cancelling) return;
    setBusy(true);
    setFormError('');
    try {
      const result = await api<Trip>(`/admin/trips/${cancelling.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelReason }),
      });
      setTrips((current) => current.map((trip) => (trip.id === result.id ? result : trip)));
      setCancelling(null);
      setSuccess('This trip and its tickets are cancelled. Trips on other dates have not changed.');
    } catch (error) {
      setFormError(staffError(error));
    } finally {
      setBusy(false);
    }
  }
  const services = trips.filter(
    (trip) =>
      (!date || trip.departure_at.startsWith(date)) &&
      (!busFilter || trip.bus_id === Number(busFilter)),
  );
  const visibleBuses = buses.filter((bus) => !busFilter || bus.id === Number(busFilter));
  const selectedDays = selectedWeekdayPrices(weekly.days);
  const plannedCount = selectedTripCount(weekly.start_date, weekly.end_date, weekly.days);
  const weeklyConflict = weeklyPlanConflict(
    weekly.start_date,
    weekly.end_date,
    weekly.days,
    weekly.departure_time,
    weekly.arrival_time,
    weekly.arrival_day_offset,
  );
  const weeklyConflictMessage = weeklyConflict
    ? `This new weekly plan overlaps itself. The ${WEEKDAYS[weeklyConflict.departureDay]} trip on ${dateLabel(weeklyConflict.departureDate)} reaches on ${dateLabel(weeklyConflict.arrivalDate)} at ${weekly.arrival_time}, after the next ${WEEKDAYS[weeklyConflict.nextDepartureDay]} trip leaves at ${weekly.departure_time}. Choose fewer days or an earlier arrival time. Nothing was saved.`
    : '';
  const arrivalDayLabel =
    weekly.arrival_day_offset === 0
      ? 'the same day'
      : weekly.arrival_day_offset === 1
        ? 'the next day'
        : `${weekly.arrival_day_offset} days later`;
  const setTrip = <K extends keyof TripForm>(key: K, value: TripForm[K]) =>
    setTripForm((current) => ({ ...current, [key]: value }));

  return (
    <>
      <PageHeading
        eyebrow="Bus staff"
        title="Trips & buses"
        description="Check today's trips, change timings, or add a bus."
      >
        <div className="staff-actions">
          <button
            className="button"
            disabled={loading || !buses.length}
            onClick={() => editTrip('new')}
          >
            + Add a trip
          </button>
          <button className="button secondary" disabled={loading} onClick={() => editBus('new')}>
            + Add a bus
          </button>
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError('');
              setRefresh((current) => current + 1);
            }}
          >
            ↻ Update list
          </button>
        </div>
      </PageHeading>
      {success && <Notice tone="success">{success}</Notice>}
      {error && (
        <Notice>
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setError('');
              setLoading(true);
              setRefresh((n) => n + 1);
            }}
          >
            Try again
          </button>
        </Notice>
      )}
      <section className="panel staff-filters" aria-label="Choose trips or buses">
        <div className="staff-filter-row">
          <div className="segmented">
            <button aria-pressed={tab === 'trips'} onClick={() => setTab('trips')}>
              Trips
            </button>
            <button aria-pressed={tab === 'fleet'} onClick={() => setTab('fleet')}>
              Buses & reviews
            </button>
          </div>
          <label className="staff-bus-filter">
            Choose bus
            <select value={busFilter} onChange={(event) => setBusFilter(event.target.value)}>
              <option value="">All buses</option>
              {buses.map((bus) => (
                <option key={bus.id} value={bus.id}>
                  {bus.name} · {bus.registration}
                </option>
              ))}
            </select>
          </label>
        </div>
        {tab === 'trips' && (
          <div className="staff-filter-row">
            <div className="staff-actions">
              <button
                className="button secondary"
                aria-pressed={date === travelDate()}
                onClick={() => setDate(travelDate())}
              >
                Today
              </button>
              <button
                className="button secondary"
                aria-pressed={date === travelDate(1)}
                onClick={() => setDate(travelDate(1))}
              >
                Tomorrow
              </button>
              <button className="button secondary" aria-pressed={!date} onClick={() => setDate('')}>
                All dates
              </button>
            </div>
            <label>
              Choose date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
        )}
      </section>
      {loading ? (
        <div className="panel loading">Loading trips and buses…</div>
      ) : error ? null : tab === 'fleet' && !visibleBuses.length ? (
        <Empty title="Add your first bus">Use “Add a bus” above. Then you can add its trips.</Empty>
      ) : tab === 'fleet' ? (
        <div className="staff-card-grid">
          {visibleBuses.map((bus) => (
            <article className="panel staff-card" key={bus.id}>
              <h2>{bus.name}</h2>
              <p className="staff-bus-number">Bus number: {bus.registration}</p>
              <p>
                {bus.bus_type} · {bus.total_seats} seats
              </p>
              <RatingBadge average={bus.average_rating} count={bus.rating_count} />
              <div className="staff-card-actions">
                <button className="button secondary" onClick={() => editBus(bus)}>
                  Change bus details
                </button>
                <button className="button secondary" onClick={() => setReviewBus(bus)}>
                  Read customer reviews
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : services.length ? (
        <section aria-label="Trips">
          <p className="staff-list-caption">
            {date ? dateLabel(date) : 'All dates'} · {services.length}{' '}
            {services.length === 1 ? 'trip' : 'trips'} · Indian time (IST)
          </p>
          <div className="staff-card-grid">
            {services.map((trip) => {
              const status = staffTripStatus(trip, clock);
              return (
                <article className="panel staff-card" key={trip.id}>
                  <div className="staff-card-heading">
                    <h2>{trip.bus_name}</h2>
                    <span className={`staff-status ${status.tone}`}>{status.label}</span>
                  </div>
                  <p className="staff-bus-number">
                    Bus number: {buses.find((bus) => bus.id === trip.bus_id)?.registration}
                  </p>
                  <h3 className="staff-route">
                    {trip.origin} → {trip.destination}
                  </h3>
                  <dl className="staff-trip-facts">
                    <div>
                      <dt>Leaves at</dt>
                      <dd>
                        {timeLabel(trip.departure_at)}
                        <span>{dateLabel(trip.departure_at)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Reaches at</dt>
                      <dd>
                        {timeLabel(trip.arrival_at)}
                        <span>{dateLabel(trip.arrival_at)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Ticket price</dt>
                      <dd>{money(trip.price_paise)}</dd>
                    </div>
                    <div>
                      <dt>{status.canBook ? 'Seats left' : 'Empty seats'}</dt>
                      <dd>
                        {trip.available_seats}
                        <span>
                          {trip.total_seats - trip.available_seats} booked · {trip.total_seats}{' '}
                          total
                        </span>
                      </dd>
                    </div>
                  </dl>
                  {trip.schedule_id && (
                    <p className="small-note">
                      Part of a weekly plan. Changes here apply only to this date.
                    </p>
                  )}
                  {trip.cancellation_reason && (
                    <p className="staff-cancel-reason">Reason: {trip.cancellation_reason}</p>
                  )}
                  {!status.canBook && !trip.cancellation_reason && (
                    <p className="small-note">No new tickets can be booked for this trip now.</p>
                  )}
                  {status.canChange && (
                    <div className="staff-card-actions">
                      <button className="button secondary" onClick={() => editTrip(trip)}>
                        Change this trip
                      </button>
                      <button
                        className="button secondary danger-outline"
                        onClick={() => {
                          setCancelling(trip);
                          setCancelReason('');
                          setFormError('');
                        }}
                      >
                        Cancel this trip
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <Empty title={date ? 'No trips on this date' : 'No trips found'}>
          Choose another date or bus, or use “Add a trip” above.
        </Empty>
      )}
      {busEditor && (
        <Modal
          title={busEditor === 'new' ? 'Add a bus' : 'Change bus details'}
          onClose={() => setBusEditor(null)}
          busy={busy}
        >
          <form onSubmit={(e) => save(e, 'bus')}>
            <fieldset className="form-stack" disabled={busy}>
              <label>
                Bus name
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={busForm.name}
                  onChange={(e) => setBusForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="KPi Express"
                />
              </label>
              <label>
                Bus number (number plate)
                <input
                  required
                  minLength={3}
                  maxLength={30}
                  value={busForm.registration}
                  onChange={(e) => setBusForm((f) => ({ ...f, registration: e.target.value }))}
                  placeholder="TS09 AB1234"
                />
              </label>
              <div className="two-columns">
                <label>
                  Bus type
                  <select
                    value={busForm.bus_type}
                    onChange={(e) => {
                      const busType = e.target.value as BusType;
                      const nextTemplate =
                        busType === 'Sleeper'
                          ? 'sleeper_2x1'
                          : layoutTemplate === 'sleeper_2x1'
                            ? 'seater_2x2'
                            : layoutTemplate;
                      setLayoutTemplate(nextTemplate);
                      setBusForm((form) => ({
                        ...form,
                        bus_type: busType,
                        layout:
                          nextTemplate === 'custom'
                            ? form.layout.map((seat) => ({
                                ...seat,
                                seat_type: busType === 'Sleeper' ? 'Sleeper' : 'Seat',
                              }))
                            : makeLayout(nextTemplate, form.total_seats),
                      }));
                    }}
                  >
                    <option>AC</option>
                    <option>Non-AC</option>
                    <option>Sleeper</option>
                  </select>
                </label>
                <label>
                  Number of seats
                  <input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={busForm.total_seats}
                    disabled={layoutTemplate === 'custom'}
                    onChange={(e) =>
                      setBusForm((form) => {
                        const count = Number(e.target.value);
                        return {
                          ...form,
                          total_seats: count,
                          layout:
                            layoutTemplate === 'custom'
                              ? form.layout
                              : makeLayout(layoutTemplate, count),
                        };
                      })
                    }
                  />
                </label>
              </div>
              <SeatLayoutEditor
                layout={busForm.layout}
                template={layoutTemplate}
                busType={busForm.bus_type}
                onTemplateChange={setLayoutTemplate}
                onChange={(layout) =>
                  setBusForm((form) => ({ ...form, layout, total_seats: layout.length }))
                }
              />
            </fieldset>
            <p className="small-note">
              This changes the seats on future trips. You cannot remove seats that are already
              booked.
            </p>
            {formError && <Notice>{formError}</Notice>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setBusEditor(null)}
                disabled={busy}
              >
                Go back
              </button>
              <button className="button" disabled={busy}>
                {busy ? 'Saving…' : 'Save bus'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {tripEditor && (
        <Modal
          title={tripEditor === 'new' ? 'Add a trip' : 'Change this trip'}
          onClose={() => setTripEditor(null)}
          busy={busy}
        >
          <form onSubmit={(e) => save(e, 'trip')}>
            <fieldset className="form-stack" disabled={busy}>
              <h3 className="staff-form-heading">1. Bus and route</h3>
              <label>
                Bus
                <select
                  required
                  value={tripForm.bus_id}
                  onChange={(e) => setTrip('bus_id', Number(e.target.value))}
                >
                  {buses.map((bus) => (
                    <option key={bus.id} value={bus.id}>
                      {bus.name} · {bus.registration} · {bus.total_seats} seats
                    </option>
                  ))}
                </select>
              </label>
              <div className="two-columns">
                <CitySelect
                  label="From"
                  cities={cities}
                  value={tripForm.origin}
                  onChange={(city) => setTrip('origin', city)}
                  allowCustom
                />
                <CitySelect
                  label="To"
                  cities={cities}
                  value={tripForm.destination}
                  onChange={(city) => setTrip('destination', city)}
                  allowCustom
                />
              </div>
              <h3 className="staff-form-heading">2. Days and times</h3>
              <p className="small-note">
                All times are Indian time (IST). For a night trip, choose the next day for arrival.
              </p>
              {tripEditor === 'new' && (
                <label>
                  How often does this bus run?
                  <select
                    value={repeatWeekly ? 'weekly' : 'once'}
                    onChange={(event) => setRepeatWeekly(event.target.value === 'weekly')}
                  >
                    <option value="weekly">Every week</option>
                    <option value="once">Only once</option>
                  </select>
                </label>
              )}
              {tripEditor === 'new' && repeatWeekly ? (
                <>
                  <div className="two-columns">
                    <label>
                      Start date
                      <input
                        type="date"
                        required
                        min={travelDate()}
                        value={weekly.start_date}
                        onChange={(event) =>
                          setWeekly((current) => ({ ...current, start_date: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Repeat until
                      <input
                        type="date"
                        required
                        min={weekly.start_date}
                        value={weekly.end_date}
                        onChange={(event) =>
                          setWeekly((current) => ({ ...current, end_date: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <fieldset className="form-stack weekday-fieldset">
                    <legend>Which days will this bus run?</legend>
                    <p className="small-note">Tap each day you want. Tap again to remove it.</p>
                    <div className="weekday-buttons">
                      {weekly.days.map((entry) => (
                        <button
                          type="button"
                          key={entry.day}
                          className="button secondary"
                          aria-label={WEEKDAYS[entry.day]}
                          aria-pressed={entry.selected}
                          onClick={() =>
                            setWeekly((current) => ({
                              ...current,
                              days: current.days.map((day) =>
                                day.day === entry.day ? { ...day, selected: !day.selected } : day,
                              ),
                            }))
                          }
                        >
                          <span>{WEEKDAYS[entry.day].slice(0, 3)}</span>
                          <span aria-hidden="true">{entry.selected ? '✓' : '+'}</span>
                        </button>
                      ))}
                    </div>
                    {!selectedDays.length && (
                      <p className="small-note" role="status">
                        Select at least one day to add trips.
                      </p>
                    )}
                  </fieldset>
                  <div className="two-columns">
                    <label>
                      Leaves at
                      <input
                        type="time"
                        required
                        value={weekly.departure_time}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            departure_time: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Reaches at
                      <input
                        type="time"
                        required
                        value={weekly.arrival_time}
                        onChange={(event) =>
                          setWeekly((current) => ({ ...current, arrival_time: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    When does the bus reach?
                    <select
                      value={weekly.arrival_day_offset}
                      onChange={(event) =>
                        setWeekly((current) => ({
                          ...current,
                          arrival_day_offset: Number(event.target.value),
                        }))
                      }
                    >
                      <option value={0}>Same day</option>
                      <option value={1}>Next day (night trip)</option>
                      {[2, 3, 4, 5, 6].map((offset) => (
                        <option key={offset} value={offset}>
                          {offset} days later
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="small-note">These times apply to every selected day.</p>
                  <div className="staff-schedule-summary" aria-live="polite">
                    <strong>
                      {plannedCount
                        ? `This will add ${plannedCount} ${plannedCount === 1 ? 'trip' : 'trips'}.`
                        : 'Choose at least one day within your date range.'}
                    </strong>
                    <p>
                      Runs only on{' '}
                      {selectedDays.length
                        ? selectedDays.map((entry) => WEEKDAYS[entry.day]).join(', ')
                        : 'the days you select'}
                      . Leaves at {weekly.departure_time} and reaches at {weekly.arrival_time}{' '}
                      {arrivalDayLabel}.
                    </p>
                    <p>
                      You can repeat trips for up to one year. Cancelling one trip will not cancel
                      the other dates.
                    </p>
                  </div>
                  {weeklyConflictMessage && <Notice>{weeklyConflictMessage}</Notice>}
                </>
              ) : (
                <div className="two-columns">
                  <label>
                    Leaves on (date and time)
                    <input
                      type="datetime-local"
                      required
                      value={tripForm.departure_at}
                      onChange={(e) => setTrip('departure_at', e.target.value)}
                    />
                  </label>
                  <label>
                    Reaches on (date and time)
                    <input
                      type="datetime-local"
                      required
                      value={tripForm.arrival_at}
                      onChange={(e) => setTrip('arrival_at', e.target.value)}
                    />
                  </label>
                </div>
              )}
              <h3 className="staff-form-heading">3. Ticket price</h3>
              {tripEditor === 'new' && repeatWeekly ? (
                <div className="weekday-prices">
                  <p>Set the ticket price for one person on each selected day.</p>
                  {selectedDays.map((entry) => (
                    <label className="weekday-price-row" key={entry.day}>
                      <span>
                        {WEEKDAYS[entry.day]} (₹)
                        <small>
                          {weeklyTripCount(weekly.start_date, weekly.end_date, entry.day)} trips in
                          this date range
                        </small>
                      </span>
                      <input
                        type="number"
                        required
                        min="0.01"
                        max="100000"
                        step="0.01"
                        value={entry.price}
                        onChange={(event) =>
                          setWeekly((current) => ({
                            ...current,
                            days: current.days.map((day) =>
                              day.day === entry.day ? { ...day, price: event.target.value } : day,
                            ),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <label>
                  Ticket price for one person (₹)
                  <input
                    type="number"
                    required
                    min="0.01"
                    max="100000"
                    step="0.01"
                    value={tripForm.price}
                    onChange={(e) => setTrip('price', e.target.value)}
                  />
                </label>
              )}
              {!(tripEditor === 'new' && repeatWeekly) && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={tripForm.active}
                    onChange={(e) => setTrip('active', e.target.checked)}
                  />
                  Allow customers to book this trip
                </label>
              )}
            </fieldset>
            {tripEditor !== 'new' && (
              <p className="small-note">
                Changes apply only to this date. If tickets have already been booked, the bus, route
                and times cannot be changed. You can still change the ticket price or stop new
                bookings. Existing tickets stay valid.
              </p>
            )}
            {!(tripEditor === 'new' && repeatWeekly) && (
              <p className="small-note">
                Turning off booking does not cancel tickets that are already booked.
              </p>
            )}
            {formError && <Notice>{formError}</Notice>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setTripEditor(null)}
                disabled={busy}
              >
                Go back
              </button>
              <button
                className="button"
                disabled={
                  busy ||
                  (tripEditor === 'new' &&
                    repeatWeekly &&
                    (!plannedCount || Boolean(weeklyConflictMessage)))
                }
              >
                {busy
                  ? 'Saving…'
                  : tripEditor === 'new' && repeatWeekly
                    ? `Save ${plannedCount} weekly ${plannedCount === 1 ? 'trip' : 'trips'}`
                    : 'Save trip'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {reviewBus && (
        <BusReviewsDialog key={reviewBus.id} bus={reviewBus} onClose={() => setReviewBus(null)} />
      )}
      {cancelling && (
        <Modal title="Cancel this trip?" onClose={() => setCancelling(null)} busy={busy}>
          <p>
            {cancelling.bus_name} · {cancelling.origin} → {cancelling.destination}
          </p>
          <p>
            {dateLabel(cancelling.departure_at)} · {timeLabel(cancelling.departure_at)} IST
          </p>
          <Notice tone="info">
            This will cancel this trip and all its tickets. There are currently{' '}
            {cancelling.total_seats - cancelling.available_seats} booked tickets. Other dates will
            not change. You cannot undo this.
          </Notice>
          <form onSubmit={cancelTrip}>
            <p>Choose a reason, or write your own below.</p>
            <div className="staff-actions staff-reason-options">
              {['Bus repair', 'Driver not available', 'Road closed'].map((reason) => (
                <button
                  key={reason}
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  aria-pressed={cancelReason === reason}
                  onClick={() => setCancelReason(reason)}
                >
                  {reason}
                </button>
              ))}
            </div>
            <label>
              Why is this trip cancelled?
              <textarea
                rows={2}
                required
                minLength={3}
                maxLength={300}
                disabled={busy}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
              />
            </label>
            <p className="small-note">
              Customers will see this reason. This demo does not collect or return money.
            </p>
            {formError && <Notice>{formError}</Notice>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCancelling(null)}
              >
                Keep this trip
              </button>
              <button className="button danger" disabled={busy}>
                {busy ? 'Cancelling…' : 'Yes, cancel trip'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
