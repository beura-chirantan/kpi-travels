'use client';

import { useEffect, useState } from 'react';
import { api, dateLabel, money, MonthlyRevenue, RevenueSummary } from '../lib/api';
import { staffError } from '../lib/staff';
import { Modal, Notice } from './ui';
import BusRevenueList from './BusRevenueList';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type RevenueView = 'daily' | 'weekly' | 'monthly' | 'yearly';

export default function RevenueDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const initialYear = Number(date.slice(0, 4));
  const initialMonth = Number(date.slice(5, 7));
  const [view, setView] = useState<RevenueView>('daily');
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [selectedDate, setSelectedDate] = useState(date);
  const [selectedWeek, setSelectedWeek] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(initialMonth);
  const [selectedYear, setSelectedYear] = useState(initialYear);
  const [data, setData] = useState<MonthlyRevenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<MonthlyRevenue>(`/admin/revenue?year=${year}&month=${month}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!alive) return;
        if (
          result.year !== year ||
          result.month !== month ||
          !Array.isArray(result.days) ||
          !Array.isArray(result.weeks) ||
          !Array.isArray(result.months) ||
          !Array.isArray(result.years)
        ) {
          setData(null);
          setError(
            'The booking API is running an older revenue report. Restart the Python API, then try again.',
          );
          return;
        }
        setData(result);
      })
      .catch((reason) => {
        if (alive) setError(staffError(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [year, month, refresh]);

  function loadPeriod(nextYear: number, nextMonth = month) {
    if (!Number.isInteger(nextYear) || nextYear < 1 || nextYear > 9999) return;
    setLoading(true);
    setError('');
    setYear(nextYear);
    setMonth(nextMonth);
    setSelectedMonth(nextMonth);
    setSelectedYear(nextYear);
    setRefresh((current) => current + 1);
  }

  function moveMonth(offset: number) {
    const nextMonthIndex = month - 1 + offset;
    const nextYear = year + Math.floor(nextMonthIndex / 12);
    if (nextYear < 1 || nextYear > 9999) return;
    const normalizedMonth = ((nextMonthIndex % 12) + 12) % 12;
    setSelectedDate(`${nextYear}-${String(normalizedMonth + 1).padStart(2, '0')}-01`);
    setSelectedWeek('');
    loadPeriod(nextYear, normalizedMonth + 1);
  }

  function moveYear(offset: number) {
    const nextYear = year + offset;
    if (nextYear < 1 || nextYear > 9999) return;
    loadPeriod(nextYear);
  }

  const report = !loading && !error && data?.year === year && data.month === month ? data : null;
  const daily = report?.days.find((entry) => entry.date === selectedDate) || report?.days[0];
  const weekly =
    report?.weeks.find((entry) => entry.start_date === selectedWeek) ||
    report?.weeks.find(
      (entry) => entry.start_date <= selectedDate && entry.end_date >= selectedDate,
    ) ||
    report?.weeks[0];
  const monthly = report?.months.find((entry) => entry.month === selectedMonth);
  const yearly = report?.years.find((entry) => entry.year === selectedYear);
  const monthTotal = report?.days.reduce((sum, entry) => sum + entry.revenue_paise, 0) || 0;
  const recordedTotal = report?.years.reduce((sum, entry) => sum + entry.revenue_paise, 0) || 0;
  const firstWeekday = report?.days.length
    ? (new Date(`${report.days[0].date}T12:00:00Z`).getUTCDay() + 6) % 7
    : 0;

  let chosen: RevenueSummary | undefined;
  let chosenLabel = '';
  let chosenType = '';
  if (view === 'daily' && daily) {
    chosen = daily;
    chosenLabel = dateLabel(daily.date);
    chosenType = 'Selected day';
  } else if (view === 'weekly' && weekly) {
    chosen = weekly;
    chosenLabel = `${dateLabel(weekly.start_date)} – ${dateLabel(weekly.end_date)}`;
    chosenType = 'Selected week';
  } else if (view === 'monthly' && monthly) {
    chosen = monthly;
    chosenLabel = `${MONTHS[monthly.month - 1]} ${year}`;
    chosenType = 'Selected month';
  } else if (view === 'yearly' && yearly) {
    chosen = yearly;
    chosenLabel = String(yearly.year);
    chosenType = 'Selected year';
  }

  return (
    <Modal title="Revenue reports" onClose={onClose} wide>
      <p>
        Revenue follows each bus’s departure date, even when the ticket was purchased earlier.
        Choose a day, week, month or year. Cancelled tickets are not counted.
      </p>
      <div className="segmented revenue-view-tabs" aria-label="Choose revenue report">
        {(
          [
            ['daily', 'Daily'],
            ['weekly', 'Weekly'],
            ['monthly', 'Monthly'],
            ['yearly', 'Yearly'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="revenue-period-controls">
        {(view === 'daily' || view === 'weekly') && (
          <div className="revenue-period-nav" aria-label="Choose month">
            <button
              type="button"
              className="button secondary"
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
            >
              ←
            </button>
            <strong>
              {MONTHS[month - 1]} {year}
            </strong>
            <button
              type="button"
              className="button secondary"
              aria-label="Next month"
              onClick={() => moveMonth(1)}
            >
              →
            </button>
          </div>
        )}
        {view === 'monthly' && (
          <div className="revenue-period-nav" aria-label="Choose year">
            <button
              type="button"
              className="button secondary"
              aria-label="Previous year"
              onClick={() => moveYear(-1)}
            >
              ←
            </button>
            <strong>{year}</strong>
            <button
              type="button"
              className="button secondary"
              aria-label="Next year"
              onClick={() => moveYear(1)}
            >
              →
            </button>
          </div>
        )}
        {view === 'yearly' && <strong className="revenue-all-years">All recorded years</strong>}
      </div>

      {error && (
        <Notice>
          {error}{' '}
          <button className="text-button" onClick={() => loadPeriod(year)}>
            Try again
          </button>
        </Notice>
      )}
      {loading && <p role="status">Loading revenue…</p>}

      {report && chosen && (
        <section className="revenue-focus" aria-label={`${chosenType} revenue`}>
          <div>
            <span>{chosenType}</span>
            <strong>{chosenLabel}</strong>
          </div>
          <div>
            <span>Revenue</span>
            <strong>{money(chosen.revenue_paise)}</strong>
          </div>
          <div>
            <span>Tickets</span>
            <strong>{chosen.ticket_count}</strong>
          </div>
        </section>
      )}

      {report && view === 'daily' && (
        <section aria-labelledby="daily-revenue-heading">
          <div className="revenue-report-heading">
            <div>
              <h3 id="daily-revenue-heading">
                Daily revenue · {MONTHS[month - 1]} {year}
              </h3>
              <p>Select a date to see that day’s buses below.</p>
            </div>
            <p>
              <span>Month total</span>
              <strong>{money(monthTotal)}</strong>
            </p>
          </div>
          <div
            className="revenue-calendar"
            role="grid"
            aria-label={`Daily revenue for ${MONTHS[month - 1]} ${year}`}
          >
            {WEEKDAYS.map((day) => (
              <strong className="revenue-calendar-weekday" key={day}>
                {day}
              </strong>
            ))}
            {Array.from({ length: firstWeekday }, (_, index) => (
              <span className="revenue-calendar-empty" key={`empty-${index}`} />
            ))}
            {report.days.map((entry) => (
              <button
                type="button"
                className="revenue-calendar-day"
                aria-pressed={entry.date === daily?.date}
                key={entry.date}
                onClick={() => setSelectedDate(entry.date)}
              >
                <time dateTime={entry.date}>{Number(entry.date.slice(-2))}</time>
                <strong>{money(entry.revenue_paise)}</strong>
                <small>
                  {entry.ticket_count} {entry.ticket_count === 1 ? 'ticket' : 'tickets'}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {report && view === 'weekly' && (
        <section aria-labelledby="weekly-revenue-heading">
          <div className="revenue-report-heading">
            <div>
              <h3 id="weekly-revenue-heading">
                Weekly revenue · {MONTHS[month - 1]} {year}
              </h3>
              <p>Weeks are Monday to Sunday and are limited to this month.</p>
            </div>
            <p>
              <span>Month total</span>
              <strong>{money(monthTotal)}</strong>
            </p>
          </div>
          <div className="revenue-period-grid" aria-label="Weekly revenue">
            {report.weeks.map((entry, index) => (
              <button
                type="button"
                className="button secondary revenue-period-card"
                aria-pressed={entry.start_date === weekly?.start_date}
                key={entry.start_date}
                onClick={() => setSelectedWeek(entry.start_date)}
              >
                <span>Week {index + 1}</span>
                <small>
                  {dateLabel(entry.start_date)} – {dateLabel(entry.end_date)}
                </small>
                <strong>{money(entry.revenue_paise)}</strong>
                <small>
                  {entry.ticket_count} {entry.ticket_count === 1 ? 'ticket' : 'tickets'}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {report && view === 'monthly' && (
        <section aria-labelledby="monthly-revenue-heading">
          <div className="revenue-report-heading">
            <div>
              <h3 id="monthly-revenue-heading">Monthly revenue · {year}</h3>
              <p>Select a month to see its buses below.</p>
            </div>
            <p>
              <span>Year total</span>
              <strong>{money(report.revenue_paise)}</strong>
            </p>
          </div>
          <div className="revenue-period-grid" aria-label="Monthly revenue">
            {report.months.map((entry) => (
              <button
                type="button"
                className="button secondary revenue-period-card"
                aria-pressed={entry.month === monthly?.month}
                key={entry.month}
                onClick={() => setSelectedMonth(entry.month)}
              >
                <span>{MONTHS[entry.month - 1]}</span>
                <strong>{money(entry.revenue_paise)}</strong>
                <small>
                  {entry.ticket_count} {entry.ticket_count === 1 ? 'ticket' : 'tickets'}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {report && view === 'yearly' && (
        <section aria-labelledby="yearly-revenue-heading">
          <div className="revenue-report-heading">
            <div>
              <h3 id="yearly-revenue-heading">Yearly revenue</h3>
              <p>Select a year to see its buses below.</p>
            </div>
            <p>
              <span>All shown years</span>
              <strong>{money(recordedTotal)}</strong>
            </p>
          </div>
          <div className="revenue-period-grid revenue-year-grid" aria-label="Yearly revenue">
            {report.years.map((entry) => (
              <button
                type="button"
                className="button secondary revenue-period-card"
                aria-pressed={entry.year === yearly?.year}
                key={entry.year}
                onClick={() => setSelectedYear(entry.year)}
              >
                <span>{entry.year}</span>
                <strong>{money(entry.revenue_paise)}</strong>
                <small>
                  {entry.ticket_count} {entry.ticket_count === 1 ? 'ticket' : 'tickets'}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {report && chosen && (
        <section className="revenue-bus-breakdown" aria-labelledby="period-bus-revenue">
          <h3 id="period-bus-revenue">Revenue by bus</h3>
          <p>{chosenLabel} · Customer ratings are from all dates.</p>
          {chosen.demo_bookings > 0 && (
            <p className="small-note">
              Includes {chosen.demo_bookings} sample tickets added for testing.
            </p>
          )}
          <BusRevenueList buses={chosen.buses} allowReviews={false} />
        </section>
      )}

      <p className="small-note">
        This demo does not collect payments. Totals use each ticket’s current price, departure, bus
        and status, so cancellations or rescheduling can change a departure period.
      </p>
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
