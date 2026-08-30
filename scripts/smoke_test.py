"""Check the running React → FastAPI connection without creating any bookings."""
import argparse
import os
from io import BytesIO
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:3000')
args = parser.parse_args()
tomorrow = (datetime.now(ZoneInfo('Asia/Kolkata')) + timedelta(days=1)).date().isoformat()

with httpx.Client(base_url=args.base_url, timeout=30, headers={
    'X-Requested-With': 'kpi-travels', 'Origin': args.base_url
}) as client:
    response = client.get('/api/health')
    response.raise_for_status()
    assert response.json()['status'] == 'ok'
    response = client.post('/api/auth/login', json={
        'email': 'customer@kpi.test', 'password': os.getenv('DEMO_PASSWORD', 'TravelDemo123!')
    })
    response.raise_for_status()
    try:
        assert client.get('/api/auth/me').json()['role'] == 'customer'
        assert client.get('/api/admin/dashboard').status_code == 403
        response = client.get('/api/trips', params={
            'origin': 'Hyderabad', 'destination': 'Bangalore', 'travel_date': tomorrow
        })
        response.raise_for_status()
        assert isinstance(response.json(), list)
        response = client.get('/api/bookings')
        response.raise_for_status()
        assert isinstance(response.json(), list)
        tickets = response.json()
        if tickets:
            download = client.get(f"/api/bookings/{tickets[0]['id']}/ticket")
            download.raise_for_status()
            assert 'attachment;' in download.headers['content-disposition']
            assert download.headers['content-type'] == 'application/pdf'
            assert download.content.startswith(b'%PDF-')
            assert 'Arrival (IST)' in PdfReader(BytesIO(download.content)).pages[0].extract_text()
        print('PASS: API relay, session cookies, role checks, search, and history. No bookings changed.')
    finally:
        client.post('/api/auth/logout').raise_for_status()
    assert client.get('/api/auth/me').status_code == 401
    print('PASS: logout revokes the test session.')

    response = client.post('/api/assistant/answer', json={
        'query': 'How can I download my ticket as a PDF?'
    })
    response.raise_for_status()
    assert response.json()['mode'] in ('ai', 'offline')
    assert response.json()['answer']
    response = client.post('/api/search/natural', json={
        'query': f'Hyderabad to Bangalore on {tomorrow}'
    })
    response.raise_for_status()
    assert response.json()['criteria']['origin'] == 'Hyderabad'
    assert isinstance(response.json()['trips'], list)
    print('PASS: Ask AI answers questions and finds real buses without changing bookings.')

    response = client.post('/api/auth/login', json={
        'email': 'admin@kpi.test', 'password': os.getenv('DEMO_PASSWORD', 'TravelDemo123!')
    })
    response.raise_for_status()
    try:
        for offset in (-1, 0, 1):
            selected_date = (datetime.now(ZoneInfo('Asia/Kolkata'))+timedelta(days=offset)).date().isoformat()
            response = client.get('/api/admin/dashboard', params={'date': selected_date})
            response.raise_for_status()
            report = response.json()
            assert report['date'] == selected_date
            activity, inventory = report['activity'], report['inventory']
            assert activity['total_bookings'] == activity['confirmed_bookings']+activity['cancelled_bookings']
            assert inventory['total_seats'] == inventory['booked_seats']+inventory['unbooked_seats']
            assert inventory['bookable_seats'] <= inventory['unbooked_seats']
            assert sum(row['bookings'] for row in report['route_demand']) == inventory['booked_seats']
            revenue = report['revenue']
            assert revenue['revenue_paise'] == activity['net_value_paise']
            assert sum(bus['revenue_paise'] for bus in revenue['buses']) == revenue['revenue_paise']
            assert sum(bus['ticket_count'] for bus in revenue['buses']) == revenue['ticket_count']
            assert all('average_rating' in bus and 'rating_count' in bus for bus in revenue['buses'])
        print('PASS: date-wise admin reports for yesterday, today, and tomorrow; consistent seat totals.')
        monthly = client.get('/api/admin/revenue', params={'year': datetime.now(ZoneInfo('Asia/Kolkata')).year})
        monthly.raise_for_status()
        yearly = monthly.json()
        assert len(yearly['months']) == 12
        assert sum(month['revenue_paise'] for month in yearly['months']) == yearly['revenue_paise']
        assert all(sum(bus['revenue_paise'] for bus in month['buses']) == month['revenue_paise'] for month in yearly['months'])
        print('PASS: daily, monthly and per-bus revenue totals agree; bus ratings included.')
        fleet = client.get('/api/admin/buses')
        fleet.raise_for_status()
        for bus in fleet.json():
            assert 'rating_count' in bus and 'average_rating' in bus
        if fleet.json():
            reviews = client.get(f"/api/admin/buses/{fleet.json()[0]['id']}/ratings")
            reviews.raise_for_status()
            assert isinstance(reviews.json(), list)
        print('PASS: ticket downloads and bus-wise admin ratings are reachable. No tickets or ratings changed.')
    finally:
        client.post('/api/auth/logout').raise_for_status()
