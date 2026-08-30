type RankedTrip = {
  average_rating: number | null;
  rating_count: number;
  preference_match?: boolean;
  departure_at: string;
  price_paise: number;
  id: number;
};
export function recommendedOrder(a: RankedTrip, b: RankedTrip) {
  return (
    (b.average_rating ?? 0) - (a.average_rating ?? 0) ||
    b.rating_count - a.rating_count ||
    Number(b.preference_match ?? false) - Number(a.preference_match ?? false) ||
    Date.parse(a.departure_at) - Date.parse(b.departure_at) ||
    a.price_paise - b.price_paise ||
    a.id - b.id
  );
}

export function arrivalDayOffset(departure: string, arrival: string) {
  return Math.round(
    (Date.parse(arrival.slice(0, 10)) - Date.parse(departure.slice(0, 10))) / 86400000,
  );
}

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
