'use client';

import { useEffect, useRef, useState } from 'react';
import {
  api,
  Booking,
  BookingGroup,
  Criteria,
  dateLabel,
  downloadTicket,
  errorMessage,
  money,
  SearchResult,
  timeLabel,
  Trip,
  TripSeat,
  User,
} from '../lib/api';
import {
  assistantIntent,
  bookingReference,
  criteriaSummary,
  contextualSearch,
  hasExplicitRoute,
  passengerAgeFromReply,
  passengerNameFromReply,
  passengerPhoneFromReply,
  validPassenger,
} from '../lib/assistant';
import { holdTime, useSeatHold } from '../lib/seat-hold';
import { RatingBadge } from './CitySelect';
import { Notice } from './ui';
import SeatMap from './SeatMap';

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  trips?: Trip[];
  bookings?: Booking[];
  mode?: 'ai' | 'offline';
  private?: boolean;
};
type BookingStep = 'seat' | 'name' | 'age' | 'phone' | 'review' | null;
type AssistantPassenger = { name: string; age: string };
const welcome: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  text: 'Hi! Tell me where and when you want to travel. I can find a bus, answer travel questions, book up to 6 tickets together, show your bookings, or help you cancel one.',
};

export default function AssistantChat({
  cities,
  user,
  onSignIn,
}: {
  cities: string[];
  user: User | null;
  onSignIn: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcome]);
  const [input, setInput] = useState('');
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [loading, setLoading] = useState(false);
  const [bookingTrip, setBookingTrip] = useState<Trip | null>(null);
  const [bookingStep, setBookingStep] = useState<BookingStep>(null);
  const [passengers, setPassengers] = useState<Record<number, AssistantPassenger>>({});
  const [passengerIndex, setPassengerIndex] = useState(0);
  const [phone, setPhone] = useState('');
  const [bookingReview, setBookingReview] = useState(false);
  const [bookingError, setBookingError] = useState('');
  const [bookingSeats, setBookingSeats] = useState<TripSeat[]>([]);
  const [selectedSeats, setSelectedSeats] = useState<TripSeat[]>([]);
  const [seatsLoading, setSeatsLoading] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const requestKey = useRef('');
  const pendingSearch = useRef('');
  const waitingForLogin = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const seatHold = useSeatHold(
    bookingTrip,
    user?.role === 'customer' && selectedSeats.length > 0,
    selectedSeats.map((seat) => seat.id),
  );

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, loading, bookingTrip, bookingReview, cancelling]);
  function add(message: Omit<ChatMessage, 'id'>) {
    setMessages((current) => [...current, { ...message, id: crypto.randomUUID() }]);
  }
  function chooseTrip(trip: Trip) {
    setBookingTrip(trip);
    setBookingReview(false);
    setBookingError('');
    setBookingSeats([]);
    setSelectedSeats([]);
    setPassengers({});
    setPassengerIndex(0);
    setPhone('');
    setBookingStep('seat');
    requestKey.current = crypto.randomUUID();
    if (user?.role === 'customer') {
      add({ role: 'assistant', text: 'Choose up to 6 available seats, then select Continue.' });
    } else {
      waitingForLogin.current = true;
      add({
        role: 'assistant',
        text: 'Please sign in as a customer. Then I’ll ask for the passenger details.',
      });
      onSignIn();
    }
  }
  useEffect(() => {
    if (waitingForLogin.current && user?.role === 'customer' && bookingTrip) {
      waitingForLogin.current = false;
      add({ role: 'assistant', text: 'Choose up to 6 available seats, then select Continue.' });
    }
  }, [user, bookingTrip]);

  useEffect(() => {
    if (!bookingTrip || user?.role !== 'customer') return;
    let alive = true;
    Promise.resolve()
      .then(() => {
        if (!alive) return [];
        setSeatsLoading(true);
        return api<TripSeat[]>(`/trips/${bookingTrip.id}/seats`);
      })
      .then((result) => {
        if (alive) setBookingSeats(result);
      })
      .catch((reason) => {
        if (alive) setBookingError(errorMessage(reason));
      })
      .finally(() => {
        if (alive) setSeatsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bookingTrip, user]);

  function displayedTripFor(message: string) {
    const searchResults = [...messages].reverse().filter((item) => item.trips !== undefined);
    const allTrips = searchResults.flatMap((item) => item.trips || []);
    const lower = message.toLowerCase();
    const named = allTrips.find((trip) => lower.includes(trip.bus_name.toLowerCase()));
    if (named) return { trip: named, options: [] as Trip[] };
    const latest = searchResults[0]?.trips || [];
    return latest.length === 1
      ? { trip: latest[0], options: [] as Trip[] }
      : { trip: null, options: latest };
  }
  async function showBookings(cancelOnly: boolean, message: string) {
    if (user?.role !== 'customer') {
      add({
        role: 'assistant',
        text: 'Please sign in as a customer first. I’ll keep this chat ready for you.',
      });
      onSignIn();
      return;
    }
    const rows = await api<Booking[]>('/bookings');
    const ref = bookingReference(message);
    let visible = cancelOnly ? rows.filter((booking) => booking.can_cancel) : rows;
    if (ref) visible = visible.filter((booking) => booking.id.toLowerCase().startsWith(ref));
    add({
      role: 'assistant',
      text: visible.length
        ? cancelOnly
          ? 'Choose the ticket you want to cancel. I will ask you to confirm next.'
          : `Here ${visible.length === 1 ? 'is' : 'are'} your ${visible.length} booking${visible.length === 1 ? '' : 's'}.`
        : cancelOnly
          ? 'I could not find a future confirmed ticket that can be cancelled.'
          : 'You do not have any bookings yet.',
      bookings: visible,
    });
  }
  async function send(value = input) {
    const message = value.trim();
    if (!message || loading) return;
    setInput('');
    add({ role: 'user', text: message, private: Boolean(bookingTrip && bookingStep) });
    setLoading(true);
    try {
      if (bookingTrip && bookingStep) {
        if (/\b(?:never mind|stop|cancel booking|start over)\b/i.test(message)) {
          setBookingTrip(null);
          setBookingStep(null);
          setBookingReview(false);
          setSelectedSeats([]);
          setPassengers({});
          setPhone('');
          add({ role: 'assistant', text: 'Okay, I stopped this booking.' });
          return;
        }
        if (user?.role !== 'customer') {
          waitingForLogin.current = true;
          add({
            role: 'assistant',
            text: 'Please sign in as a customer before sharing passenger details.',
          });
          onSignIn();
          return;
        }
        if (bookingStep === 'seat') {
          add({
            role: 'assistant',
            text: 'Please choose up to 6 seats on the seat map, then select Continue.',
          });
          return;
        }
        if (bookingStep === 'name') {
          const seat = selectedSeats[passengerIndex];
          if (!seat) {
            setBookingStep('seat');
            add({ role: 'assistant', text: 'Please choose your seats first.' });
            return;
          }
          const name = passengerNameFromReply(message);
          if (name.length < 2) {
            add({ role: 'assistant', text: 'Please enter the passenger’s full name.' });
            return;
          }
          setPassengers((current) => ({
            ...current,
            [seat.id]: { name, age: current[seat.id]?.age || '' },
          }));
          setBookingStep('age');
          add({
            role: 'assistant',
            text: `What is ${name}’s age for seat ${seat.label}?`,
          });
          return;
        }
        if (bookingStep === 'age') {
          const seat = selectedSeats[passengerIndex];
          if (!seat) {
            setBookingStep('seat');
            add({ role: 'assistant', text: 'Please choose your seats first.' });
            return;
          }
          const age = passengerAgeFromReply(message);
          const numberAge = Number(age);
          if (!Number.isInteger(numberAge) || numberAge < 1 || numberAge > 120) {
            add({ role: 'assistant', text: 'Please enter an age from 1 to 120.' });
            return;
          }
          setPassengers((current) => ({
            ...current,
            [seat.id]: { name: current[seat.id]?.name || '', age },
          }));
          if (passengerIndex < selectedSeats.length - 1) {
            const nextIndex = passengerIndex + 1;
            const nextSeat = selectedSeats[nextIndex];
            setPassengerIndex(nextIndex);
            setBookingStep('name');
            add({
              role: 'assistant',
              text: `What is passenger ${nextIndex + 1}’s full name for seat ${nextSeat.label}?`,
            });
          } else {
            setBookingStep('phone');
            add({ role: 'assistant', text: 'What contact phone number should be used for all tickets?' });
          }
          return;
        }
        if (bookingStep === 'phone') {
          const parsedPhone = passengerPhoneFromReply(message);
          const firstPassenger = passengers[selectedSeats[0]?.id];
          const error = validPassenger(
            firstPassenger?.name || '',
            firstPassenger?.age || '',
            parsedPhone,
          );
          if (error) {
            add({ role: 'assistant', text: error });
            return;
          }
          setPhone(parsedPhone);
          setBookingStep('review');
          setBookingReview(true);
          add({
            role: 'assistant',
            text: `Please review all ${selectedSeats.length} ticket${selectedSeats.length === 1 ? '' : 's'} below. Type “confirm booking” or use the button to book and download the PDF ticket${selectedSeats.length === 1 ? '' : 's'}.`,
          });
          return;
        }
        if (/^(?:yes|confirm(?: booking)?|proceed|book it)[.!?]*$/i.test(message)) {
          await confirmBooking();
        } else {
          add({
            role: 'assistant',
            text: 'Type “confirm booking” to continue, or “cancel booking” to stop.',
          });
        }
        return;
      }
      const intent = assistantIntent(message, cities, criteria);
      if (intent === 'book') {
        const selected = displayedTripFor(message);
        if (selected.trip) chooseTrip(selected.trip);
        else if (selected.options.length) {
          add({
            role: 'assistant',
            text: 'Which bus should I book? Say the bus name, for example “Book KPi Express”.',
            trips: selected.options,
          });
        } else {
          add({
            role: 'assistant',
            text: 'Yes—I can complete the booking here and give you the PDF ticket. I need an available bus first, so search another route, date, or set of filters.',
          });
        }
      } else if (intent === 'cancel' || intent === 'bookings')
        await showBookings(intent === 'cancel', message);
      else if (intent === 'search') {
        const contextual = contextualSearch(message, criteria, cities);
        const query =
          pendingSearch.current && !hasExplicitRoute(message, cities)
            ? `${pendingSearch.current} ${message}`
            : contextual;
        const result = await api<SearchResult>('/search/natural', {
          method: 'POST',
          body: JSON.stringify({ query }),
        });
        pendingSearch.current = result.criteria.clarification ? query : '';
        setCriteria(result.criteria);
        const summary = criteriaSummary(result.criteria);
        add({
          role: 'assistant',
          mode: result.mode,
          text:
            result.criteria.clarification ||
            (result.trips.length
              ? `I found ${result.trips.length} available ${result.trips.length === 1 ? 'bus' : 'buses'}${summary ? ` for ${summary}` : ''}. They are ordered by rating, then preference and time.`
              : result.criteria.next_available
                ? `No future active buses are scheduled${result.criteria.origin && result.criteria.destination ? ` from ${result.criteria.origin} to ${result.criteria.destination}` : ''}. Try the reverse route or another route.`
                : `No available buses match${summary ? ` ${summary}` : ' those details'}. Try another date or remove a filter.`),
          trips: result.trips.slice(0, 5),
        });
      } else {
        const history = messages
          .filter((item) => item.id !== 'welcome' && !item.bookings?.length && !item.private)
          .slice(-8)
          .map((item) => ({ role: item.role, content: item.text }));
        const result = await api<{ answer: string; mode: 'ai' | 'offline' }>('/assistant/answer', {
          method: 'POST',
          body: JSON.stringify({ query: message, history }),
        });
        add({ role: 'assistant', text: result.answer, mode: result.mode });
      }
    } catch (error) {
      add({ role: 'assistant', text: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }
  async function confirmBooking() {
    if (!bookingTrip || user?.role !== 'customer') return;
    if (!seatHold.hold || seatHold.status !== 'active') {
      setBookingError('Your selected seats are not currently held. Hold them again before confirming.');
      return;
    }
    setLoading(true);
    setBookingError('');
    try {
      const group = await api<BookingGroup>('/booking-groups', {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey.current },
        body: JSON.stringify({
          trip_id: bookingTrip.id,
          hold_id: seatHold.hold.id,
          passengers: selectedSeats.map((seat) => ({
            seat_id: seat.id,
            passenger_name: passengers[seat.id]?.name || '',
            passenger_age: Number(passengers[seat.id]?.age),
          })),
          phone,
          expected_price_paise: bookingTrip.price_paise,
        }),
      });
      const pdfResults = await Promise.allSettled(
        group.bookings.map((booking) => downloadTicket(booking.id)),
      );
      const downloadedCount = pdfResults.filter((result) => result.status === 'fulfilled').length;
      add({
        role: 'assistant',
        text: `Booked ${group.ticket_count} ticket${group.ticket_count === 1 ? '' : 's'}! Your group reference is ${group.id.slice(0, 8).toUpperCase()}. ${downloadedCount === group.ticket_count ? `All ${group.ticket_count} PDF ticket${group.ticket_count === 1 ? ' has' : 's have'} been downloaded.` : `Downloaded ${downloadedCount} of ${group.ticket_count} PDFs. Use Download PDF below for any file your browser blocked.`}`,
        bookings: group.bookings,
      });
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          trips: message.trips?.map((trip) =>
            trip.id === bookingTrip.id
              ? {
                  ...trip,
                  available_seats: Math.max(0, trip.available_seats - group.ticket_count),
                }
              : trip,
          ),
        })),
      );
      setBookingTrip(null);
      setBookingStep(null);
      setBookingReview(false);
      setSelectedSeats([]);
      setPassengers({});
      setPassengerIndex(0);
      setPhone('');
      setBookingSeats([]);
    } catch (error) {
      setBookingError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  async function confirmCancellation() {
    if (!cancelling) return;
    setLoading(true);
    setBookingError('');
    try {
      const result = await api<Booking>(`/bookings/${cancelling.id}/cancel`, { method: 'POST' });
      add({
        role: 'assistant',
        text: `Booking ${result.id.slice(0, 8).toUpperCase()} is cancelled. The seat has been released.`,
        bookings: [result],
      });
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          trips: message.trips?.map((trip) =>
            trip.id === result.trip_id
              ? {
                  ...trip,
                  available_seats: Math.min(trip.total_seats, trip.available_seats + 1),
                }
              : trip,
          ),
          bookings: message.bookings?.map((booking) =>
            booking.id === result.id ? result : booking,
          ),
        })),
      );
      setCancelling(null);
    } catch (error) {
      setBookingError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  async function download(booking: Booking) {
    setDownloading(booking.id);
    try {
      await downloadTicket(booking.id);
      add({ role: 'assistant', text: 'Your PDF ticket has been downloaded.' });
    } catch (error) {
      add({ role: 'assistant', text: errorMessage(error) });
    } finally {
      setDownloading('');
    }
  }
  return (
    <div className="assistant-shell">
      <div className="assistant-quick-actions" aria-label="Common requests">
        {[
          'Find a bus',
          'Show my bookings',
          'Cancel my ticket',
          'What are the cancellation rules?',
        ].map((text) => (
          <button
            type="button"
            className="button secondary"
            key={text}
            disabled={loading}
            onClick={() => send(text)}
          >
            {text}
          </button>
        ))}
      </div>
      <div
        className="assistant-log"
        role="log"
        aria-live="polite"
        aria-label="Travel assistant conversation"
      >
        {messages.map((message) => (
          <div className={`chat-message ${message.role}`} key={message.id}>
            <div className="chat-bubble">
              <strong>{message.role === 'assistant' ? 'Travel assistant' : 'You'}</strong>
              <p>{message.text}</p>
              {message.role === 'assistant' && message.mode && (
                <small>
                  {message.mode === 'ai' ? 'Answered with AI' : 'Offline travel helper'}
                </small>
              )}
            </div>
            {message.trips?.map((trip) => (
              <article className="assistant-trip" key={trip.id}>
                <div>
                  <strong>{trip.bus_name}</strong>
                  <p>
                    {trip.origin} → {trip.destination}
                  </p>
                  <RatingBadge average={trip.average_rating} count={trip.rating_count} />
                </div>
                <div>
                  <strong>
                    {dateLabel(trip.departure_at)} · {timeLabel(trip.departure_at)}
                  </strong>
                  <p>
                    {trip.bus_type} · {trip.available_seats} seats left
                  </p>
                </div>
                <div>
                  <strong>{money(trip.price_paise)}</strong>
                  <button
                    type="button"
                    className="button"
                    disabled={loading}
                    onClick={() => chooseTrip(trip)}
                  >
                    Book this bus
                  </button>
                </div>
              </article>
            ))}
            {message.bookings?.map((booking) => (
              <article className="assistant-trip assistant-booking" key={booking.id}>
                <div>
                  <strong>#{booking.id.slice(0, 8).toUpperCase()}</strong>
                  <p>
                    {booking.trip.origin} → {booking.trip.destination}
                  </p>
                </div>
                <div>
                  <strong>
                    {dateLabel(booking.trip.departure_at)} · {timeLabel(booking.trip.departure_at)}
                  </strong>
                  <p>
                    {booking.passenger_name} ·{' '}
                    {booking.seat ? `Seat ${booking.seat.seat_label} · ` : ''}
                    {booking.status}
                  </p>
                </div>
                <div>
                  <strong>{money(booking.total_paise)}</strong>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={loading || downloading === booking.id}
                    onClick={() => download(booking)}
                  >
                    {downloading === booking.id ? 'Downloading…' : 'Download PDF'}
                  </button>
                  {booking.can_cancel && (
                    <button
                      type="button"
                      className="button secondary danger-outline"
                      disabled={loading}
                      onClick={() => {
                        setCancelling(booking);
                        setBookingError('');
                      }}
                    >
                      Cancel this ticket
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ))}
        {loading && (
          <div className="chat-message assistant">
            <div className="chat-bubble">
              <p>Checking…</p>
            </div>
          </div>
        )}
        {bookingTrip && user?.role === 'customer' && (
          <section className="assistant-action-card" aria-labelledby="assistant-booking-heading">
            <h3 id="assistant-booking-heading">
              {bookingReview
                ? `Confirm ${selectedSeats.length} ticket${selectedSeats.length === 1 ? '' : 's'}`
                : bookingStep === 'seat'
                  ? 'Choose seats'
                  : `Passenger ${Math.min(passengerIndex + 1, selectedSeats.length)} details`}
            </h3>
            <p>
              {bookingTrip.bus_name} · {bookingTrip.origin} → {bookingTrip.destination}
            </p>
            <p>
              {dateLabel(bookingTrip.departure_at)} · {timeLabel(bookingTrip.departure_at)} ·{' '}
              {money(bookingTrip.price_paise)}
            </p>
            {seatHold.status === 'active' && (
              <Notice tone="info">
                <strong>
                  Seats {seatHold.hold?.seats.map((seat) => seat.label).join(', ')} are held for you
                </strong>{' '}
                · Finish within{' '}
                <span className="hold-time" aria-live="polite">
                  {holdTime(seatHold.remaining)}
                </span>
                .
              </Notice>
            )}
            {seatHold.status === 'loading' && (
              <Notice tone="info">Holding {selectedSeats.length} selected seat(s) for you…</Notice>
            )}
            {(seatHold.status === 'error' || seatHold.status === 'expired') && (
              <Notice>
                {seatHold.error}{' '}
                <button type="button" className="text-button" onClick={seatHold.retry}>
                  Hold a seat again
                </button>
              </Notice>
            )}
            {!bookingReview ? (
              <>
                {bookingStep === 'seat' ? (
                  seatsLoading ? (
                    <p className="small-note">Loading the seat map…</p>
                  ) : bookingSeats.length ? (
                    <SeatMap
                      seats={bookingSeats}
                      selectedId={null}
                      selectedIds={selectedSeats.map((seat) => seat.id)}
                      onSelect={(seat) => {
                        const alreadySelected = selectedSeats.some((item) => item.id === seat.id);
                        if (!alreadySelected && selectedSeats.length >= 6) {
                          setBookingError('You can book up to 6 tickets at a time.');
                          return;
                        }
                        setSelectedSeats((current) =>
                          alreadySelected
                            ? current.filter((item) => item.id !== seat.id)
                            : [...current, seat],
                        );
                        if (alreadySelected)
                          setPassengers((current) => {
                            const next = { ...current };
                            delete next[seat.id];
                            return next;
                          });
                        requestKey.current = crypto.randomUUID();
                        setBookingError('');
                      }}
                    />
                  ) : (
                    <Notice>No seat layout is available for this bus.</Notice>
                  )
                ) : (
                  <>
                    <Notice tone="info">
                      Reply in chat with the passenger’s{' '}
                      {bookingStep === 'name'
                        ? 'full name'
                        : bookingStep === 'age'
                          ? 'age'
                          : 'phone number'}
                      .
                    </Notice>
                    {Object.keys(passengers).length > 0 && (
                      <dl className="assistant-review">
                        {selectedSeats.map((seat, index) => (
                          <div key={seat.id}>
                            <dt>
                              Passenger {index + 1} · Seat {seat.label}
                            </dt>
                            <dd>
                              {passengers[seat.id]?.name || 'Waiting for name'}
                              {passengers[seat.id]?.age
                                ? ` · Age ${passengers[seat.id].age}`
                                : ''}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </>
                )}
                <p className="small-note">
                  These passenger details go only to the booking service, not to AI.
                </p>
                <div className="modal-actions">
                  {bookingStep === 'seat' && (
                    <button
                      type="button"
                      className="button"
                      disabled={!selectedSeats.length || seatHold.status !== 'active'}
                      onClick={() => {
                        setPassengerIndex(0);
                        setBookingStep('name');
                        setPassengers({});
                        setPhone('');
                        setBookingError('');
                        const seats = selectedSeats.map((seat) => seat.label).join(', ');
                        add({
                          role: 'assistant',
                          text: `Seats ${seats} selected. What is passenger 1’s full name for seat ${selectedSeats[0].label}?`,
                        });
                      }}
                    >
                      Continue with {selectedSeats.length || 0} seat
                      {selectedSeats.length === 1 ? '' : 's'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setBookingTrip(null);
                      setBookingStep(null);
                      setSelectedSeats([]);
                      setPassengers({});
                      setPhone('');
                    }}
                  >
                    Stop booking
                  </button>
                </div>
              </>
            ) : (
              <>
                <dl className="assistant-review">
                  {selectedSeats.map((seat, index) => (
                    <div key={seat.id}>
                      <dt>
                        Passenger {index + 1} · Seat {seat.label}
                      </dt>
                      <dd>
                        {passengers[seat.id]?.name} · Age {passengers[seat.id]?.age} · {seat.deck}{' '}
                        deck
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Phone</dt>
                    <dd>{phone}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{money(bookingTrip.price_paise * selectedSeats.length)}</dd>
                  </div>
                </dl>
                <p className="small-note">
                  Your held seats become confirmed tickets when you confirm. No payment is collected
                  in this demo.
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={loading}
                    onClick={() => {
                      setBookingReview(false);
                      setBookingStep('name');
                      setPassengerIndex(0);
                      setPassengers({});
                      setPhone('');
                      requestKey.current = crypto.randomUUID();
                      add({
                        role: 'assistant',
                        text: `What is passenger 1’s full name for seat ${selectedSeats[0]?.label}?`,
                      });
                    }}
                  >
                    Edit details
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={loading || seatHold.status !== 'active'}
                    onClick={confirmBooking}
                  >
                    {loading
                      ? 'Booking…'
                      : `Confirm ${selectedSeats.length} ticket${selectedSeats.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </>
            )}
            {bookingError && <Notice>{bookingError}</Notice>}
          </section>
        )}
        {cancelling && (
          <section className="assistant-action-card" aria-labelledby="assistant-cancel-heading">
            <h3 id="assistant-cancel-heading">Cancel this ticket?</h3>
            <p>
              #{cancelling.id.slice(0, 8).toUpperCase()} · {cancelling.trip.origin} →{' '}
              {cancelling.trip.destination}
            </p>
            <p>
              {dateLabel(cancelling.trip.departure_at)} · {timeLabel(cancelling.trip.departure_at)}{' '}
              · {cancelling.passenger_name}
            </p>
            <Notice tone="info">
              The seat will be released immediately. This cannot be undone.
            </Notice>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={loading}
                onClick={() => setCancelling(null)}
              >
                Keep ticket
              </button>
              <button
                type="button"
                className="button danger"
                disabled={loading}
                onClick={confirmCancellation}
              >
                {loading ? 'Cancelling…' : 'Yes, cancel ticket'}
              </button>
            </div>
            {bookingError && <Notice>{bookingError}</Notice>}
          </section>
        )}
        <div ref={end} />
      </div>
      <div className="assistant-composer">
        <label htmlFor="assistant-message">Message Ask AI</label>
        <textarea
          id="assistant-message"
          rows={2}
          maxLength={500}
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Find an AC bus from Hyderabad to Bangalore tomorrow morning under ₹1,000"
        />
        <button
          type="button"
          className="button"
          disabled={loading || input.trim().length < (bookingStep ? 1 : 2)}
          onClick={() => send()}
        >
          {loading ? 'Working…' : 'Send →'}
        </button>
      </div>
      <p className="small-note">
        This chat remembers your route and recent messages while you stay on this page. AI can make
        mistakes, so always review the bus, passenger details, fare, and cancellation before
        confirming.
      </p>
    </div>
  );
}
