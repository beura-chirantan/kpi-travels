import type { Criteria } from './api';

export type AssistantIntent = 'search' | 'book' | 'cancel' | 'bookings' | 'question';

const cityAliases: Record<string, string> = {
  hyd: 'Hyderabad',
  hydrabad: 'Hyderabad',
  hyderbad: 'Hyderabad',
  blr: 'Bangalore',
  bengaluru: 'Bangalore',
  banglore: 'Bangalore',
  mum: 'Mumbai',
  bom: 'Mumbai',
  bombay: 'Mumbai',
  chn: 'Chennai',
};

function includesTerm(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function mentionedCityCount(text: string, cities: string[]) {
  const found = new Set<string>();
  cities.forEach((city) => {
    if (includesTerm(text, city)) found.add(city.toLowerCase());
  });
  Object.entries(cityAliases).forEach(([alias, city]) => {
    if (
      cities.some((known) => known.toLowerCase() === city.toLowerCase()) &&
      includesTerm(text, alias)
    )
      found.add(city.toLowerCase());
  });
  return found.size;
}

export function hasExplicitRoute(text: string, cities: string[]) {
  return mentionedCityCount(text, cities) >= 2;
}

export function assistantIntent(
  message: string,
  cities: string[],
  criteria: Criteria | null = null,
): AssistantIntent {
  const text = message.toLowerCase();
  if (
    /\b(cancel|delete)\b.*\b(my|booking|ticket|reservation)\b|\b(cancel|delete)\s+[a-f0-9]{4,}/i.test(
      message,
    )
  )
    return 'cancel';
  if (
    /\b(show|list|view|find)\b.*\b(my )?(booking|ticket|reservation)s?\b|\bmy bookings?\b/i.test(
      message,
    )
  )
    return 'bookings';
  if (
    /^(?:can you\s+)?(?:book|reserve)(?:\s+(?:it|this|the\s+bus|a\s+ticket))?[.!?]*$/i.test(
      message.trim(),
    ) ||
    (!/^(?:how|what|why|can|could|is)\b/i.test(message.trim()) &&
      /\b(?:book|reserve)\b.*\b(?:bus|ticket|seat|it|express|connect|sleeper|comfort)\b/i.test(
        message,
      ))
  )
    return 'book';
  const namedCities = mentionedCityCount(text, cities);
  const hasJourney = Boolean(criteria?.origin || criteria?.destination || criteria?.travel_date);
  const needsDate = Boolean(criteria?.clarification?.toLowerCase().includes('travel date'));
  const dateFragment =
    needsDate &&
    (/^\s*[0-3]?\d(?:st|nd|rd|th)?\s*$/i.test(message) ||
      /^\s*\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\s*$/.test(message) ||
      /^\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*$/i.test(
        message,
      ));
  const explanatoryQuestion = /^(?:what (?:is|does)|why|how (?:do|does|can|is|are))\b/.test(text);
  const journeyFollowUp =
    hasJourney &&
    !explanatoryQuestion &&
    (/^(?:same|again|repeat|use the same)(?:\s+(?:route|search|trip|bus|details))?[.!?]*$/i.test(
      message.trim(),
    ) ||
      /\b(?:today|tomorrow|day after tomorrow|morning|afternoon|evening|night|non[ -]?ac|ac|sleeper)\b/i.test(
        message,
      ) ||
      /\b(?:under|below|less than|max(?:imum)?|cheaper|earlier|later)\b/i.test(message) ||
      /\b(?:above|over|more than|at least|min(?:imum)?)\b/i.test(message) ||
      /\b(?:next|earliest)\s+(?:available\s+)?bus\b/i.test(message) ||
      /\b(?:what about|how about|show me|make it|change it|instead)\b/i.test(message) ||
      /\b(?:other|another|different)\s+bus(?:es)?\b/i.test(message) ||
      /\b(?:doesn'?t matter|does not matter|no preference|any time)\b/i.test(message) ||
      /^(?:no|none|nope)[.!?]*$/i.test(message.trim()) ||
      /\b[0-3]?\d(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(
        message,
      ) ||
      dateFragment);
  if (
    namedCities >= 2 ||
    journeyFollowUp ||
    /\b(find|search|show)\b.*\bbus(?:es|ses)?\b|\bbus\s+from\b|\btravel\s+from\b/i.test(message)
  )
    return 'search';
  return 'question';
}

export function contextualSearch(message: string, criteria: Criteria | null, cities: string[]) {
  if (!criteria) return message;
  const text = message.toLowerCase();
  const namedCities = mentionedCityCount(text, cities);
  if (namedCities >= 2) return message;
  const allBuses = /\b(?:all|any)\s+bus(?:es)?\b|\bno\s+(?:bus\s+)?preference\b/.test(text);
  const noPreferences = /^(?:no|none|nope)[.!?]*$/.test(text.trim());
  const wantsNext = /\b(?:next|earliest)\s+(?:available\s+)?bus\b/.test(text);
  const anyTime =
    /\b(?:any time|all times?|doesn'?t matter|does not matter|no time preference|time (?:is|does) not (?:matter|an issue)|regardless of time)\b/.test(
      text,
    );
  const noBudget = /\b(?:any price|no budget|budget (?:is|does) not (?:matter|an issue))\b/.test(
    text,
  );
  const hasDate =
    /\b(?:today|tomorrow|day after tomorrow|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?|[0-3]?\d(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/.test(
      text,
    );
  const hasType = /\b(?:non[ -]?ac|ac|sleeper)\b/.test(text);
  const hasTime =
    /\b(?:morning|afternoon|evening|night)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|to|until)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(
      text,
    );
  const hasBudget =
    /\b(?:under|below|less than|max(?:imum)?|above|over|more than|at least|min(?:imum)?)\b/.test(
      text,
    );
  const context = [
    criteria.origin && `from ${criteria.origin}`,
    criteria.destination && `to ${criteria.destination}`,
    !hasDate && !wantsNext && criteria.travel_date && `on ${criteria.travel_date}`,
    !hasType && !allBuses && !noPreferences && criteria.bus_type && `${criteria.bus_type} required`,
    !hasType &&
      !allBuses &&
      !noPreferences &&
      criteria.preferred_type &&
      `prefer ${criteria.preferred_type}`,
    !hasTime && !anyTime && !allBuses && !noPreferences && criteria.time_of_day,
    !hasTime &&
      !anyTime &&
      !allBuses &&
      !noPreferences &&
      criteria.departure_after &&
      `depart after ${criteria.departure_after}`,
    !hasTime &&
      !anyTime &&
      !allBuses &&
      !noPreferences &&
      criteria.departure_before &&
      `depart before ${criteria.departure_before}`,
    !hasTime &&
      !anyTime &&
      !allBuses &&
      !noPreferences &&
      criteria.arrival_time_of_day &&
      `arrive ${criteria.arrival_time_of_day}`,
    !hasBudget &&
      !noBudget &&
      !allBuses &&
      !noPreferences &&
      criteria.min_price &&
      `above ₹${criteria.min_price}`,
    !hasBudget &&
      !noBudget &&
      !allBuses &&
      !noPreferences &&
      criteria.max_price &&
      `under ₹${criteria.max_price}`,
    !allBuses &&
      !noPreferences &&
      criteria.exclude_bus_name &&
      `excluding ${criteria.exclude_bus_name}`,
  ]
    .filter(Boolean)
    .join(' ');
  return context ? `${context}. ${message}` : message;
}

export function passengerNameFromReply(message: string) {
  return message.replace(/^\s*(?:my\s+name\s+is|name\s*(?:is|:))\s*/i, '').trim();
}

export function passengerAgeFromReply(message: string) {
  return message.match(/\b(\d{1,3})\b/)?.[1] || '';
}

export function passengerPhoneFromReply(message: string) {
  return message.match(/\+?[0-9][0-9 -]{8,18}/)?.[0]?.trim() || '';
}

export function criteriaSummary(criteria: Criteria) {
  return [
    criteria.origin && criteria.destination && `${criteria.origin} to ${criteria.destination}`,
    criteria.travel_date && `on ${criteria.travel_date}`,
    criteria.bus_type || (criteria.preferred_type && `prefer ${criteria.preferred_type}`),
    criteria.time_of_day && `${criteria.time_of_day} departure`,
    criteria.departure_after && criteria.departure_before
      ? `${criteria.departure_after}–${criteria.departure_before} departure`
      : criteria.departure_after
        ? `after ${criteria.departure_after}`
        : criteria.departure_before && `before ${criteria.departure_before}`,
    criteria.arrival_time_of_day && `${criteria.arrival_time_of_day} arrival`,
    criteria.min_price && `₹${criteria.min_price} or more`,
    criteria.max_price && `up to ₹${criteria.max_price}`,
    criteria.exclude_bus_name && `excluding ${criteria.exclude_bus_name}`,
    criteria.next_available && 'next available departure',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function bookingReference(message: string) {
  return (
    message.match(/(?:#|booking|ticket|reference)\s*#?\s*([a-f0-9]{4,8})\b/i)?.[1]?.toLowerCase() ||
    ''
  );
}

export function validPassenger(name: string, age: string, phone: string) {
  const normalizedPhone = phone.replace(/[ -]/g, '').replace(/^\+/, '');
  const numberAge = Number(age);
  if (name.trim().length < 2) return 'Enter the passenger’s full name.';
  if (!Number.isInteger(numberAge) || numberAge < 1 || numberAge > 120)
    return 'Enter an age from 1 to 120.';
  if (
    !/^\+?[0-9][0-9 -]{8,18}$/.test(phone) ||
    normalizedPhone.length < 10 ||
    normalizedPhone.length > 15
  )
    return 'Enter a valid phone number with 10 to 15 digits.';
  return '';
}
