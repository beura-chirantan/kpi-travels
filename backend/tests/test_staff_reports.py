"""Selected weekdays/prices and a single booking-date revenue definition."""
from datetime import datetime, timedelta

from sqlalchemy import func, select

from backend.database import bookings, ratings, schedule_departures, trips, weekly_schedules
from backend.search import IST
from .test_api import app, book, future_trip, login
from .test_features import weekly_input


def multi_day_input(client):
    data = weekly_input(client)
    for field in ('departure_day', 'arrival_day', 'price'):
        data.pop(field)
    return data | {'days': [{'day': 0, 'price': '500.25'}, {'day': 2, 'price': '600'},
                            {'day': 6, 'price': '750.50'}], 'arrival_day_offset': 1}


def test_selected_weekdays_and_prices_reach_search_and_booking(app):
    application, client = app
    login(client, 'admin')
    data = multi_day_input(client)
    response = client.post('/api/admin/weekly-schedules', json=data)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result['trip_count'] == 7  # Sunday x3, Monday x2, Wednesday x2 (inclusive).
    assert len(result['schedule_ids']) == 3
    prices = {0: 50025, 2: 60000, 6: 75050}
    first = datetime.fromisoformat(data['start_date']).date()
    last = datetime.fromisoformat(data['end_date']).date()
    expected = {(first+timedelta(days=index)).isoformat() for index in range(15)
                if (first+timedelta(days=index)).weekday() in prices}
    rows = result['trips']
    assert {row['departure_at'][:10] for row in rows} == expected
    for row in rows:
        departure, arrival = datetime.fromisoformat(row['departure_at']), datetime.fromisoformat(row['arrival_at'])
        assert first <= departure.date() <= last
        assert row['price_paise'] == prices[departure.weekday()]
        assert arrival-departure == timedelta(hours=8)
        assert row['available_seats'] == 10
    login(client)
    for day in range(7):
        selected = (first+timedelta(days=day)).isoformat()
        search = client.get('/api/trips', params={'origin': 'Pune', 'destination': 'Mumbai', 'travel_date': selected}).json()
        matching = [row for row in search if row['bus_id'] == data['bus_id']]
        assert bool(matching) == ((first+timedelta(days=day)).weekday() in prices)
        if matching:
            ticket = book(client, matching[0])
            assert ticket.status_code == 201, ticket.text
            assert ticket.json()['total_paise'] == prices[(first+timedelta(days=day)).weekday()]
    # Prices live on the saved trips, not just in the creation response.
    with application.state.engine.connect() as conn:
        saved = conn.execute(select(trips).where(trips.c.bus_id == data['bus_id'])).mappings().all()
        assert len(saved) == 7
        assert {row['price_paise'] for row in saved} == set(prices.values())


def test_every_day_short_range_and_no_selected_occurrence(app):
    _, client = app
    login(client, 'admin')
    data = multi_day_input(client)
    first = datetime.fromisoformat(data['start_date']).date()
    data['end_date'] = (first+timedelta(days=6)).isoformat()
    data['days'] = [{'day': index, 'price': str(100+index)} for index in range(7)]
    result = client.post('/api/admin/weekly-schedules', json=data)
    assert result.status_code == 201, result.text
    assert result.json()['trip_count'] == 7
    data = multi_day_input(client)
    data['end_date'] = data['start_date']  # Sunday only, skip selected weekdays outside range.
    result = client.post('/api/admin/weekly-schedules', json=data)
    assert result.status_code == 201 and result.json()['trip_count'] == 1
    data = multi_day_input(client)
    data['end_date'] = data['start_date']
    data['days'] = [{'day': 0, 'price': '100'}]
    assert client.post('/api/admin/weekly-schedules', json=data).status_code == 422


def test_multi_day_validation_rejects_bad_days_and_prices_without_writes(app):
    application, client = app
    login(client, 'admin')
    data = multi_day_input(client)
    invalid = [[], [{'day': 0, 'price': '500'}, {'day': 0, 'price': '600'}],
               [{'day': 7, 'price': '500'}], [{'day': -1, 'price': '500'}],
               [{'day': True, 'price': '500'}], [{'day': 1, 'price': '0'}],
               [{'day': 1, 'price': '-1'}], [{'day': 1, 'price': '1.001'}],
               [{'day': 1, 'price': '100000.01'}], [{'day': 1}],
               [{'day': 1, 'price': 'NaN'}]]
    for days in invalid:
        response = client.post('/api/admin/weekly-schedules', json=data | {'days': days})
        assert response.status_code == 422, response.text
    for change in ({'arrival_day_offset': 0}, {'arrival_day_offset': 7},
                   {'arrival_day_offset': -1}, {'origin': 'Mumbai'}, {'end_date': '2020-01-01'}):
        assert client.post('/api/admin/weekly-schedules', json=data | change).status_code == 422
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(weekly_schedules)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(trips).where(trips.c.bus_id == data['bus_id'])).scalar_one() == 0


def test_conflict_on_last_selected_weekday_rolls_back_all_days(app):
    application, client = app
    login(client, 'admin')
    data = multi_day_input(client)
    sunday = datetime.fromisoformat(data['start_date']).replace(tzinfo=IST, hour=22)
    conflict = client.post('/api/admin/trips', json={'bus_id': data['bus_id'], 'origin': 'Pune',
        'destination': 'Mumbai', 'departure_at': sunday.isoformat(),
        'arrival_at': (sunday+timedelta(hours=8)).isoformat(), 'price': '100'})
    assert conflict.status_code == 201
    result = client.post('/api/admin/weekly-schedules', json=data)
    assert result.status_code == 409, result.text
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(weekly_schedules)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(schedule_departures)).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(trips).where(trips.c.bus_id == data['bus_id'])).scalar_one() == 1


def test_overlapping_selected_weekdays_roll_back_the_whole_plan(app):
    application, client = app
    login(client, 'admin')
    data = multi_day_input(client) | {'arrival_day_offset': 2,
        'days': [{'day': 0, 'price': '500'}, {'day': 1, 'price': '600'}]}
    response = client.post('/api/admin/weekly-schedules', json=data)
    assert response.status_code == 422
    assert 'new weekly plan overlaps itself' in response.json()['detail']
    with application.state.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(trips).where(trips.c.bus_id == data['bus_id'])).scalar_one() == 0
        assert conn.execute(select(func.count()).select_from(weekly_schedules)).scalar_one() == 0


def test_revenue_uses_ist_booking_dates_ticket_fares_and_separate_ratings(app):
    application, client = app
    login(client)
    trip = future_trip(client)
    tickets = [book(client, trip).json() for _ in range(5)]
    # Include both sides of IST midnight, leap day, and the next year boundary.
    dates = ['2024-01-31T23:59:59+05:30', '2024-02-01T00:00:00+05:30',
             '2024-02-29T23:59:59+05:30', '2024-02-15T12:00:00+05:30', '2025-01-01T00:00:00+05:30']
    prices = [10025, 20050, 30075, 99900, 40000]
    with application.state.engine.begin() as conn:
        for ticket, value, created in zip(tickets, prices, dates):
            conn.execute(bookings.update().where(bookings.c.id == ticket['id']).values(
                total_paise=value, created_at=int(datetime.fromisoformat(created).timestamp())))
        conn.execute(bookings.update().where(bookings.c.id == tickets[3]['id']).values(status='Cancelled'))
        # These passengers have travelled; two reviews must not duplicate revenue rows.
        conn.execute(trips.update().where(trips.c.id == trip['id']).values(
            departure_at=1, arrival_at=2, price_paise=999999))
        for ticket, stars in zip(tickets[:2], [4, 5]):
            conn.execute(ratings.insert().values(booking_id=ticket['id'], bus_id=trip['bus_id'],
                user_id=ticket['user_id'], stars=stars, comment='', updated_at=3))
    login(client, 'admin')
    result = client.get('/api/admin/revenue?year=2024&month=2')
    assert result.status_code == 200, result.text
    report = result.json()
    assert len(report['months']) == 12
    assert report['revenue_paise'] == 60150
    assert report['months'][0]['revenue_paise'] == 10025
    assert report['months'][1]['revenue_paise'] == 50125
    assert all(month['revenue_paise'] == 0 for month in report['months'][2:])
    assert report['month'] == 2 and len(report['days']) == 29
    assert sum(day['revenue_paise'] for day in report['days']) == 50125
    assert sum(week['revenue_paise'] for week in report['weeks']) == 50125
    assert next(year for year in report['years'] if year['year'] == 2024)['revenue_paise'] == 60150
    for month in report['months']:
        assert sum(bus['revenue_paise'] for bus in month['buses']) == month['revenue_paise']
        assert sum(bus['ticket_count'] for bus in month['buses']) == month['ticket_count']
    feb = report['months'][1]
    bus = next(bus for bus in feb['buses'] if bus['id'] == trip['bus_id'])
    assert bus['revenue_paise'] == 50125 and bus['ticket_count'] == 2
    assert bus['average_rating'] == 4.5 and bus['rating_count'] == 2
    assert any(bus['revenue_paise'] == 0 and bus['average_rating'] is None for bus in feb['buses'])
    assert client.get('/api/admin/revenue?year=2025').json()['months'][0]['revenue_paise'] == 40000
    for created, value in zip(dates[:3], prices[:3]):
        daily = client.get('/api/admin/dashboard', params={'date': created[:10]}).json()
        assert daily['revenue']['revenue_paise'] == value
        assert daily['revenue']['revenue_paise'] == daily['activity']['net_value_paise']
        assert sum(bus['revenue_paise'] for bus in daily['revenue']['buses']) == value


def test_revenue_changes_after_cancellation_and_is_admin_only(app):
    _, client = app
    assert client.get('/api/admin/revenue').status_code == 401
    login(client)
    assert client.get('/api/admin/revenue').status_code == 403
    assert client.post('/api/admin/weekly-schedules', json={}).status_code in (403, 422)
    trip = future_trip(client)
    login(client, 'admin')
    before = client.get('/api/admin/dashboard').json()['revenue']
    login(client)
    ticket = book(client, trip).json()
    login(client, 'admin')
    after = client.get('/api/admin/dashboard').json()['revenue']
    assert after['revenue_paise'] == before['revenue_paise']+trip['price_paise']
    assert after['ticket_count'] == before['ticket_count']+1
    login(client)
    assert client.post(f"/api/bookings/{ticket['id']}/cancel").status_code == 200
    login(client, 'admin')
    assert client.get('/api/admin/dashboard').json()['revenue'] == before
    for year in ('0', '10000', 'bad'):
        assert client.get('/api/admin/revenue', params={'year': year}).status_code == 422
    assert client.get('/api/admin/revenue?year=9999').json()['revenue_paise'] == 0


def test_revenue_index_is_added_without_replacing_existing_data(app):
    application, client = app
    login(client)
    ticket = book(client, future_trip(client)).json()
    with application.state.engine.connect() as conn:
        indexes = conn.exec_driver_sql("PRAGMA index_list('bookings')").mappings().all()
        assert 'ix_bookings_created' in {row['name'] for row in indexes}
        plan = conn.exec_driver_sql('EXPLAIN QUERY PLAN SELECT total_paise FROM bookings WHERE created_at >= 1 AND created_at < 100').all()
        assert any('ix_bookings_created' in row[-1] for row in plan)
        assert conn.execute(select(bookings.c.id).where(bookings.c.id == ticket['id'])).scalar_one() == ticket['id']
