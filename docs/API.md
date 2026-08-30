# REST API reference

FastAPI runs at `http://127.0.0.1:8000` in local development. Every application
endpoint is prefixed with `/api`. The React application normally calls the same
paths through its relay at `http://127.0.0.1:3000/api`.

The complete generated OpenAPI documentation is available at
`http://127.0.0.1:8000/docs` while FastAPI is running. This file is the concise
role-based catalogue used for project review and the live demo.

## Public endpoints

| Method | Path                    | Purpose                                                        |
| ------ | ----------------------- | -------------------------------------------------------------- |
| `GET`  | `/api/health`           | API, database and AI-configuration readiness                   |
| `GET`  | `/api/cities`           | Cities available in stored routes                              |
| `GET`  | `/api/trips`            | Search real trips using structured query parameters            |
| `POST` | `/api/search/natural`   | Interpret a natural-language journey and return matching trips |
| `POST` | `/api/assistant/answer` | Answer short bus-travel and application questions              |

Natural-language results are validated criteria applied to database trips. The
AI provider never receives database credentials and cannot directly create,
cancel or modify a booking.

## Customer identity and profile

| Method | Path                | Purpose                                               |
| ------ | ------------------- | ----------------------------------------------------- |
| `POST` | `/api/auth/login`   | Create an HttpOnly Customer or Admin session          |
| `POST` | `/api/auth/logout`  | Revoke the current application session                |
| `GET`  | `/api/auth/me`      | Return the signed-in application user                 |
| `PUT`  | `/api/auth/profile` | Update the signed-in Customer's name, email and phone |

## Customer booking endpoints

| Method   | Path                                    | Purpose                                                |
| -------- | --------------------------------------- | ------------------------------------------------------ |
| `GET`    | `/api/bookings`                         | List the signed-in Customer's booking history          |
| `GET`    | `/api/trips/{trip_id}/seats`            | Return available, held and booked seats for one trip   |
| `POST`   | `/api/seat-holds`                       | Temporarily hold one to six selected seats             |
| `DELETE` | `/api/seat-holds/{hold_id}`             | Release the Customer's checkout hold                   |
| `POST`   | `/api/booking-groups`                   | Atomically confirm one to six passenger tickets        |
| `POST`   | `/api/bookings`                         | Compatible single-ticket confirmation endpoint         |
| `POST`   | `/api/bookings/{booking_id}/cancel`     | Cancel an eligible owned ticket and release its seat   |
| `GET`    | `/api/bookings/{booking_id}/ticket`     | Download an owned ticket as a PDF                      |
| `POST`   | `/api/bookings/{booking_id}/reschedule` | Move an eligible ticket and seat to another trip       |
| `PUT`    | `/api/bookings/{booking_id}/rating`     | Create or edit the completed journey's 1–5 star rating |

Booking ownership, status, departure time, hold expiry, seat availability and
fare are rechecked by FastAPI. Group confirmation and rescheduling use database
transactions and idempotency keys to prevent partial or duplicate changes.

## Admin endpoints

| Method | Path                                | Purpose                                                   |
| ------ | ----------------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/admin/buses`                  | List fleet details, layouts and ratings                   |
| `POST` | `/api/admin/buses`                  | Add a bus and seat layout                                 |
| `PUT`  | `/api/admin/buses/{bus_id}`         | Edit an existing bus                                      |
| `GET`  | `/api/admin/buses/{bus_id}/ratings` | Read verified ratings and comments for one bus            |
| `GET`  | `/api/admin/trips`                  | List dated trips for management                           |
| `POST` | `/api/admin/trips`                  | Create one dated trip                                     |
| `PUT`  | `/api/admin/trips/{trip_id}`        | Edit route, time, fare or booking availability            |
| `POST` | `/api/admin/weekly-schedules`       | Create a bounded repeating plan with weekday fares        |
| `POST` | `/api/admin/trips/{trip_id}/cancel` | Cancel one not-yet-departed occurrence with a reason      |
| `GET`  | `/api/admin/dashboard`              | Return the date-wise Admin report                         |
| `GET`  | `/api/admin/revenue`                | Return daily, weekly, monthly, yearly and per-bus revenue |

## Private developer endpoints

| Method | Path                           | Purpose                                   |
| ------ | ------------------------------ | ----------------------------------------- |
| `POST` | `/api/developer/login`         | Create an independent developer session   |
| `POST` | `/api/developer/logout`        | Revoke the developer session              |
| `GET`  | `/api/developer/me`            | Validate developer access                 |
| `GET`  | `/api/developer/system-health` | Read the rolling 15-minute health report  |
| `GET`  | `/api/developer/incidents`     | Read sanitized failed-request diagnostics |

The health and incidents endpoints do not measure or record themselves. Metrics,
developer sessions and incidents are held in memory and reset when FastAPI
restarts. Customer and Admin session cookies cannot access this portal.

## Request protection and status codes

State-changing requests require `X-Requested-With: kpi-travels`. Browser cookies
are HttpOnly and protected resources enforce role and ownership on the backend.

| Status                | Meaning in this project                                        |
| --------------------- | -------------------------------------------------------------- |
| `200` / `201` / `204` | Read, creation or no-content action succeeded                  |
| `401`                 | Authentication is missing, expired or invalid                  |
| `403`                 | The signed-in role is not allowed to perform the action        |
| `404`                 | The requested resource or route was not found                  |
| `409`                 | Current booking, seat, schedule or idempotency state conflicts |
| `422`                 | Submitted fields or business input failed validation           |
| `429`                 | The client exceeded a configured request limit                 |
| `500` / `503`         | Server or dependency failure requiring investigation/retry     |

Failed responses are copied to the developer incident feed after sensitive
fields are redacted. A 4xx response describes a rejected client request; it is
not automatically evidence that the Python process crashed.
