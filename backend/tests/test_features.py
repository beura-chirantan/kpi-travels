from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
from io import BytesIO
import uuid

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select
from pypdf import PdfReader

from backend.database import (booking_changes, bookings, ratings, schedule_departures,
                              trips, weekly_schedules)
from backend.search import IST
from .test_api import app, book, future_trip, login, payload, remaining, HEADERS


def alternate_trip(client, source, days=2):
    day = (datetime.now(IST)+timedelta(days=days)).date().isoformat()
    return client.get('/api/trips', params={'origin': source['origin'],
        'destination': source['destination'], 'travel_date': day}).json()[0]


def move(client, booking, target, key=None):
    return client.post(f"/api/bookings/{booking['id']}/reschedule", json={
        'trip_id': target['id'], 'expected_trip_id': booking['trip_id'],
        'expected_price_paise': target['price_paise']},
        headers={'Idempotency-Key': key or str(uuid.uuid4())})


def weekly_input(client):
    bus = client.post('/api/admin/buses', json={'name': 'Weekly Express',
        'registration': str(uuid.uuid4())[:12], 'bus_type': 'AC', 'total_seats': 10}).json()
    day = datetime.now(IST).date()+timedelta(days=30)
    day += timedelta(days=(6-day.weekday()) % 7)
    return {'bus_id': bus['id'], 'origin': 'Pune', 'destination': 'Mumbai',
        'start_date': day.isoformat(), 'end_date': (day+timedelta(days=14)).isoformat(),
        'departure_day': 6, 'arrival_day': 0, 'departure_time': '22:00',
        'arrival_time': '06:00', 'price': '600.50'}


def test_ticket_download_owner_status_and_escaping(app):
    _, client = app
    login(client)
    trip = future_trip(client)
    data = payload(trip) | {'passenger_name': '<script>alert("hi")</script>'}
    booking = client.post('/api/bookings', json=data,
        headers={'Idempotency-Key': str(uuid.uuid4())}).json()
    path = f"/api/bookings/{booking['id']}/ticket"
    result = client.get(path)
    assert result.status_code == 200
    assert 'attachment;' in result.headers['content-disposition']
    assert result.headers['content-type'] == 'application/pdf'
    assert result.headers['content-disposition'].endswith('.pdf"')
    assert result.content.startswith(b'%PDF-')
    assert 'no-store' in result.headers['cache-control']
    pdf = PdfReader(BytesIO(result.content))
    assert len(pdf.pages) == 1
    text = pdf.pages[0].extract_text()
    assert 'Arrival (IST)' in text and trip['destination'] in text
    assert '<script>alert("hi")</script>' in text
    assert '/OpenAction' not in pdf.trailer['/Root']
    assert booking['id'] in text
    client.post(f"/api/bookings/{booking['id']}/cancel")
    cancelled_pdf = PdfReader(BytesIO(client.get(path).content))
    assert 'Cancelled' in cancelled_pdf.pages[0].extract_text()
    login(client, 'priya')
    assert client.get(path).status_code == 404
    client.post('/api/auth/logout')
    assert client.get(path).status_code == 401


def test_reschedule_preserves_reference_and_moves_seat_once(app):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    booking = book(client, source).json()
    old_remaining = remaining(application, source['id'])
    new_remaining = remaining(application, target['id'])
    key = str(uuid.uuid4())
    for _ in range(2):
        result = move(client, booking, target, key)
        assert result.status_code == 200, result.text
        moved = result.json()
        assert moved['id'] == booking['id']
        assert moved['passenger_name'] == booking['passenger_name']
        assert moved['trip_id'] == target['id']
        assert moved['total_paise'] == target['price_paise']
        assert moved['reschedule_count'] == 1
    assert remaining(application, source['id']) == old_remaining+1
    assert remaining(application, target['id']) == new_remaining-1
    assert move(client, booking, source, key).status_code == 409
    assert move(client, booking, source).status_code == 409
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(booking_changes)).scalar_one() == 1
    ticket = PdfReader(BytesIO(client.get(f"/api/bookings/{booking['id']}/ticket").content)).pages[0].extract_text()
    assert datetime.fromisoformat(target['departure_at']).strftime('%d %b %Y, %I:%M %p') in ticket
    cancelled = client.post(f"/api/bookings/{booking['id']}/cancel")
    assert cancelled.status_code == 200
    assert remaining(application, source['id']) == old_remaining+1
    assert remaining(application, target['id']) == new_remaining


@pytest.mark.parametrize('change', [
    {'available_seats': 0}, {'active': False}, {'departure_at': 1}, {'price_paise': 99999},
])
def test_reschedule_failure_keeps_original_ticket(app, change):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    booking = book(client, source).json()
    old_remaining = remaining(application, source['id'])
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == target['id']).values(**change))
    target_remaining = remaining(application, target['id'])
    result = move(client, booking, target)
    assert result.status_code == 409, result.text
    assert remaining(application, source['id']) == old_remaining
    assert remaining(application, target['id']) == target_remaining
    original = next(row for row in client.get('/api/bookings').json() if row['id'] == booking['id'])
    assert original['trip_id'] == source['id'] and original['status'] == 'Confirmed'


def test_reschedule_ownership_route_and_departure_rules(app):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    booking = book(client, source).json()
    login(client, 'priya')
    assert move(client, booking, target).status_code == 404
    login(client)
    assert move(client, booking, source).status_code == 422
    wrong_route = next(row for row in client.get('/api/trips').json() if row['route_id'] != source['route_id'])
    assert move(client, booking, wrong_route).status_code == 422
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == source['id']).values(departure_at=1))
    assert move(client, booking, target).status_code == 409


def test_concurrent_reschedule_replay(app):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    booking = book(client, source).json()
    old_remaining, new_remaining = remaining(application, source['id']), remaining(application, target['id'])
    cookie, key, barrier = dict(client.cookies), str(uuid.uuid4()), Barrier(2)
    def attempt(_):
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            barrier.wait(timeout=10)
            return move(other, booking, target, key).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(attempt, range(2))) == [200, 200]
    assert remaining(application, source['id']) == old_remaining+1
    assert remaining(application, target['id']) == new_remaining-1


def test_reschedules_compete_for_last_seat(app):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    first = book(client, source).json()
    first_cookie = dict(client.cookies)
    client.cookies.clear()
    login(client, 'priya')
    second = book(client, source).json()
    second_cookie = dict(client.cookies)
    before = remaining(application, source['id'])
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == target['id']).values(available_seats=1))
    barrier = Barrier(2)
    def attempt(args):
        cookie, booking = args
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            barrier.wait(timeout=10)
            return move(other, booking, target).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, [(first_cookie, first), (second_cookie, second)]))
    assert sorted(results) == [200, 409]
    assert remaining(application, source['id']) == before+1
    assert remaining(application, target['id']) == 0


def test_weekly_overnight_trips_have_separate_inventory(app):
    application, client = app
    login(client, 'admin')
    data = weekly_input(client)
    result = client.post('/api/admin/weekly-schedules', json=data)
    assert result.status_code == 201, result.text
    schedule = result.json()
    assert schedule['trip_count'] == 3
    rows = schedule['trips']
    for trip in rows:
        departure, arrival = datetime.fromisoformat(trip['departure_at']), datetime.fromisoformat(trip['arrival_at'])
        assert departure.weekday() == 6 and arrival.weekday() == 0
        assert arrival-departure == timedelta(hours=8)
        assert trip['schedule_id'] == schedule['schedule_id']
        assert trip['price_paise'] == 60050 and trip['available_seats'] == 10
    assert datetime.fromisoformat(rows[1]['departure_at'])-datetime.fromisoformat(rows[0]['departure_at']) == timedelta(days=7)
    login(client)
    assert book(client, rows[0]).status_code == 201
    assert remaining(application, rows[0]['id']) == 9
    assert remaining(application, rows[1]['id']) == 10
    login(client, 'admin')
    report = client.get('/api/admin/dashboard', params={'date': rows[0]['departure_at'][:10]}).json()
    assert report['inventory']['total_seats'] == 10
    assert report['inventory']['bookable_seats'] == 9


def test_weekly_conflict_rolls_back_entire_series(app):
    application, client = app
    login(client, 'admin')
    data = weekly_input(client)
    second = datetime.fromisoformat(data['start_date']).replace(tzinfo=IST)+timedelta(days=7, hours=22)
    conflict = client.post('/api/admin/trips', json={
        'bus_id': data['bus_id'], 'origin': data['origin'], 'destination': data['destination'],
        'departure_at': second.isoformat(), 'arrival_at': (second+timedelta(hours=8)).isoformat(), 'price': '600'})
    assert conflict.status_code == 201
    result = client.post('/api/admin/weekly-schedules', json=data)
    assert result.status_code == 409
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(weekly_schedules)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(schedule_departures)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(trips).where(trips.c.bus_id == data['bus_id'])).scalar_one() == 1


@pytest.mark.parametrize('changes', [
    {'departure_day': 7}, {'arrival_time': '25:00'}, {'departure_time': '6:00'},
    {'arrival_day': 6, 'arrival_time': '20:00'}, {'origin': 'Mumbai'},
    {'end_date': '2020-01-01'}, {'end_date': '2030-12-31'},
])
def test_weekly_validation(app, changes):
    _, client = app
    login(client, 'admin')
    data = weekly_input(client)
    assert client.post('/api/admin/weekly-schedules', json=data | changes).status_code == 422


def test_cancel_one_weekly_departure_and_restore_once(app):
    application, client = app
    login(client, 'admin')
    rows = client.post('/api/admin/weekly-schedules', json=weekly_input(client)).json()['trips']
    login(client)
    ticket = book(client, rows[0]).json()
    assert client.post(f"/api/admin/trips/{rows[0]['id']}/cancel", json={'reason': 'Bus maintenance'}).status_code == 403
    login(client, 'admin')
    for _ in range(2):
        result = client.post(f"/api/admin/trips/{rows[0]['id']}/cancel", json={'reason': 'Bus maintenance'})
        assert result.status_code == 200, result.text
        assert not result.json()['active']
        assert result.json()['cancellation_reason'] == 'Bus maintenance'
    assert remaining(application, rows[0]['id']) == 10
    assert remaining(application, rows[1]['id']) == 10
    with application.state.engine.connect() as conn:
        assert conn.execute(select(trips.c.active).where(trips.c.id == rows[1]['id'])).scalar_one()
    result = client.put(f"/api/admin/trips/{rows[0]['id']}", json={
        'bus_id': rows[0]['bus_id'], 'origin': 'Pune', 'destination': 'Mumbai',
        'departure_at': rows[0]['departure_at'], 'arrival_at': rows[0]['arrival_at'], 'price': '600', 'active': True})
    assert result.status_code == 409
    login(client)
    cancelled = next(row for row in client.get('/api/bookings').json() if row['id'] == ticket['id'])
    assert cancelled['status'] == 'Cancelled'
    assert not cancelled['can_reschedule'] and not cancelled['can_rate']
    assert cancelled['trip']['cancellation_reason'] == 'Bus maintenance'
    assert book(client, rows[0]).status_code == 409


def test_cancel_todays_trip_before_but_not_after_departure(app, monkeypatch):
    application, client = app
    fixed = datetime.now(IST).replace(hour=6, minute=0, second=0, microsecond=0)
    monkeypatch.setattr('backend.main.now', lambda: int(fixed.timestamp()))
    login(client, 'admin')
    rows = client.get('/api/admin/trips').json()
    today = next(row for row in rows if row['departure_at'][:10] == fixed.date().isoformat() and datetime.fromisoformat(row['departure_at']) > fixed)
    result = client.post(f"/api/admin/trips/{today['id']}/cancel", json={'reason': 'Today only maintenance'})
    assert result.status_code == 200
    other = next(row for row in rows if row['id'] != today['id'])
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == other['id']).values(departure_at=int(fixed.timestamp())-1))
    assert client.post(f"/api/admin/trips/{other['id']}/cancel", json={'reason': 'Too late'}).status_code == 409


def test_verified_ratings_update_and_admin_visibility(app):
    application, client = app
    login(client)
    source = future_trip(client)
    booking = book(client, source).json()
    path = f"/api/bookings/{booking['id']}/rating"
    assert client.put(path, json={'stars': 5}).status_code == 409
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == source['id']).values(departure_at=1, arrival_at=2))
    login(client, 'priya')
    assert client.put(path, json={'stars': 5}).status_code == 404
    login(client)
    for score in [5, 4]:
        response = client.put(path, json={'stars': score, 'comment': 'Comfortable bus'})
        assert response.status_code == 200, response.text
        assert response.json()['rating']['stars'] == score
    for invalid in [0, 6, 2.5, True]:
        assert client.put(path, json={'stars': invalid}).status_code == 422
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(ratings)).scalar_one() == 1
    assert client.get(f"/api/admin/buses/{source['bus_id']}/ratings").status_code == 403
    results = client.get('/api/trips', params={'origin': source['origin'], 'destination': source['destination']}).json()
    assert results[0]['bus_id'] == source['bus_id']
    assert results[0]['average_rating'] == 4 and results[0]['rating_count'] == 1
    login(client, 'admin')
    fleet = client.get('/api/admin/buses').json()
    bus = next(row for row in fleet if row['id'] == source['bus_id'])
    assert bus['average_rating'] == 4 and bus['rating_count'] == 1
    reviews = client.get(f"/api/admin/buses/{source['bus_id']}/ratings").json()
    assert len(reviews) == 1 and reviews[0]['comment'] == 'Comfortable bus'
    assert 'phone' not in reviews[0]


def test_cancelled_journey_cannot_be_rated(app):
    application, client = app
    login(client)
    source = future_trip(client)
    booking = book(client, source).json()
    client.post(f"/api/bookings/{booking['id']}/cancel")
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == source['id']).values(departure_at=1, arrival_at=2))
    assert client.put(f"/api/bookings/{booking['id']}/rating", json={'stars': 5}).status_code == 409


def test_arrival_filter_and_empty_ratings(app):
    _, client = app
    result = client.get('/api/trips', params={'arrival_time_of_day': 'morning'})
    assert result.status_code == 200
    for row in result.json():
        assert 6 <= datetime.fromisoformat(row['arrival_at']).hour < 12
        assert row['average_rating'] is None and row['rating_count'] == 0
    assert client.get('/api/trips', params={'arrival_time_of_day': 'invalid'}).status_code == 422


def test_cancellation_racing_reschedule_keeps_inventory_consistent(app):
    application, client = app
    login(client)
    source = future_trip(client)
    target = alternate_trip(client, source)
    booking = book(client, source).json()
    customer_cookie = dict(client.cookies)
    client.cookies.clear()
    login(client, 'admin')
    admin_cookie, barrier = dict(client.cookies), Barrier(2)
    def attempt(operation):
        cookie = customer_cookie if operation == 'move' else admin_cookie
        with TestClient(application, headers=HEADERS, cookies=cookie) as other:
            barrier.wait(timeout=10)
            if operation == 'move':
                return move(other, booking, target).status_code
            return other.post(f"/api/admin/trips/{source['id']}/cancel", json={'reason': 'Bus maintenance'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, ['move', 'cancel']))
    assert results[0] in (200, 409) and results[1] == 200
    with application.state.engine.connect() as conn:
        for trip_id in [source['id'], target['id']]:
            row = conn.execute(select(trips).where(trips.c.id == trip_id)).mappings().one()
            confirmed = conn.execute(select(func.count()).select_from(bookings).where(
                bookings.c.trip_id == trip_id, bookings.c.status == 'Confirmed')).scalar_one()
            assert row['total_seats']-row['available_seats'] == confirmed
        assert conn.execute(select(trips.c.available_seats).where(trips.c.id == source['id'])).scalar_one() == source['total_seats']


def test_rating_priority_over_type_preference(app):
    application, client = app
    login(client)
    tomorrow = (datetime.now(IST)+timedelta(days=1)).date().isoformat()
    choices = client.get('/api/trips', params={'origin': 'Hyderabad', 'destination': 'Bangalore', 'travel_date': tomorrow}).json()
    non_ac = next(trip for trip in choices if trip['bus_type'] == 'Non-AC')
    ticket = book(client, non_ac).json()
    with application.state.engine.begin() as conn:
        conn.execute(trips.update().where(trips.c.id == non_ac['id']).values(departure_at=1, arrival_at=2))
    assert client.put(f"/api/bookings/{ticket['id']}/rating", json={'stars': 5}).status_code == 200
    next_day = (datetime.now(IST)+timedelta(days=2)).date().isoformat()
    results = client.get('/api/trips', params={'origin': 'Hyderabad', 'destination': 'Bangalore',
        'travel_date': next_day, 'preferred_type': 'AC'}).json()
    assert results[0]['bus_type'] == 'Non-AC'
    assert results[0]['average_rating'] == 5
    assert any(trip['bus_type'] == 'AC' for trip in results[1:])


def test_additive_schema_preserves_existing_bookings(tmp_path, monkeypatch):
    from backend.database import make_engine, metadata, buses, routes, sessions, users
    from backend.main import create_app
    from backend.seed import seed_demo
    monkeypatch.setenv('DEMO_PASSWORD', 'TravelDemo123!')
    url = f'sqlite:///{tmp_path}/existing.db'
    engine = make_engine(url)
    metadata.create_all(engine, tables=[users, sessions, buses, routes, trips, bookings])
    seed_demo(engine)
    with engine.connect() as conn:
        before = conn.execute(select(bookings).order_by(bookings.c.id)).all()
        original_trips = conn.execute(select(trips).order_by(trips.c.id)).all()
    engine.dispose()
    application = create_app(url, seed=True)
    with TestClient(application, headers=HEADERS) as client:
        assert client.get('/api/health').status_code == 200
        with application.state.engine.connect() as conn:
            assert conn.execute(select(bookings).order_by(bookings.c.id)).all() == before
            assert conn.execute(select(trips).order_by(trips.c.id)).all() == original_trips
            assert conn.execute(select(func.count()).select_from(ratings)).scalar_one() == 0
