type StaffTrip = {
  departure_at: string;
  active: boolean;
  available_seats: number;
  cancellation_reason: string | null;
};

export function staffTripStatus(trip: StaffTrip, clock: number) {
  if (trip.cancellation_reason)
    return { label: 'Trip cancelled', tone: 'cancelled', canChange: false, canBook: false };
  if (Date.parse(trip.departure_at) <= clock)
    return { label: 'Bus has left', tone: 'closed', canChange: false, canBook: false };
  if (!trip.active)
    return { label: 'Booking closed', tone: 'closed', canChange: true, canBook: false };
  if (!trip.available_seats)
    return { label: 'Bus full', tone: 'closed', canChange: true, canBook: false };
  return { label: 'Booking open', tone: 'open', canChange: true, canBook: true };
}

export function weeklyTripCount(start: string, end: string, weekday: number) {
  const from = Date.parse(`${start}T12:00:00Z`);
  const until = Date.parse(`${end}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until < from) return 0;
  const first = from + ((weekday - ((new Date(from).getUTCDay() + 6) % 7) + 7) % 7) * 86400000;
  return Math.max(0, Math.floor((until - first) / 604800000) + 1);
}

export function shiftedArrivalDay(oldDeparture: number, oldArrival: number, newDeparture: number) {
  return (newDeparture + ((oldArrival - oldDeparture + 7) % 7)) % 7;
}

export type WeekdayChoice = { day: number; selected: boolean; price: string };

export function selectedWeekdayPrices(days: WeekdayChoice[]) {
  return days.filter((entry) => entry.selected).map(({ day, price }) => ({ day, price }));
}

export function selectedTripCount(start: string, end: string, days: WeekdayChoice[]) {
  return selectedWeekdayPrices(days).reduce(
    (count, entry) => count + weeklyTripCount(start, end, entry.day),
    0,
  );
}

export type WeeklyPlanConflict = {
  departureDate: string;
  arrivalDate: string;
  nextDepartureDate: string;
  departureDay: number;
  nextDepartureDay: number;
};

function clockMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) ? hours * 60 + minutes : NaN;
}

/** Detect overlaps between occurrences being created by one weekly plan. */
export function weeklyPlanConflict(
  start: string,
  end: string,
  days: WeekdayChoice[],
  departureTime: string,
  arrivalTime: string,
  arrivalDayOffset: number,
): WeeklyPlanConflict | null {
  const from = Date.parse(`${start}T00:00:00Z`);
  const until = Date.parse(`${end}T00:00:00Z`);
  const departureMinutes = clockMinutes(departureTime);
  const arrivalMinutes = clockMinutes(arrivalTime);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    !Number.isFinite(departureMinutes) ||
    !Number.isFinite(arrivalMinutes) ||
    until < from
  )
    return null;

  const chosen = new Set(days.filter((entry) => entry.selected).map((entry) => entry.day));
  const occurrences: { departure: number; arrival: number; day: number }[] = [];
  for (let date = from; date <= until; date += 86400000) {
    const day = (new Date(date).getUTCDay() + 6) % 7;
    if (!chosen.has(day)) continue;
    occurrences.push({
      departure: date + departureMinutes * 60000,
      arrival: date + (arrivalDayOffset * 1440 + arrivalMinutes) * 60000,
      day,
    });
  }

  for (let index = 1; index < occurrences.length; index += 1) {
    const previous = occurrences[index - 1];
    const current = occurrences[index];
    if (previous.arrival > current.departure) {
      return {
        departureDate: new Date(previous.departure).toISOString().slice(0, 10),
        arrivalDate: new Date(previous.arrival).toISOString().slice(0, 10),
        nextDepartureDate: new Date(current.departure).toISOString().slice(0, 10),
        departureDay: previous.day,
        nextDepartureDay: current.day,
      };
    }
  }
  return null;
}

export function staffError(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Could not save this change. Please try again.';
  if (/Cannot reach|API is unavailable|Database temporarily/i.test(message))
    return 'Cannot connect right now. Please try again. If this keeps happening, ask the person who set up the app for help.';
  if (/new weekly plan overlaps itself/i.test(message)) return message;
  if (/already has another trip.+overlap/i.test(message)) return message;
  if (/overlapping trip/i.test(message))
    return 'This bus already has a trip at that time. Choose another bus, day or time. Nothing was saved.';
  if (/booking history/i.test(message))
    return 'Tickets have already been booked for this trip. You can change the ticket price or close new bookings, but not the bus, route or times.';
  if (/Registration is already in use, or capacity/i.test(message))
    return 'Check that the bus number is not used by another bus and that there are enough seats for all booked tickets. Update the list, then try again.';
  if (/Capacity cannot|capacity conflicts/i.test(message))
    return 'Some seats are already booked. Keep at least that many seats and try again.';
  if (/registration.*already|already.*registration/i.test(message))
    return 'That bus number is already saved. Check the number or change the existing bus.';
  if (/first departure time has passed|Departure must be in the future/i.test(message))
    return 'That start time has already passed. Choose a later time or another date.';
  if (/Arrival must be after departure|overnight journey/i.test(message))
    return 'The bus must arrive after it leaves. For a night trip, choose the next arrival day.';
  if (/Origin and destination must be different/i.test(message))
    return 'Choose different cities for From and To.';
  if (/cancelled departure cannot be edited/i.test(message))
    return 'This trip has already been cancelled. Add a new trip if needed.';
  if (/departed trip cannot be cancelled/i.test(message))
    return 'The start time has passed, so this trip cannot be cancelled.';
  if (/concurrently|schedule conflicts with another update/i.test(message))
    return 'Another change was made at the same time. Update the list, then try again.';
  if (/No selected departure weekday/i.test(message))
    return 'That weekday is not in the date range. Choose a later last date.';
  if (/within 52 weeks/i.test(message))
    return 'The last trip date must be after the first date and no more than one year later.';
  return message;
}
