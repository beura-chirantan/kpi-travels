export type User = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: 'admin' | 'customer';
};
export type BusType = 'AC' | 'Non-AC' | 'Sleeper';
export type SeatDefinition = {
  id?: number;
  label: string;
  deck: 'Lower' | 'Upper';
  row_index: number;
  column_index: number;
  seat_type: 'Seat' | 'Sleeper';
};
export type TripSeat = SeatDefinition & {
  id: number;
  bus_id: number;
  status: 'Available' | 'Held' | 'Booked';
  mine: boolean;
};
export type Bus = {
  id: number;
  name: string;
  registration: string;
  bus_type: BusType;
  total_seats: number;
  average_rating: number | null;
  rating_count: number;
  layout: SeatDefinition[];
};
export type Trip = {
  id: number;
  bus_id: number;
  route_id: number;
  bus_name: string;
  registration: string;
  bus_type: BusType;
  origin: string;
  destination: string;
  departure_at: string;
  arrival_at: string;
  price_paise: number;
  total_seats: number;
  available_seats: number;
  active: boolean;
  average_rating: number | null;
  rating_count: number;
  cancellation_reason: string | null;
  schedule_id: number | null;
  preference_match?: boolean;
};
export type Booking = {
  id: string;
  trip_id: number;
  trip: Trip;
  passenger_name: string;
  passenger_age: number;
  phone: string;
  seat_count: number;
  total_paise: number;
  status: 'Confirmed' | 'Cancelled';
  created_at: string;
  can_cancel: boolean;
  can_reschedule: boolean;
  can_rate: boolean;
  rating: { stars: number; comment: string } | null;
  reschedule_count: number;
  seat: {
    seat_id: number | null;
    seat_label: string;
    deck: 'Lower' | 'Upper';
    seat_type: 'Seat' | 'Sleeper';
  } | null;
};
export type SeatHold = {
  id: string;
  trip_id: number;
  price_paise: number;
  created_at: string;
  expires_at: string;
  seconds_remaining: number;
  seat: SeatDefinition & { id: number; bus_id: number };
  seats: (SeatDefinition & { id: number; bus_id: number })[];
};
export type BookingGroup = {
  id: string;
  created_at: string;
  bookings: Booking[];
  ticket_count: number;
  total_paise: number;
};
export type BusReview = {
  stars: number;
  comment: string;
  customer_name: string;
  departure_at: string;
  updated_at: string;
  origin: string;
  destination: string;
};
export type Criteria = {
  origin: string | null;
  destination: string | null;
  travel_date: string | null;
  time_of_day: string | null;
  departure_after: string | null;
  departure_before: string | null;
  arrival_time_of_day: string | null;
  bus_type: BusType | null;
  preferred_type: BusType | null;
  min_price: number | null;
  max_price: number | null;
  exclude_bus_name: string | null;
  next_available: boolean;
  clarification: string | null;
};
export type SearchResult = {
  criteria: Criteria;
  trips: Trip[];
  mode: 'ai' | 'offline';
  message: string;
};
export type Dashboard = {
  date: string;
  revenue: RevenueSummary;
  activity: {
    total_bookings: number;
    confirmed_bookings: number;
    cancelled_bookings: number;
    net_value_paise: number;
    demo_bookings: number;
  };
  inventory: {
    trip_count: number;
    total_seats: number;
    booked_seats: number;
    unbooked_seats: number;
    bookable_seats: number;
    net_value_paise: number;
    demo_bookings: number;
  };
  occupancy: {
    bus_name: string;
    registration: string;
    booked_seats: number;
    total_seats: number;
    occupancy_rate: number;
    trip_count: number;
  }[];
  route_demand: { origin: string; destination: string; bookings: number; revenue_paise: number }[];
};

export type BusRevenue = Bus & { revenue_paise: number; ticket_count: number };
export type RevenueSummary = {
  revenue_paise: number;
  ticket_count: number;
  demo_bookings: number;
  buses: BusRevenue[];
};
export type MonthlyRevenue = {
  year: number;
  month: number;
  revenue_paise: number;
  months: (RevenueSummary & { month: number })[];
  days: (RevenueSummary & { date: string })[];
  weeks: (RevenueSummary & { start_date: string; end_date: string })[];
  years: (RevenueSummary & { year: number })[];
};

export type SystemHealth = {
  generated_at: string;
  started_at: string;
  uptime_seconds: number;
  window_minutes: number;
  overall_status: 'Healthy' | 'Warning' | 'Critical';
  summary: {
    requests: number;
    requests_per_minute: number;
    errors: number;
    server_errors: number;
    error_rate: number;
    throttled: number;
    average_latency_ms: number;
    p95_latency_ms: number;
  };
  dependencies: { name: string; status: string; detail: string }[];
  routes: {
    method: string;
    path: string;
    status: 'Healthy' | 'Warning' | 'Critical';
    requests: number;
    requests_per_minute: number;
    errors: number;
    server_errors: number;
    error_rate: number;
    throttled: number;
    average_latency_ms: number;
    p95_latency_ms: number;
    max_latency_ms: number;
    last_status: number;
    last_seen: string;
    recommendation: string;
  }[];
  rate_limits: {
    name: string;
    path: string;
    maximum: number;
    window_seconds: number;
    active_clients: number;
    highest_current_usage: number;
    throttled: number;
  }[];
  recommendations: string[];
  note: string;
};

export type DeveloperIncident = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  error_type: string | null;
  request_payload: unknown;
  response: unknown;
};

export type IncidentReport = {
  generated_at: string;
  incident_count: number;
  retained_count: number;
  maximum_retained: number;
  incidents: DeveloperIncident[];
  note: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// The UI never talks to the database or receives an AI API key.
async function apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
  const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      ...options,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'kpi-travels',
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(
      'Cannot reach the booking service. Make sure the Python API is running, then retry.',
      0,
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : null;
    const message = Array.isArray(detail)
      ? detail.map((item: { msg: string }) => item.msg).join(' ')
      : detail;
    throw new ApiError(
      typeof message === 'string'
        ? message
        : 'The service could not complete the request. Please retry.',
      response.status,
    );
  }
  return response;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiResponse(path, options);
  return response.status === 204 ? (undefined as T) : response.json();
}

export async function downloadTicket(bookingId: string) {
  const response = await apiResponse(`/bookings/${encodeURIComponent(bookingId)}/ticket`);
  if (!response.headers.get('Content-Type')?.includes('application/pdf')) {
    throw new Error('The service did not return a PDF ticket. Please refresh and retry.');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `KPi-ticket-${bookingId}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const money = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: paise % 100 ? 2 : 0,
  }).format(paise / 100);
export const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
export const dateLabel = (value: string) =>
  new Date(value.length === 10 ? `${value}T00:00:00+05:30` : value).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
export function travelDate(offset = 0) {
  return new Date(Date.now() + 19800000 + offset * 86400000).toISOString().slice(0, 10);
}
export function duration(trip: Trip) {
  const minutes = Math.round(
    (new Date(trip.arrival_at).getTime() - new Date(trip.departure_at).getTime()) / 60000,
  );
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please retry.';
