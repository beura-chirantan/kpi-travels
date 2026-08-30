# Hiring-assessment requirement checklist

This checklist maps the supplied KPi-Tech assignment to the finished project.
It distinguishes required functionality from the additional features built for
the demonstration.

## Required features

| Assignment requirement             | Project implementation                                                                                | Demo evidence                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Admin manages buses                | Add/edit name, registration, AC/Non-AC/Sleeper type, capacity and explicit seat layout                | Admin → Trips & buses → Buses & reviews               |
| Admin manages routes and schedules | Create/edit dated trips with From, To, departure, arrival, fare and booking status                    | Admin → Trips & buses → Trips                         |
| Customer searches buses            | Structured route, date, type, time and fare filters with remaining seats and price                    | Customer → Find buses                                 |
| Customer books and views history   | Seat map, passenger details, confirmation and My bookings                                             | Customer search → Book tickets → My bookings          |
| AI natural-language search         | Groq/OpenAI interpretation produces validated criteria and searches stored trips, ranked by relevance | Ask AI with a route/date/type/budget request          |
| Seat count decreases after booking | Held seats become booked assignments inside the confirmation transaction                              | Compare trip seat count before and after confirmation |
| Confirmed → Cancelled              | Customer cancellation changes status and releases exactly that seat                                   | My bookings → Cancel ticket                           |
| Admin dashboard                    | Date-wise ticket activity/value, occupancy, route demand and per-bus revenue/rating                   | Admin → Daily report                                  |
| Prevent overbooking                | Server-side holds, unique trip/seat assignments, transactions and conditional inventory checks        | Backend concurrency and last-seat tests               |
| Python REST API                    | FastAPI endpoints with validation, status codes, role/ownership checks and OpenAPI                    | `http://127.0.0.1:8000/docs`                          |
| React frontend                     | Separate role-selected Customer and Admin views with functional forms and error states                | `http://127.0.0.1:3000`                               |

Every required assignment item is implemented. Additional features extend the
brief without removing or contradicting its required flows.

## Additional implemented features

- Explicit bus seat-map templates and custom layouts.
- One-to-six-passenger checkout in both regular search and Ask AI.
- Server-side 10-minute group seat holds.
- Atomic group confirmation and safe idempotent retries.
- Individual authenticated PDF tickets.
- Customer ticket rescheduling with seat selection.
- Post-arrival bus ratings and Admin bus-wise review visibility.
- Seven-day weekly schedules with a separate fare per selected weekday.
- One-occurrence trip cancellation with a Customer-visible reason.
- Daily, weekly, monthly and yearly revenue with per-bus breakdowns.
- Customer profile management for name, email and phone.
- Separate developer-only system-health and sanitized incident portal.
- SQLite default plus an optional PostgreSQL configuration.

## Intentional scope boundaries

The assignment does not require and this project does not claim to provide:

- Payment collection, settlement or refunds.
- Customer self-registration, password reset or account verification.
- Email, SMS or push notifications.
- Live GPS tracking or real transport-operator integrations.
- An immutable accounting ledger.
- Distributed production sessions, metrics or rate limits.

Dashboard “revenue” is the current stored value of Confirmed tickets booked in
the selected period, not captured payment revenue. These limits are stated in
the interface, README and live-demo guide so the extra features do not create a
contradictory claim.

## Submission deliverables

- [x] Clean full-stack source structure.
- [x] README with stack, architecture, setup, assumptions and limitations.
- [x] API reference and generated FastAPI OpenAPI documentation.
- [x] Automated backend, frontend-helper and live smoke tests.
- [x] Four-slide presentation outline and 30-minute demo sequence.
- [ ] Final Git commit and GitHub repository link.
- [ ] Actual presentation deck created from the outline.
- [ ] Live Groq request rehearsed with the final local environment.

The last three items require the candidate's repository, presentation tool and
private environment; they should be completed before the Microsoft Teams call.
