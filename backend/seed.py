"""Repeatable sample data; never resets an existing database."""
import os
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select

from .database import bookings, buses, routes, trips, users
from .search import IST
from .security import hash_password


def seed_demo(engine):
    with engine.begin() as conn:
        if conn.execute(select(users.c.id).limit(1)).first():
            return
        password = hash_password(os.getenv('DEMO_PASSWORD', 'TravelDemo123!'))
        for name, email, role in [('Admin', 'admin@kpi.test', 'admin'),
                                 ('Aarav', 'customer@kpi.test', 'customer'),
                                 ('Priya', 'priya@kpi.test', 'customer')]:
            conn.execute(users.insert().values(name=name, email=email, role=role, password_hash=password))
        route_pairs = [('Hyderabad', 'Bangalore'), ('Bangalore', 'Chennai'),
                       ('Pune', 'Mumbai'), ('Hyderabad', 'Vijayawada'), ('Bangalore', 'Mysore')]
        route_ids = [conn.execute(routes.insert().values(origin=a, destination=b)).inserted_primary_key[0]
                     for a, b in route_pairs]
        fleet = [('KPi Express', 'TS09 AB1234', 'AC', 40, 850, 7, 0),
                 ('Deccan Sleeper', 'TS10 CD5678', 'Sleeper', 30, 1200, 21, 0),
                 ('City Connect', 'KA01 EF9012', 'Non-AC', 44, 550, 9, 0),
                 ('Southern Comfort', 'KA02 GH3456', 'AC', 36, 700, 8, 1),
                 ('Western Express', 'MH12 IJ7890', 'AC', 40, 450, 10, 2),
                 ('Coastal Connect', 'AP16 KL2345', 'Non-AC', 40, 400, 6, 3),
                 ('Mysore Shuttle', 'KA03 MN6789', 'AC', 32, 350, 11, 4)]
        customer = conn.execute(select(users.c.id).where(users.c.email == 'customer@kpi.test')).scalar_one()
        for i, (name, registration, kind, capacity, price, hour, route_index) in enumerate(fleet):
            bus_id = conn.execute(buses.insert().values(name=name, registration=registration,
                bus_type=kind, total_seats=capacity)).inserted_primary_key[0]
            for day in range(15):
                departure = datetime.now(IST).replace(hour=hour, minute=0, second=0, microsecond=0) + timedelta(days=day)
                arrival = departure + timedelta(hours=8 if route_index == 0 else 4)
                used = (4 if i == 0 else 1) if day == 1 else 0
                trip_id = conn.execute(trips.insert().values(bus_id=bus_id, route_id=route_ids[route_index],
                    departure_at=int(departure.timestamp()), arrival_at=int(arrival.timestamp()),
                    price_paise=price * 100, total_seats=capacity, available_seats=capacity-used,
                    active=True)).inserted_primary_key[0]
                for n in range(used):
                    conn.execute(bookings.insert().values(id=str(uuid.uuid4()), user_id=customer,
                        trip_id=trip_id, passenger_name=f'Demo Passenger {n+1}', passenger_age=28,
                        phone='9000000000', seat_count=1, total_paise=price * 100, status='Confirmed',
                        created_at=int(time.time()), idempotency_key=f'seed-{i}-{day}-{n}', request_hash='seed'))
