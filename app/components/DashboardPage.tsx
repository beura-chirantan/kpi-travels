'use client';

import { useEffect, useState } from 'react';
import { api, Dashboard, dateLabel, money, travelDate } from '../lib/api';
import { staffError } from '../lib/staff';
import { Notice, PageHeading } from './ui';
import BusRevenueList from './BusRevenueList';
import RevenueDialog from './RevenueDialog';

export default function DashboardPage({
  initialDate,
  onTrips,
}: {
  initialDate: string;
  onTrips: (date: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [monthlyOpen, setMonthlyOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<Dashboard>(`/admin/dashboard?date=${encodeURIComponent(selectedDate)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((error) => {
        if (alive) setError(staffError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [selectedDate, refresh]);

  function showDate(value: string) {
    if (!value) return;
    setLoading(true);
    setError('');
    setSelectedDate(value);
    setRefresh((n) => n + 1);
  }

  const label = dateLabel(selectedDate);
  // Never display the previous date's numbers under the newly selected date.
  const report = !loading && !error && data?.date === selectedDate ? data : null;

  return (
    <>
      <PageHeading
        eyebrow="Bus staff"
        title="Daily report"
        description="Revenue, customer ratings and seats for buses travelling on the selected date."
      >
        <button className="button" onClick={() => onTrips(selectedDate)}>
          See trips for this date →
        </button>
      </PageHeading>
      <section className="panel staff-filters" aria-label="Choose report date">
        <div className="staff-filter-row">
          <div className="staff-actions">
            {(
              [
                [-1, 'Yesterday'],
                [0, 'Today'],
                [1, 'Tomorrow'],
              ] as const
            ).map(([offset, name]) => (
              <button
                key={name}
                className="button secondary"
                aria-pressed={selectedDate === travelDate(offset)}
                onClick={() => showDate(travelDate(offset))}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="staff-actions">
            <label>
              Choose date
              <input
                type="date"
                required
                value={selectedDate}
                onChange={(event) => showDate(event.target.value)}
              />
            </label>
            <button
              className="button secondary"
              disabled={loading}
              onClick={() => showDate(selectedDate)}
            >
              {loading ? 'Updating…' : '↻ Update report'}
            </button>
          </div>
        </div>
      </section>
      {error && <Notice>{error} Use “Update report” to try again.</Notice>}
      <div aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="panel loading">Loading the report for {label}…</div>
        ) : (
          report && (
            <>
              <section className="dashboard-section" aria-label="Revenue">
                <button
                  className="panel revenue-hero"
                  onClick={() => setMonthlyOpen(true)}
                  aria-haspopup="dialog"
                >
                  <span>
                    {selectedDate === travelDate()
                      ? "Today's trip revenue"
                      : `Trip revenue for ${label}`}
                  </span>
                  <strong>{money(report.revenue.revenue_paise)}</strong>
                  <span>
                    {report.revenue.ticket_count}{' '}
                    {report.revenue.ticket_count === 1 ? 'ticket' : 'tickets'} · View daily, weekly,
                    monthly and yearly revenue →
                  </span>
                </button>
                <p className="small-note">
                  Value of confirmed tickets for buses leaving on {label}, even if customers bought
                  them earlier. Cancelled tickets are not counted. This demo does not collect
                  payments.
                </p>
                {report.revenue.demo_bookings > 0 && (
                  <p className="small-note">
                    Includes {report.revenue.demo_bookings} sample tickets added for testing.
                  </p>
                )}
              </section>
              <section className="dashboard-section" aria-labelledby="inventory-heading">
                <div className="panel-heading">
                  <div>
                    <h2 id="inventory-heading">Trips on {label}</h2>
                    <p>Only buses leaving on this date. All times are Indian time (IST).</p>
                  </div>
                </div>
                <div className="stats-grid">
                  <article className="panel stat">
                    <span>Number of trips</span>
                    <strong>{report.inventory.trip_count}</strong>
                    <p>Includes buses that left and cancelled trips</p>
                  </article>
                  <article className="panel stat">
                    <span>Total seats</span>
                    <strong>{report.inventory.total_seats.toLocaleString('en-IN')}</strong>
                    <p>Across all trips on this date</p>
                  </article>
                  <article className="panel stat">
                    <span>Seats booked</span>
                    <strong>{report.inventory.booked_seats.toLocaleString('en-IN')}</strong>
                    <p>Cancelled tickets not counted</p>
                  </article>
                  <article className="panel stat staff-highlight">
                    <span>Seats left to book</span>
                    <strong>{report.inventory.bookable_seats.toLocaleString('en-IN')}</strong>
                    <p>Only buses still open for booking</p>
                  </article>
                </div>
                <p className="small-note">
                  Seats left to book are only on buses that have not left and are open for booking.
                  Closed or cancelled trips are not included.
                </p>
                <details className="staff-help">
                  <summary>How are seats counted?</summary>
                  <p>
                    {report.inventory.total_seats.toLocaleString('en-IN')} total seats −{' '}
                    {report.inventory.booked_seats.toLocaleString('en-IN')} booked ={' '}
                    {report.inventory.unbooked_seats.toLocaleString('en-IN')} empty seats.
                  </p>
                  <p>
                    Some empty seats cannot be booked because the bus has left or booking is closed.
                    That is why “Seats left to book” can be lower.
                  </p>
                </details>
                {report.inventory.demo_bookings > 0 && (
                  <p className="small-note">
                    Includes {report.inventory.demo_bookings} sample tickets added for testing.
                  </p>
                )}
                <section className="bus-revenue-section" aria-labelledby="bus-revenue-heading">
                  <h2 id="bus-revenue-heading">Each bus: trip revenue & rating</h2>
                  <p>
                    Confirmed ticket value for buses leaving on {label}. Customer ratings are from
                    all dates.
                  </p>
                  <BusRevenueList buses={report.revenue.buses} />
                </section>
                <div className="dashboard-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Seats booked in each bus</h2>
                        <p>Trips on {label} only</p>
                      </div>
                    </div>
                    {report.occupancy.length ? (
                      <div className="occupancy-list">
                        {report.occupancy.map((bus) => (
                          <div key={bus.registration}>
                            <div className="bar-label">
                              <strong>{bus.bus_name}</strong>
                              <span>{bus.occupancy_rate}% booked</span>
                            </div>
                            <p>Bus number: {bus.registration}</p>
                            <div
                              className="meter"
                              role="meter"
                              aria-label={`${bus.bus_name}: seats booked on ${label}`}
                              aria-valuenow={bus.occupancy_rate}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <span style={{ width: `${bus.occupancy_rate}%` }} />
                            </div>
                            <p>
                              {bus.booked_seats} of {bus.total_seats} seats booked ·{' '}
                              {bus.trip_count} {bus.trip_count === 1 ? 'trip' : 'trips'}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No trips on this date.</p>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Bookings by route</h2>
                        <p>Travel on {label}. Cancelled tickets not counted.</p>
                      </div>
                    </div>
                    {report.route_demand.length ? (
                      <div className="demand-list">
                        {report.route_demand.map((route) => (
                          <div key={`${route.origin}-${route.destination}`}>
                            <div>
                              <strong>
                                {route.origin} → {route.destination}
                              </strong>
                            </div>
                            <span className="demand-count">
                              {route.bookings}
                              <small>tickets</small>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No booked tickets for travel on this date.</p>
                    )}
                  </section>
                </div>
              </section>
              <p className="small-note">
                Revenue follows the bus departure date, not the ticket purchase date. Totals use
                each ticket’s current price, bus and status, so cancellation or rescheduling can
                change a departure period.
              </p>
            </>
          )
        )}
      </div>
      {monthlyOpen && <RevenueDialog date={selectedDate} onClose={() => setMonthlyOpen(false)} />}
    </>
  );
}
