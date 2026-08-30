from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from threading import Barrier
import uuid

from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import select

from backend.database import bookings, checkout_holds, trips
from backend.main import create_app
from backend.schemas import SearchCriteria
from backend.search import IST, apply_explicit_filters, fallback_parse, interpret, validate_criteria

HEADERS = {'X-Requested-With': 'kpi-travels'}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.setenv('DEMO_PASSWORD', 'TravelDemo123!')
    monkeypatch.setenv('DEVELOPER_EMAIL', 'developer@kpi.test')
    monkeypatch.setenv('DEVELOPER_PASSWORD', 'DeveloperDemo123!')
    monkeypatch.setenv('COOKIE_SECURE', 'false')
    application = create_app(f'sqlite:///{tmp_path}/test.db', seed=True)
    with TestClient(application, headers=HEADERS) as client:
        yield application, client


def login(client, role='customer'):
    response = client.post('/api/auth/login', json={'email': f'{role}@kpi.test', 'password': 'TravelDemo123!'})
    assert response.status_code == 200, response.text
    return response


def future_trip(client):
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    result = client.get('/api/trips', params={'origin': 'Hyderabad', 'destination': 'Bangalore', 'travel_date': tomorrow})
    assert result.status_code == 200, result.text
    return result.json()[0]


def payload(trip):
    return {'trip_id': trip['id'], 'passenger_name': 'Test Passenger', 'passenger_age': 25,
            'phone': '9876543210', 'expected_price_paise': trip['price_paise']}


def book(client, trip, key=None):
    return client.post('/api/bookings', json=payload(trip), headers={'Idempotency-Key': key or str(uuid.uuid4())})


def hold(client, trip, seat_id=None):
    body = {'trip_id': trip['id'], 'expected_price_paise': trip['price_paise']}
    if seat_id is not None:
        body['seat_id'] = seat_id
    return client.post('/api/seat-holds', json=body)


def remaining(application, trip_id):
    with application.state.engine.connect() as conn:
        return conn.execute(select(trips.c.available_seats).where(trips.c.id == trip_id)).scalar_one()


def test_search_and_auth_permissions(app):
    _, client = app
    assert client.get('/api/health').json()['status'] == 'ok'
    assert future_trip(client)['origin'] == 'Hyderabad'
    assert client.get('/api/admin/dashboard').status_code == 401
    login(client)
    assert client.get('/api/auth/me').json()['role'] == 'customer'
    assert client.get('/api/admin/dashboard').status_code == 403
    assert client.post('/api/auth/logout').status_code == 204
    assert client.get('/api/auth/me').status_code == 401
    assert client.post('/api/auth/login', json={'email': 'admin@kpi.test', 'password': 'wrong'}).status_code == 401


def test_customer_can_update_and_reuse_persistent_profile(app):
    _, client = app
    signed_in = login(client).json()
    assert signed_in['name'] == 'Aarav' and signed_in['phone'] is None
    assert client.put('/api/auth/profile', json={
        'name': 'Chiru Kumar', 'email': 'chiru@example.com', 'phone': '98765 43210'
    }).status_code == 200
    updated = client.get('/api/auth/me').json()
    assert updated == {'id': signed_in['id'], 'name': 'Chiru Kumar',
        'email': 'chiru@example.com', 'phone': '98765 43210', 'role': 'customer'}
    assert client.put('/api/auth/profile', json={
        'name': 'Chiru Kumar', 'email': 'priya@kpi.test', 'phone': '98765 43210'
    }).status_code == 409
    assert client.put('/api/auth/profile', json={
        'name': 'Chiru Kumar', 'email': 'chiru@example.com', 'phone': '12'
    }).status_code == 422
    assert client.post('/api/auth/logout').status_code == 204
    assert client.post('/api/auth/login', json={
        'email': 'chiru@example.com', 'password': 'TravelDemo123!'
    }).json()['name'] == 'Chiru Kumar'
    login(client, 'admin')
    assert client.put('/api/auth/profile', json={
        'name': 'Admin Name', 'email': 'admin-new@kpi.test', 'phone': None
    }).status_code == 403


def test_system_health_is_developer_only_and_reports_real_traffic(app):
    _, client = app
    assert client.get('/api/developer/system-health').status_code == 401
    assert client.get('/api/developer/incidents').status_code == 401
    login(client)
    assert client.get('/api/developer/system-health').status_code == 401
    login(client, 'admin')
    assert client.get('/api/admin/system-health').status_code == 404
    assert client.get('/api/developer/system-health').status_code == 401
    assert client.get('/api/does-not-exist?api_key=supersecret').status_code == 404
    assert client.post('/api/developer/login', json={
        'email': 'developer@kpi.test', 'password': 'wrong'}).status_code == 401
    signed_in = client.post('/api/developer/login', json={
        'email': 'developer@kpi.test', 'password': 'DeveloperDemo123!'})
    assert signed_in.status_code == 200
    assert signed_in.json()['role'] == 'developer'
    assert client.get('/api/developer/me').json()['email'] == 'developer@kpi.test'
    first = client.get('/api/developer/system-health')
    assert first.status_code == 200, first.text
    report = first.json()
    assert report['overall_status'] in ('Healthy', 'Warning', 'Critical')
    assert report['window_minutes'] == 15
    assert report['summary']['requests'] >= 4
    assert report['summary']['errors'] >= 2
    assert {row['name'] for row in report['dependencies']} >= {
        'Booking API', 'Database', 'AI provider'}
    assert {row['name'] for row in report['rate_limits']} == {
        'Login', 'Developer Login', 'Search', 'Assistant'}
    assert any(row['path'] == '/api/does-not-exist' and row['errors'] == 1
               for row in report['routes'])
    assert not any(row['path'] in {
        '/api/developer/system-health', '/api/developer/incidents'}
        for row in report['routes'])
    incidents = client.get('/api/developer/incidents')
    assert incidents.status_code == 200
    incident_report = incidents.json()
    assert incident_report['maximum_retained'] == 500
    wrong_login = next(row for row in incident_report['incidents']
                       if row['path'] == '/api/developer/login' and row['status'] == 401)
    assert wrong_login['request_payload']['body']['password'] == '[REDACTED]'
    assert wrong_login['request_payload']['body']['email'] == '[REDACTED]'
    missing = next(row for row in incident_report['incidents']
                   if row['path'] == '/api/does-not-exist')
    assert missing['response']['detail'] == 'Not Found'
    assert missing['request_payload']['query']['api_key'] == '[REDACTED]'
    assert missing['timestamp'] and missing['method'] == 'GET'
    assert not any(row['path'] in {
        '/api/developer/system-health', '/api/developer/incidents'}
        for row in incident_report['incidents'])
    # Reading observability data does not create its own traffic feedback loop.
    second = client.get('/api/developer/system-health').json()
    assert second['summary']['requests'] == report['summary']['requests']
    assert client.post('/api/developer/logout').status_code == 204
    assert client.get('/api/developer/system-health').status_code == 401


def test_booking_and_idempotent_cancellation(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    before = remaining(application, trip['id'])
    result = book(client, trip)
    assert result.status_code == 201, result.text
    booking = result.json()
    assert remaining(application, trip['id']) == before-1
    assert booking['status'] == 'Confirmed'
    for _ in range(2):
        response = client.post(f"/api/bookings/{booking['id']}/cancel")
        assert response.status_code == 200, response.text
        assert response.json()['status'] == 'Cancelled'
    assert remaining(application, trip['id']) == before


def test_seat_hold_reuses_releases_and_converts_without_double_counting(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    before = remaining(application, trip['id'])

    first = hold(client, trip)
    assert first.status_code == 201, first.text
    held = first.json()
    assert held['trip_id'] == trip['id']
    assert 590 <= held['seconds_remaining'] <= 600
    assert remaining(application, trip['id']) == before-1

    repeated = hold(client, trip)
    assert repeated.status_code == 200
    assert repeated.json()['id'] == held['id']
    assert remaining(application, trip['id']) == before-1

    booking_data = payload(trip) | {'hold_id': held['id']}
    booked = client.post('/api/bookings', json=booking_data,
        headers={'Idempotency-Key': str(uuid.uuid4())})
    assert booked.status_code == 201, booked.text
    assert remaining(application, trip['id']) == before-1
    with application.state.engine.connect() as conn:
        assert conn.execute(select(checkout_holds).where(
            checkout_holds.c.id == held['id'])).first() is None
    # Closing checkout after conversion is harmless and cannot return the booked seat.
    assert client.delete(f"/api/seat-holds/{held['id']}").status_code == 204
    assert remaining(application, trip['id']) == before-1


def test_expired_and_manually_released_holds_restore_inventory_once(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    before = remaining(application, trip['id'])
    held = hold(client, trip).json()
    assert remaining(application, trip['id']) == before-1

    with application.state.engine.begin() as conn:
        conn.execute(checkout_holds.update().where(checkout_holds.c.id == held['id'])
                     .values(created_at=0, expires_at=1))
    # Searching performs expiry cleanup before returning live availability.
    assert future_trip(client)['available_seats'] == before
    assert remaining(application, trip['id']) == before
    assert client.delete(f"/api/seat-holds/{held['id']}").status_code == 204
    assert remaining(application, trip['id']) == before

    second = hold(client, trip).json()
    assert remaining(application, trip['id']) == before-1
    for _ in range(2):
        assert client.delete(f"/api/seat-holds/{second['id']}").status_code == 204
    assert remaining(application, trip['id']) == before


def test_customer_cannot_use_another_customers_hold(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    before = remaining(application, trip['id'])
    held = hold(client, trip).json()
    client.cookies.clear()
    login(client, 'priya')
    result = client.post('/api/bookings', json=payload(trip) | {'hold_id': held['id']},
        headers={'Idempotency-Key': str(uuid.uuid4())})
    assert result.status_code == 409
    assert remaining(application, trip['id']) == before-1


def test_customer_selects_specific_seat_and_cancellation_reopens_it(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    seats = client.get(f"/api/trips/{trip['id']}/seats")
    assert seats.status_code == 200, seats.text
    available = next(seat for seat in seats.json() if seat['status'] == 'Available')
    before = remaining(application, trip['id'])
    held = hold(client, trip, available['id'])
    assert held.status_code == 201, held.text
    assert held.json()['seat']['id'] == available['id']
    assert held.json()['seat']['label'] == available['label']
    current = next(seat for seat in client.get(
        f"/api/trips/{trip['id']}/seats").json() if seat['id'] == available['id'])
    assert current['status'] == 'Held' and current['mine'] is True

    booked = client.post('/api/bookings', json=payload(trip) | {'hold_id': held.json()['id']},
        headers={'Idempotency-Key': str(uuid.uuid4())})
    assert booked.status_code == 201, booked.text
    assert booked.json()['seat']['seat_label'] == available['label']
    assert remaining(application, trip['id']) == before-1
    current = next(seat for seat in client.get(
        f"/api/trips/{trip['id']}/seats").json() if seat['id'] == available['id'])
    assert current['status'] == 'Booked'

    assert client.post(f"/api/bookings/{booked.json()['id']}/cancel").status_code == 200
    reopened = next(seat for seat in client.get(
        f"/api/trips/{trip['id']}/seats").json() if seat['id'] == available['id'])
    assert reopened['status'] == 'Available'
    assert remaining(application, trip['id']) == before


def test_bus_layout_templates_are_created_and_returned(app):
    _, client = app
    login(client, 'admin')
    fleet = client.get('/api/admin/buses').json()
    assert fleet and all(len(bus['layout']) == bus['total_seats'] for bus in fleet)
    sleeper = next(bus for bus in fleet if bus['bus_type'] == 'Sleeper')
    assert {seat['deck'] for seat in sleeper['layout']} == {'Lower', 'Upper'}
    assert {seat['seat_type'] for seat in sleeper['layout']} == {'Sleeper'}
    custom = [
        {'label': 'A1', 'deck': 'Lower', 'row_index': 0, 'column_index': 0, 'seat_type': 'Seat'},
        {'label': 'A2', 'deck': 'Lower', 'row_index': 1, 'column_index': 4, 'seat_type': 'Seat'},
    ]
    created = client.post('/api/admin/buses', json={'name': 'Custom Mini',
        'registration': 'CUSTOM-2', 'bus_type': 'AC', 'total_seats': 2, 'layout': custom})
    assert created.status_code == 201, created.text
    assert created.json()['layout'] == custom


def test_multi_passenger_booking_is_atomic_idempotent_and_uses_selected_seats(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    available = [seat for seat in client.get(
        f"/api/trips/{trip['id']}/seats").json() if seat['status'] == 'Available'][:3]
    before = remaining(application, trip['id'])
    held = client.post('/api/seat-holds', json={'trip_id': trip['id'],
        'seat_ids': [seat['id'] for seat in available],
        'expected_price_paise': trip['price_paise']})
    assert held.status_code == 201, held.text
    assert {seat['id'] for seat in held.json()['seats']} == {seat['id'] for seat in available}
    assert remaining(application, trip['id']) == before-3

    body = {'trip_id': trip['id'], 'hold_id': held.json()['id'],
        'expected_price_paise': trip['price_paise'], 'phone': '9876543210',
        'passengers': [{'seat_id': seat['id'], 'passenger_name': f'Passenger {index+1}',
                        'passenger_age': 20+index}
                       for index, seat in enumerate(available)]}
    key = str(uuid.uuid4())
    first = client.post('/api/booking-groups', json=body,
        headers={'Idempotency-Key': key})
    assert first.status_code == 201, first.text
    group = first.json()
    assert group['ticket_count'] == 3
    assert group['total_paise'] == trip['price_paise']*3
    assert {ticket['passenger_name'] for ticket in group['bookings']} == {
        'Passenger 1', 'Passenger 2', 'Passenger 3'}
    assert {ticket['seat']['seat_id'] for ticket in group['bookings']} == {
        seat['id'] for seat in available}
    assert remaining(application, trip['id']) == before-3

    replayed = client.post('/api/booking-groups', json=body,
        headers={'Idempotency-Key': key})
    assert replayed.status_code == 200
    assert [ticket['id'] for ticket in replayed.json()['bookings']] == [
        ticket['id'] for ticket in group['bookings']]
    assert remaining(application, trip['id']) == before-3
    for ticket in group['bookings']:
        assert client.post(f"/api/bookings/{ticket['id']}/cancel").status_code == 200
    assert remaining(application, trip['id']) == before


def test_group_booking_requires_details_for_every_held_seat(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    available = [seat for seat in client.get(
        f"/api/trips/{trip['id']}/seats").json() if seat['status'] == 'Available'][:2]
    before = remaining(application, trip['id'])
    held = client.post('/api/seat-holds', json={'trip_id': trip['id'],
        'seat_ids': [seat['id'] for seat in available],
        'expected_price_paise': trip['price_paise']}).json()
    invalid = client.post('/api/booking-groups', json={'trip_id': trip['id'],
        'hold_id': held['id'], 'expected_price_paise': trip['price_paise'],
        'phone': '9876543210', 'passengers': [{'seat_id': available[0]['id'],
            'passenger_name': 'Only One', 'passenger_age': 30}]},
        headers={'Idempotency-Key': str(uuid.uuid4())})
    assert invalid.status_code == 409
    assert remaining(application, trip['id']) == before-2
    assert client.delete(f"/api/seat-holds/{held['id']}").status_code == 204
    assert remaining(application, trip['id']) == before


def test_duplicate_submission_and_changed_payload(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    before = remaining(application, trip['id'])
    key = str(uuid.uuid4())
    first, second = book(client, trip, key), book(client, trip, key)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()['id'] == second.json()['id']
    assert remaining(application, trip['id']) == before-1
    changed = payload(trip) | {'passenger_name': 'Different Person'}
    assert client.post('/api/bookings', json=changed, headers={'Idempotency-Key': key}).status_code == 409


def test_only_owner_can_cancel(app):
    _, client = app
    login(client)
    first = book(client, future_trip(client)).json()
    login(client, 'priya')
    assert client.post(f"/api/bookings/{first['id']}/cancel").status_code == 404
    assert all(row['id'] != first['id'] for row in client.get('/api/bookings').json())


@pytest.mark.parametrize('change', [{'available_seats': 0}, {'active': False}, {'departure_at': 1}, {'price_paise': 999999}])
def test_unavailable_or_changed_trip_rejects_booking(app, change):
    application, client = app
    login(client)
    trip = future_trip(client)
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == trip['id']).values(**change))
    before = remaining(application, trip['id'])
    assert book(client, trip).status_code == 409
    assert remaining(application, trip['id']) == before


def test_invalid_passenger_and_missing_key(app):
    _, client = app
    login(client)
    trip = future_trip(client)
    assert client.post('/api/bookings', json=payload(trip)).status_code == 422
    for changes in ({'passenger_name': ' '}, {'passenger_age': 0}, {'phone': 'abc'}, {'phone': '1---------'}, {'trip_id': -1}, {'seat_count': 10}):
        response = client.post('/api/bookings', json=payload(trip) | changes, headers={'Idempotency-Key': str(uuid.uuid4())})
        assert response.status_code == 422, response.text


def test_two_customers_compete_for_last_seat(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    customer_cookie = dict(client.cookies)
    # A second browser has a separate session; logging in on the same browser rotates it.
    client.cookies.clear()
    login(client, 'priya')
    priya_cookie = dict(client.cookies)
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == trip['id']).values(available_seats=1))
    barrier = Barrier(2)

    def attempt(cookie):
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            barrier.wait(timeout=10)
            return book(other, trip).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(attempt, [customer_cookie, priya_cookie]))
    assert sorted(statuses) == [201, 409]
    assert remaining(application, trip['id']) == 0


def test_concurrent_duplicate_does_not_reserve_twice(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    cookie = dict(client.cookies)
    key = str(uuid.uuid4())
    before = remaining(application, trip['id'])

    def attempt(_):
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            return book(other, trip, key)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(attempt, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 201]
    assert responses[0].json()['id'] == responses[1].json()['id']
    assert remaining(application, trip['id']) == before-1


def test_concurrent_cancellation_releases_once(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    booking = book(client, trip).json()
    before = remaining(application, trip['id'])
    cookie = dict(client.cookies)
    barrier = Barrier(2)

    def attempt(_):
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            barrier.wait(timeout=10)
            return other.post(f"/api/bookings/{booking['id']}/cancel").status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(attempt, range(2)))
    assert statuses == [200, 200]
    assert remaining(application, trip['id']) == before+1


def test_failed_insert_rolls_back_inventory(app, monkeypatch):
    application, client = app
    login(client)
    trip = future_trip(client)
    first = book(client, trip).json()
    before = remaining(application, trip['id'])
    key = str(uuid.uuid4())
    monkeypatch.setattr('backend.main.uuid.uuid4', lambda: first['id'])
    assert book(client, trip, key).status_code == 409
    assert remaining(application, trip['id']) == before


def test_dashboard_changes_and_fare_snapshot(app):
    application, client = app
    login(client, 'admin')
    before = client.get('/api/admin/dashboard').json()
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    departure_before = client.get('/api/admin/dashboard', params={'date': tomorrow}).json()
    login(client)
    trip = future_trip(client)
    booking = book(client, trip).json()
    login(client, 'admin')
    after = client.get('/api/admin/dashboard').json()
    assert after['activity']['total_bookings'] == before['activity']['total_bookings']+1
    assert after['activity']['net_value_paise'] == before['activity']['net_value_paise']+trip['price_paise']
    departure_after = client.get('/api/admin/dashboard', params={'date': tomorrow}).json()
    assert departure_after['inventory']['booked_seats'] == departure_before['inventory']['booked_seats']+1
    assert departure_after['inventory']['unbooked_seats'] == departure_before['inventory']['unbooked_seats']-1
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == trip['id']).values(price_paise=150000))
    login(client)
    assert next(b for b in client.get('/api/bookings').json() if b['id'] == booking['id'])['total_paise'] == trip['price_paise']
    client.post(f"/api/bookings/{booking['id']}/cancel")
    login(client, 'admin')
    cancelled = client.get('/api/admin/dashboard').json()
    assert cancelled['activity']['net_value_paise'] == before['activity']['net_value_paise']
    assert cancelled['inventory']['unbooked_seats'] == before['inventory']['unbooked_seats']
    departure_cancelled = client.get('/api/admin/dashboard', params={'date': tomorrow}).json()
    assert departure_cancelled['inventory']['unbooked_seats'] == departure_before['inventory']['unbooked_seats']
    assert departure_cancelled['inventory']['net_value_paise'] == departure_before['inventory']['net_value_paise']


def test_dashboard_date_boundaries_and_independent_scopes(app):
    application, client = app
    login(client, 'admin')
    target = datetime.now(IST).date()+timedelta(days=30)
    start = int(datetime.combine(target, datetime.min.time(), IST).timestamp())
    end = start+86400
    with application.state.engine.begin() as conn:
        template_trip = dict(conn.execute(select(trips).limit(1)).mappings().one())
        template_trip.pop('id')
        template_booking = dict(conn.execute(select(bookings).limit(1)).mappings().one())

        def add_trip(departure, capacity, occupied, active=True):
            return conn.execute(trips.insert().values(**(template_trip | {
                'departure_at': departure, 'arrival_at': departure+3600,
                'total_seats': capacity, 'available_seats': capacity-occupied, 'active': active
            }))).inserted_primary_key[0]

        def add_booking(trip_id, created_at, value, status='Confirmed'):
            conn.execute(bookings.insert().values(**(template_booking | {
                'id': str(uuid.uuid4()), 'idempotency_key': str(uuid.uuid4()),
                'trip_id': trip_id, 'created_at': created_at, 'total_paise': value, 'status': status,
                'cancelled_at': created_at+1 if status == 'Cancelled' else None
            })))

        before = add_trip(start-1, 10, 1)
        at_start = add_trip(start, 10, 2)
        before_end = add_trip(end-1, 20, 1, active=False)
        at_end = add_trip(end, 10, 1)
        add_booking(before, start-1, 10000)
        add_booking(at_start, start-1, 10000)
        add_booking(at_start, end-1, 15000)
        add_booking(at_start, start+1, 9000, 'Cancelled')
        add_booking(before_end, end, 30000)
        add_booking(at_end, start, 70000)

    response = client.get('/api/admin/dashboard', params={'date': target.isoformat()})
    assert response.status_code == 200, response.text
    report = response.json()
    assert report['date'] == target.isoformat()
    assert report['activity'] == {'total_bookings': 3, 'confirmed_bookings': 2,
        'cancelled_bookings': 1, 'net_value_paise': 85000, 'demo_bookings': 0}
    assert report['inventory'] == {'trip_count': 2, 'total_seats': 30, 'booked_seats': 3,
        'unbooked_seats': 27, 'bookable_seats': 8, 'net_value_paise': 55000, 'demo_bookings': 0}
    assert sum(row['total_seats'] for row in report['occupancy']) == 30
    assert sum(row['booked_seats'] for row in report['occupancy']) == 3
    assert sum(row['bookings'] for row in report['route_demand']) == 3
    assert sum(row['revenue_paise'] for row in report['route_demand']) == 55000
    next_day = client.get('/api/admin/dashboard', params={'date': (target+timedelta(days=1)).isoformat()}).json()
    assert next_day['inventory']['trip_count'] == 1
    assert next_day['inventory']['bookable_seats'] == 9
    assert next_day['inventory']['net_value_paise'] == 70000
    assert next_day['activity']['net_value_paise'] == 30000


def test_dashboard_empty_date_and_default(app):
    _, client = app
    login(client, 'admin')
    today = datetime.now(IST).date().isoformat()
    assert client.get('/api/admin/dashboard').json() == client.get('/api/admin/dashboard', params={'date': today}).json()
    empty_date = (datetime.now(IST)+timedelta(days=800)).date().isoformat()
    response = client.get('/api/admin/dashboard', params={'date': empty_date})
    assert response.status_code == 200
    report = response.json()
    assert report['date'] == empty_date
    assert all(value == 0 for value in report['activity'].values())
    assert all(value == 0 for value in report['inventory'].values())
    assert report['occupancy'] == []
    assert report['route_demand'] == []


@pytest.mark.parametrize('value', ['not-a-date', '2026-02-30', '2026-13-01'])
def test_dashboard_rejects_invalid_date(app, value):
    _, client = app
    login(client, 'admin')
    assert client.get('/api/admin/dashboard', params={'date': value}).status_code == 422


def test_dashboard_historical_inventory_not_bookable(app):
    application, client = app
    login(client, 'admin')
    target = (datetime.now(IST)-timedelta(days=10)).replace(hour=10, minute=0, second=0, microsecond=0)
    with application.state.engine.begin() as conn:
        trip = dict(conn.execute(select(trips).limit(1)).mappings().one())
        trip.pop('id')
        conn.execute(trips.insert().values(**(trip | {'departure_at': int(target.timestamp()),
            'arrival_at': int(target.timestamp())+3600, 'total_seats': 20, 'available_seats': 20})))
    report = client.get('/api/admin/dashboard', params={'date': target.date().isoformat()}).json()
    assert report['inventory']['trip_count'] == 1
    assert report['inventory']['total_seats'] == 20
    assert report['inventory']['unbooked_seats'] == 20
    assert report['inventory']['bookable_seats'] == 0


def test_dashboard_identifies_demo_data(app):
    _, client = app
    login(client, 'admin')
    today = client.get('/api/admin/dashboard').json()
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    tomorrow_report = client.get('/api/admin/dashboard', params={'date': tomorrow}).json()
    assert today['activity']['demo_bookings'] == 10
    assert tomorrow_report['inventory']['demo_bookings'] == 10
    assert tomorrow_report['inventory']['total_seats'] == 262
    assert tomorrow_report['inventory']['booked_seats'] == 10
    assert tomorrow_report['inventory']['unbooked_seats'] == 252
    assert tomorrow_report['inventory']['bookable_seats'] == 252


def test_admin_create_and_edit_bus_and_trip(app):
    _, client = app
    login(client, 'admin')
    data = {'name': 'Test Express', 'registration': 'TEST-123', 'bus_type': 'AC', 'total_seats': 10}
    bus = client.post('/api/admin/buses', json=data)
    assert bus.status_code == 201
    assert client.post('/api/admin/buses', json=data).status_code == 409
    departure = datetime.now(IST)+timedelta(days=3)
    trip_data = {'bus_id': bus.json()['id'], 'origin': 'Pune', 'destination': 'Mumbai',
                 'departure_at': departure.isoformat(), 'arrival_at': (departure+timedelta(hours=4)).isoformat(),
                 'price': '499.50', 'active': True}
    trip = client.post('/api/admin/trips', json=trip_data)
    assert trip.status_code == 201, trip.text
    assert trip.json()['price_paise'] == 49950
    assert client.post('/api/admin/trips', json=trip_data).status_code == 409
    updated = client.put(f"/api/admin/trips/{trip.json()['id']}", json=trip_data | {'active': False})
    assert updated.status_code == 200
    assert updated.json()['active'] is False
    assert client.put(f"/api/admin/buses/{bus.json()['id']}", json=data | {'total_seats': 12}).status_code == 200


def test_capacity_and_schedule_with_existing_bookings(app):
    _, client = app
    trip = future_trip(client)
    login(client, 'admin')
    bus = next(b for b in client.get('/api/admin/buses').json() if b['id'] == trip['bus_id'])
    bus.pop('id')
    bus.pop('average_rating')
    bus.pop('rating_count')
    response = client.put(f"/api/admin/buses/{trip['bus_id']}", json=bus | {'total_seats': 1})
    assert response.status_code == 409
    response = client.put(f"/api/admin/trips/{trip['id']}", json={'bus_id': trip['bus_id'],
        'origin': 'Pune', 'destination': 'Mumbai', 'departure_at': trip['departure_at'], 'arrival_at': trip['arrival_at'],
        'price': '900', 'active': True})
    assert response.status_code == 409


def test_cannot_cancel_after_departure(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    booking = book(client, trip).json()
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == trip['id']).values(departure_at=1))
    before = remaining(application, trip['id'])
    assert client.post(f"/api/bookings/{booking['id']}/cancel").status_code == 409
    assert remaining(application, trip['id']) == before


def test_csrf_and_login_rate_limit(app):
    application, client = app
    with TestClient(application) as unprotected:
        assert unprotected.post('/api/auth/logout').status_code == 403
    assert client.post('/api/auth/logout', headers={'Origin': 'https://evil.example'}).status_code == 403
    for _ in range(15):
        assert client.post('/api/auth/login', json={'email': 'nobody@kpi.test', 'password': 'wrong'}).status_code == 401
    assert client.post('/api/auth/login', json={'email': 'nobody@kpi.test', 'password': 'wrong'}).status_code == 429


def test_natural_search_and_preference_ranking(app):
    _, client = app
    response = client.post('/api/search/natural', json={'query': 'Hyderabad to Bengaluru tomorrow morning, preferably AC'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['mode'] == 'offline'
    assert result['criteria']['preferred_type'] == 'AC'
    assert result['criteria']['bus_type'] is None
    assert result['trips'][0]['bus_type'] == 'AC'
    assert any(t['bus_type'] == 'Non-AC' for t in result['trips'])
    missing = client.post('/api/search/natural', json={'query': 'I want a bus tomorrow'}).json()
    assert missing['criteria']['clarification']
    assert missing['trips'] == []


def test_offline_parser_date_budget_and_type():
    result = fallback_parse('Hyderabad to Bangalore day after tomorrow non-ac under 700')
    assert result.travel_date == datetime.now(IST).date()+timedelta(days=2)
    assert result.bus_type == 'Non-AC'
    assert result.max_price == 700
    assert fallback_parse('Hyderabad to Bangalore on 2026-99-99').clarification
    written = fallback_parse('mum to pune 1st sep above 100 other buses than Western Express',
                             date(2026, 8, 29))
    assert written.origin == 'Mumbai' and written.destination == 'Pune'
    assert written.travel_date == date(2026, 9, 1)
    assert written.min_price == 100 and written.exclude_bus_name == 'Western Express'
    next_bus = fallback_parse('next available bus from hyd to blr', date(2026, 8, 29))
    assert next_bus.next_available is True
    assert next_bus.travel_date is None and next_bus.clarification is None
    misspelled = fallback_parse('chennai banglore tomorrow', date(2026, 8, 29))
    assert misspelled.origin == 'Chennai' and misspelled.destination == 'Bangalore'
    assert misspelled.travel_date == date(2026, 8, 30)
    numeric = fallback_parse('chennai to banglore 8-31', date(2026, 8, 29))
    assert numeric.travel_date == date(2026, 8, 31)
    timed = fallback_parse('hyd to blr tomorrow between 6-9pm', date(2026, 8, 29))
    assert timed.departure_after == '18:00' and timed.departure_before == '21:00'


def test_explicit_filters_override_weaker_ai_interpretation():
    result = SearchCriteria(preferred_type='AC', time_of_day='morning')
    result = apply_explicit_filters(
        result, 'hyd to blr tomorrow AC under 2000 between 6-9pm')
    assert result.origin == 'Hyderabad' and result.destination == 'Bangalore'
    assert result.bus_type == 'AC' and result.preferred_type is None
    assert result.max_price == 2000
    assert result.departure_after == '18:00' and result.departure_before == '21:00'
    cleared = apply_explicit_filters(result, 'from hyd to blr tomorrow. no')
    assert cleared.bus_type is None and cleared.time_of_day is None
    assert cleared.max_price is None and cleared.departure_after is None


def test_next_available_search_and_optional_preferences(app):
    _, client = app
    response = client.post('/api/search/natural', json={
        'query': 'next available bus from Hyderabad to Bangalore',
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['criteria']['next_available'] is True
    assert result['criteria']['travel_date'] is None
    assert result['criteria']['clarification'] is None
    assert len(result['trips']) == 1

    optional_question = SearchCriteria(
        origin='Pune', destination='Mumbai',
        travel_date=(datetime.now(IST)+timedelta(days=2)).date(),
        clarification='What time would you like to travel?',
    )
    assert validate_criteria(optional_question).clarification is None


def test_exact_departure_window_filters_real_trips(app):
    _, client = app
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    response = client.post('/api/search/natural', json={
        'query': f'Hyderabad to Bangalore on {tomorrow} between 6-9pm',
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['criteria']['departure_after'] == '18:00'
    assert result['criteria']['departure_before'] == '21:00'
    assert result['trips']
    assert all(18 <= datetime.fromisoformat(row['departure_at']).hour <= 21
               for row in result['trips'])


def test_search_minimum_fare_and_bus_exclusion(app):
    _, client = app
    trip = future_trip(client)
    params = {'origin': trip['origin'], 'destination': trip['destination'],
              'travel_date': trip['departure_at'][:10]}
    rows = client.get('/api/trips', params=params).json()
    minimum = client.get('/api/trips', params=params | {
        'min_price': max(row['price_paise'] for row in rows)//100 + 1})
    assert minimum.status_code == 200 and minimum.json() == []
    excluded = client.get('/api/trips', params=params | {
        'exclude_bus_name': trip['bus_name']})
    assert excluded.status_code == 200
    assert all(row['bus_name'].casefold() != trip['bus_name'].casefold()
               for row in excluded.json())
    assert len(excluded.json()) < len(rows)


def test_live_ai_adapter_with_mocked_provider(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key-not-real')
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    criteria = SearchCriteria(origin='Hyderabad', destination='Bangalore', travel_date=tomorrow, preferred_type='AC')

    def fake_post(self, url, **kwargs):
        assert url == 'https://api.openai.com/v1/chat/completions'
        request = kwargs['json']
        assert request['response_format']['json_schema']['strict'] is True
        assert set(request['response_format']['json_schema']['schema']['required']) == set(SearchCriteria.model_fields)
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'message': {'content': criteria.model_dump_json()}}]})

    monkeypatch.setattr(httpx.Client, 'post', fake_post)
    result, mode, _ = interpret('Hyderabad to Bangalore tomorrow preferably AC', ['Hyderabad', 'Bangalore'])
    assert mode == 'ai'
    assert result.preferred_type == 'AC'


@pytest.mark.parametrize('failure', ['timeout', 'malformed', 'refusal'])
def test_ai_failure_is_labelled_as_offline(monkeypatch, failure):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key-not-real')

    def fake_post(self, url, **kwargs):
        if failure == 'timeout':
            raise httpx.TimeoutException('test timeout')
        message = {'content': 'not-json'} if failure == 'malformed' else {'refusal': 'No'}
        return httpx.Response(200, request=httpx.Request('POST', url), json={'choices': [{'message': message}]})

    monkeypatch.setattr(httpx.Client, 'post', fake_post)
    result, mode, message = interpret('Hyderabad to Bangalore tomorrow', ['Hyderabad', 'Bangalore'])
    assert mode == 'offline'
    assert 'unavailable' in message
    assert result.origin == 'Hyderabad'
