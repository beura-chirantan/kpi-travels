import { SeatDefinition } from './api';

export type LayoutTemplate = 'seater_2x2' | 'seater_2x1' | 'sleeper_2x1' | 'custom';

const columns = {
  seater_2x2: [0, 1, 3, 4],
  seater_2x1: [0, 1, 4],
  sleeper_2x1: [0, 1, 4],
};

export function relabelLayout(layout: SeatDefinition[]) {
  return [...layout]
    .sort((a, b) =>
      a.deck.localeCompare(b.deck) ||
      a.row_index - b.row_index ||
      a.column_index - b.column_index,
    )
    .map((seat, index) => ({ ...seat, label: String(index + 1), id: undefined }));
}

export function makeLayout(template: Exclude<LayoutTemplate, 'custom'>, count: number) {
  const safeCount = Math.max(1, Math.min(100, count));
  const result: SeatDefinition[] = [];
  if (template === 'sleeper_2x1') {
    const lower = Math.ceil(safeCount / 2);
    for (const [deck, deckCount] of [
      ['Lower', lower],
      ['Upper', safeCount - lower],
    ] as const) {
      for (let index = 0; index < deckCount; index += 1) {
        const perRow = columns.sleeper_2x1;
        result.push({
          label: '',
          deck,
          row_index: Math.floor(index / perRow.length),
          column_index: perRow[index % perRow.length],
          seat_type: 'Sleeper',
        });
      }
    }
  } else {
    const perRow = columns[template];
    for (let index = 0; index < safeCount; index += 1) {
      result.push({
        label: '',
        deck: 'Lower',
        row_index: Math.floor(index / perRow.length),
        column_index: perRow[index % perRow.length],
        seat_type: 'Seat',
      });
    }
  }
  return relabelLayout(result);
}

export function inferTemplate(layout: SeatDefinition[], busType: string): LayoutTemplate {
  if (!layout.length) return busType === 'Sleeper' ? 'sleeper_2x1' : 'seater_2x2';
  if (layout.some((seat) => seat.deck === 'Upper' || seat.seat_type === 'Sleeper'))
    return 'sleeper_2x1';
  const used = new Set(layout.map((seat) => seat.column_index));
  if (![...used].every((column) => [0, 1, 3, 4].includes(column))) return 'custom';
  return used.has(3) && !used.has(4) ? 'custom' : used.has(3) ? 'seater_2x2' : 'seater_2x1';
}
