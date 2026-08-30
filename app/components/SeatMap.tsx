'use client';

import { TripSeat } from '../lib/api';

export default function SeatMap({
  seats,
  selectedId,
  selectedIds,
  onSelect,
}: {
  seats: TripSeat[];
  selectedId: number | null;
  selectedIds?: number[];
  onSelect: (seat: TripSeat) => void;
}) {
  const decks = (['Lower', 'Upper'] as const).filter((deck) =>
    seats.some((seat) => seat.deck === deck),
  );
  return (
    <div className="seat-map-wrap">
      <div className="seat-legend" aria-label="Seat status legend">
        <span><i className="seat-swatch available" />Available</span>
        <span><i className="seat-swatch selected" />Selected</span>
        <span><i className="seat-swatch unavailable" />Unavailable</span>
      </div>
      <div className={`seat-decks ${decks.length > 1 ? 'two-decks' : ''}`}>
        {decks.map((deck) => {
          const deckSeats = seats.filter((seat) => seat.deck === deck);
          const rows = Math.max(...deckSeats.map((seat) => seat.row_index), 0) + 1;
          return (
            <section className="seat-deck" key={deck} aria-label={`${deck} deck seats`}>
              <div className="seat-deck-heading">
                <strong>{decks.length > 1 ? `${deck} deck` : 'Choose your seat'}</strong>
                {deck === 'Lower' && <span className="driver-mark">Driver</span>}
              </div>
              <div className="seat-grid">
                {Array.from({ length: rows }).flatMap((_, row) =>
                  Array.from({ length: 5 }).map((__, column) => {
                    const seat = deckSeats.find(
                      (item) => item.row_index === row && item.column_index === column,
                    );
                    if (!seat)
                      return <span className={`seat-space ${column === 2 ? 'aisle' : ''}`} key={`${row}-${column}`} />;
                    const selected = selectedIds?.includes(seat.id) || selectedId === seat.id;
                    const unavailable = seat.status !== 'Available' && !selected;
                    return (
                      <button
                        type="button"
                        key={seat.id}
                        className={`seat-button ${seat.seat_type.toLowerCase()} ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`}
                        disabled={unavailable}
                        aria-pressed={selected}
                        aria-label={`Seat ${seat.label}, ${selected ? 'selected' : seat.status.toLowerCase()}`}
                        onClick={() => onSelect(seat)}
                      >
                        {seat.label}
                      </button>
                    );
                  }),
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
