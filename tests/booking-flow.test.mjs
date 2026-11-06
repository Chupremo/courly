import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  selectedHour, validCourtRange, courtSubtotal, openPlayAmounts,
  bookingStatus, requestSequence, submissionGuard, validateReceipt,
  readBookingTokens, BOOKING_TOKEN_KEY
} from '../booking-utils.mjs';

const venueSource = await readFile(new URL('../venue.html', import.meta.url), 'utf8');
const coachSource = await readFile(new URL('../coach-booking.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'The tested application function must exist');
  return source.slice(from, to);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('empty time selections cannot become midnight or produce negative durations', () => {
  assert.equal(selectedHour(''), null);
  assert.equal(selectedHour('  '), null);
  assert.equal(selectedHour(null), null);
  assert.equal(selectedHour('0'), 0);
  assert.equal(validCourtRange(8, selectedHour('')), false);
  assert.equal(validCourtRange(10, 8), false);
  assert.equal(validCourtRange(8, 8), false);
  assert.equal(validCourtRange(8, 17), false);
  assert.equal(validCourtRange(8, 16, [8, 16]), true);
});

test('court subtotal preserves peak pricing and excludes the owner-paid fee', () => {
  const court = { off_peak_rate: 300, peak_rate: 450 };
  assert.equal(courtSubtotal(court, 17, 20, '18:00', '22:00'), 1200);
  assert.equal(courtSubtotal(court, 8, 10, '18:00', '22:00'), 600);
  assert.equal(courtSubtotal(court, 22, 24, '21:00', '06:00'), 900);
  assert.equal(courtSubtotal({ hourly_rate: 350 }, 8, 10, null, null), 700);
});

test('courts without a listed rate cannot silently become free bookings', () => {
  for (const court of [{}, { off_peak_rate: null, hourly_rate: undefined }, { off_peak_rate: '', hourly_rate: '  ' }]) {
    assert.throws(() => courtSubtotal(court, 8, 10, null, null), /price is unavailable/);
  }
  assert.equal(courtSubtotal({ off_peak_rate: 0, hourly_rate: 350 }, 8, 10, null, null), 0);
  assert.equal(courtSubtotal({ off_peak_rate: '0', hourly_rate: 350 }, 8, 10, null, null), 0);
  assert.equal(courtSubtotal({ off_peak_rate: '', hourly_rate: '350' }, 8, 10, null, null), 700);
});

test('paid Open Play adds exactly PHP 10 and free sessions remain free', () => {
  assert.deepEqual(openPlayAmounts(150), { registration: 150, fee: 10, total: 160, free: false });
  assert.deepEqual(openPlayAmounts(0), { registration: 0, fee: 0, total: 0, free: true });
  assert.throws(() => openPlayAmounts('invalid'));
});

test('cancelled bookings cannot be presented as confirmed payments or receipt submissions', () => {
  assert.equal(bookingStatus({ status: 'cancelled', payment_status: 'confirmed' }).state, 'cancelled');
  assert.equal(bookingStatus({ status: 'pending', payment_status: 'unpaid' }).state, 'unpaid');
  assert.equal(bookingStatus({ status: 'pending', payment_status: 'awaiting_verification' }).state, 'awaiting');
  assert.equal(bookingStatus({ status: 'confirmed', payment_status: 'confirmed' }).state, 'confirmed');
});

test('rejected and expired reservations override an old confirmed payment status', () => {
  assert.deepEqual(bookingStatus({ status: 'rejected', payment_status: 'confirmed' }), { state: 'rejected', label: 'Booking rejected' });
  assert.deepEqual(bookingStatus({ status: 'expired', payment_status: 'confirmed' }), { state: 'expired', label: 'Expired' });
  assert.equal(bookingStatus({ status: 'expired', payment_status: 'awaiting_verification' }).state, 'expired');
});

test('a late availability response cannot replace the selected date’s slots', async () => {
  const calls = [];
  const context = vm.createContext({
    venue: {}, slug: 'sample-venue', selectedDate: '2026-11-08', availabilityRequests: requestSequence(),
    availabilityLoading: false, availabilityError: '', availabilityDate: '', busySlots: [],
    selectedCourtId: null, localDateForSelection: (date) => date,
    getDateRange: (date) => ({ from: date, to: date }),
    refreshTimeSelects() {}, renderSlots() {}, renderCourts() {}, updateSummary() {},
    selectedRangeIso: () => null, hasConflict: () => false,
    console: { warn() {} },
    supabase: { rpc: () => { const call = deferred(); calls.push(call); return call.promise; } }
  });
  context.availabilityReady = () => !context.availabilityLoading && !context.availabilityError && context.availabilityDate === context.selectedDate;
  vm.runInContext(between(venueSource, 'async function loadAvailability()', 'function hasConflict('), context);
  const earlier = context.loadAvailability();
  context.selectedDate = '2026-11-09';
  const later = context.loadAvailability();
  calls[1].resolve({ data: [{ court_id: 'current-date-court' }], error: null });
  assert.equal(await later, true);
  calls[0].resolve({ data: [{ court_id: 'previous-date-court' }], error: null });
  assert.equal(await earlier, false);
  assert.equal(context.busySlots[0].court_id, 'current-date-court');
  assert.equal(context.availabilityDate, '2026-11-09');
});

test('availability failures keep checkout disabled instead of advertising free courts', async () => {
  const context = vm.createContext({
    venue: {}, slug: 'sample-venue', selectedDate: '2026-11-08', availabilityRequests: requestSequence(),
    availabilityLoading: false, availabilityError: '', availabilityDate: '2026-11-08',
    busySlots: [{ court_id: 'busy' }], selectedCourtId: null,
    localDateForSelection: (date) => date, getDateRange: (date) => ({ from: date, to: date }),
    refreshTimeSelects() {}, renderSlots() {}, renderCourts() {}, updateSummary() {},
    selectedRangeIso: () => null, hasConflict: () => false, console: { warn() {} },
    supabase: { rpc: async () => ({ data: null, error: new Error('Network offline') }) }
  });
  context.availabilityReady = () => !context.availabilityLoading && !context.availabilityError && context.availabilityDate === context.selectedDate;
  vm.runInContext(between(venueSource, 'async function loadAvailability()', 'function hasConflict('), context);
  assert.equal(await context.loadAvailability(), false);
  assert.equal(context.availabilityReady(), false);
  assert.notEqual(context.availabilityError, '');
  assert.equal(context.availabilityDate, '');
});

test('court end-time choices obey the existing backend eight-hour limit', () => {
  const inputs = { startTime: {}, endTime: {} };
  const context = vm.createContext({
    $: (id) => inputs[id], venueHours: Array.from({ length: 15 }, (_, i) => i + 8),
    selectedStart: 8, selectedEnd: null, selectedCourtId: null,
    isPastHour: () => false, availabilityReady: () => true, formatHour: String, MAX_COURT_BOOKING_HOURS: 8
  });
  vm.runInContext(between(venueSource, 'function refreshTimeSelects()', 'function renderCalendar()'), context);
  context.refreshTimeSelects();
  assert.match(inputs.endTime.innerHTML, /value="16"/);
  assert.doesNotMatch(inputs.endTime.innerHTML, /value="17"/);
});

test('rapid coach booking taps create one attempt while authentication is pending', async () => {
  const auth = deferred();
  const button = { disabled: false, textContent: '' };
  let authenticationCalls = 0;
  let mutationCalls = 0;
  const locked = [];
  const context = vm.createContext({
    booking: null, reservationSubmission: submissionGuard(),
    $: () => button, setSelectionLocked: (value) => locked.push(value),
    formSelection: () => ({ date: '2026-11-08', duration: 1, key: '2026-11-08:1' }),
    selected: { slot_start: '2026-11-08T01:00:00Z', slot_end: '2026-11-08T02:00:00Z' },
    selectionKey: '2026-11-08:1', coach: { coach_id: 'coach-1' },
    ensurePlayer: () => { authenticationCalls += 1; return auth.promise; },
    supabase: { rpc: async () => { mutationCalls += 1; return { data: null, error: new Error('Slot taken') }; } },
    loadSlots: async () => {}, showMessage() {}
  });
  vm.runInContext(between(coachSource, 'async function createBooking()', 'async function submitPayment('), context);
  const first = context.createBooking();
  const second = context.createBooking();
  assert.equal(authenticationCalls, 1);
  assert.equal(locked[0], true);
  auth.resolve({ id: 'player-1' });
  await Promise.all([first, second]);
  assert.equal(mutationCalls, 1);
  assert.equal(context.reservationSubmission.busy, false);
});

test('a successful Open Play registration stays successful when the list refresh fails', async () => {
  let refreshCount = 0;
  let confirmationCount = 0;
  const context = vm.createContext({
    recoverableHold: null,
    $: () => ({ hidden: false }),
    renderCheckoutRecovery() {},
    showOpenPlayConfirmation: () => { confirmationCount += 1; },
    loadVenueEvents: async () => { refreshCount += 1; throw new Error('Refresh offline'); },
    notifyCheckoutCommitted: async () => {},
    console: { warn() {} }
  });
  vm.runInContext(between(venueSource, 'function completeCheckout(', 'async function submitPayment(event)'), context);
  context.completeCheckout({ kind: 'openplay', amounts: { free: true }, hold: { status: 'confirmed', reference: 'OP-TEST' } });
  await Promise.resolve();
  assert.equal(confirmationCount, 1);
  assert.equal(refreshCount, 1);
  assert.equal(context.recoverableHold.reference, 'OP-TEST');
});

test('invalid receipt files are rejected before upload or booking creation', () => {
  assert.throws(() => validateReceipt({ type: 'text/html', size: 500 }, 100, ['image/png']));
  assert.throws(() => validateReceipt({ type: 'image/png', size: 101 * 1024 * 1024 }, 100, ['image/png']));
  assert.throws(() => validateReceipt({ type: 'image/png', size: 0 }, 100, ['image/png']));
  assert.doesNotThrow(() => validateReceipt({ type: 'image/png', size: 500 }, 100, ['image/png']));
});

test('saved booking keys tolerate blocked storage and ignore malformed entries', () => {
  const key = '12345678-1234-1234-1234-123456789abc';
  const blocked = { getItem() { throw new Error('Storage blocked'); } };
  const saved = { getItem: (name) => name === BOOKING_TOKEN_KEY ? JSON.stringify([null, 'invalid', key, key]) : null };
  assert.deepEqual(readBookingTokens(blocked, saved), [key]);
});

test('invalidating an old bookings refresh prevents removed private records reappearing', () => {
  const requests = requestSequence();
  const pendingRefresh = requests.next();
  requests.next(); // Forget this browser invalidates the pending response.
  assert.equal(requests.isCurrent(pendingRefresh), false);
});
