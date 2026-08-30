# React guide for this project

You do not need to learn all of React to explain KPi Travels. Understand the
ideas below, then trace one multi-passenger booking from the UI to FastAPI.

## 1. Components are functions that return UI

`SearchPage` renders filters, the Ask AI entry and bus cards. `BookingDialog`
renders the seat map and passenger form. `BookingsPage` renders individual
tickets. `ProfilePage` edits the signed-in customer's saved details. `AdminPage`
renders fleet and schedule controls. `DashboardPage` renders the Admin report;
`SystemHealthPage` and `IncidentsPage` render the protected developer reports.

JSX resembles HTML but can include JavaScript expressions inside `{braces}`.
Components start with a capital letter and can compose other components.

## 2. State is the screen's changing information

```tsx
const [loading, setLoading] = useState(false);
```

`loading` is the current value. Calling `setLoading(true)` asks React to render
again. This app keeps form fields, search results, selected seats, passenger
drafts, the signed-in user, active page, messages and dialog state in React.

React does **not** own the authoritative seat inventory, booking status, fare,
roles or ratings. FastAPI revalidates those values against the database.

## 3. Props connect components

The root page passes an `onBook` callback to `SearchPage`. Clicking a bus calls
that callback with the selected trip. The parent either asks the user to sign in
or opens `BookingDialog`.

`SeatMap` receives seats, selected IDs and an `onSelect` callback. It does not
know how a booking is stored; it only displays the state it was given and reports
the user's next selection upward.

This is ordinary one-way React data flow, not an event bus or agent framework.

## 4. Events handle actions; effects load data

- `onChange` updates inputs and selections.
- `onSubmit` prevents the browser's default page reload and calls an API.
- `onClick` opens dialogs, swaps cities, selects seats or starts an action.
- `useEffect` loads sessions, trips, seat maps, bookings and reports.

Effects return cleanup functions where a request, timer or temporary seat hold
must stop when the component unmounts or its selection changes.

## 5. API calls are asynchronous

`app/lib/api.ts` centralizes fetch, cookies, the request-protection header, JSON,
downloads and readable errors. `await api(...)` waits for a server response
without freezing the screen. Forms disable unsafe repeat submissions while an
action is running.

The HttpOnly session cookie identifies the user to FastAPI. React never receives
password hashes, database credentials, developer credentials or AI keys.

## 6. Custom hooks package reusable behavior

`useSeatHold` in `app/lib/seat-hold.ts` owns the temporary hold lifecycle:

1. The selected trip and seat IDs change.
2. The hook requests `/api/seat-holds`.
3. It exposes loading, active, expired or error state and the countdown.
4. It releases the old hold when the selection/dialog changes.
5. The server also expires abandoned holds, so browser cleanup is not trusted as
   the only protection.

## Trace one multi-passenger booking

1. `SearchPage` loads available trips from `/api/trips`.
2. Clicking **Book tickets** passes a trip to the root page.
3. `BookingDialog` loads `/api/trips/{trip_id}/seats`.
4. The customer selects one to six available seats. `useSeatHold` sends their IDs
   to `/api/seat-holds` and displays the 10-minute countdown.
5. The dialog collects a name and age for each seat plus one contact phone number.
6. Confirm sends `/api/booking-groups` with the hold ID, passenger/seat pairs,
   expected fare and an idempotency key.
7. FastAPI authenticates the customer, validates every field, verifies the hold
   and fare, and creates every ticket in one transaction.
8. React closes the dialog, opens My bookings and displays one ticket per
   passenger. Each ticket can be downloaded or cancelled separately.
9. Cancelling a ticket calls `/api/bookings/{id}/cancel`; only that ticket's seat
   is released.

The chat uses the same multi-passenger rules. `AssistantChat` displays the real
seat map, accepts one to six seats, creates one temporary group hold, collects a
name and age for each selected seat plus one phone number, and calls
`/api/booking-groups` only after explicit confirmation. It then downloads each
passenger's PDF ticket. The language model itself never writes bookings or
receives passenger details.

## Trace developer monitoring

1. `/developer` uses a separate developer session and never accepts a Customer or
   Admin session.
2. `SystemHealthPage` loads `/api/developer/system-health` every 15 seconds.
3. `IncidentsPage` loads `/api/developer/incidents` and displays sanitized request
   and response JSON for failed calls.
4. FastAPI keeps the rolling metrics and incidents in memory. Restarting FastAPI
   clears both and requires the developer to sign in again.
5. The two observability endpoints are deliberately excluded from their own
   metrics and incident capture, preventing polling or an expired developer
   session from making the monitoring system report itself as broken.

## Where the APIs live

The React browser uses `app/api/[...path]/route.ts` as a same-origin relay. The
actual REST endpoints and business rules are declared in `backend/main.py`.
Supporting backend responsibilities are separated into `database.py`,
`schemas.py`, `search.py`, `security.py`, `seed.py` and `tickets.py`. This is a
modular monolith: one FastAPI service with focused supporting modules.

## Trace one rating

1. `BookingsPage` receives `can_rate` from the backend for each ticket.
2. The flag is true only for the owner of a Confirmed ticket after arrival.
3. **Rate this bus** opens `RatingDialog`.
4. Submit calls `PUT /api/bookings/{id}/rating` with 1–5 stars and a comment.
5. The returned booking updates the card immediately. Submitting again edits the
   same rating rather than inserting a second one.

## What to explain in the interview

- Why Python validates requests even when React already validates the form.
- Why hiding the Admin page is not authorization.
- Why React cannot prevent two customers from booking the last seat.
- Why holds improve checkout UX but are not confirmed tickets.
- Why group checkout must be atomic.
- Why booking and rescheduling send an expected fare.
- Why idempotency matters when the network fails after confirmation.
- Why AI returns criteria and suggestions rather than SQL or direct authority.
- Why each downloaded PDF is a snapshot of the ticket at that moment.
- Why rating eligibility is calculated on the backend.
- Which in-memory/local-demo parts would change in production.

Practice changing a harmless label or empty state, then trace both a successful
request and one HTTP 409 error into the UI. During the demo, describe only code
you understand and identify limitations honestly.
