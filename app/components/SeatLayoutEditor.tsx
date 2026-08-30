'use client';

import { useState } from 'react';
import { BusType, SeatDefinition } from '../lib/api';
import { LayoutTemplate, makeLayout, relabelLayout } from '../lib/seats';

export default function SeatLayoutEditor({
  layout,
  template,
  busType,
  onChange,
  onTemplateChange,
}: {
  layout: SeatDefinition[];
  template: LayoutTemplate;
  busType: BusType;
  onChange: (layout: SeatDefinition[]) => void;
  onTemplateChange: (template: LayoutTemplate) => void;
}) {
  const [deck, setDeck] = useState<'Lower' | 'Upper'>('Lower');
  const shownDeck = template === 'sleeper_2x1' || template === 'custom' ? deck : 'Lower';
  const deckSeats = layout.filter((seat) => seat.deck === shownDeck);
  const maxRow = Math.max(...deckSeats.map((seat) => seat.row_index), 2);
  const rows = Math.min(25, maxRow + (template === 'custom' ? 2 : 1));

  function chooseTemplate(next: LayoutTemplate) {
    onTemplateChange(next);
    if (next === 'custom') return;
    const count = Math.max(1, layout.length);
    onChange(makeLayout(next, count));
    setDeck('Lower');
  }

  function toggle(row: number, column: number) {
    if (template !== 'custom' || column === 2) return;
    const existing = layout.find(
      (seat) => seat.deck === deck && seat.row_index === row && seat.column_index === column,
    );
    if (existing) {
      if (layout.length === 1) return;
      onChange(relabelLayout(layout.filter((seat) => seat !== existing)));
    } else if (layout.length < 100) {
      onChange(
        relabelLayout([
          ...layout,
          {
            label: '',
            deck,
            row_index: row,
            column_index: column,
            seat_type: busType === 'Sleeper' ? 'Sleeper' : 'Seat',
          },
        ]),
      );
    }
  }

  return (
    <section className="layout-editor" aria-labelledby="layout-editor-heading">
      <div className="layout-editor-heading">
        <div>
          <h3 id="layout-editor-heading">Seat arrangement</h3>
          <p>{layout.length} seats in this bus</p>
        </div>
        <label>
          Layout
          <select
            value={template}
            onChange={(event) => chooseTemplate(event.target.value as LayoutTemplate)}
          >
            <option value="seater_2x2">Seater · 2 + 2</option>
            <option value="seater_2x1">Seater · 2 + 1</option>
            <option value="sleeper_2x1">Sleeper · lower and upper</option>
            <option value="custom">Custom arrangement</option>
          </select>
        </label>
      </div>
      {(template === 'sleeper_2x1' || template === 'custom') && (
        <div className="segmented layout-deck-switch" aria-label="Choose deck to edit">
          {(['Lower', 'Upper'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={deck === value}
              onClick={() => setDeck(value)}
            >
              {value} deck
            </button>
          ))}
        </div>
      )}
      <div className="layout-bus-shell">
        <div className="seat-deck-heading">
          <strong>{shownDeck} deck</strong>
          {shownDeck === 'Lower' && <span className="driver-mark">Driver</span>}
        </div>
        <div className="seat-grid admin-seat-grid">
          {Array.from({ length: rows }).flatMap((_, row) =>
            Array.from({ length: 5 }).map((__, column) => {
              const seat = deckSeats.find(
                (item) => item.row_index === row && item.column_index === column,
              );
              if (column === 2)
                return <span className="seat-space aisle" key={`${row}-${column}`} />;
              return (
                <button
                  type="button"
                  key={`${row}-${column}`}
                  className={`seat-button ${seat ? seat.seat_type.toLowerCase() : 'empty-seat'} ${template === 'custom' ? 'editable' : ''}`}
                  disabled={template !== 'custom'}
                  aria-label={
                    seat
                      ? `Seat ${seat.label}${template === 'custom' ? ', click to remove' : ''}`
                      : `Empty position${template === 'custom' ? ', click to add a seat' : ''}`
                  }
                  onClick={() => toggle(row, column)}
                >
                  {seat?.label || (template === 'custom' ? '+' : '')}
                </button>
              );
            }),
          )}
        </div>
      </div>
      <p className="small-note">
        {template === 'custom'
          ? 'Click a position to add or remove a seat. The middle space is the aisle.'
          : 'Choose the number of seats above and this arrangement is created automatically.'}
      </p>
    </section>
  );
}
