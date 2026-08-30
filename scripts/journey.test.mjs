import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendedOrder, arrivalDayOffset } from '../app/lib/journey.ts';
import { staffTripStatus, weeklyTripCount, shiftedArrivalDay, selectedTripCount, selectedWeekdayPrices, staffError, weeklyPlanConflict } from '../app/lib/staff.ts';
import { assistantIntent, bookingReference, contextualSearch, criteriaSummary, passengerAgeFromReply, passengerNameFromReply, passengerPhoneFromReply, validPassenger } from '../app/lib/assistant.ts';

test('assistant routes search, booking history, cancellation and questions correctly', () => {
  const cities = ['Hyderabad', 'Bangalore', 'Pune', 'Mumbai'];
  assert.equal(assistantIntent('Hyderabad to Bangalore tomorrow', cities), 'search');
  assert.equal(assistantIntent('Find a bus under 700', cities), 'search');
  assert.equal(assistantIntent('Show my bookings', cities), 'bookings');
  assert.equal(assistantIntent('Cancel booking ABC123', cities), 'cancel');
  assert.equal(assistantIntent('okay, book the bus', cities), 'book');
  assert.equal(assistantIntent('book the KPi Express', cities), 'book');
  assert.equal(assistantIntent('can you book?', cities), 'book');
  assert.equal(assistantIntent('How do I book a ticket?', cities), 'question');
  assert.equal(assistantIntent('chennai banglore tomorrow', [...cities, 'Chennai']), 'search');
  assert.equal(assistantIntent('What are the cancellation rules?', cities), 'question');
});

test('assistant treats remembered route refinements as searches', () => {
  const cities = ['Hyderabad', 'Bangalore', 'Pune', 'Mumbai'];
  const criteria = {
    origin: 'Hyderabad', destination: 'Bangalore', travel_date: '2026-08-30',
    bus_type: 'AC', preferred_type: null, time_of_day: 'morning',
    arrival_time_of_day: null, min_price: null, max_price: 1000,
    exclude_bus_name: null, next_available: false, clarification: null,
  };
  assert.equal(assistantIntent('show me for day after tomorrow', cities, criteria), 'search');
  assert.equal(assistantIntent('same', cities, criteria), 'search');
  assert.equal(assistantIntent('make it sleeper', cities, criteria), 'search');
  assert.equal(assistantIntent('doesnt matter', cities, criteria), 'search');
  assert.equal(assistantIntent('no', cities, criteria), 'search');
  assert.equal(assistantIntent('What does AC mean?', cities, criteria), 'question');
  const changedDay = contextualSearch('show me for day after tomorrow', criteria, cities);
  assert.match(changedDay, /from Hyderabad/);
  assert.match(changedDay, /to Bangalore/);
  assert.match(changedDay, /day after tomorrow/);
  assert.doesNotMatch(changedDay, /2026-08-30/);
  const same = contextualSearch('same', criteria, cities);
  assert.match(same, /from Hyderabad/);
  assert.match(same, /on 2026-08-30/);
  assert.match(same, /AC required/);
});

test('assistant understands city shortcuts, written dates and filter-clearing requests', () => {
  const cities = ['Hyderabad', 'Bangalore', 'Pune', 'Mumbai'];
  const criteria = {
    origin: 'Hyderabad', destination: 'Bangalore', travel_date: '2026-08-31',
    bus_type: 'AC', preferred_type: null, time_of_day: 'morning',
    arrival_time_of_day: null, min_price: null, max_price: 1000,
    exclude_bus_name: 'KPi Express', next_available: false, clarification: null,
  };
  assert.equal(assistantIntent('mum to pune', cities, criteria), 'search');
  assert.equal(assistantIntent('1st sep', cities, criteria), 'search');
  assert.equal(assistantIntent('other bus than KPi Express?', cities, criteria), 'search');
  assert.equal(contextualSearch('mum to pune', criteria, cities), 'mum to pune');
  const dated = contextualSearch('1st sep', criteria, cities);
  assert.match(dated, /from Hyderabad to Bangalore/);
  assert.doesNotMatch(dated, /2026-08-31/);
  const anyTime = contextualSearch('time is not an issue. show me other buses', criteria, cities);
  assert.doesNotMatch(anyTime, /morning/);
  assert.match(anyTime, /excluding KPi Express/);
  const all = contextualSearch('show me all buses', criteria, cities);
  assert.doesNotMatch(all, /AC required|morning|under ₹1000|excluding/);
  assert.match(criteriaSummary({ ...criteria, min_price: 100 }), /₹100 or more/);
});

test('assistant search follow-ups retain only missing journey details', () => {
  const criteria = {
    origin: 'Hyderabad', destination: 'Bangalore', travel_date: '2026-09-01',
    bus_type: null, preferred_type: 'AC', time_of_day: 'morning',
    arrival_time_of_day: null, min_price: null, max_price: 700,
    exclude_bus_name: null, next_available: false, clarification: null,
  };
  const cities = ['Hyderabad', 'Bangalore', 'Pune', 'Mumbai'];
  const followUp = contextualSearch('make it sleeper', criteria, cities);
  assert.match(followUp, /from Hyderabad/);
  assert.match(followUp, /on 2026-09-01/);
  assert.doesNotMatch(followUp, /prefer AC/);
  assert.match(followUp, /under ₹700/);
  const newRoute = contextualSearch('Pune to Mumbai', criteria, cities);
  assert.doesNotMatch(newRoute, /from Hyderabad/);
  assert.doesNotMatch(newRoute, /on 2026-09-01/);
});

test('assistant keeps incomplete date replies in the active route search', () => {
  const cities = ['Hyderabad', 'Bangalore', 'Pune', 'Mumbai'];
  const waitingForDate = {
    origin: 'Mumbai', destination: 'Pune', travel_date: null,
    bus_type: null, preferred_type: null, time_of_day: null,
    arrival_time_of_day: null, min_price: null, max_price: null,
    exclude_bus_name: null, next_available: false,
    clarification: 'Please specify your travel date.',
  };
  assert.equal(assistantIntent('31', cities, waitingForDate), 'search');
  assert.equal(assistantIntent('august', cities, waitingForDate), 'search');
  assert.equal(assistantIntent('8-31', cities, waitingForDate), 'search');
});

test('assistant ticket references and passenger details are validated safely', () => {
  assert.equal(bookingReference('cancel booking ABC123'), 'abc123');
  assert.equal(bookingReference('cancel #12af90'), '12af90');
  assert.equal(bookingReference('cancel my ticket on 2026-09-01'), '');
  assert.equal(validPassenger('Asha Rao', '29', '98765 43210'), '');
  assert.equal(passengerNameFromReply('My name is Asha Rao'), 'Asha Rao');
  assert.equal(passengerAgeFromReply('I am 29'), '29');
  assert.equal(passengerPhoneFromReply('Phone is 98765 43210'), '98765 43210');
  assert.match(validPassenger('A', '29', '9876543210'), /full name/);
  assert.match(validPassenger('Asha Rao', '0', '9876543210'), /age/);
  assert.match(validPassenger('Asha Rao', '29', '123'), /phone/);
});

test('only selected weekdays and their own prices are submitted', () => {
  const days = Array.from({ length: 7 }, (_, day) => ({ day, selected: [0, 2, 6].includes(day), price: String(500+day) }));
  assert.deepEqual(selectedWeekdayPrices(days), [{ day: 0, price: '500' }, { day: 2, price: '502' }, { day: 6, price: '506' }]);
  assert.equal(selectedTripCount('2026-08-30', '2026-09-13', days), 7);
  // Removing Sunday removes all Sunday dates, but preserves all other prices.
  const removed = days.map((entry) => entry.day === 6 ? { ...entry, selected: false } : entry);
  assert.equal(selectedTripCount('2026-08-30', '2026-09-13', removed), 4);
  assert.deepEqual(selectedWeekdayPrices(removed), [{ day: 0, price: '500' }, { day: 2, price: '502' }]);
  assert.equal(selectedTripCount('2026-08-30', '2026-09-13', days.map((entry) => ({ ...entry, selected: false }))), 0);
  assert.equal(selectedTripCount('2026-08-30', '2026-09-05', days.map((entry) => ({ ...entry, selected: true }))), 7);
});

test('staff trip labels distinguish open, full, closed, departed and cancelled trips', () => {
  const clock = Date.parse('2026-09-01T12:00:00+05:30');
  const trip = { departure_at: '2026-09-01T13:00:00+05:30', active: true, available_seats: 8, cancellation_reason: null };
  assert.deepEqual(staffTripStatus(trip, clock), { label: 'Booking open', tone: 'open', canChange: true, canBook: true });
  for (const [changes, label] of [[{ active: false }, 'Booking closed'], [{ available_seats: 0 }, 'Bus full']]) {
    const status = staffTripStatus({ ...trip, ...changes }, clock);
    assert.equal(status.label, label);
    assert.equal(status.canChange, true);
    assert.equal(status.canBook, false);
  }
  for (const changes of [{ departure_at: '2026-09-01T12:00:00+05:30' }, { cancellation_reason: 'Bus repair' }]) {
    const status = staffTripStatus({ ...trip, ...changes }, clock);
    assert.equal(status.canChange, false);
    assert.equal(status.canBook, false);
  }
  assert.equal(staffTripStatus({ ...trip, departure_at: '2026-08-01T12:00:00+05:30', cancellation_reason: 'Bus repair' }, clock).label, 'Trip cancelled');
});

test('weekly preview counts matching dates inclusively and handles invalid ranges', () => {
  assert.equal(weeklyTripCount('2026-08-30', '2026-09-13', 6), 3);
  assert.equal(weeklyTripCount('2026-08-30', '2026-08-30', 6), 1);
  assert.equal(weeklyTripCount('2026-08-30', '2026-08-30', 0), 0);
  assert.equal(weeklyTripCount('2026-08-30', '2026-09-13', 0), 2);
  assert.equal(weeklyTripCount('2026-09-13', '2026-08-30', 6), 0);
  assert.equal(weeklyTripCount('', '2026-09-13', 6), 0);
});

test('weekly plan preview detects when a long trip overlaps its next selected day', () => {
  const days = Array.from({ length: 7 }, (_, day) => ({
    day,
    selected: [0, 2, 4].includes(day),
    price: '850',
  }));
  assert.deepEqual(
    weeklyPlanConflict('2026-08-31', '2026-10-25', days, '19:00', '20:30', 2),
    {
      departureDate: '2026-08-31',
      arrivalDate: '2026-09-02',
      nextDepartureDate: '2026-09-02',
      departureDay: 0,
      nextDepartureDay: 2,
    },
  );
  assert.equal(weeklyPlanConflict('2026-08-31', '2026-10-25', days, '19:00', '18:00', 1), null);
});

test('changing the weekly leaving day keeps the same arrival-day gap', () => {
  assert.equal(shiftedArrivalDay(0, 0, 6), 6);
  assert.equal(shiftedArrivalDay(0, 1, 6), 0);
  assert.equal(shiftedArrivalDay(6, 0, 2), 3);
  assert.equal(shiftedArrivalDay(6, 2, 4), 0);
});

test('staff errors explain connection and conflicting-trip problems in plain language', () => {
  assert.match(staffError(new Error('Cannot reach the booking service. Make sure the Python API is running')), /ask the person who set up/);
  assert.match(staffError(new Error('Bus has an overlapping trip')), /Choose another bus/);
  assert.match(staffError(new Error('Trip has booking history')), /Tickets have already been booked/);
  assert.equal(staffError(new Error('Please sign in again.')), 'Please sign in again.');
});

test('recommended is highest-rated first, not fare or AC preference', () => {
  const trip = { id: 1, average_rating: null, rating_count: 0, preference_match: true,
    departure_at: '2026-09-01T06:00:00+05:30', price_paise: 10000 };
  const rows = [trip, { ...trip, id: 2, average_rating: 4, rating_count: 100 },
    { ...trip, id: 3, average_rating: 5, rating_count: 1, preference_match: false },
    { ...trip, id: 4, average_rating: 4, rating_count: 101 }];
  assert.deepEqual(rows.sort(recommendedOrder).map((row) => row.id), [3, 4, 2, 1]);
});
test('arrival day labels handle same day, overnight, and multiple days', () => {
  assert.equal(arrivalDayOffset('2026-09-01T06:00:00+05:30', '2026-09-01T08:00:00+05:30'), 0);
  assert.equal(arrivalDayOffset('2026-09-01T22:00:00+05:30', '2026-09-02T08:00:00+05:30'), 1);
  assert.equal(arrivalDayOffset('2026-12-31T22:00:00+05:30', '2027-01-02T08:00:00+05:30'), 2);
});
