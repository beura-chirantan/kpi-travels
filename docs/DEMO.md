# Assessment demo and presentation guide

This guide is for the required 30-minute Microsoft Teams screen share. It is a
rehearsal plan and four-slide outline, not a generated PowerPoint deck.

## Before the call

- Confirm the deadline. The supplied brief mentions both 48 hours and three days.
- Commit and push the final source before the call; do not change it during or
  after the demo.
- Start FastAPI on port 8000 and React on port 3000 before joining Teams.
- Open a fresh customer page, the API health endpoint, and the Admin page once.
- Run `python scripts/smoke_test.py` against the live services.
- Run backend tests, UI tests, type-check, lint and the production build.
- Configure Groq and make one real Ask AI request. Keep normal route search ready
  in case the external provider is unavailable.
- Configure separate `DEVELOPER_EMAIL` and `DEVELOPER_PASSWORD` values, then sign
  in to `/developer` once. A FastAPI restart clears this in-memory developer
  session, so sign in again after any restart.
- Choose dates that still have seeded or Admin-created departures.
- Use fictitious passenger details and never display `.env`, API keys or personal
  data while sharing the screen.
- Keep the four actual slides open in a presentation tool. The outline below is
  the content to turn into those slides.

## Four-slide outline (about 5 minutes)

### Slide 1 — Objective and scope

- Two assignment roles: Customer and Admin.
- Customer searches, chooses seats, books up to six passengers, views tickets and
  cancels before departure.
- Admin manages buses, seat layouts, routes, dated/weekly trips and availability.
- Ask AI interprets natural-language travel requests and guides a booking for up
  to six passengers with explicit confirmation.
- No payment gateway: dashboard revenue means confirmed booked-ticket value.
- Revenue can be reviewed daily, weekly, monthly or yearly, with a per-bus
  breakdown for the selected period.

### Slide 2 — Architecture

```text
React / Vinext → same-origin API relay → FastAPI → SQLAlchemy → SQLite/PostgreSQL
                                         ├── Groq/OpenAI
                                         └── ReportLab PDF
```

- HttpOnly sessions and backend role/ownership checks.
- Customer/Admin UI at `/`; independent developer access at `/developer`.
- The model never receives database access or permission to perform side effects.

### Slide 3 — End-to-end workflow

```text
Search → choose bus → select seats → 10-minute hold → passenger details
       → server revalidation → atomic group booking → individual PDF tickets
```

- Each passenger gets one selected seat and one ticket.
- Cancellation changes Confirmed → Cancelled and releases that seat.
- Ratings become available only after a Confirmed journey arrives.

### Slide 4 — Engineering decisions

- Conditional inventory updates and unique trip/seat assignments prevent
  overbooking.
- Transactions make group checkout, cancellation and rescheduling all-or-nothing.
- Idempotency keys make confirmation retries safe.
- Stored fares protect existing tickets from later fare edits.
- AI output becomes validated criteria; only application endpoints search or book.
- Production improvements: migrations, distributed sessions/limits/metrics,
  PostgreSQL integration tests and browser E2E tests.

## Core live walkthrough (about 15 minutes)

1. Sign in using **Admin demo**.
2. Open **Trips & buses**. Show the Today/date filter and explain that inventory
   belongs to each dated departure.
3. Add or edit a bus. Show its type, capacity and seat-layout templates without
   saving unnecessary demo changes.
4. Add an upcoming trip or weekly plan. Point out From/To, departure, arrival,
   availability, selected weekdays and per-day prices.
5. Open **Daily report**. Select a date and show booked-ticket value, departing
   trips, seats left to book, occupancy, route demand, and bus-wise rating. Open
   Revenue reports and briefly switch between Daily, Weekly, Monthly and Yearly;
   point out that each view has only the period control it needs.
6. Sign out and sign in using **Customer demo**.
7. Open **Profile** and explain that the header name, email and phone belong to
   the signed-in customer and persist across sessions.
8. Search the route normally. Show filters, the From/To swap, arrival time, fare,
   rating and remaining seats.
9. Choose a bus and select two seats on the map. Explain the 10-minute hold and
   enter different fictitious passenger details for both seats.
10. Confirm once. Show two individual tickets in **My bookings** and download one
    PDF.
11. Cancel one of the two tickets. Refresh search or the Admin report and show
    that exactly one seat returned.
12. Open **Ask AI**. Request a route/date/type/budget, then refine it with a
    follow-up such as “same route day after tomorrow” or “remove the time limit.”
13. Ask it to book a result, select two seats, provide each passenger's name and
    age, confirm once, and show the two PDF ticket downloads.

## Optional feature walkthrough (use only if time remains)

### Rescheduling

Open My bookings → Reschedule, choose another departure on the same route, select
an available seat, review the new fare and confirm. The reference and passenger
stay the same; download a fresh PDF afterward.

### Weekly schedule and one-day cancellation

Select Monday, Wednesday and Sunday, give each a different fare, use shared
departure/arrival times and create the bounded series. Show that unselected days
have no trips. Cancel one future occurrence with a reason and show that other
weekly dates remain active.

### Ratings

After a Confirmed trip's arrival time, My bookings displays **Rate this bus**.
Select 1–5 stars and optionally add a comment. Admin sees it under Trips & buses →
Buses & reviews, and recommendations rank rated buses first. If the demo database
has no eligible completed ticket, show the honest “Rate this bus after arrival”
state and explain the automated rating tests; do not invent a review.

### Developer health

Open `/developer` using its separate credentials. Show the rolling 15-minute API
traffic, errors, p95 latency, rate-limit summary, dependency status and capacity
guidance.
Open the Incidents tab and show an error timestamp, sanitized request payload and
returned response. Explain that credentials and customer personal details are
redacted, and that metrics and incidents reset when FastAPI restarts. A clean
system correctly shows **No incidents recorded**. The health and incidents APIs
are excluded from their own metrics, preventing a self-monitoring error loop.
This portal is not linked from or accessible with Customer/Admin sessions.

If the panel asks for a rate-limit demonstration, use a controlled local burst
only after the main login flows are finished. HTTP 401 means invalid or missing
authentication; HTTP 429 means the request limit was exceeded. The login limit
clears after about one minute, while its health measurements remain in the
15-minute window. Do not describe an intentional 401/429 test as a server crash.

### Last-seat concurrency

Explain the automated test in which two customers compete for one remaining seat.
Only one confirmation succeeds. A live two-browser race is optional and should
not replace the reliable automated test explanation.

## Likely follow-up questions

Be ready to explain:

- Why React validation improves UX but cannot enforce security or inventory.
- Why hiding a navigation item is not authorization.
- How selected seats are held, expired and converted to bookings.
- Why a six-passenger checkout creates six tickets in one transaction.
- How idempotency handles a network failure after server confirmation.
- Why the AI returns validated search criteria instead of SQL or invented buses.
- Why chat needs explicit confirmation before booking or cancellation.
- Why ratings require ownership, Confirmed status and a passed arrival time.
- Why revenue is booked-ticket value rather than payment receipts.
- Why SQLite is appropriate for the local demo and what must be tested with
  PostgreSQL before production.
- Which developer metrics are real and which scaling recommendations are only
  short-window guidance.

## Final reminder

The evaluation rewards a clear explanation more than unsupported claims. State
that live payment/refunds, self-registration, email/SMS and live vehicle tracking
are outside scope. If the AI provider or another external dependency fails, show
the labelled fallback and continue with regular search.
