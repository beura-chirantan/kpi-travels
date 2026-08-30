"""Create a fictitious PDF ticket for visual QA, without reading customer records."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.tickets import ticket_pdf

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
args = parser.parse_args()
sample = {'id': '0f123456-7890-4abc-8def-012345678901', 'status': 'Confirmed',
    'passenger_name': 'Sample Traveller', 'passenger_age': 28, 'total_paise': 85000,
    'trip': {'origin': 'Hyderabad', 'destination': 'Bangalore', 'bus_name': 'KPi Night Express',
        'registration': 'TS09 AB1234', 'bus_type': 'Sleeper',
        'departure_at': '2026-09-06T22:00:00+05:30', 'arrival_at': '2026-09-07T06:00:00+05:30'}}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(ticket_pdf(sample, '2026-08-29T12:00:00+05:30'))
print(args.output)
