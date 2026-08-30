"""REST endpoints. Business rules remain on the server, never in the UI."""
import hashlib
import json
import os
import secrets
import time
import uuid
from calendar import monthrange
from collections import Counter, defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from threading import Lock

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, inspect, or_, select
from sqlalchemy.exc import IntegrityError, OperationalError

from .database import (booking_changes, booking_group_members, booking_groups,
                       booking_seat_history, bookings, buses, bus_seats, checkout_hold_seats,
                       checkout_holds, make_engine, metadata, ratings, routes,
                       schedule_departures, seat_holds, sessions, trip_cancellations,
                       trip_seat_assignments, trips, users, weekly_schedules)
from .schemas import (AssistantQuestion, BookingInput, BusInput, CancelTripInput, LoginInput, MultiDayScheduleInput, ProfileInput, RatingInput,
                      GroupBookingInput, RescheduleInput, SearchCriteria, SearchQuery,
                      SeatHoldInput, TripInput, WeeklyScheduleInput)
from .search import IST, answer_travel_question, canonical_city, interpret
from .security import hash_password, token_hash, verify_password
from .seed import seed_demo
from .tickets import ticket_pdf

load_dotenv()


def now():
    return int(time.time())


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, IST).isoformat()


def trip_query():
    scores = rating_summary()
    return select(trips, buses.c.name.label('bus_name'), buses.c.registration, buses.c.bus_type,
                  routes.c.origin, routes.c.destination, scores.c.average_rating,
                  func.coalesce(scores.c.rating_count, 0).label('rating_count'),
                  trip_cancellations.c.reason.label('cancellation_reason'),
                  schedule_departures.c.schedule_id).select_from(
                      trips.join(buses).join(routes).outerjoin(scores, scores.c.bus_id == buses.c.id)
                      .outerjoin(trip_cancellations).outerjoin(schedule_departures))


def rating_summary():
    return select(ratings.c.bus_id, func.avg(ratings.c.stars).label('average_rating'),
                  func.count().label('rating_count')).group_by(ratings.c.bus_id).subquery()


def revenue_summary(conn, start_timestamp, end_timestamp, monthly=False):
    """Confirmed ticket value by trip departure date (IST), using stored prices.

    Aggregate ratings separately so multiple reviews never multiply ticket revenue.
    Include every bus, even those with no sales or no reviews.
    """
    scores = rating_summary()
    fleet = conn.execute(select(buses, scores.c.average_rating,
        func.coalesce(scores.c.rating_count, 0).label('rating_count')).select_from(
        buses.outerjoin(scores, scores.c.bus_id == buses.c.id))).mappings().all()
    groups = []
    for _ in range(12 if monthly else 1):
        groups.append({'revenue_paise': 0, 'ticket_count': 0, 'demo_bookings': 0,
            'buses': {bus['id']: dict(bus) | {'revenue_paise': 0, 'ticket_count': 0}
                      for bus in fleet}})
    rows = conn.execute(select(bookings.c.total_paise, trips.c.departure_at,
        bookings.c.idempotency_key, trips.c.bus_id).select_from(bookings.join(trips))
        .where(bookings.c.status == 'Confirmed', trips.c.departure_at >= start_timestamp,
               trips.c.departure_at < end_timestamp)).mappings()
    for row in rows:
        index = datetime.fromtimestamp(row['departure_at'], IST).month-1 if monthly else 0
        group = groups[index]
        group['revenue_paise'] += row['total_paise']
        group['ticket_count'] += 1
        group['demo_bookings'] += int(row['idempotency_key'].startswith('seed-'))
        bus = group['buses'][row['bus_id']]
        bus['revenue_paise'] += row['total_paise']
        bus['ticket_count'] += 1
    for group in groups:
        group['buses'] = sorted(group['buses'].values(), key=lambda bus: (-bus['revenue_paise'], bus['name'], bus['id']))
    return groups if monthly else groups[0]


def revenue_timeline(conn, selected_year, selected_month):
    """Build daily, calendar-week, monthly and yearly views in one database read."""
    scores = rating_summary()
    fleet = [dict(row) for row in conn.execute(select(buses, scores.c.average_rating,
        func.coalesce(scores.c.rating_count, 0).label('rating_count')).select_from(
        buses.outerjoin(scores, scores.c.bus_id == buses.c.id))).mappings()]

    def blank_group():
        return {'revenue_paise': 0, 'ticket_count': 0, 'demo_bookings': 0,
                'buses': {bus['id']: bus.copy() | {'revenue_paise': 0, 'ticket_count': 0}
                          for bus in fleet}}

    def add_booking(group, row):
        group['revenue_paise'] += row['total_paise']
        group['ticket_count'] += 1
        group['demo_bookings'] += int((row['idempotency_key'] or '').startswith('seed-'))
        bus = group['buses'][row['bus_id']]
        bus['revenue_paise'] += row['total_paise']
        bus['ticket_count'] += 1

    def finish(group):
        group['buses'] = sorted(group['buses'].values(),
            key=lambda bus: (-bus['revenue_paise'], bus['name'], bus['id']))
        return group

    rows = list(conn.execute(select(bookings.c.total_paise, trips.c.departure_at,
        bookings.c.idempotency_key, trips.c.bus_id).select_from(bookings.join(trips))
        .where(bookings.c.status == 'Confirmed')).mappings())
    year_values = {datetime.fromtimestamp(row['departure_at'], IST).year for row in rows}
    year_values.update((selected_year, datetime.now(IST).year))
    years = {value: blank_group() for value in sorted(year_values)}
    months = [blank_group() for _ in range(12)]
    day_count = monthrange(selected_year, selected_month)[1]
    days = [blank_group() for _ in range(day_count)]

    first_day = date(selected_year, selected_month, 1)
    last_day = date(selected_year, selected_month, day_count)
    week_ranges = []
    cursor = first_day
    while cursor <= last_day:
        week_end = min(cursor + timedelta(days=6-cursor.weekday()), last_day)
        week_ranges.append((cursor, week_end, blank_group()))
        cursor = week_end + timedelta(days=1)

    for row in rows:
        departure = datetime.fromtimestamp(row['departure_at'], IST)
        add_booking(years[departure.year], row)
        if departure.year != selected_year:
            continue
        add_booking(months[departure.month-1], row)
        if departure.month != selected_month:
            continue
        add_booking(days[departure.day-1], row)
        departure_day = departure.date()
        for week_start, week_end, group in week_ranges:
            if week_start <= departure_day <= week_end:
                add_booking(group, row)
                break

    finished_months = [finish(group) | {'month': index+1}
                       for index, group in enumerate(months)]
    return {
        'year': selected_year,
        'month': selected_month,
        'revenue_paise': sum(group['revenue_paise'] for group in finished_months),
        'months': finished_months,
        'days': [finish(group) | {'date': date(selected_year, selected_month, index+1).isoformat()}
                 for index, group in enumerate(days)],
        'weeks': [finish(group) | {'start_date': start.isoformat(), 'end_date': end.isoformat()}
                  for start, end, group in week_ranges],
        'years': [finish(years[value]) | {'year': value}
                  for value in sorted(years, reverse=True)],
    }


def lock_trips(conn, trip_ids):
    # All seat-changing workflows acquire trip locks in the same order.
    for trip_id in sorted(set(trip_ids)):
        conn.execute(trips.update().where(trips.c.id == trip_id).values(active=trips.c.active))


def generated_layout(bus_type, total_seats):
    """Create a practical default that staff can later replace with a custom map."""
    template = 'sleeper_2x1' if bus_type == 'Sleeper' else 'seater_2x2'
    positions = []
    if template == 'sleeper_2x1':
        lower_count = (total_seats+1)//2
        counts = [('Lower', lower_count), ('Upper', total_seats-lower_count)]
        for deck, count in counts:
            for index in range(count):
                row, offset = divmod(index, 3)
                positions.append((deck, row, (0, 1, 3)[offset], 'Sleeper'))
    else:
        for index in range(total_seats):
            row, offset = divmod(index, 4)
            positions.append(('Lower', row, (0, 1, 3, 4)[offset], 'Seat'))
    return [dict(label=str(index+1), deck=deck, row_index=row, column_index=column,
                 seat_type=seat_type)
            for index, (deck, row, column, seat_type) in enumerate(positions)]


def replace_bus_layout(conn, bus_id, layout):
    conn.execute(bus_seats.delete().where(bus_seats.c.bus_id == bus_id))
    if layout:
        conn.execute(bus_seats.insert(), [dict(bus_id=bus_id, **seat) for seat in layout])


def first_free_seat(conn, trip_id, bus_id, seat_id=None):
    assigned = select(trip_seat_assignments.c.seat_id).where(
        trip_seat_assignments.c.trip_id == trip_id)
    held = select(checkout_hold_seats.c.seat_id).where(
        checkout_hold_seats.c.trip_id == trip_id)
    query = select(bus_seats).where(bus_seats.c.bus_id == bus_id,
                                    bus_seats.c.id.not_in(assigned),
                                    bus_seats.c.id.not_in(held))
    if seat_id is not None:
        query = query.where(bus_seats.c.id == seat_id)
    return conn.execute(query.order_by(bus_seats.c.deck, bus_seats.c.row_index,
                                       bus_seats.c.column_index, bus_seats.c.id)).mappings().first()


def save_booking_seat(conn, booking_id, trip_id, seat):
    values = dict(trip_id=trip_id, seat_id=seat['id'], seat_label=seat['label'],
                  deck=seat['deck'], seat_type=seat['seat_type'])
    updated = conn.execute(booking_seat_history.update().where(
        booking_seat_history.c.booking_id == booking_id).values(**values))
    if not updated.rowcount:
        conn.execute(booking_seat_history.insert().values(booking_id=booking_id, **values))


def layout_for_bus(conn, bus_id):
    return [dict(label=row['label'], deck=row['deck'], row_index=row['row_index'],
                 column_index=row['column_index'], seat_type=row['seat_type'])
            for row in conn.execute(select(bus_seats).where(bus_seats.c.bus_id == bus_id)
                .order_by(bus_seats.c.deck, bus_seats.c.row_index,
                          bus_seats.c.column_index)).mappings()]


def bus_dict(conn, row):
    return dict(row) | {'layout': layout_for_bus(conn, row['id'])}


def ensure_seat_data(conn):
    """Backfill layouts and seat labels for databases created by older app versions."""
    for bus in conn.execute(select(buses)).mappings():
        if not conn.execute(select(bus_seats.c.id).where(
                bus_seats.c.bus_id == bus['id']).limit(1)).first():
            replace_bus_layout(conn, bus['id'], generated_layout(bus['bus_type'], bus['total_seats']))
    legacy = conn.execute(select(bookings.c.id, bookings.c.trip_id, trips.c.bus_id)
        .select_from(bookings.join(trips)).where(bookings.c.status == 'Confirmed',
        bookings.c.id.not_in(select(booking_seat_history.c.booking_id)))
        .order_by(bookings.c.created_at, bookings.c.id)).mappings().all()
    for booking in legacy:
        seat = first_free_seat(conn, booking['trip_id'], booking['bus_id'])
        if not seat:
            continue
        conn.execute(trip_seat_assignments.insert().values(trip_id=booking['trip_id'],
            seat_id=seat['id'], booking_id=booking['id'], state='Booked'))
        save_booking_seat(conn, booking['id'], booking['trip_id'], seat)
    # Release version-one holds during the additive migration. They contained
    # exactly one seat and are replaced by checkout_holds on the next selection.
    legacy = conn.execute(seat_holds.delete().returning(seat_holds.c.trip_id)).all()
    for trip_id, count in Counter(row.trip_id for row in legacy).items():
        conn.execute(trips.update().where(trips.c.id == trip_id)
                     .values(available_seats=trips.c.available_seats+count))


def release_expired_holds(conn, timestamp=None):
    """Return inventory for expired checkout holds exactly once."""
    timestamp = timestamp or now()
    expired = conn.execute(seat_holds.delete().where(seat_holds.c.expires_at <= timestamp)
                           .returning(seat_holds.c.trip_id)).all()
    for trip_id, count in Counter(row.trip_id for row in expired).items():
        conn.execute(trips.update().where(trips.c.id == trip_id)
                     .values(available_seats=trips.c.available_seats+count))
    expired_ids = select(checkout_holds.c.id).where(checkout_holds.c.expires_at <= timestamp)
    released = conn.execute(select(checkout_hold_seats.c.trip_id).where(
        checkout_hold_seats.c.hold_id.in_(expired_ids))).all()
    conn.execute(checkout_holds.delete().where(checkout_holds.c.expires_at <= timestamp))
    for trip_id, count in Counter(row.trip_id for row in released).items():
        conn.execute(trips.update().where(trips.c.id == trip_id)
                     .values(available_seats=trips.c.available_seats+count))


def hold_dict(conn, row):
    seats = conn.execute(select(bus_seats).select_from(checkout_hold_seats.join(
        bus_seats, checkout_hold_seats.c.seat_id == bus_seats.c.id)).where(
        checkout_hold_seats.c.hold_id == row['id']).order_by(
        bus_seats.c.deck, bus_seats.c.row_index, bus_seats.c.column_index)).mappings().all()
    return {'id': row['id'], 'trip_id': row['trip_id'], 'price_paise': row['price_paise'],
            'created_at': iso(row['created_at']), 'expires_at': iso(row['expires_at']),
            'seconds_remaining': max(0, row['expires_at']-now()),
            'seat': dict(seats[0]) if seats else None,
            'seats': [dict(seat) for seat in seats]}


def trip_dict(row):
    result = dict(row)
    result['departure_at'] = iso(result['departure_at'])
    result['arrival_at'] = iso(result['arrival_at'])
    return result


def booking_dict(conn, row):
    result = dict(row)
    result.pop('request_hash', None)
    result.pop('idempotency_key', None)
    result['created_at'] = iso(result['created_at'])
    result['cancelled_at'] = iso(result['cancelled_at']) if result['cancelled_at'] else None
    trip = conn.execute(trip_query().where(trips.c.id == result['trip_id'])).mappings().one()
    result['trip'] = trip_dict(trip)
    result['can_cancel'] = result['status'] == 'Confirmed' and trip['departure_at'] > now()
    result['can_reschedule'] = result['can_cancel'] and not trip['cancellation_reason']
    result['can_rate'] = result['status'] == 'Confirmed' and trip['arrival_at'] <= now()
    rating = conn.execute(select(ratings.c.stars, ratings.c.comment).where(
        ratings.c.booking_id == result['id'])).mappings().first()
    result['rating'] = dict(rating) if rating else None
    result['reschedule_count'] = conn.execute(select(func.count()).select_from(booking_changes)
        .where(booking_changes.c.booking_id == result['id'])).scalar_one()
    seat = conn.execute(select(booking_seat_history.c.seat_id, booking_seat_history.c.seat_label,
        booking_seat_history.c.deck, booking_seat_history.c.seat_type).where(
        booking_seat_history.c.booking_id == result['id'])).mappings().first()
    result['seat'] = dict(seat) if seat else None
    return result


def booking_group_dict(conn, row):
    member_ids = select(booking_group_members.c.booking_id).where(
        booking_group_members.c.group_id == row['id']).order_by(
        booking_group_members.c.passenger_order)
    tickets = [booking_dict(conn, booking) for booking in conn.execute(
        select(bookings).where(bookings.c.id.in_(member_ids))).mappings().all()]
    order = {booking_id: index for index, booking_id in enumerate(conn.execute(
        select(booking_group_members.c.booking_id).where(
            booking_group_members.c.group_id == row['id']).order_by(
            booking_group_members.c.passenger_order)).scalars())}
    tickets.sort(key=lambda booking: order[booking['id']])
    return {'id': row['id'], 'created_at': iso(row['created_at']), 'bookings': tickets,
            'ticket_count': len(tickets),
            'total_paise': sum(ticket['total_paise'] for ticket in tickets)}


def create_app(database_url=None, seed=None):
    engine = make_engine(database_url)
    hold_seconds = max(60, min(900, int(os.getenv('SEAT_HOLD_SECONDS', '600'))))

    @asynccontextmanager
    async def lifespan(app):
        metadata.create_all(engine)
        # metadata.create_all does not add columns to an existing installation.
        # Keep the assessment database compatible without requiring a reset.
        with engine.begin() as conn:
            if 'phone' not in {column['name'] for column in inspect(conn).get_columns('users')}:
                conn.exec_driver_sql('ALTER TABLE users ADD COLUMN phone VARCHAR(20)')
        # Also installs reporting/history indexes when these tables already exist.
        for table in (trips, booking_changes, bookings):
            for index in table.indexes:
                index.create(engine, checkfirst=True)
        if engine.dialect.name == 'sqlite':
            with engine.begin() as conn:
                conn.exec_driver_sql('PRAGMA optimize')
        if seed if seed is not None else os.getenv('SEED_DEMO', 'true').lower() == 'true':
            seed_demo(engine)
        with engine.begin() as conn:
            release_expired_holds(conn)
            ensure_seat_data(conn)
        yield
        engine.dispose()

    app = FastAPI(title='KPi Travels API', version='1.0.0', lifespan=lifespan,
                  description='Bus inventory, transactional booking, and AI-assisted search. All fares are in paise.')
    app.state.engine = engine
    original_openapi = app.openapi
    metrics_started = time.time()
    request_events = deque(maxlen=20_000)
    provider_events = deque(maxlen=2_000)
    incident_events = deque(maxlen=500)
    metrics_lock = Lock()
    developer_sessions = {}
    developer_sessions_lock = Lock()
    observability_paths = {'/api/developer/system-health', '/api/developer/incidents'}

    sensitive_fields = {
        'password', 'token', 'access_token', 'refresh_token', 'api_key', 'secret',
        'authorization', 'cookie', 'phone', 'email', 'passenger_name', 'customer_name',
        'passenger_age', 'name', 'comment',
    }

    def sanitized(value, field='', depth=0):
        """Keep useful diagnostics while removing credentials and customer PII."""
        normalized = field.casefold().replace('-', '_')
        if normalized in sensitive_fields or any(term in normalized for term in (
                'password', 'token', 'secret', 'api_key', 'authorization', 'cookie')):
            return '[REDACTED]'
        if depth >= 6:
            return '[TRUNCATED]'
        if isinstance(value, dict):
            return {str(key): sanitized(item, str(key), depth+1)
                    for key, item in list(value.items())[:100]}
        if isinstance(value, (list, tuple)):
            return [sanitized(item, field, depth+1) for item in list(value)[:100]]
        if isinstance(value, str):
            return value if len(value) <= 1000 else value[:1000]+'… [TRUNCATED]'
        if value is None or isinstance(value, (int, float, bool)):
            return value
        return str(value)[:1000]

    def request_path(request):
        route = request.scope.get('route')
        return getattr(route, 'path', request.url.path)

    def record_incident(request, status, response_payload, error_type=None):
        if request.url.path in observability_paths:
            request.state.incident_recorded = True
            return
        payload = getattr(request.state, 'incident_payload', {})
        request.state.incident_recorded = True
        with metrics_lock:
            incident_events.append({
                'id': str(uuid.uuid4()),
                'timestamp': datetime.now(IST).isoformat(),
                'method': request.method,
                'path': request_path(request),
                'status': status,
                'error_type': error_type,
                'request_payload': sanitized(payload),
                'response': sanitized(response_payload),
            })

    def documented_openapi():
        schema = original_openapi()
        for path in schema.get('paths', {}).values():
            for method, operation in path.items():
                if method in ('post', 'put', 'patch', 'delete'):
                    parameters = operation.setdefault('parameters', [])
                    if not any(p.get('name') == 'X-Requested-With' for p in parameters):
                        parameters.append({'name': 'X-Requested-With', 'in': 'header', 'required': True,
                            'schema': {'type': 'string', 'default': 'kpi-travels'},
                            'description': 'Request protection header required for state-changing calls.'})
        return schema

    app.openapi = documented_openapi
    allowed = [x.strip() for x in os.getenv('ALLOWED_ORIGINS', 'http://127.0.0.1:3000,http://localhost:3000').split(',')]
    app.add_middleware(CORSMiddleware, allow_origins=allowed, allow_credentials=True,
                       allow_methods=['GET', 'POST', 'PUT', 'DELETE'], allow_headers=['Content-Type', 'X-Requested-With', 'Idempotency-Key'])

    @app.middleware('http')
    async def protect_writes(request, call_next):
        started = time.perf_counter()
        status_code = 500
        request.state.incident_recorded = False
        captured = {}
        if request.query_params:
            captured['query'] = dict(request.query_params)
        if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and \
                'application/json' in request.headers.get('content-type', ''):
            try:
                content_length = int(request.headers.get('content-length', '0') or 0)
                captured['body'] = (await request.json() if content_length <= 16_384 else
                                    '[PAYLOAD OMITTED: LARGER THAN 16 KB]')
            except (ValueError, json.JSONDecodeError):
                captured['body'] = '[INVALID JSON PAYLOAD]'
        request.state.incident_payload = sanitized(captured)
        try:
            if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
                origin = request.headers.get('origin')
                if origin and origin not in allowed:
                    response = JSONResponse(status_code=403, content={'detail': 'Origin is not allowed.'})
                    record_incident(request, 403, {'detail': 'Origin is not allowed.'}, 'RequestProtection')
                elif request.headers.get('x-requested-with') != 'kpi-travels':
                    response = JSONResponse(status_code=403, content={'detail': 'Missing request protection header.'})
                    record_incident(request, 403, {'detail': 'Missing request protection header.'}, 'RequestProtection')
                else:
                    response = await call_next(request)
            else:
                response = await call_next(request)
            status_code = response.status_code
            if status_code >= 400 and not request.state.incident_recorded:
                chunks = [chunk async for chunk in response.body_iterator]
                body = b''.join(chunk if isinstance(chunk, bytes) else chunk.encode()
                                for chunk in chunks)
                try:
                    response_payload = json.loads(body) if body else {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    response_payload = {'body': body.decode('utf-8', errors='replace')}
                record_incident(request, status_code, response_payload, 'HTTPErrorResponse')
                replacement = Response(content=body, status_code=status_code,
                                       background=response.background)
                replacement.raw_headers = response.raw_headers
                response = replacement
            response.headers['Cache-Control'] = 'no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            return response
        except Exception as exc:
            if not request.state.incident_recorded:
                record_incident(request, 500, {'detail': 'Internal server error.'}, type(exc).__name__)
            raise
        finally:
            path = request_path(request)
            if request.method != 'OPTIONS' and request.url.path not in observability_paths:
                with metrics_lock:
                    request_events.append({
                        'at': time.time(), 'method': request.method, 'path': path,
                        'status': status_code,
                        'duration_ms': round((time.perf_counter()-started)*1000, 2),
                    })

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        content = {'detail': jsonable_encoder(exc.detail)}
        record_incident(request, exc.status_code, content, 'HTTPException')
        return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        details = []
        for item in jsonable_encoder(exc.errors()):
            details.append({key: value for key, value in item.items() if key not in ('input', 'ctx')})
        content = {'detail': details}
        record_incident(request, 422, content, 'RequestValidationError')
        return JSONResponse(status_code=422, content=content)

    @app.exception_handler(OperationalError)
    async def database_busy(request, exc):
        content = {'detail': 'Database temporarily unavailable. Please retry.'}
        record_incident(request, 503, content, 'OperationalError')
        return JSONResponse(status_code=503, content=content)

    def current_user(request: Request):
        token = request.cookies.get('kpi_session', '')
        with engine.connect() as conn:
            user = conn.execute(select(users.c.id, users.c.name, users.c.email, users.c.phone,
                users.c.role)
                .join(sessions, users.c.id == sessions.c.user_id)
                .where(sessions.c.token_hash == token_hash(token), sessions.c.expires_at > now())).mappings().first()
        if not user:
            raise HTTPException(401, 'Please sign in to continue.')
        return dict(user)

    def admin(user=Depends(current_user)):
        if user['role'] != 'admin':
            raise HTTPException(403, 'Admin access required.')
        return user

    def customer(user=Depends(current_user)):
        if user['role'] != 'customer':
            raise HTTPException(403, 'Please use a customer account to book tickets.')
        return user

    def current_developer(request: Request):
        session_hash = token_hash(request.cookies.get('kpi_developer_session', ''))
        current = now()
        with developer_sessions_lock:
            expired = [key for key, value in developer_sessions.items()
                       if value['expires_at'] <= current]
            for key in expired:
                developer_sessions.pop(key, None)
            session = developer_sessions.get(session_hash)
        if not session:
            raise HTTPException(401, 'Developer sign-in required.')
        return {'email': session['email'], 'role': 'developer'}

    limits = defaultdict(list)
    limits_lock = Lock()
    dummy_hash = hash_password('invalid-user-placeholder')

    def rate_limit(key, maximum, seconds=60):
        with limits_lock:
            cutoff = time.time() - seconds
            limits[key] = [stamp for stamp in limits[key] if stamp > cutoff]
            if len(limits[key]) >= maximum:
                raise HTTPException(429, 'Too many requests. Please wait a minute and try again.')
            limits[key].append(time.time())

    def record_provider(operation, mode):
        with metrics_lock:
            provider_events.append({'at': time.time(), 'operation': operation, 'mode': mode})

    @app.get('/api/health')
    def health():
        with engine.connect() as conn:
            conn.execute(select(1))
        return {'status': 'ok', 'ai_configured': bool(os.getenv('GROQ_API_KEY') or
                os.getenv('OPENAI_API_KEY')), 'timezone': 'Asia/Kolkata'}

    @app.post('/api/developer/login')
    def developer_login(data: LoginInput, request: Request, response: Response):
        rate_limit(('developer_login', request.client.host if request.client else 'unknown'), 8)
        expected_email = os.getenv('DEVELOPER_EMAIL', '').strip().lower()
        expected_password = os.getenv('DEVELOPER_PASSWORD', '')
        if not expected_email or not expected_password:
            raise HTTPException(503, 'Developer access is not configured on this server.')
        email_ok = secrets.compare_digest(
            hashlib.sha256(data.email.lower().encode()).digest(),
            hashlib.sha256(expected_email.encode()).digest())
        password_ok = secrets.compare_digest(
            hashlib.sha256(data.password.encode()).digest(),
            hashlib.sha256(expected_password.encode()).digest())
        if not (email_ok and password_ok):
            raise HTTPException(401, 'Incorrect developer email or password.')
        token = secrets.token_urlsafe(32)
        with developer_sessions_lock:
            developer_sessions[token_hash(token)] = {
                'email': expected_email, 'expires_at': now()+28800}
        response.set_cookie('kpi_developer_session', token, httponly=True, samesite='lax',
                            max_age=28800,
                            secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true', path='/')
        return {'email': expected_email, 'role': 'developer'}

    @app.post('/api/developer/logout', status_code=204)
    def developer_logout(request: Request, response: Response):
        with developer_sessions_lock:
            developer_sessions.pop(token_hash(request.cookies.get(
                'kpi_developer_session', '')), None)
        response.delete_cookie('kpi_developer_session', path='/')

    @app.get('/api/developer/me')
    def developer_me(developer=Depends(current_developer)):
        return developer

    @app.post('/api/auth/login')
    def login(data: LoginInput, request: Request, response: Response):
        rate_limit(('login', request.client.host if request.client else 'unknown'), 15)
        with engine.begin() as conn:
            user = conn.execute(select(users).where(users.c.email == data.email.lower())).mappings().first()
            valid = verify_password(data.password, user['password_hash'] if user else dummy_hash)
            if not user or not valid:
                raise HTTPException(401, 'Incorrect email or password.')
            token = secrets.token_urlsafe(32)
            previous = request.cookies.get('kpi_session')
            if previous:
                conn.execute(sessions.delete().where(sessions.c.token_hash == token_hash(previous)))
            conn.execute(sessions.delete().where(sessions.c.expires_at < now()))
            conn.execute(sessions.insert().values(token_hash=token_hash(token), user_id=user['id'], expires_at=now()+28800))
            response.set_cookie('kpi_session', token, httponly=True, samesite='lax', max_age=28800,
                                secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true', path='/')
            return {key: user[key] for key in ('id', 'name', 'email', 'phone', 'role')}

    @app.post('/api/auth/logout', status_code=204)
    def logout(request: Request, response: Response):
        with engine.begin() as conn:
            conn.execute(sessions.delete().where(sessions.c.token_hash == token_hash(request.cookies.get('kpi_session', ''))))
        response.delete_cookie('kpi_session', path='/')

    @app.get('/api/auth/me')
    def me(user=Depends(current_user)):
        return user

    @app.put('/api/auth/profile')
    def update_profile(data: ProfileInput, user=Depends(customer)):
        try:
            with engine.begin() as conn:
                conn.execute(users.update().where(users.c.id == user['id']).values(
                    name=data.name, email=data.email, phone=data.phone))
                updated = conn.execute(select(users.c.id, users.c.name, users.c.email,
                    users.c.phone, users.c.role).where(users.c.id == user['id'])).mappings().one()
                return dict(updated)
        except IntegrityError:
            raise HTTPException(409, 'That email address is already used by another account.')

    @app.get('/api/cities')
    def cities():
        with engine.connect() as conn:
            rows = conn.execute(select(routes.c.origin, routes.c.destination)).all()
        return sorted({city for row in rows for city in row})

    def find_trips(criteria):
        query = trip_query().where(trips.c.active.is_(True), trips.c.available_seats > 0, trips.c.departure_at > now())
        if criteria.origin:
            query = query.where(routes.c.origin == canonical_city(criteria.origin))
        if criteria.destination:
            query = query.where(routes.c.destination == canonical_city(criteria.destination))
        if criteria.travel_date:
            start = datetime.combine(criteria.travel_date, datetime.min.time(), IST)
            query = query.where(trips.c.departure_at >= int(start.timestamp()),
                                trips.c.departure_at < int((start+timedelta(days=1)).timestamp()))
        if criteria.bus_type:
            query = query.where(buses.c.bus_type == criteria.bus_type)
        if criteria.min_price:
            query = query.where(trips.c.price_paise >= criteria.min_price*100)
        if criteria.max_price:
            query = query.where(trips.c.price_paise <= criteria.max_price*100)
        if criteria.exclude_bus_name:
            query = query.where(func.lower(buses.c.name) != criteria.exclude_bus_name.casefold())
        with engine.begin() as conn:
            release_expired_holds(conn)
            records = conn.execute(query.order_by(trips.c.departure_at, trips.c.price_paise)).mappings().all()
        windows = {'morning': lambda h: 6 <= h < 12, 'afternoon': lambda h: 12 <= h < 17,
                   'evening': lambda h: 17 <= h < 21, 'night': lambda h: h >= 21 or h < 6}
        results = []
        for row in records:
            departure = datetime.fromtimestamp(row['departure_at'], IST)
            hour = departure.hour
            if criteria.time_of_day and not windows[criteria.time_of_day](hour):
                continue
            departure_minutes = departure.hour*60 + departure.minute
            after = (int(criteria.departure_after[:2])*60 + int(criteria.departure_after[3:])
                     if criteria.departure_after else None)
            before = (int(criteria.departure_before[:2])*60 + int(criteria.departure_before[3:])
                      if criteria.departure_before else None)
            if after is not None and before is not None:
                in_range = (after <= departure_minutes <= before if after <= before else
                            departure_minutes >= after or departure_minutes <= before)
                if not in_range:
                    continue
            elif after is not None and departure_minutes < after:
                continue
            elif before is not None and departure_minutes > before:
                continue
            arrival_hour = datetime.fromtimestamp(row['arrival_at'], IST).hour
            if criteria.arrival_time_of_day and not windows[criteria.arrival_time_of_day](arrival_hour):
                continue
            item = trip_dict(row)
            item['preference_match'] = bool(criteria.preferred_type and row['bus_type'] == criteria.preferred_type)
            results.append(item)
        results.sort(key=lambda row: (-(row['average_rating'] or 0), -row['rating_count'],
                     not row['preference_match'], row['departure_at'], row['price_paise'], row['id']))
        if criteria.next_available and results:
            return [min(results, key=lambda row: (row['departure_at'], row['price_paise'], row['id']))]
        return results

    @app.get('/api/trips')
    def search(criteria: SearchCriteria = Depends()):
        if criteria.travel_date and criteria.travel_date < datetime.now(IST).date():
            raise HTTPException(422, 'Please choose today or a future date.')
        return find_trips(criteria)

    @app.post('/api/search/natural')
    def natural_search(data: SearchQuery, request: Request):
        rate_limit(('search', request.client.host if request.client else 'unknown'), 12)
        criteria, mode, message = interpret(data.query, cities())
        record_provider('AI search', mode)
        return {'criteria': criteria.model_dump(mode='json'), 'mode': mode, 'message': message,
                'trips': [] if criteria.clarification else find_trips(criteria)}

    @app.post('/api/assistant/answer')
    def assistant_answer(data: AssistantQuestion, request: Request):
        rate_limit(('assistant', request.client.host if request.client else 'unknown'), 20)
        answer, mode = answer_travel_question(data.query, cities(), [
            turn.model_dump() for turn in data.history])
        record_provider('Travel answers', mode)
        return {'answer': answer, 'mode': mode}

    @app.get('/api/bookings')
    def my_bookings(user=Depends(customer)):
        with engine.connect() as conn:
            rows = conn.execute(select(bookings).where(bookings.c.user_id == user['id']).order_by(bookings.c.created_at.desc())).mappings().all()
            return [booking_dict(conn, row) for row in rows]

    @app.get('/api/trips/{trip_id}/seats')
    def trip_seats(trip_id: int, user=Depends(customer)):
        with engine.begin() as conn:
            release_expired_holds(conn)
            trip = conn.execute(select(trips).where(trips.c.id == trip_id)).mappings().first()
            if not trip:
                raise HTTPException(404, 'Trip not found.')
            rows = conn.execute(select(bus_seats).where(
                bus_seats.c.bus_id == trip['bus_id']).order_by(
                bus_seats.c.deck, bus_seats.c.row_index,
                bus_seats.c.column_index)).mappings().all()
            booked_ids = set(conn.execute(select(trip_seat_assignments.c.seat_id).where(
                trip_seat_assignments.c.trip_id == trip_id)).scalars())
            held_rows = conn.execute(select(checkout_hold_seats.c.seat_id,
                checkout_holds.c.user_id).select_from(checkout_hold_seats.join(
                checkout_holds)).where(checkout_hold_seats.c.trip_id == trip_id)).all()
            held = {row.seat_id: row.user_id for row in held_rows}
            return [{**dict(row),
                     'status': ('Booked' if row['id'] in booked_ids else
                                ('Held' if row['id'] in held else 'Available')),
                     'mine': held.get(row['id']) == user['id']} for row in rows]

    @app.post('/api/seat-holds', status_code=201)
    def create_seat_hold(data: SeatHoldInput, response: Response, user=Depends(customer)):
        """Atomically replace this customer's checkout seat selection."""
        try:
            with engine.begin() as conn:
                release_expired_holds(conn)
                existing = conn.execute(select(checkout_holds).where(
                    checkout_holds.c.user_id == user['id'])).mappings().first()
                if existing and data.seat_id is None and data.seat_ids is None and \
                        existing['trip_id'] == data.trip_id and \
                        existing['price_paise'] == data.expected_price_paise:
                    response.status_code = 200
                    return hold_dict(conn, existing)
                requested_ids = data.seat_ids or ([data.seat_id] if data.seat_id else [])
                if not requested_ids:
                    trip_for_default = conn.execute(select(trips).where(
                        trips.c.id == data.trip_id)).mappings().first()
                    if not trip_for_default:
                        raise HTTPException(404, 'Trip not found.')
                    default = first_free_seat(conn, data.trip_id, trip_for_default['bus_id'])
                    requested_ids = [default['id']] if default else []
                current_ids = (set(conn.execute(select(checkout_hold_seats.c.seat_id).where(
                    checkout_hold_seats.c.hold_id == existing['id'])).scalars()) if existing else set())
                if existing and existing['trip_id'] == data.trip_id and \
                        existing['price_paise'] == data.expected_price_paise and \
                        current_ids == set(requested_ids):
                    response.status_code = 200
                    return hold_dict(conn, existing)
                if existing:
                    conn.execute(checkout_holds.delete().where(
                        checkout_holds.c.id == existing['id']))
                    conn.execute(trips.update().where(trips.c.id == existing['trip_id'])
                                 .values(available_seats=trips.c.available_seats+len(current_ids)))
                trip = conn.execute(select(trips).where(trips.c.id == data.trip_id)).mappings().first()
                if not trip:
                    raise HTTPException(404, 'Trip not found.')
                if trip['price_paise'] != data.expected_price_paise:
                    raise HTTPException(409, 'The fare changed. Search again to review the latest price.')
                if not requested_ids or len(requested_ids) > 6:
                    raise HTTPException(422, 'Choose between 1 and 6 seats.')
                if (not trip['active'] or trip['departure_at'] <= now() or
                        trip['available_seats'] < len(requested_ids)):
                    raise HTTPException(409, 'Not enough seats are available for this booking.')
                selected = conn.execute(select(bus_seats).where(
                    bus_seats.c.bus_id == trip['bus_id'],
                    bus_seats.c.id.in_(requested_ids),
                    bus_seats.c.id.not_in(select(trip_seat_assignments.c.seat_id).where(
                        trip_seat_assignments.c.trip_id == data.trip_id)),
                    bus_seats.c.id.not_in(select(checkout_hold_seats.c.seat_id).where(
                        checkout_hold_seats.c.trip_id == data.trip_id)))).mappings().all()
                if len(selected) != len(requested_ids):
                    raise HTTPException(409, 'One of those seats was just taken. Refresh and choose again.')
                timestamp = now()
                hold_id = str(uuid.uuid4())
                conn.execute(checkout_holds.insert().values(id=hold_id, user_id=user['id'],
                    trip_id=data.trip_id, price_paise=trip['price_paise'],
                    created_at=timestamp, expires_at=timestamp+hold_seconds))
                conn.execute(checkout_hold_seats.insert(), [dict(hold_id=hold_id,
                    trip_id=data.trip_id, seat_id=seat_id) for seat_id in requested_ids])
                reserved = conn.execute(trips.update().where(trips.c.id == data.trip_id,
                    trips.c.active.is_(True), trips.c.departure_at > now(),
                    trips.c.available_seats >= len(requested_ids),
                    trips.c.price_paise == data.expected_price_paise)
                    .values(available_seats=trips.c.available_seats-len(requested_ids)))
                if not reserved.rowcount:
                    raise HTTPException(409, 'No seat is available to hold for this trip. Please search again.')
                row = conn.execute(select(checkout_holds).where(
                    checkout_holds.c.id == hold_id)).mappings().one()
                return hold_dict(conn, row)
        except IntegrityError:
            # Another checkout may have changed one of the same seats concurrently.
            with engine.connect() as conn:
                existing = conn.execute(select(checkout_holds).where(
                    checkout_holds.c.user_id == user['id'],
                    checkout_holds.c.expires_at > now())).mappings().first()
                if existing and existing['trip_id'] == data.trip_id:
                    return hold_dict(conn, existing)
            raise HTTPException(409, 'That seat is no longer available. Refresh the seat map and choose another.')

    @app.delete('/api/seat-holds/{hold_id}', status_code=204)
    def release_seat_hold(hold_id: str, user=Depends(customer)):
        with engine.begin() as conn:
            release_expired_holds(conn)
            held = conn.execute(select(checkout_holds).where(checkout_holds.c.id == hold_id,
                checkout_holds.c.user_id == user['id'])).mappings().first()
            seat_count = (conn.execute(select(func.count()).select_from(checkout_hold_seats)
                .where(checkout_hold_seats.c.hold_id == hold_id)).scalar_one() if held else 0)
            released = conn.execute(checkout_holds.delete().where(
                checkout_holds.c.id == hold_id, checkout_holds.c.user_id == user['id'])
                .returning(checkout_holds.c.trip_id)).first()
            if released:
                conn.execute(trips.update().where(trips.c.id == released.trip_id)
                             .values(available_seats=trips.c.available_seats+seat_count))
        return Response(status_code=204)

    @app.post('/api/bookings', status_code=201)
    def book(data: BookingInput, response: Response, user=Depends(customer),
             idempotency_key: str = Header(min_length=8, max_length=100)):
        fingerprint = hashlib.sha256(json.dumps(data.model_dump(), sort_keys=True).encode()).hexdigest()

        def replay(conn):
            existing = conn.execute(select(bookings).where(bookings.c.user_id == user['id'],
                                   bookings.c.idempotency_key == idempotency_key)).mappings().first()
            if existing:
                if existing['request_hash'] != fingerprint:
                    raise HTTPException(409, 'This request key was already used for different passenger details.')
                response.status_code = 200
                return booking_dict(conn, existing)

        try:
            with engine.begin() as conn:
                release_expired_holds(conn)
                existing = replay(conn)
                if existing:
                    return existing
                reserved = None
                selected_seat = None
                if data.hold_id:
                    held = conn.execute(select(checkout_holds).where(
                        checkout_holds.c.id == data.hold_id,
                        checkout_holds.c.user_id == user['id'],
                        checkout_holds.c.trip_id == data.trip_id,
                        checkout_holds.c.price_paise == data.expected_price_paise,
                        checkout_holds.c.expires_at > now())).mappings().first()
                    if not held:
                        raise HTTPException(409, 'Your 10-minute seat hold expired. Hold a seat again to continue.')
                    trip = conn.execute(select(trips.c.price_paise, trips.c.active,
                        trips.c.departure_at).where(trips.c.id == data.trip_id)).mappings().first()
                    if not trip or not trip['active'] or trip['departure_at'] <= now():
                        raise HTTPException(409, 'This trip is no longer available. Please search again.')
                    if trip['price_paise'] != data.expected_price_paise:
                        raise HTTPException(409, 'The fare changed. Search again to review the latest price.')
                    held_seats = conn.execute(select(bus_seats).select_from(
                        checkout_hold_seats.join(bus_seats,
                            checkout_hold_seats.c.seat_id == bus_seats.c.id)).where(
                        checkout_hold_seats.c.hold_id == data.hold_id,
                        checkout_hold_seats.c.trip_id == data.trip_id)).mappings().all()
                    if len(held_seats) != 1:
                        raise HTTPException(409, 'Use group checkout to confirm multiple selected seats.')
                    selected_seat = held_seats[0]
                    if not selected_seat:
                        raise HTTPException(409, 'Your selected seat is no longer held. Choose a seat again.')
                    reserved = (held['price_paise'],)
                else:
                    # A single conditional UPDATE reserves the seat atomically on both databases.
                    reserved = conn.execute(trips.update().where(trips.c.id == data.trip_id,
                        trips.c.active.is_(True), trips.c.departure_at > now(), trips.c.available_seats >= 1,
                        trips.c.price_paise == data.expected_price_paise)
                        .values(available_seats=trips.c.available_seats-1).returning(trips.c.price_paise)).first()
                if not reserved:
                    # Another request with the same key may have just finished while we waited.
                    existing = replay(conn)
                    if existing:
                        return existing
                    row = conn.execute(select(trips).where(trips.c.id == data.trip_id)).mappings().first()
                    if not row:
                        raise HTTPException(404, 'Trip not found.')
                    if row['price_paise'] != data.expected_price_paise:
                        raise HTTPException(409, 'The fare changed. Search again to review the latest price.')
                    raise HTTPException(409, 'This trip is sold out, inactive, or already departed. Please search again.')
                if not selected_seat:
                    trip_bus_id = conn.execute(select(trips.c.bus_id).where(
                        trips.c.id == data.trip_id)).scalar_one()
                    selected_seat = first_free_seat(conn, data.trip_id, trip_bus_id)
                    if not selected_seat:
                        raise HTTPException(409, 'No individual seat is available. Please refresh and choose again.')
                booking_id = str(uuid.uuid4())
                conn.execute(bookings.insert().values(id=booking_id, user_id=user['id'], trip_id=data.trip_id,
                    passenger_name=data.passenger_name, passenger_age=data.passenger_age, phone=data.phone,
                    seat_count=1, total_paise=reserved[0], status='Confirmed', created_at=now(),
                    idempotency_key=idempotency_key, request_hash=fingerprint))
                if data.hold_id:
                    conn.execute(trip_seat_assignments.insert().values(trip_id=data.trip_id,
                        seat_id=selected_seat['id'], booking_id=booking_id, state='Booked'))
                    conn.execute(checkout_holds.delete().where(
                        checkout_holds.c.id == data.hold_id,
                        checkout_holds.c.user_id == user['id']))
                else:
                    conn.execute(trip_seat_assignments.insert().values(trip_id=data.trip_id,
                        seat_id=selected_seat['id'], booking_id=booking_id, state='Booked'))
                save_booking_seat(conn, booking_id, data.trip_id, selected_seat)
                row = conn.execute(select(bookings).where(bookings.c.id == booking_id)).mappings().one()
                return booking_dict(conn, row)
        except IntegrityError:
            # Unique idempotency key prevents duplicate tickets; the failed reservation rolled back.
            with engine.connect() as conn:
                existing = replay(conn)
                if existing:
                    return existing
            raise HTTPException(409, 'Booking could not be completed. Please retry.')

    @app.post('/api/booking-groups', status_code=201)
    def book_group(data: GroupBookingInput, response: Response, user=Depends(customer),
                   idempotency_key: str = Header(min_length=8, max_length=100)):
        fingerprint = hashlib.sha256(json.dumps(data.model_dump(), sort_keys=True).encode()).hexdigest()

        def replay(conn):
            group = conn.execute(select(booking_groups).where(
                booking_groups.c.user_id == user['id'],
                booking_groups.c.idempotency_key == idempotency_key)).mappings().first()
            if group:
                if group['request_hash'] != fingerprint:
                    raise HTTPException(409, 'This request key was already used for different passengers.')
                response.status_code = 200
                return booking_group_dict(conn, group)

        try:
            with engine.begin() as conn:
                release_expired_holds(conn)
                existing = replay(conn)
                if existing:
                    return existing
                held = conn.execute(select(checkout_holds).where(
                    checkout_holds.c.id == data.hold_id,
                    checkout_holds.c.user_id == user['id'],
                    checkout_holds.c.trip_id == data.trip_id,
                    checkout_holds.c.price_paise == data.expected_price_paise,
                    checkout_holds.c.expires_at > now())).mappings().first()
                if not held:
                    raise HTTPException(409, 'Your 10-minute seat hold expired. Select the seats again.')
                trip = conn.execute(select(trips).where(trips.c.id == data.trip_id)).mappings().first()
                if not trip or not trip['active'] or trip['departure_at'] <= now():
                    raise HTTPException(409, 'This trip is no longer available. Please search again.')
                if trip['price_paise'] != data.expected_price_paise:
                    raise HTTPException(409, 'The fare changed. Search again to review the latest price.')
                seat_rows = conn.execute(select(bus_seats).select_from(checkout_hold_seats.join(
                    bus_seats, checkout_hold_seats.c.seat_id == bus_seats.c.id)).where(
                    checkout_hold_seats.c.hold_id == data.hold_id)).mappings().all()
                seats_by_id = {seat['id']: seat for seat in seat_rows}
                passenger_ids = {passenger.seat_id for passenger in data.passengers}
                if passenger_ids != set(seats_by_id) or len(data.passengers) != len(seat_rows):
                    raise HTTPException(409, 'Passenger details must be provided for every held seat.')
                group_id = str(uuid.uuid4())
                created = now()
                conn.execute(booking_groups.insert().values(id=group_id, user_id=user['id'],
                    idempotency_key=idempotency_key, request_hash=fingerprint, created_at=created))
                for index, passenger in enumerate(data.passengers):
                    booking_id = str(uuid.uuid4())
                    conn.execute(bookings.insert().values(id=booking_id, user_id=user['id'],
                        trip_id=data.trip_id, passenger_name=passenger.passenger_name,
                        passenger_age=passenger.passenger_age, phone=data.phone, seat_count=1,
                        total_paise=trip['price_paise'], status='Confirmed', created_at=created,
                        idempotency_key=f'group-{group_id}-{index}', request_hash=fingerprint))
                    seat = seats_by_id[passenger.seat_id]
                    conn.execute(trip_seat_assignments.insert().values(trip_id=data.trip_id,
                        seat_id=seat['id'], booking_id=booking_id, state='Booked'))
                    save_booking_seat(conn, booking_id, data.trip_id, seat)
                    conn.execute(booking_group_members.insert().values(group_id=group_id,
                        booking_id=booking_id, passenger_order=index))
                conn.execute(checkout_holds.delete().where(
                    checkout_holds.c.id == data.hold_id))
                group = conn.execute(select(booking_groups).where(
                    booking_groups.c.id == group_id)).mappings().one()
                return booking_group_dict(conn, group)
        except IntegrityError:
            with engine.connect() as conn:
                existing = replay(conn)
                if existing:
                    return existing
            raise HTTPException(409, 'Group booking conflicted with another request. Please retry.')

    @app.post('/api/bookings/{booking_id}/cancel')
    def cancel(booking_id: str, user=Depends(customer)):
        with engine.begin() as conn:
            original = conn.execute(select(bookings).where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id'])).mappings().first()
            if not original:
                raise HTTPException(404, 'Booking not found.')
            lock_trips(conn, [original['trip_id']])
            future_trip = select(trips.c.id).where(trips.c.departure_at > now())
            changed = conn.execute(bookings.update().where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id'], bookings.c.status == 'Confirmed',
                bookings.c.trip_id == original['trip_id'],
                bookings.c.trip_id.in_(future_trip)).values(status='Cancelled', cancelled_at=now())
                .returning(bookings.c.trip_id, bookings.c.seat_count)).first()
            if changed:
                conn.execute(trip_seat_assignments.delete().where(
                    trip_seat_assignments.c.booking_id == booking_id))
                conn.execute(trips.update().where(trips.c.id == changed.trip_id)
                             .values(available_seats=trips.c.available_seats+changed.seat_count))
            row = conn.execute(select(bookings).where(bookings.c.id == booking_id, bookings.c.user_id == user['id'])).mappings().first()
            if not row:
                raise HTTPException(404, 'Booking not found.')
            if not changed and row['status'] == 'Confirmed':
                raise HTTPException(409, 'Booking changed or departure has passed. Refresh before cancelling.')
            return booking_dict(conn, row)

    @app.get('/api/bookings/{booking_id}/ticket')
    def download_ticket(booking_id: str, user=Depends(customer)):
        with engine.connect() as conn:
            row = conn.execute(select(bookings).where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id'])).mappings().first()
            if not row:
                raise HTTPException(404, 'Booking not found.')
            content = ticket_pdf(booking_dict(conn, row), iso(now()))
        # The filename uses only a server-generated UUID, never passenger input.
        return Response(content, media_type='application/pdf', headers={
            'Content-Disposition': f'attachment; filename="KPi-ticket-{row["id"]}.pdf"'})

    def perform_reschedule(booking_id, data, user, idempotency_key):
        fingerprint = hashlib.sha256(json.dumps({'booking_id': booking_id,
            **data.model_dump()}, sort_keys=True).encode()).hexdigest()
        with engine.begin() as conn:
            original = conn.execute(select(bookings).where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id'])).mappings().first()
            if not original:
                raise HTTPException(404, 'Booking not found.')
            lock_trips(conn, [data.expected_trip_id, data.trip_id])
            previous = conn.execute(select(booking_changes).where(
                booking_changes.c.user_id == user['id'],
                booking_changes.c.idempotency_key == idempotency_key)).mappings().first()
            current = conn.execute(select(bookings).where(bookings.c.id == booking_id)).mappings().one()
            if previous:
                if previous['request_hash'] != fingerprint:
                    raise HTTPException(409, 'This request key was already used for a different reschedule.')
                return booking_dict(conn, current)
            if current['status'] != 'Confirmed' or current['trip_id'] != data.expected_trip_id:
                raise HTTPException(409, 'This booking changed. Refresh your tickets and try again.')
            source = conn.execute(select(trips).where(trips.c.id == current['trip_id'])).mappings().one()
            target = conn.execute(select(trips).where(trips.c.id == data.trip_id)).mappings().first()
            if source['departure_at'] <= now():
                raise HTTPException(409, 'Rescheduling closes at departure.')
            if not target:
                raise HTTPException(404, 'New trip not found.')
            if target['id'] == source['id'] or target['route_id'] != source['route_id']:
                raise HTTPException(422, 'Choose a different departure on the same route.')
            target_seat = first_free_seat(conn, target['id'], target['bus_id'], data.seat_id)
            if not target_seat:
                raise HTTPException(409, 'That seat is unavailable on the new trip. Choose another seat; your original ticket is unchanged.')
            reserved = conn.execute(trips.update().where(trips.c.id == data.trip_id,
                trips.c.active.is_(True), trips.c.departure_at > now(), trips.c.available_seats > 0,
                trips.c.price_paise == data.expected_price_paise)
                .values(available_seats=trips.c.available_seats-1))
            if not reserved.rowcount:
                raise HTTPException(409, 'New trip is unavailable or its fare changed. Search again; your original ticket is unchanged.')
            changed = conn.execute(bookings.update().where(bookings.c.id == booking_id,
                bookings.c.status == 'Confirmed', bookings.c.trip_id == source['id'])
                .values(trip_id=target['id'], total_paise=target['price_paise']))
            if not changed.rowcount:
                raise HTTPException(409, 'Booking changed. Refresh and try again.')
            conn.execute(trips.update().where(trips.c.id == source['id'])
                .values(available_seats=trips.c.available_seats+1))
            conn.execute(trip_seat_assignments.delete().where(
                trip_seat_assignments.c.booking_id == booking_id))
            conn.execute(trip_seat_assignments.insert().values(trip_id=target['id'],
                seat_id=target_seat['id'], booking_id=booking_id, state='Booked'))
            save_booking_seat(conn, booking_id, target['id'], target_seat)
            conn.execute(booking_changes.insert().values(booking_id=booking_id, user_id=user['id'],
                from_trip_id=source['id'], to_trip_id=target['id'], old_price_paise=current['total_paise'],
                new_price_paise=target['price_paise'], created_at=now(),
                idempotency_key=idempotency_key, request_hash=fingerprint))
            return booking_dict(conn, conn.execute(select(bookings).where(bookings.c.id == booking_id)).mappings().one())

    @app.post('/api/bookings/{booking_id}/reschedule')
    def reschedule(booking_id: str, data: RescheduleInput, user=Depends(customer),
                   idempotency_key: str = Header(min_length=8, max_length=100)):
        try:
            return perform_reschedule(booking_id, data, user, idempotency_key)
        except IntegrityError:
            raise HTTPException(409, 'Reschedule conflicted with another request and was rolled back. Refresh your bookings.')

    @app.put('/api/bookings/{booking_id}/rating')
    def rate_bus(booking_id: str, data: RatingInput, user=Depends(customer)):
        with engine.begin() as conn:
            # Serialize two edits of the same rating without changing the booking.
            conn.execute(bookings.update().where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id']).values(status=bookings.c.status))
            row = conn.execute(select(bookings).where(bookings.c.id == booking_id,
                bookings.c.user_id == user['id'])).mappings().first()
            if not row:
                raise HTTPException(404, 'Booking not found.')
            trip = conn.execute(select(trips).where(trips.c.id == row['trip_id'])).mappings().one()
            if row['status'] != 'Confirmed' or trip['arrival_at'] > now():
                raise HTTPException(409, 'Only completed, non-cancelled journeys can be rated.')
            values = dict(stars=data.stars, comment=data.comment, updated_at=now())
            updated = conn.execute(ratings.update().where(ratings.c.booking_id == booking_id).values(**values))
            if not updated.rowcount:
                conn.execute(ratings.insert().values(booking_id=booking_id, bus_id=trip['bus_id'],
                    user_id=user['id'], **values))
            return booking_dict(conn, row)

    @app.get('/api/developer/system-health', dependencies=[Depends(current_developer)])
    def system_health():
        current = time.time()
        cutoff = current - 900
        with metrics_lock:
            recent = [event.copy() for event in request_events if event['at'] >= cutoff]
            recent_provider = [event.copy() for event in provider_events if event['at'] >= cutoff]

        grouped = defaultdict(list)
        for event in recent:
            grouped[(event['method'], event['path'])].append(event)

        def percentile(values, percent=0.95):
            if not values:
                return 0
            ordered = sorted(values)
            return round(ordered[min(len(ordered)-1, int((len(ordered)-1)*percent))], 1)

        routes_health = []
        for (method, path), events in grouped.items():
            durations = [event['duration_ms'] for event in events]
            errors = sum(event['status'] >= 400 for event in events)
            server_errors = sum(event['status'] >= 500 for event in events)
            throttled = sum(event['status'] == 429 for event in events)
            error_rate = round(errors*100/len(events), 1)
            requests_per_minute = round(len(events)/15, 2)
            p95 = percentile(durations)
            if server_errors or error_rate >= 20:
                status, recommendation = 'Critical', 'Investigate errors'
            elif throttled:
                status, recommendation = 'Warning', 'Review throttle limit or add capacity'
            elif p95 >= 1000 or requests_per_minute >= 60:
                status, recommendation = 'Warning', 'Scale up'
            elif current-metrics_started >= 3600 and requests_per_minute < 0.5:
                status, recommendation = 'Healthy', 'Scale-down candidate; confirm with longer history'
            elif errors:
                status, recommendation = 'Warning', 'Check rejected requests'
            else:
                status, recommendation = 'Healthy', 'Keep current capacity'
            routes_health.append({
                'method': method, 'path': path, 'status': status,
                'requests': len(events), 'requests_per_minute': requests_per_minute,
                'errors': errors, 'server_errors': server_errors,
                'error_rate': error_rate, 'throttled': throttled,
                'average_latency_ms': round(sum(durations)/len(durations), 1),
                'p95_latency_ms': p95, 'max_latency_ms': round(max(durations), 1),
                'last_status': events[-1]['status'],
                'last_seen': datetime.fromtimestamp(events[-1]['at'], IST).isoformat(),
                'recommendation': recommendation,
            })
        routes_health.sort(key=lambda row: (
            row['status'] != 'Critical', row['status'] != 'Warning',
            -row['requests'], row['path'], row['method']))

        durations = [event['duration_ms'] for event in recent]
        errors = sum(event['status'] >= 400 for event in recent)
        server_errors = sum(event['status'] >= 500 for event in recent)
        throttled = sum(event['status'] == 429 for event in recent)
        summary = {
            'requests': len(recent), 'requests_per_minute': round(len(recent)/15, 2),
            'errors': errors, 'server_errors': server_errors,
            'error_rate': round(errors*100/len(recent), 1) if recent else 0,
            'throttled': throttled,
            'average_latency_ms': round(sum(durations)/len(durations), 1) if durations else 0,
            'p95_latency_ms': percentile(durations),
        }

        database_started = time.perf_counter()
        try:
            with engine.connect() as conn:
                conn.execute(select(1)).scalar_one()
            database_status = 'Working'
            database_detail = f'{round((time.perf_counter()-database_started)*1000, 1)} ms check'
        except OperationalError:
            database_status, database_detail = 'Error', 'Database connection failed'

        configured_provider = ('Groq' if os.getenv('GROQ_API_KEY') else
                               ('OpenAI' if os.getenv('OPENAI_API_KEY') else None))
        ai_calls = len(recent_provider)
        fallbacks = sum(event['mode'] != 'ai' for event in recent_provider)
        if not configured_provider:
            ai_status, ai_detail = 'Not configured', 'Search uses the offline helper'
        elif fallbacks:
            ai_status = 'Warning'
            ai_detail = f'{fallbacks} of {ai_calls} recent AI calls used the offline fallback'
        elif ai_calls:
            ai_status, ai_detail = 'Working', f'{ai_calls} successful AI calls in 15 minutes'
        else:
            ai_status, ai_detail = 'Ready', 'Configured, with no calls in the last 15 minutes'

        limit_config = {'login': (15, 60), 'developer_login': (8, 60),
                        'search': (12, 60), 'assistant': (20, 60)}
        limit_routes = {'login': '/api/auth/login', 'search': '/api/search/natural',
                        'assistant': '/api/assistant/answer',
                        'developer_login': '/api/developer/login'}
        rate_limits = []
        with limits_lock:
            for name, (maximum, seconds) in limit_config.items():
                active = [len([stamp for stamp in stamps if stamp > current-seconds])
                          for key, stamps in limits.items() if key[0] == name]
                active = [usage for usage in active if usage]
                route_events = [event for event in recent if event['path'] == limit_routes[name]]
                rate_limits.append({
                    'name': name.replace('_', ' ').title(), 'path': limit_routes[name],
                    'maximum': maximum,
                    'window_seconds': seconds, 'active_clients': len(active),
                    'highest_current_usage': max(active, default=0),
                    'throttled': sum(event['status'] == 429 for event in route_events),
                })

        if database_status == 'Error' or server_errors or summary['error_rate'] >= 20:
            overall = 'Critical'
        elif throttled or summary['p95_latency_ms'] >= 1000 or ai_status == 'Warning':
            overall = 'Warning'
        else:
            overall = 'Healthy'
        recommendations = sorted({row['recommendation'] for row in routes_health
                                  if row['recommendation'] != 'Keep current capacity'})
        if not recommendations:
            recommendations = ['Keep current capacity; no action is needed now']
        return {
            'generated_at': datetime.now(IST).isoformat(),
            'started_at': datetime.fromtimestamp(metrics_started, IST).isoformat(),
            'uptime_seconds': round(current-metrics_started), 'window_minutes': 15,
            'overall_status': overall, 'summary': summary,
            'dependencies': [
                {'name': 'Booking API', 'status': 'Working',
                 'detail': f'Process uptime {round((current-metrics_started)/60)} minutes'},
                {'name': 'Database', 'status': database_status, 'detail': database_detail},
                {'name': configured_provider or 'AI provider', 'status': ai_status,
                 'detail': ai_detail},
            ],
            'routes': routes_health, 'rate_limits': rate_limits,
            'recommendations': recommendations,
            'note': 'Metrics are kept in memory and reset when the Python API restarts.',
        }

    @app.get('/api/developer/incidents', dependencies=[Depends(current_developer)])
    def developer_incidents(limit: int = Query(default=100, ge=1, le=200)):
        with metrics_lock:
            rows = [event.copy() for event in list(incident_events)[-limit:]][::-1]
        return {
            'generated_at': datetime.now(IST).isoformat(),
            'incident_count': len(rows),
            'retained_count': len(incident_events),
            'maximum_retained': incident_events.maxlen,
            'incidents': rows,
            'note': ('Incidents are kept in memory and reset when the Python API restarts. '
                     'Credentials and customer personal details are redacted.'),
        }

    @app.get('/api/admin/buses', dependencies=[Depends(admin)])
    def list_buses():
        with engine.connect() as conn:
            scores = rating_summary()
            return [bus_dict(conn, row) for row in conn.execute(select(buses, scores.c.average_rating,
                func.coalesce(scores.c.rating_count, 0).label('rating_count'))
                .outerjoin(scores, buses.c.id == scores.c.bus_id).order_by(buses.c.id)).mappings()]

    @app.get('/api/admin/buses/{bus_id}/ratings', dependencies=[Depends(admin)])
    def bus_ratings(bus_id: int):
        with engine.connect() as conn:
            if not conn.execute(select(buses.c.id).where(buses.c.id == bus_id)).first():
                raise HTTPException(404, 'Bus not found.')
            rows = conn.execute(select(ratings.c.stars, ratings.c.comment, ratings.c.updated_at,
                users.c.name.label('customer_name'), trips.c.departure_at,
                routes.c.origin, routes.c.destination).select_from(
                ratings.join(users).join(bookings, bookings.c.id == ratings.c.booking_id)
                .join(trips, trips.c.id == bookings.c.trip_id).join(routes))
                .where(ratings.c.bus_id == bus_id).order_by(ratings.c.updated_at.desc())).mappings()
            return [{**dict(row), 'updated_at': iso(row['updated_at']),
                     'departure_at': iso(row['departure_at'])} for row in rows]

    @app.post('/api/admin/buses', status_code=201, dependencies=[Depends(admin)])
    def add_bus(data: BusInput):
        if data.layout is not None and len(data.layout) != data.total_seats:
            raise HTTPException(422, 'Number of seats must match the seat layout.')
        try:
            with engine.begin() as conn:
                values = data.model_dump(exclude={'layout'})
                bus_id = conn.execute(buses.insert().values(**values)).inserted_primary_key[0]
                layout = ([seat.model_dump() for seat in data.layout] if data.layout is not None
                          else generated_layout(data.bus_type, data.total_seats))
                replace_bus_layout(conn, bus_id, layout)
                return bus_dict(conn, conn.execute(select(buses).where(
                    buses.c.id == bus_id)).mappings().one())
        except IntegrityError:
            raise HTTPException(409, 'A bus with that registration already exists.')

    @app.put('/api/admin/buses/{bus_id}', dependencies=[Depends(admin)])
    def edit_bus(bus_id: int, data: BusInput):
        try:
            with engine.begin() as conn:
                old_bus = conn.execute(select(buses).where(buses.c.id == bus_id)).mappings().first()
                if not old_bus:
                    raise HTTPException(404, 'Bus not found.')
                old_layout = layout_for_bus(conn, bus_id)
                supplied_layout = (data.layout if data.layout is not None and
                                   len(data.layout) == data.total_seats else None)
                requested_layout = ([seat.model_dump() for seat in supplied_layout]
                                    if supplied_layout is not None else
                                    (generated_layout(data.bus_type, data.total_seats)
                                     if data.total_seats != old_bus['total_seats'] or
                                     data.bus_type != old_bus['bus_type'] else old_layout))
                # Update first to serialize fleet edits and new schedules on this bus.
                changed = conn.execute(buses.update().where(buses.c.id == bus_id).values(
                    **data.model_dump(exclude={'layout'})))
                if not changed.rowcount:
                    raise HTTPException(404, 'Bus not found.')
                future = trips.c.departure_at > now()
                invalid = conn.execute(select(trips.c.id).where(trips.c.bus_id == bus_id, future,
                    trips.c.total_seats-trips.c.available_seats > data.total_seats)).first()
                if invalid:
                    raise HTTPException(409, 'Capacity cannot be lower than seats already booked on an upcoming trip.')
                if requested_layout != old_layout:
                    future_assignments = conn.execute(select(trip_seat_assignments.c.seat_id)
                        .select_from(trip_seat_assignments.join(trips)).where(
                        trips.c.bus_id == bus_id, trips.c.departure_at > now()).limit(1)).first()
                    if future_assignments:
                        raise HTTPException(409, 'This bus already has selected seats on a future trip. Keep this layout or create a new bus.')
                    conn.execute(trip_seat_assignments.delete().where(
                        trip_seat_assignments.c.trip_id.in_(select(trips.c.id).where(
                            trips.c.bus_id == bus_id, trips.c.departure_at <= now()))))
                    replace_bus_layout(conn, bus_id, requested_layout)
                conn.execute(trips.update().where(trips.c.bus_id == bus_id, future)
                    .values(available_seats=data.total_seats-(trips.c.total_seats-trips.c.available_seats),
                            total_seats=data.total_seats))
                return bus_dict(conn, conn.execute(select(buses).where(
                    buses.c.id == bus_id)).mappings().one())
        except IntegrityError:
            raise HTTPException(409, 'Registration is already in use, or capacity conflicts with a new booking. Please refresh.')

    def save_trip(data, trip_id=None):
        if data.departure_at.timestamp() <= now():
            raise HTTPException(422, 'Departure must be in the future.')
        try:
            with engine.begin() as conn:
                # No-op UPDATE provides a write lock even on SQLite, unlike SELECT FOR UPDATE.
                conn.execute(buses.update().where(buses.c.id == data.bus_id).values(name=buses.c.name))
                bus = conn.execute(select(buses).where(buses.c.id == data.bus_id)).mappings().first()
                if not bus:
                    raise HTTPException(404, 'Bus not found.')
                if trip_id:
                    # Serialize schedule edits with reservations before checking booking history.
                    conn.execute(trips.update().where(trips.c.id == trip_id).values(active=trips.c.active))
                old = conn.execute(select(trips).where(trips.c.id == trip_id)).mappings().first() if trip_id else None
                if trip_id and not old:
                    raise HTTPException(404, 'Trip not found.')
                if old and conn.execute(select(trip_cancellations.c.trip_id).where(
                    trip_cancellations.c.trip_id == trip_id)).first():
                    raise HTTPException(409, 'A cancelled departure cannot be edited or reopened. Create a new trip instead.')
                origin, destination = canonical_city(data.origin), canonical_city(data.destination)
                if origin == destination:
                    raise HTTPException(422, 'Origin and destination must be different.')
                route_id = conn.execute(select(routes.c.id).where(routes.c.origin == origin, routes.c.destination == destination)).scalar()
                if not route_id:
                    route_id = conn.execute(routes.insert().values(origin=origin, destination=destination)).inserted_primary_key[0]
                departure, arrival = int(data.departure_at.timestamp()), int(data.arrival_at.timestamp())
                if old:
                    has_bookings = conn.execute(select(bookings.c.id).where(bookings.c.trip_id == trip_id).limit(1)).first()
                    has_bookings = has_bookings or conn.execute(select(booking_changes.c.id).where(or_(
                        booking_changes.c.from_trip_id == trip_id, booking_changes.c.to_trip_id == trip_id)).limit(1)).first()
                    if has_bookings and (old['bus_id'], old['route_id'], old['departure_at'], old['arrival_at']) != (data.bus_id, route_id, departure, arrival):
                        raise HTTPException(409, 'This trip has booking history. Only price and availability may be changed.')
                overlap = conn.execute(select(trips.c.id).where(trips.c.bus_id == data.bus_id,
                    trips.c.id != (trip_id or 0), or_(trips.c.active.is_(True), trips.c.id.in_(
                        select(bookings.c.trip_id).where(bookings.c.status == 'Confirmed'))),
                    trips.c.departure_at < arrival, trips.c.arrival_at > departure)).first()
                if data.active and overlap:
                    raise HTTPException(409, 'This bus already has an overlapping trip.')
                values = dict(bus_id=data.bus_id, route_id=route_id, departure_at=departure,
                              arrival_at=arrival, price_paise=int(data.price*100), active=data.active)
                if old:
                    values['total_seats'] = bus['total_seats']
                    # SQL expression uses the latest inventory after concurrent bookings.
                    values['available_seats'] = bus['total_seats']-(trips.c.total_seats-trips.c.available_seats)
                    conn.execute(trips.update().where(trips.c.id == trip_id).values(**values))
                else:
                    trip_id = conn.execute(trips.insert().values(**values, total_seats=bus['total_seats'],
                        available_seats=bus['total_seats'])).inserted_primary_key[0]
                return trip_dict(conn.execute(trip_query().where(trips.c.id == trip_id)).mappings().one())
        except IntegrityError:
            raise HTTPException(409, 'The schedule conflicts with another update. Please refresh and retry.')

    @app.get('/api/admin/trips', dependencies=[Depends(admin)])
    def list_trips():
        with engine.connect() as conn:
            return [trip_dict(row) for row in conn.execute(trip_query().order_by(trips.c.departure_at)).mappings()]

    @app.post('/api/admin/trips', status_code=201, dependencies=[Depends(admin)])
    def add_trip(data: TripInput):
        return save_trip(data)

    @app.put('/api/admin/trips/{trip_id}', dependencies=[Depends(admin)])
    def edit_trip(trip_id: int, data: TripInput):
        return save_trip(data, trip_id)

    @app.post('/api/admin/weekly-schedules', status_code=201, dependencies=[Depends(admin)])
    def add_weekly_schedule(data: MultiDayScheduleInput | WeeklyScheduleInput):
        if data.start_date < datetime.now(IST).date():
            raise HTTPException(422, 'Weekly schedules must start today or later.')
        plans = ([(entry.day, entry.price, data.arrival_day_offset) for entry in data.days]
                 if isinstance(data, MultiDayScheduleInput)
                 else [(data.departure_day, data.price, (data.arrival_day-data.departure_day) % 7)])
        if not any(data.start_date + timedelta(days=(day-data.start_date.weekday()) % 7)
                   <= data.end_date for day, _, _ in plans):
            raise HTTPException(422, 'No selected departure weekday falls within this date range.')
        origin, destination = canonical_city(data.origin), canonical_city(data.destination)
        if origin == destination:
            raise HTTPException(422, 'Choose two different cities.')
        departure_clock = datetime.strptime(data.departure_time, '%H:%M').time()
        arrival_clock = datetime.strptime(data.arrival_time, '%H:%M').time()
        planned_occurrences = []
        for weekday, _, day_offset in sorted(plans):
            day = data.start_date + timedelta(days=(weekday-data.start_date.weekday()) % 7)
            while day <= data.end_date:
                departure = int(datetime.combine(day, departure_clock, IST).timestamp())
                arrival = int(datetime.combine(
                    day+timedelta(days=day_offset), arrival_clock, IST).timestamp())
                planned_occurrences.append((departure, arrival))
                day += timedelta(days=7)
        planned_occurrences.sort()
        for previous, current in zip(planned_occurrences, planned_occurrences[1:]):
            if previous[1] > current[0]:
                previous_departure = datetime.fromtimestamp(previous[0], IST)
                previous_arrival = datetime.fromtimestamp(previous[1], IST)
                next_departure = datetime.fromtimestamp(current[0], IST)
                raise HTTPException(422,
                    'This new weekly plan overlaps itself: the trip leaving '
                    f'{previous_departure:%d %b %Y at %H:%M} reaches '
                    f'{previous_arrival:%d %b %Y at %H:%M}, after the next trip leaves '
                    f'{next_departure:%d %b %Y at %H:%M}. Choose fewer days or an earlier '
                    'arrival time. Nothing was saved.')
        try:
            with engine.begin() as conn:
                conn.execute(buses.update().where(buses.c.id == data.bus_id).values(name=buses.c.name))
                bus = conn.execute(select(buses).where(buses.c.id == data.bus_id)).mappings().first()
                if not bus:
                    raise HTTPException(404, 'Bus not found.')
                route_id = conn.execute(select(routes.c.id).where(routes.c.origin == origin,
                    routes.c.destination == destination)).scalar()
                if not route_id:
                    route_id = conn.execute(routes.insert().values(origin=origin,
                        destination=destination)).inserted_primary_key[0]
                ids, schedule_ids = [], []
                # One transaction for ALL selected days: a conflict rolls back the entire plan.
                # Existing per-weekday rows remain compatible; prices are saved on each dated trip.
                for weekday, price, day_offset in sorted(plans):
                    day = data.start_date + timedelta(days=(weekday-data.start_date.weekday()) % 7)
                    if day > data.end_date:
                        continue
                    schedule_id = conn.execute(weekly_schedules.insert().values(bus_id=data.bus_id,
                        start_date=data.start_date.isoformat(), end_date=data.end_date.isoformat(),
                        departure_day=weekday, departure_time=data.departure_time,
                        arrival_day=(weekday+day_offset) % 7, arrival_time=data.arrival_time,
                        created_at=now())).inserted_primary_key[0]
                    schedule_ids.append(schedule_id)
                    while day <= data.end_date:
                        departure = int(datetime.combine(day, departure_clock, IST).timestamp())
                        arrival = int(datetime.combine(day+timedelta(days=day_offset), arrival_clock, IST).timestamp())
                        if departure <= now():
                            raise HTTPException(422, 'The first departure time has passed. Choose a later start date or time.')
                        overlap = conn.execute(select(trips.c.id, trips.c.departure_at,
                            trips.c.arrival_at).where(trips.c.bus_id == data.bus_id,
                            or_(trips.c.active.is_(True), trips.c.id.in_(select(bookings.c.trip_id)
                                .where(bookings.c.status == 'Confirmed'))), trips.c.departure_at < arrival,
                            trips.c.arrival_at > departure)).mappings().first()
                        if overlap:
                            existing_departure = datetime.fromtimestamp(overlap['departure_at'], IST)
                            existing_arrival = datetime.fromtimestamp(overlap['arrival_at'], IST)
                            requested_departure = datetime.fromtimestamp(departure, IST)
                            raise HTTPException(409,
                                'This bus already has another trip from '
                                f'{existing_departure:%d %b %Y at %H:%M} to '
                                f'{existing_arrival:%d %b %Y at %H:%M}. It overlaps the new '
                                f'departure on {requested_departure:%d %b %Y at %H:%M}. Choose '
                                'another bus, day or time. Nothing was saved.')
                        trip_id = conn.execute(trips.insert().values(bus_id=data.bus_id, route_id=route_id,
                            departure_at=departure, arrival_at=arrival, price_paise=int(price*100),
                            total_seats=bus['total_seats'], available_seats=bus['total_seats'], active=True)).inserted_primary_key[0]
                        conn.execute(schedule_departures.insert().values(trip_id=trip_id, schedule_id=schedule_id))
                        ids.append(trip_id)
                        day += timedelta(days=7)
                return {'schedule_id': schedule_ids[0], 'schedule_ids': schedule_ids, 'trip_count': len(ids),
                        'trips': [trip_dict(row) for row in conn.execute(trip_query().where(
                            trips.c.id.in_(ids)).order_by(trips.c.departure_at)).mappings()]}
        except IntegrityError:
            raise HTTPException(409, 'A schedule changed concurrently. No weekly trips were created; please retry.')

    @app.post('/api/admin/trips/{trip_id}/cancel', dependencies=[Depends(admin)])
    def cancel_departure(trip_id: int, data: CancelTripInput):
        with engine.begin() as conn:
            lock_trips(conn, [trip_id])
            trip = conn.execute(select(trips).where(trips.c.id == trip_id)).mappings().first()
            if not trip:
                raise HTTPException(404, 'Trip not found.')
            previous = conn.execute(select(trip_cancellations).where(
                trip_cancellations.c.trip_id == trip_id)).mappings().first()
            if not previous:
                if trip['departure_at'] <= now():
                    raise HTTPException(409, 'A departed trip cannot be cancelled.')
                conn.execute(trips.update().where(trips.c.id == trip_id).values(active=False))
                released = conn.execute(bookings.update().where(bookings.c.trip_id == trip_id,
                    bookings.c.status == 'Confirmed').values(status='Cancelled', cancelled_at=now())
                    .returning(bookings.c.seat_count)).all()
                released_holds = conn.execute(seat_holds.delete().where(
                    seat_holds.c.trip_id == trip_id).returning(seat_holds.c.id)).all()
                group_hold_count = conn.execute(select(func.count()).select_from(
                    checkout_hold_seats).where(
                    checkout_hold_seats.c.trip_id == trip_id)).scalar_one()
                conn.execute(checkout_holds.delete().where(
                    checkout_holds.c.trip_id == trip_id))
                conn.execute(trip_seat_assignments.delete().where(
                    trip_seat_assignments.c.trip_id == trip_id))
                conn.execute(trips.update().where(trips.c.id == trip_id).values(
                    available_seats=trips.c.available_seats+sum(row[0] for row in released)
                    +len(released_holds)+group_hold_count))
                conn.execute(trip_cancellations.insert().values(trip_id=trip_id, reason=data.reason,
                    cancelled_at=now()))
            return trip_dict(conn.execute(trip_query().where(trips.c.id == trip_id)).mappings().one())

    @app.get('/api/admin/dashboard', dependencies=[Depends(admin)])
    def dashboard(selected_date: date | None = Query(default=None, alias='date')):
        report_date = selected_date or datetime.now(IST).date()
        start = datetime.combine(report_date, datetime.min.time(), IST)
        start_timestamp = int(start.timestamp())
        # Adding seconds also supports the last valid calendar date (9999-12-31).
        end_timestamp = start_timestamp + 86400
        made_on_date = and_(bookings.c.created_at >= start_timestamp,
                            bookings.c.created_at < end_timestamp)
        departs_on_date = and_(trips.c.departure_at >= start_timestamp,
                               trips.c.departure_at < end_timestamp)
        confirmed = bookings.c.status == 'Confirmed'
        with engine.begin() as conn:
            release_expired_holds(conn)
            activity_rows = conn.execute(select(bookings.c.status, bookings.c.total_paise,
                bookings.c.idempotency_key).where(made_on_date)).mappings().all()
            activity = {
                'total_bookings': len(activity_rows),
                'confirmed_bookings': sum(row['status'] == 'Confirmed' for row in activity_rows),
                'cancelled_bookings': sum(row['status'] == 'Cancelled' for row in activity_rows),
                'net_value_paise': sum(row['total_paise'] for row in activity_rows if row['status'] == 'Confirmed'),
                'demo_bookings': sum(row['idempotency_key'].startswith('seed-') for row in activity_rows),
            }
            # Date reports include departed and inactive services too; "bookable" is separate.
            services = conn.execute(trip_query().where(departs_on_date)).mappings().all()
            occupancy = {}
            for trip in services:
                entry = occupancy.setdefault(trip['bus_id'], {'bus_name': trip['bus_name'], 'registration': trip['registration'],
                    'booked_seats': 0, 'total_seats': 0, 'trip_count': 0})
                entry['booked_seats'] += trip['total_seats']-trip['available_seats']
                entry['total_seats'] += trip['total_seats']
                entry['trip_count'] += 1
            for entry in occupancy.values():
                entry['occupancy_rate'] = round(entry['booked_seats']/entry['total_seats']*100, 1)
            departure_bookings = conn.execute(select(routes.c.origin, routes.c.destination,
                bookings.c.total_paise, bookings.c.idempotency_key)
                .select_from(bookings.join(trips).join(routes)).where(confirmed, departs_on_date)).mappings().all()
            demand = {}
            for row in departure_bookings:
                route = demand.setdefault((row['origin'], row['destination']), {
                    'origin': row['origin'], 'destination': row['destination'], 'bookings': 0, 'revenue_paise': 0})
                route['bookings'] += 1
                route['revenue_paise'] += row['total_paise']
            current_time = now()
            inventory = {
                'trip_count': len(services),
                'total_seats': sum(t['total_seats'] for t in services),
                'booked_seats': sum(t['total_seats']-t['available_seats'] for t in services),
                'unbooked_seats': sum(t['available_seats'] for t in services),
                'bookable_seats': sum(t['available_seats'] for t in services
                                      if t['active'] and t['departure_at'] > current_time),
                'net_value_paise': sum(row['total_paise'] for row in departure_bookings),
                'demo_bookings': sum(row['idempotency_key'].startswith('seed-') for row in departure_bookings),
            }
            return {'date': report_date.isoformat(), 'activity': activity, 'inventory': inventory,
                    'revenue': revenue_summary(conn, start_timestamp, end_timestamp),
                    'occupancy': sorted(occupancy.values(), key=lambda x: -x['occupancy_rate']),
                    'route_demand': sorted(demand.values(), key=lambda x: (-x['bookings'], x['origin'], x['destination']))}

    @app.get('/api/admin/revenue', dependencies=[Depends(admin)])
    def monthly_revenue(year: int | None = Query(default=None, ge=1, le=9999),
                        month: int | None = Query(default=None, ge=1, le=12)):
        selected_year = year or datetime.now(IST).year
        selected_month = month or datetime.now(IST).month
        with engine.connect() as conn:
            return revenue_timeline(conn, selected_year, selected_month)

    return app


app = create_app()
