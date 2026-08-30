'use client';

import { useState } from 'react';

export default function CitySelect({
  label,
  value,
  cities,
  onChange,
  allowCustom = false,
}: {
  label: string;
  value: string;
  cities: string[];
  onChange: (city: string) => void;
  allowCustom?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const options = [...new Set([...cities, ...(value ? [value] : [])])].sort();
  return (
    <div className="city-field">
      <label>
        {label}
        <select
          required
          value={custom ? '__new__' : value}
          onChange={(event) => {
            const isNew = event.target.value === '__new__';
            setCustom(isNew);
            onChange(isNew ? '' : event.target.value);
          }}
        >
          <option value="">Select city</option>
          {options.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
          {allowCustom && <option value="__new__">+ Add another city</option>}
        </select>
      </label>
      {custom && (
        <label>
          New {label.toLowerCase()} city
          <input
            required
            minLength={2}
            maxLength={80}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Enter city name"
          />
        </label>
      )}
    </div>
  );
}

export function RatingBadge({ average, count }: { average: number | null; count: number }) {
  return (
    <span className="badge rating-badge">
      {count > 0 && average !== null
        ? `★ ${average.toFixed(1)} / 5 · ${count} ${count === 1 ? 'rating' : 'ratings'}`
        : 'No ratings yet'}
    </span>
  );
}
