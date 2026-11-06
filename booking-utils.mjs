export const CONVENIENCE_FEE_LABEL = 'Convenience Fee';
export const MAX_COURT_BOOKING_HOURS = 8;
export const BOOKING_TOKEN_KEY = 'courtlyBookingAccessTokensV1';

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
