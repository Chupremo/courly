export const CONVENIENCE_FEE_LABEL = 'Convenience Fee';
export const MAX_COURT_BOOKING_HOURS = 8;
export const BOOKING_TOKEN_KEY = 'courtlyBookingAccessTokensV1';
export const CHECKOUT_CONTRACT_VERSION = 1;
export const CHECKOUT_REQUEST_KEY = 'courtlyCheckoutRequestsV1';

export function requireBookingReadiness(value) {
  if (value?.version !== CHECKOUT_CONTRACT_VERSION || value.ready !== true
      || value.court_holds !== true || value.open_play_holds !== true
      || value.idempotent_submission !== true || value.server_pricing !== true) {
    throw new Error('Reservations are temporarily unavailable. Please do not transfer money. Try again later or contact the venue.');
  }
  return value;
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const checkoutMemory = new Map();
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

// Persist the key before the first network request. A timeout is an unknown
// outcome, never permission to create a second booking with a new key.
export function checkoutRequestKey(selection, { fresh = false, stores, randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
  const fingerprint = JSON.stringify([selection.playerId, selection.venueSlug, selection.kind,
    selection.kind === 'court' ? [selection.courtId, Date.parse(selection.startsAt), Number(selection.durationHours)] : selection.eventId]);
  stores ??= [browserStorage('localStorage'), browserStorage('sessionStorage')];
  const saved = new Map(checkoutMemory);
  for (const storage of stores) {
    try {
      const entries = JSON.parse(storage?.getItem(CHECKOUT_REQUEST_KEY) || '[]');
      if (Array.isArray(entries)) entries.forEach((entry) => {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && uuidPattern.test(entry[1])) saved.set(entry[0], entry[1]);
      });
    } catch { /* Server recovery remains available when browser storage is blocked. */ }
  }
  let key = fresh ? null : saved.get(fingerprint);
  if (!key) key = randomUUID();
  if (!uuidPattern.test(key)) throw new Error('A secure checkout request could not be created. Please reload and try again.');
  saved.delete(fingerprint);
  saved.set(fingerprint, key);
  checkoutMemory.set(fingerprint, key);
  for (const storage of stores) {
    try { storage?.setItem(CHECKOUT_REQUEST_KEY, JSON.stringify([...saved].slice(-60))); } catch { /* Optional recovery cache. */ }
  }
  return key;
}

export function normalizeCheckoutHold(value, expected = {}, receivedAt = monotonicNow()) {
  const fail = () => { throw new Error('The reservation response could not be verified. Do not pay again. Reload to recover the checkout or contact the venue.'); };
  if (!value || value.version !== CHECKOUT_CONTRACT_VERSION || !uuidPattern.test(value.hold_id)
      || !uuidPattern.test(value.player_id) || !['court', 'openplay'].includes(value.kind)
      || !['held', 'expired', 'submitted', 'confirmed', 'cancelled', 'rejected', 'refunded'].includes(value.status)
      || !Number.isFinite(Date.parse(value.expires_at)) || !Number.isFinite(Date.parse(value.server_now))
      || !Number.isFinite(Date.parse(value.starts_at))
      || !value.reference || !value.venue_slug || typeof value.receipt_prefix !== 'string' || !value.receipt_prefix.endsWith('/')
      || (expected.kind && value.kind !== expected.kind)
      || (expected.playerId && value.player_id !== expected.playerId)
      || (expected.holdId && value.hold_id !== expected.holdId)
      || (expected.courtId && value.court_id !== expected.courtId)
      || (expected.eventId && value.event_id !== expected.eventId)
      || (expected.startsAt && Date.parse(value.starts_at) !== Date.parse(expected.startsAt))) fail();
  const numeric = (field) => {
    if (value[field] === null || value[field] === undefined || String(value[field]).trim() === '') fail();
    const number = Number(value[field]);
    if (!Number.isFinite(number) || number < 0) fail();
    return number;
  };
  const subtotal = numeric('subtotal'), fee = numeric('convenience_fee'), total = numeric('total');
  if (Math.abs(subtotal + fee - total) > 0.005
      || (value.kind === 'court' && (!uuidPattern.test(value.booking_id) || !uuidPattern.test(value.court_id)
        || !uuidPattern.test(value.customer_access_token) || fee !== 0 || value.fee_payer !== 'venue_owner'))
      || (value.kind === 'openplay' && (!uuidPattern.test(value.event_id) || fee !== (subtotal > 0 ? 10 : 0) || value.fee_payer !== (subtotal > 0 ? 'player' : 'none')))) fail();
  return { ...value, subtotal, convenience_fee: fee, total, checkedAt: receivedAt };
}

// Use server time plus monotonic elapsed time. A player's incorrect wall clock
// cannot extend the displayed hold, and the server still enforces every expiry.
export function holdRemainingMs(hold, now = monotonicNow()) {
  if (!hold || hold.status !== 'held') return 0;
  const remaining = Date.parse(hold.expires_at) - Date.parse(hold.server_now) - Math.max(0, now - hold.checkedAt);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

// An empty select is an incomplete selection, never midnight.
export function selectedHour(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : null;
}

export function validCourtRange(start, end, hours = null) {
  return Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && start < 24 && end <= 24 && end > start
    && end - start <= MAX_COURT_BOOKING_HOURS
    && (!hours || (hours.includes(start) && hours.includes(end)));
}

function clockMinutes(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function courtSubtotal(court, start, end, peakStart, peakEnd) {
  if (!court || !validCourtRange(start, end)) return 0;
  const hasRate = (value) => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '';
  const offPeakValue = [court.off_peak_rate, court.hourly_rate].find(hasRate);
  if (offPeakValue === undefined) throw new Error('This court’s price is unavailable. Please contact the venue.');
  const offPeak = Number(offPeakValue);
  const peak = Number(hasRate(court.peak_rate) ? court.peak_rate : offPeak);
  if (!Number.isFinite(offPeak) || !Number.isFinite(peak) || offPeak < 0 || peak < 0) {
    throw new Error('This court’s price is unavailable. Please contact the venue.');
  }
  const from = clockMinutes(peakStart);
  const to = clockMinutes(peakEnd);
  let total = 0;
  for (let hour = start; hour < end; hour += 1) {
    const minute = hour * 60;
    const isPeak = from !== null && to !== null && from !== to
      && (from < to ? minute >= from && minute < to : minute >= from || minute < to);
    total += isPeak ? peak : offPeak;
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

export function openPlayAmounts(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) throw new Error('This session’s price is unavailable. Please contact the venue.');
  const registration = Math.max(0, amount);
  const fee = registration > 0 ? 10 : 0;
  return { registration, fee, total: registration + fee, free: registration === 0 };
}

export function bookingStatus(booking) {
  if (booking.status === 'cancelled') return { state: 'cancelled', label: 'Cancelled' };
  if (booking.status === 'rejected') return { state: 'rejected', label: 'Booking rejected' };
  if (booking.status === 'expired') return { state: 'expired', label: 'Expired' };
  if (booking.payment_status === 'rejected') return { state: 'rejected', label: 'Payment rejected' };
  if (booking.payment_status === 'confirmed') return { state: 'confirmed', label: 'Confirmed' };
  if (booking.payment_status === 'awaiting_verification') {
    return { state: 'awaiting', label: 'Reserved · Awaiting owner verification' };
  }
  return { state: 'unpaid', label: 'Booking request created · Receipt needed' };
}

// Ignore results belonging to a previous date/filter or an abandoned view.
export function requestSequence() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (request) => request === latest
  };
}

// Acquire before the first await so rapid taps cannot start two mutations.
export function submissionGuard() {
  let active = false;
  return {
    get busy() { return active; },
    start() {
      if (active) return false;
      active = true;
      return true;
    },
    finish() { active = false; }
  };
}

export function validateReceipt(file, maxMegabytes, allowedTypes) {
  if (!file || !allowedTypes.includes(file.type)) throw new Error('Choose a payment receipt in one of the supported file formats.');
  if (file.size > maxMegabytes * 1024 * 1024) throw new Error(`Payment receipt must be ${maxMegabytes} MB or smaller.`);
  if (file.size === 0) throw new Error('The selected receipt is empty. Please choose another file.');
}

export function readBookingTokens(...stores) {
  const tokens = new Set();
  for (const storage of stores) {
    try {
      const saved = JSON.parse(storage?.getItem(BOOKING_TOKEN_KEY) || '[]');
      if (Array.isArray(saved)) {
        saved.forEach((token) => {
          if (typeof token === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) tokens.add(token);
        });
      }
    } catch { /* Another available browser storage can still contain the key. */ }
  }
  return [...tokens];
}

export function browserStorage(name) {
  try { return globalThis[name]; } catch { return null; }
}

export function saveBookingToken(token) {
  const stores = [browserStorage('localStorage'), browserStorage('sessionStorage')];
  const tokens = readBookingTokens(...stores);
  if (!tokens.includes(token)) tokens.push(token);
  for (const storage of stores) {
    try {
      if (!storage) continue;
      storage.setItem(BOOKING_TOKEN_KEY, JSON.stringify(tokens.slice(-100)));
      return true;
    } catch { /* Try session storage if persistent storage is unavailable. */ }
  }
  return false;
}
