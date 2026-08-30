"""Small relational schema, shared by SQLite and PostgreSQL.

Money is stored as integer paise; timestamps are UTC Unix seconds. This avoids
floating-point fares and SQLite/PostgreSQL timezone differences.
"""
import os
from pathlib import Path

from sqlalchemy import (Boolean, CheckConstraint, Column, ForeignKey, Index,
                        Integer, MetaData, String, Table, UniqueConstraint,
                        create_engine, event)

metadata = MetaData()
users = Table('users', metadata,
    Column('id', Integer, primary_key=True),
    Column('name', String(100), nullable=False),
    Column('email', String(160), nullable=False, unique=True),
    Column('phone', String(20)),
    Column('password_hash', String(256), nullable=False),
    Column('role', String(20), nullable=False),
    CheckConstraint("role IN ('admin', 'customer')"))
sessions = Table('sessions', metadata,
    Column('token_hash', String(64), primary_key=True),
    Column('user_id', ForeignKey('users.id'), nullable=False),
    Column('expires_at', Integer, nullable=False))
buses = Table('buses', metadata,
    Column('id', Integer, primary_key=True),
    Column('name', String(100), nullable=False),
    Column('registration', String(30), nullable=False, unique=True),
    Column('bus_type', String(20), nullable=False),
    Column('total_seats', Integer, nullable=False),
    CheckConstraint('total_seats BETWEEN 1 AND 100'),
    CheckConstraint("bus_type IN ('AC', 'Non-AC', 'Sleeper')"))
routes = Table('routes', metadata,
    Column('id', Integer, primary_key=True),
    Column('origin', String(80), nullable=False),
    Column('destination', String(80), nullable=False),
    UniqueConstraint('origin', 'destination'),
    CheckConstraint('origin <> destination'))
trips = Table('trips', metadata,
    Column('id', Integer, primary_key=True),
    Column('bus_id', ForeignKey('buses.id'), nullable=False),
    Column('route_id', ForeignKey('routes.id'), nullable=False),
    Column('departure_at', Integer, nullable=False),
    Column('arrival_at', Integer, nullable=False),
    Column('price_paise', Integer, nullable=False),
    Column('total_seats', Integer, nullable=False),
    Column('available_seats', Integer, nullable=False),
    Column('active', Boolean, nullable=False, default=True),
    CheckConstraint('price_paise > 0'),
    CheckConstraint('total_seats BETWEEN 1 AND 100'),
    CheckConstraint('available_seats >= 0 AND available_seats <= total_seats'),
    CheckConstraint('arrival_at > departure_at'))
bookings = Table('bookings', metadata,
    Column('id', String(36), primary_key=True),
    Column('user_id', ForeignKey('users.id'), nullable=False),
    Column('trip_id', ForeignKey('trips.id'), nullable=False),
    Column('passenger_name', String(100), nullable=False),
    Column('passenger_age', Integer, nullable=False),
    Column('phone', String(20), nullable=False),
    Column('seat_count', Integer, nullable=False),
    Column('total_paise', Integer, nullable=False),
    Column('status', String(20), nullable=False),
    Column('created_at', Integer, nullable=False),
    Column('cancelled_at', Integer),
    Column('idempotency_key', String(100), nullable=False),
    Column('request_hash', String(64), nullable=False),
    UniqueConstraint('user_id', 'idempotency_key'),
    CheckConstraint("status IN ('Confirmed', 'Cancelled')"),
    CheckConstraint('seat_count = 1'))
Index('ix_trips_route_departure', trips.c.route_id, trips.c.departure_at)
Index('ix_trips_bus_departure', trips.c.bus_id, trips.c.departure_at)
Index('ix_bookings_user_created', bookings.c.user_id, bookings.c.created_at)
Index('ix_bookings_created', bookings.c.created_at)
Index('ix_bookings_trip_status', bookings.c.trip_id, bookings.c.status)

# One customer can keep one checkout seat on hold at a time. Holds are deleted
# when they are confirmed, released, or expire, so the unique user constraint
# also prevents concurrent checkout tabs from reserving multiple seats.
seat_holds = Table('seat_holds', metadata,
    Column('id', String(36), primary_key=True),
    Column('user_id', ForeignKey('users.id'), nullable=False, unique=True),
    Column('trip_id', ForeignKey('trips.id'), nullable=False),
    Column('price_paise', Integer, nullable=False),
    Column('created_at', Integer, nullable=False),
    Column('expires_at', Integer, nullable=False),
    CheckConstraint('price_paise > 0'),
    CheckConstraint('expires_at > created_at'))
Index('ix_seat_holds_trip', seat_holds.c.trip_id)
Index('ix_seat_holds_expires', seat_holds.c.expires_at)

# Version-two checkout holds can contain several seats. The older seat_holds
# table remains readable so existing databases can be migrated safely.
checkout_holds = Table('checkout_holds', metadata,
    Column('id', String(36), primary_key=True),
    Column('user_id', ForeignKey('users.id'), nullable=False, unique=True),
    Column('trip_id', ForeignKey('trips.id'), nullable=False),
    Column('price_paise', Integer, nullable=False),
    Column('created_at', Integer, nullable=False),
    Column('expires_at', Integer, nullable=False),
    CheckConstraint('price_paise > 0'),
    CheckConstraint('expires_at > created_at'))
checkout_hold_seats = Table('checkout_hold_seats', metadata,
    Column('hold_id', ForeignKey('checkout_holds.id', ondelete='CASCADE'), primary_key=True),
    Column('trip_id', ForeignKey('trips.id'), nullable=False),
    Column('seat_id', ForeignKey('bus_seats.id'), primary_key=True),
    UniqueConstraint('trip_id', 'seat_id'))
Index('ix_checkout_holds_expires', checkout_holds.c.expires_at)
Index('ix_checkout_hold_seats_trip', checkout_hold_seats.c.trip_id)

bus_seats = Table('bus_seats', metadata,
    Column('id', Integer, primary_key=True),
    Column('bus_id', ForeignKey('buses.id'), nullable=False),
    Column('label', String(12), nullable=False),
    Column('deck', String(10), nullable=False),
    Column('row_index', Integer, nullable=False),
    Column('column_index', Integer, nullable=False),
    Column('seat_type', String(10), nullable=False),
    UniqueConstraint('bus_id', 'label'),
    UniqueConstraint('bus_id', 'deck', 'row_index', 'column_index'),
    CheckConstraint("deck IN ('Lower', 'Upper')"),
    CheckConstraint("seat_type IN ('Seat', 'Sleeper')"),
    CheckConstraint('row_index BETWEEN 0 AND 39'),
    CheckConstraint('column_index BETWEEN 0 AND 5'))
Index('ix_bus_seats_bus', bus_seats.c.bus_id)

# The composite primary key guarantees that one physical seat can have only
# one active hold or confirmed booking for a particular departure.
trip_seat_assignments = Table('trip_seat_assignments', metadata,
    Column('trip_id', ForeignKey('trips.id'), primary_key=True),
    Column('seat_id', ForeignKey('bus_seats.id'), primary_key=True),
    Column('hold_id', ForeignKey('seat_holds.id', ondelete='CASCADE'), unique=True),
    Column('booking_id', ForeignKey('bookings.id'), unique=True),
    Column('state', String(10), nullable=False),
    Column('expires_at', Integer),
    CheckConstraint("state IN ('Held', 'Booked')"),
    CheckConstraint("(state = 'Held' AND hold_id IS NOT NULL AND booking_id IS NULL AND expires_at IS NOT NULL) OR "
                    "(state = 'Booked' AND booking_id IS NOT NULL AND hold_id IS NULL AND expires_at IS NULL)"))
Index('ix_trip_seat_assignments_hold', trip_seat_assignments.c.hold_id)
Index('ix_trip_seat_assignments_booking', trip_seat_assignments.c.booking_id)

# Keep the displayed seat on historical and cancelled tickets after its active
# assignment is released or a booking is moved to another departure.
booking_seat_history = Table('booking_seat_history', metadata,
    Column('booking_id', ForeignKey('bookings.id'), primary_key=True),
    Column('trip_id', ForeignKey('trips.id'), nullable=False),
    Column('seat_id', Integer),
    Column('seat_label', String(12), nullable=False),
    Column('deck', String(10), nullable=False),
    Column('seat_type', String(10), nullable=False))
Index('ix_booking_seat_history_trip', booking_seat_history.c.trip_id)

booking_groups = Table('booking_groups', metadata,
    Column('id', String(36), primary_key=True),
    Column('user_id', ForeignKey('users.id'), nullable=False),
    Column('idempotency_key', String(100), nullable=False),
    Column('request_hash', String(64), nullable=False),
    Column('created_at', Integer, nullable=False),
    UniqueConstraint('user_id', 'idempotency_key'))
booking_group_members = Table('booking_group_members', metadata,
    Column('group_id', ForeignKey('booking_groups.id'), primary_key=True),
    Column('booking_id', ForeignKey('bookings.id'), primary_key=True),
    Column('passenger_order', Integer, nullable=False),
    UniqueConstraint('booking_id'),
    UniqueConstraint('group_id', 'passenger_order'))
Index('ix_booking_group_members_group', booking_group_members.c.group_id)

# Additive tables: existing buses, trips and booking records are never rebuilt.
ratings = Table('ratings', metadata,
    Column('booking_id', ForeignKey('bookings.id'), primary_key=True),
    Column('bus_id', ForeignKey('buses.id'), nullable=False),
    Column('user_id', ForeignKey('users.id'), nullable=False),
    Column('stars', Integer, nullable=False),
    Column('comment', String(1000), nullable=False),
    Column('updated_at', Integer, nullable=False),
    CheckConstraint('stars BETWEEN 1 AND 5'))
Index('ix_ratings_bus', ratings.c.bus_id)
booking_changes = Table('booking_changes', metadata,
    Column('id', Integer, primary_key=True),
    Column('booking_id', ForeignKey('bookings.id'), nullable=False),
    Column('user_id', ForeignKey('users.id'), nullable=False),
    Column('from_trip_id', ForeignKey('trips.id'), nullable=False),
    Column('to_trip_id', ForeignKey('trips.id'), nullable=False),
    Column('old_price_paise', Integer, nullable=False),
    Column('new_price_paise', Integer, nullable=False),
    Column('created_at', Integer, nullable=False),
    Column('idempotency_key', String(100), nullable=False),
    Column('request_hash', String(64), nullable=False),
    UniqueConstraint('user_id', 'idempotency_key'))
Index('ix_booking_changes_booking', booking_changes.c.booking_id)
Index('ix_booking_changes_from_trip', booking_changes.c.from_trip_id)
Index('ix_booking_changes_to_trip', booking_changes.c.to_trip_id)
trip_cancellations = Table('trip_cancellations', metadata,
    Column('trip_id', ForeignKey('trips.id'), primary_key=True),
    Column('reason', String(300), nullable=False),
    Column('cancelled_at', Integer, nullable=False))
weekly_schedules = Table('weekly_schedules', metadata,
    Column('id', Integer, primary_key=True),
    Column('bus_id', ForeignKey('buses.id'), nullable=False),
    Column('start_date', String(10), nullable=False),
    Column('end_date', String(10), nullable=False),
    Column('departure_day', Integer, nullable=False),
    Column('departure_time', String(5), nullable=False),
    Column('arrival_day', Integer, nullable=False),
    Column('arrival_time', String(5), nullable=False),
    Column('created_at', Integer, nullable=False))
schedule_departures = Table('schedule_departures', metadata,
    Column('trip_id', ForeignKey('trips.id'), primary_key=True),
    Column('schedule_id', ForeignKey('weekly_schedules.id'), nullable=False))


def make_engine(url=None):
    url = url or os.getenv('DATABASE_URL', 'sqlite:///./data/ticketing.db')
    if url.startswith('sqlite:///') and ':memory:' not in url:
        Path(url.removeprefix('sqlite:///')).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args={'check_same_thread': False, 'timeout': 30}
                           if url.startswith('sqlite') else {}, pool_pre_ping=True)
    if url.startswith('sqlite'):
        @event.listens_for(engine, 'connect')
        def configure_sqlite(connection, _):
            cursor = connection.cursor()
            cursor.execute('PRAGMA foreign_keys=ON')
            cursor.execute('PRAGMA journal_mode=WAL')
            cursor.close()
    return engine
