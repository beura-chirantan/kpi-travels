from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BusType = Literal['AC', 'Non-AC', 'Sleeper']
SeatDeck = Literal['Lower', 'Upper']
SeatType = Literal['Seat', 'Sleeper']


class Input(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')


class LoginInput(Input):
    email: str = Field(min_length=3, max_length=160)
    password: str = Field(min_length=1, max_length=200)


class ProfileInput(Input):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=160,
                       pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    phone: str | None = Field(default=None, min_length=9, max_length=20,
                              pattern=r'^\+?[0-9][0-9 -]{8,18}$')

    @field_validator('email')
    @classmethod
    def normalize_email(cls, value):
        return value.lower()


class SeatInput(Input):
    label: str = Field(min_length=1, max_length=12, pattern=r'^[A-Za-z0-9-]+$')
    deck: SeatDeck = 'Lower'
    row_index: int = Field(ge=0, le=39, strict=True)
    column_index: int = Field(ge=0, le=5, strict=True)
    seat_type: SeatType = 'Seat'

    @field_validator('label')
    @classmethod
    def normalize_label(cls, value):
        return value.upper()


class BusInput(Input):
    name: str = Field(min_length=2, max_length=100)
    registration: str = Field(min_length=3, max_length=30)
    bus_type: BusType
    total_seats: int = Field(ge=1, le=100)
    layout: list[SeatInput] | None = Field(default=None, min_length=1, max_length=100)

    @field_validator('registration')
    @classmethod
    def normalize_registration(cls, value):
        return value.upper()

    @model_validator(mode='after')
    def valid_layout(self):
        if self.layout is None:
            return self
        if len({seat.label for seat in self.layout}) != len(self.layout):
            raise ValueError('Every seat must have a different label.')
        positions = {(seat.deck, seat.row_index, seat.column_index) for seat in self.layout}
        if len(positions) != len(self.layout):
            raise ValueError('Two seats cannot use the same layout position.')
        return self


class TripInput(Input):
    bus_id: int = Field(gt=0)
    origin: str = Field(min_length=2, max_length=80)
    destination: str = Field(min_length=2, max_length=80)
    departure_at: datetime
    arrival_at: datetime
    price: Decimal = Field(gt=0, le=100000, decimal_places=2)
    active: bool = True

    @field_validator('departure_at', 'arrival_at')
    @classmethod
    def require_timezone(cls, value):
        if value.tzinfo is None:
            raise ValueError('Include a timezone in departure and arrival times.')
        return value

    @model_validator(mode='after')
    def validate_journey(self):
        if self.origin.casefold() == self.destination.casefold():
            raise ValueError('Origin and destination must be different.')
        if self.arrival_at <= self.departure_at:
            raise ValueError('Arrival must be after departure.')
        return self


class BookingInput(Input):
    trip_id: int = Field(gt=0)
    hold_id: str | None = Field(default=None, min_length=36, max_length=36)
    passenger_name: str = Field(min_length=2, max_length=100)
    passenger_age: int = Field(ge=1, le=120)
    phone: str = Field(pattern=r'^\+?[0-9][0-9 -]{8,18}$')
    expected_price_paise: int = Field(gt=0)

    @field_validator('phone')
    @classmethod
    def validate_phone_digits(cls, value):
        normalized = value.replace(' ', '').replace('-', '')
        if not 10 <= len(normalized.lstrip('+')) <= 15:
            raise ValueError('Phone number must contain 10 to 15 digits.')
        return normalized


class SeatHoldInput(Input):
    trip_id: int = Field(gt=0)
    seat_id: int | None = Field(default=None, gt=0)
    seat_ids: list[int] | None = Field(default=None, min_length=1, max_length=6)
    expected_price_paise: int = Field(gt=0)

    @model_validator(mode='after')
    def valid_seats(self):
        if self.seat_id is not None and self.seat_ids is not None:
            raise ValueError('Send seat_id or seat_ids, not both.')
        if self.seat_ids is not None and (len(set(self.seat_ids)) != len(self.seat_ids)
                                          or any(seat <= 0 for seat in self.seat_ids)):
            raise ValueError('Choose different valid seats.')
        return self


class GroupPassengerInput(Input):
    seat_id: int = Field(gt=0)
    passenger_name: str = Field(min_length=2, max_length=100)
    passenger_age: int = Field(ge=1, le=120)


class GroupBookingInput(Input):
    trip_id: int = Field(gt=0)
    hold_id: str = Field(min_length=36, max_length=36)
    passengers: list[GroupPassengerInput] = Field(min_length=1, max_length=6)
    phone: str = Field(pattern=r'^\+?[0-9][0-9 -]{8,18}$')
    expected_price_paise: int = Field(gt=0)

    @field_validator('phone')
    @classmethod
    def validate_phone_digits(cls, value):
        normalized = value.replace(' ', '').replace('-', '')
        if not 10 <= len(normalized.lstrip('+')) <= 15:
            raise ValueError('Phone number must contain 10 to 15 digits.')
        return normalized

    @model_validator(mode='after')
    def different_seats(self):
        if len({passenger.seat_id for passenger in self.passengers}) != len(self.passengers):
            raise ValueError('Each passenger needs a different seat.')
        return self


class RescheduleInput(Input):
    trip_id: int = Field(gt=0)
    seat_id: int | None = Field(default=None, gt=0)
    expected_trip_id: int = Field(gt=0)
    expected_price_paise: int = Field(gt=0)


class RatingInput(Input):
    stars: int = Field(ge=1, le=5, strict=True)
    comment: str = Field(default='', max_length=1000)


class CancelTripInput(Input):
    reason: str = Field(min_length=3, max_length=300)


class WeeklyScheduleInput(Input):
    bus_id: int = Field(gt=0)
    origin: str = Field(min_length=2, max_length=80)
    destination: str = Field(min_length=2, max_length=80)
    start_date: date
    end_date: date
    departure_day: int = Field(ge=0, le=6)
    arrival_day: int = Field(ge=0, le=6)
    departure_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    arrival_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    price: Decimal = Field(gt=0, le=100000, decimal_places=2)

    @model_validator(mode='after')
    def valid_range(self):
        if self.end_date > date(9999, 12, 24):
            raise ValueError('Choose an earlier end date to allow the final arrival and weekly interval.')
        if not 0 <= (self.end_date-self.start_date).days <= 364:
            raise ValueError('Choose an end date within 52 weeks of the start date.')
        if self.origin.casefold() == self.destination.casefold():
            raise ValueError('Origin and destination must be different.')
        if self.departure_day == self.arrival_day and self.arrival_time <= self.departure_time:
            raise ValueError('For an overnight journey, choose the next arrival day.')
        return self


class WeekdayPrice(Input):
    day: int = Field(ge=0, le=6, strict=True)
    price: Decimal = Field(gt=0, le=100000, decimal_places=2)


class MultiDayScheduleInput(Input):
    bus_id: int = Field(gt=0)
    origin: str = Field(min_length=2, max_length=80)
    destination: str = Field(min_length=2, max_length=80)
    start_date: date
    end_date: date
    days: list[WeekdayPrice] = Field(min_length=1, max_length=7)
    departure_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    arrival_time: str = Field(pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    arrival_day_offset: int = Field(ge=0, le=6, strict=True)

    @model_validator(mode='after')
    def valid_plan(self):
        if len({entry.day for entry in self.days}) != len(self.days):
            raise ValueError('Choose each weekday only once.')
        # Apply the same date, route and overnight rules as existing single-day plans.
        first = self.days[0]
        WeeklyScheduleInput(bus_id=self.bus_id, origin=self.origin, destination=self.destination,
            start_date=self.start_date, end_date=self.end_date, departure_day=first.day,
            arrival_day=(first.day+self.arrival_day_offset) % 7,
            departure_time=self.departure_time, arrival_time=self.arrival_time, price=first.price)
        return self


class SearchQuery(Input):
    query: str = Field(min_length=3, max_length=500)


class AssistantTurn(Input):
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=500)


class AssistantQuestion(Input):
    query: str = Field(min_length=2, max_length=500)
    history: list[AssistantTurn] = Field(default_factory=list, max_length=8)


class SearchCriteria(Input):
    origin: str | None = None
    destination: str | None = None
    travel_date: date | None = None
    time_of_day: Literal['morning', 'afternoon', 'evening', 'night'] | None = None
    departure_after: str | None = Field(default=None, pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    departure_before: str | None = Field(default=None, pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    arrival_time_of_day: Literal['morning', 'afternoon', 'evening', 'night'] | None = None
    bus_type: BusType | None = None
    preferred_type: BusType | None = None
    min_price: int | None = Field(default=None, gt=0, le=100000)
    max_price: int | None = Field(default=None, gt=0, le=100000)
    exclude_bus_name: str | None = Field(default=None, min_length=2, max_length=100)
    next_available: bool = False
    clarification: str | None = None

    @model_validator(mode='after')
    def valid_price_range(self):
        if self.min_price and self.max_price and self.min_price > self.max_price:
            raise ValueError('Minimum fare cannot be greater than maximum fare.')
        return self
