# KPi Travels — AI-assisted bus ticketing

KPi Travels is a full-stack hiring-assessment project with React Customer and
Admin interfaces, a Python FastAPI backend, transactional seat inventory, and
AI-assisted bus search and booking.

The required assignment flows are implemented: Admins manage buses and trips;
customers search, book and cancel tickets; Ask AI interprets natural-language
travel requests; and the Admin dashboard reports bookings, ticket value,
occupancy and route demand. The project also includes seat maps, multi-passenger
checkout, temporary seat holds, PDF tickets, rescheduling, ratings, weekly
schedules, and a separate developer-only health portal.

## Product views

### Customer

- Search by From, To, travel date, bus type, departure/arrival window and fare.
- Swap the From and To cities without retyping them.
- Use Ask AI for natural-language searches and follow-up refinements.
- Sort results by recommendation, departure time or price. Recommendations put
  verified customer rating first.
- Open the bus seat map and select up to six seats in one checkout.
- Enter a name and age for each selected seat, plus one contact phone number.
- Update the signed-in customer's name, email and phone number in Profile; the
  header always shows the saved profile name.
- View individual tickets in My bookings, download each as a PDF, reschedule,
  cancel before departure, and rate the bus after arrival.

### Admin

- Add and edit buses, including registration, type, capacity and seat layout.
- Choose 2+2 seater, 2+1 seater, lower/upper sleeper, or a custom arrangement.
- Add and edit dated trips with route, departure, arrival, fare and booking status.
- Create bounded weekly schedules by selecting any of seven weekdays and a
  different fare for each selected day.
- Cancel one not-yet-departed occurrence, including today's trip, with a reason.
- Review bus-wise ratings and written passenger feedback.
- Open a date-wise dashboard for ticket activity, ticket value, departure
  inventory, bus occupancy, route demand, and per-bus revenue and rating.

### Developer

`/developer` is a separate, unlinked portal with independent credentials. It
shows the previous 15 minutes of API traffic, errors, latency, rate-limit usage,
dependency checks and capacity guidance. Its Incidents tab records each failed
request's timestamp, endpoint, status, sanitized request payload and error
response. Credentials and customer personal details are redacted. Metrics and
incidents are held in memory and reset whenever FastAPI restarts. The two
observability endpoints are excluded from their own metrics and incident feed, so
the portal cannot mark itself unhealthy. Customer and Admin sessions cannot open
it.

## Start locally

Requirements:

- Python 3.11 or newer
- Node.js 22.13 or newer
- pnpm
- Docker only if using PostgreSQL

On macOS, if `node` or `pnpm` prints `command not found`, install both once with
Homebrew, then open a new terminal:

```bash
brew install node pnpm
node --version
pnpm --version
```

Activating `.venv` installs or enables only Python packages; it does not provide
Node.js or pnpm.

Install dependencies from the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pnpm install
```

On the first setup, copy `.env.example` to `.env` if `.env` does not already
exist, then add the private values required for AI and developer access.

On Windows, activate the environment with `.venv\Scripts\activate`. If pnpm asks
to approve the scaffold's native build tools, review and run:

```bash
pnpm approve-builds esbuild sharp unrs-resolver workerd
```

Start FastAPI in terminal 1:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Start React in terminal 2:

```bash
pnpm dev
```

Open:

- Application: http://127.0.0.1:3000
- Private developer portal: http://127.0.0.1:3000/developer

Both processes are required. The React server relays same-origin `/api` requests
to FastAPI; it does not replace or connect directly to the database.

### If the site cannot be reached

Check `http://127.0.0.1:8000/api/health` first. If it is unavailable, restart the
FastAPI command in terminal 1. If health works but `http://127.0.0.1:3000` does
not, restart `pnpm dev` in terminal 2. A FastAPI restart clears developer sessions,
rolling health metrics and temporary incidents; persisted users, buses, trips,
seat holds and bookings remain in the database. Holds still expire according to
their stored timeout.

### Demo accounts

| Role            | Email               | Password         |
| --------------- | ------------------- | ---------------- |
| Admin           | `admin@kpi.test`    | `TravelDemo123!` |
| Customer        | `customer@kpi.test` | `TravelDemo123!` |
| Second customer | `priya@kpi.test`    | `TravelDemo123!` |

These are local demonstration accounts. Do not publish them. Use fictitious
passenger details during the demo. Developer access deliberately uses the
separate `DEVELOPER_EMAIL` and `DEVELOPER_PASSWORD` values from `.env` and is not
one of these application-role accounts.

The first startup creates seven buses, five routes, 15 dated departures per bus,
and several clearly labelled sample bookings. Seeding is non-destructive:
restarting does not erase data or add a second copy. To create a separate clean
demo, point `DATABASE_URL` at another SQLite filename.

### Configuration

Copy `.env.example` to `.env`. Important values are:

| Variable                                 | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                           | SQLite by default; PostgreSQL is also supported            |
| `SEED_DEMO`                              | Creates sample data only when the database is empty        |
| `DEMO_PASSWORD`                          | Password used while creating the local demo users          |
| `SEAT_HOLD_SECONDS`                      | Checkout hold duration; server clamps it to 60–900 seconds |
| `GROQ_API_KEY` / `GROQ_MODEL`            | Preferred AI provider and model                            |
| `OPENAI_API_KEY` / `OPENAI_MODEL`        | Optional AI-provider fallback                              |
| `DEVELOPER_EMAIL` / `DEVELOPER_PASSWORD` | Independent `/developer` login                             |
| `API_ORIGIN`                             | FastAPI origin used by the production React relay          |
| `ALLOWED_ORIGINS`                        | Browser origins accepted by FastAPI                        |
| `COOKIE_SECURE`                          | Set to `true` behind production HTTPS                      |

Keep `.env` local. It is ignored by Git; `.env.example` contains names and safe
defaults only.

## AI travel assistant

Groq is the preferred provider:

```dotenv
GROQ_API_KEY=your_key_here
GROQ_MODEL=openai/gpt-oss-20b
```

Restart FastAPI after changing the key. The key remains server-side and is never
returned to React.

Ask AI supports two operations:

1. It turns natural-language travel needs into validated search criteria and
   queries real trips in the application database.
2. It answers short questions about the app and bus travel.

Examples:

- `Hyderabad to Bangalore tomorrow morning, preferably AC`
- `Show the same route day after tomorrow`
- `Show all buses and remove the time limit`
- `Pune to Mumbai under 600`

The interpreter can extract route, date, departure/arrival windows, required or
preferred bus type, fare range and an excluded bus name. Missing route or date
produces a clarification instead of a guessed booking. Search results come only
from database records and are ranked by rating, rating count, preference match,
departure and fare.

The chat remembers recent journey criteria, can show the signed-in customer's
bookings, and can guide seat selection and booking for **up to six passengers**
in one checkout. It displays the real seat map, creates a temporary hold, asks for
a name and age for every selected seat, asks once for the contact phone, requires
explicit confirmation, creates all tickets atomically, and downloads each PDF
ticket. Passenger details are sent to the protected booking endpoint, not to the
AI-answer endpoint.

If no provider is configured or a provider call fails, the UI clearly labels the
response **Offline travel helper**. That fallback supports a limited set of route,
date, time, type and fare phrases; it must not be presented as live AI during the
demo. Provider tests use mocks, so test the configured Groq call once before the
Teams interview.

## Architecture

```text
Browser
  └── React / Vinext UI
        └── same-origin /api relay
              └── FastAPI
                    ├── authentication, validation and business rules
                    ├── SQLAlchemy → SQLite or PostgreSQL
                    ├── ReportLab → PDF tickets
                    └── Groq/OpenAI → interpreted search or short answer
```

The frontend uses React state, props, effects, forms and fetch. The business
backend is Python. There is no Redux, agent framework, vector database, or
microservice split. Customer and Admin screens share the root route but are
selected by the authenticated role; the developer portal has its own route and
session cookie.

All FastAPI route declarations currently live in `backend/main.py`; supporting
database, validation, AI, security, seed and PDF code is separated into focused
modules under `backend/`. The React catch-all route at `app/api/[...path]/route.ts`
relays browser `/api` calls to FastAPI. This is intentionally a modular monolith,
not a collection of microservices.

### Main data groups

- Identity: `users`, `sessions`
- Fleet and schedules: `buses`, `bus_seats`, `routes`, `trips`,
  `weekly_schedules`, `schedule_departures`, `trip_cancellations`
- Checkout inventory: `checkout_holds`, `checkout_hold_seats`,
  `trip_seat_assignments`
- Tickets: `bookings`, `booking_groups`, `booking_group_members`,
  `booking_seat_history`, `booking_changes`
- Feedback: `ratings`

The older `seat_holds` table remains for safe additive startup compatibility.
New tables and indexes are created without deleting existing booking data.

## Booking and inventory rules

### Seat layouts and holds

Every bus has an explicit seat layout. A dated trip uses that bus layout but owns
its own inventory. The same physical bus can therefore have seat 1 available
tomorrow even when seat 1 is booked today.

Selecting one or more seats creates one server-side checkout hold. The default is
10 minutes. Changing the selection, closing or leaving checkout, or allowing the
timer to expire releases the held seats. A hold is not a booking.

### Multi-passenger confirmation

The normal checkout accepts one to six different seats. Each selected seat
requires its own passenger name and age. Confirmation creates one individual
ticket per passenger and one group record for the checkout. Each ticket can later
be downloaded or cancelled independently.

The booking request includes the hold ID, selected seat IDs, displayed fare and an
idempotency key. A transaction verifies ownership and expiry, rechecks the fare,
converts all held seats to booked assignments, and creates every ticket. Any
failure rolls back the complete group; a partial group cannot be sold.

### Overbooking protection

Inventory rules live in FastAPI and the database, never only in React. Conditional
updates, unique trip/seat assignments and transactions prevent two customers from
confirming the same last seat. Retrying the same request returns the original
result; reusing its idempotency key with different details returns HTTP 409.

### Cancellation, rescheduling and ratings

- A customer may cancel only their own Confirmed ticket before departure. The
  successful status change releases exactly one seat; a repeated cancellation does
  not release it twice.
- Rescheduling is allowed before departure to an active trip on the same route.
  The customer selects an available seat and confirms the current fare. The new
  seat is reserved, the ticket moves, and the old seat is released atomically.
- A customer may rate only their own Confirmed ticket after its arrival time.
  Cancelled and future journeys cannot be rated. One booking has one editable
  1–5 star rating and optional comment.

PDF tickets are generated by an authenticated ownership-checked endpoint. They
include the current status, route, bus, passenger, seat, departure, arrival and
stored fare. An already downloaded PDF is a snapshot; download it again after a
reschedule or cancellation.

## Admin scheduling and reports

### Trips and weekly schedules

An Admin can create one dated trip or a weekly plan. A weekly plan supports any
combination of Monday through Sunday, a separate fare per selected weekday,
shared departure/arrival times, an inclusive Start date / Repeat until range, and
overnight arrivals. It creates concrete dated trips for at most 52 weeks. A
conflict on any selected day rolls back the entire plan.

Cancelling one occurrence does not cancel the rest of its weekly series. The
cancelled trip cannot be reopened; affected confirmed tickets are marked
Cancelled and customers see the Admin reason.

### Dashboard definitions

The Daily report starts at today in IST and supports Yesterday, Today, Tomorrow,
or any selected date.

- **Revenue:** stored value of Confirmed tickets booked on the selected date.
  Cancelled tickets are excluded. It is booked ticket value, not collected money.
- **Revenue reports:** four clear views. Daily and Weekly use month arrows,
  Monthly uses year arrows, and Yearly shows every recorded year. A selected-period
  summary displays revenue and ticket count before the calendar/cards; selecting
  a day, week, month or year updates the per-bus breakdown below it.
- **Each bus: revenue & rating:** revenue for the selected booking period plus the
  bus's all-time verified rating.
- **Trips departing:** all scheduled departures on the selected travel date.
- **Seats left to book:** seats on active, not-yet-departed trips on that date only.
- **Occupancy and route demand:** calculated from trips departing on the selected
  date, regardless of when their tickets were booked.

Selecting a report date does not change data. Cancellation or rescheduling can
change an earlier day's booked-ticket value because the report is a current view,
not an immutable accounting ledger.

## REST API behavior

FastAPI exposes resource-oriented endpoints for authentication, trips, seat maps,
holds, group bookings, individual bookings, PDFs, rescheduling, ratings, Admin
fleet/schedules/reports, AI search, developer health and sanitized incidents.
OpenAPI documentation is available at `/docs` while the API runs.

State-changing calls require the same-origin request-protection header. Protected
resources enforce the role and booking owner on the backend. Expected errors use
clear status codes, including 401, 403, 404, 409, 422, 429 and 503. Client errors
and server failures are both recorded as sanitized incidents; HTTP 401 means
authentication is missing or invalid, while HTTP 429 means a rate limit was hit.

## PostgreSQL option

SQLite is the zero-setup default at `data/ticketing.db`. To use PostgreSQL:

```bash
docker compose up -d db
```

Then set:

```dotenv
DATABASE_URL=postgresql+psycopg://kpi:kpi_local_only@127.0.0.1:5432/kpi
```

Restart FastAPI. This creates a separate database; it does not migrate existing
SQLite data. The automated suite uses isolated SQLite databases. PostgreSQL must
be integration-tested separately before claiming production support.

## Verify

```bash
python -m pytest backend/tests -q
pnpm typecheck
pnpm test:ui
pnpm lint
pnpm build
```

With both services running:

```bash
python scripts/smoke_test.py
```

The smoke test checks the React-to-FastAPI connection, session cookies, role
checks, search, booking history and logout without creating or cancelling tickets.

The automated suite covers authentication, ownership, input validation, seat-map
and hold behavior, atomic group checkout, idempotency, last-seat concurrency,
cancellation, rescheduling, PDFs, weekly schedules, ratings, AI interpretation,
report boundaries, developer-only health access, incident capture and sensitive-field redaction. AI-provider requests are
mocked. The UI suite checks assistant memory, schedule helpers, status labels,
recommendation order and arrival labels.

## Files to understand first

```text
app/page.tsx                       Role-based navigation and shared UI state
app/components/SearchPage.tsx      Filters, Ask AI entry and result cards
app/components/AssistantChat.tsx   Conversational search and multi-seat actions
app/components/BookingDialog.tsx   Seat map and multi-passenger checkout
app/components/BookingsPage.tsx    Ticket history, PDF, cancel, reschedule, rating
app/components/ProfilePage.tsx     Customer name, email and phone settings
app/components/AdminPage.tsx       Fleet, seat-layout and schedule management
app/components/DashboardPage.tsx   Date-wise Admin report
app/components/SystemHealthPage.tsx Developer observability UI
app/components/IncidentsPage.tsx    Sanitized developer error diagnostics
app/lib/api.ts                     API types, fetch and formatting helpers
app/lib/seat-hold.ts               Temporary checkout hold lifecycle
app/api/[...path]/route.ts         Same-origin relay to FastAPI
backend/main.py                    REST endpoints and transactional rules
backend/database.py                Relational tables and constraints
backend/schemas.py                 Validated request shapes
backend/search.py                  Groq/OpenAI adapter and labelled fallback
backend/tickets.py                 PDF generation
backend/seed.py                    Non-destructive demo data
backend/tests/                     Automated backend coverage
scripts/journey.test.mjs           Frontend helper tests
scripts/smoke_test.py              Read-only live integration check
```

## Scope and production limitations

This is a local assessment application, not a production transport or payment
platform. Assumptions: INR, IST, up to six passengers per normal checkout, one
ticket and selected seat per passenger, and AC / Non-AC / Sleeper as the supported
bus types.

Not included: payment collection, refunds, customer self-registration, email/SMS,
live vehicle tracking, operator-specific luggage rules, or an immutable accounting
ledger.

Production hardening would include Alembic migrations, persistent distributed
sessions/rate limits/metrics, user provisioning and password reset, audit logs,
pagination, a production identity provider for `/developer`, PostgreSQL integration
tests and browser end-to-end tests.

The frontend includes Sites-compatible build configuration, but Sites alone does
not run this Python API. For a real deployment, host FastAPI and its database,
configure `API_ORIGIN` to that HTTPS service, set the allowed frontend origin,
enable secure cookies, disable demo seeding, replace all demo credentials and keep
secrets outside source control. A frontend deployment pointing to localhost is not
a working full-stack deployment.

Before submission, run every verification command, rehearse the live Groq request,
prepare the four-slide deck, review the code, and commit/push the final source to
the GitHub repository. Never commit `.env`, database files, API keys, or personal
passenger data.
