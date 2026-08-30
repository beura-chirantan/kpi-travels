'use client';

import { useState } from 'react';
import { Bus, BusRevenue, money } from '../lib/api';
import { RatingBadge } from './CitySelect';
import BusReviewsDialog from './BusReviewsDialog';

export default function BusRevenueList({
  buses,
  allowReviews = true,
}: {
  buses: BusRevenue[];
  allowReviews?: boolean;
}) {
  const [reviewBus, setReviewBus] = useState<Bus | null>(null);
  return (
    <>
      {buses.length ? (
        <div className="bus-revenue-list">
          {buses.map((bus) => (
            <article className="panel bus-revenue-card" key={bus.id}>
              <div>
                <h3>{bus.name}</h3>
                <p>{bus.registration}</p>
              </div>
              <div className="bus-revenue-amount">
                <strong>{money(bus.revenue_paise)}</strong>
                <span>
                  {bus.ticket_count} {bus.ticket_count === 1 ? 'ticket' : 'tickets'}
                </span>
              </div>
              <div className="bus-revenue-rating">
                <RatingBadge average={bus.average_rating} count={bus.rating_count} />
                {allowReviews && (
                  <button className="text-button" onClick={() => setReviewBus(bus)}>
                    Read reviews
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p>No buses added yet.</p>
      )}
      {reviewBus && <BusReviewsDialog bus={reviewBus} onClose={() => setReviewBus(null)} />}
    </>
  );
}
