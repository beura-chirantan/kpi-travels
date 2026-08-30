'use client';

import { useEffect, useState } from 'react';
import { api, Bus, BusReview, dateLabel } from '../lib/api';
import { staffError } from '../lib/staff';
import { RatingBadge } from './CitySelect';
import { Modal, Notice } from './ui';

export default function BusReviewsDialog({ bus, onClose }: { bus: Bus; onClose: () => void }) {
  const [reviews, setReviews] = useState<BusReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api<BusReview[]>(`/admin/buses/${bus.id}/ratings`)
      .then((data) => {
        if (alive) setReviews(data);
      })
      .catch((error) => {
        if (alive) setError(staffError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bus.id]);
  const average = reviews.length
    ? reviews.reduce((sum, review) => sum + review.stars, 0) / reviews.length
    : null;
  return (
    <Modal title={`Customer reviews · ${bus.name}`} onClose={onClose}>
      <p>Bus number: {bus.registration}</p>
      <p>Reviews from passengers who have travelled on this bus, from all dates.</p>
      {!loading && !error && <RatingBadge average={average} count={reviews.length} />}
      {error && <Notice>{error}</Notice>}
      {loading ? (
        <p>Loading customer reviews…</p>
      ) : reviews.length ? (
        <div className="review-list">
          {reviews.map((review, index) => (
            <article className="booking-summary" key={index}>
              <strong>
                ★ {review.stars}/5 · {review.customer_name}
              </strong>
              <p>
                {review.origin} → {review.destination} · Travelled {dateLabel(review.departure_at)}
              </p>
              {review.comment && <p className="review-comment">{review.comment}</p>}
              <small>Updated {dateLabel(review.updated_at)}</small>
            </article>
          ))}
        </div>
      ) : (
        !error && <p>No reviews yet. Passengers can rate the bus after their trip.</p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
