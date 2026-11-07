import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  requireBookingReadiness, normalizeCheckoutHold, holdRemainingMs,
  checkoutRequestKey, CHECKOUT_REQUEST_KEY, submissionGuard, validateReceipt
} from '../booking-utils.mjs';

const venue = await readFile(new URL('../venue.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/202611060005_booking_checkout_holds.sql', import.meta.url), 'utf8');
const ids = Object.fromEntries(['player','hold','court','booking','event','registration','token'].map((name, index) => [name, `${index + 1}1111111-1111-4111-8111-111111111111`]));
const readiness = { version: 1, ready: true, court_holds: true, open_play_holds: true, idempotent_submission: true, server_pricing: true };
function slice(start, end) {
  const a = venue.indexOf(start), b = venue.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return venue.slice(a, b);
}
function hold(overrides = {}) {
  return {
    version: 1, hold_id: ids.hold, player_id: ids.player, kind: 'court', booking_id: ids.booking,
    court_id: ids.court, court_name: 'Court 1', venue_slug: 'test-venue', venue_name: 'Test Venue',
    reference: 'CT-TEST', status: 'held', payment_status: 'unpaid',
    starts_at: '2030-11-08T02:00:00Z', ends_at: '2030-11-08T04:00:00Z', duration_hours: 2,
    subtotal: 700, convenience_fee: 0, owner_fee: 10, total: 700, fee_payer: 'venue_owner',
    server_now: '2030-11-07T00:00:00Z', expires_at: '2030-11-07T00:20:00Z',
    customer_access_token: ids.token, receipt_prefix: `test-venue/${ids.booking}/${ids.hold}/`,
    payment_qr_url: 'https://example.invalid/qr.png', payment_account: 'Test Venue',
    player_name: 'Test Player', player_email: 'player@example.invalid', player_phone: '',
    ...overrides
  };
}
function openPlayHold(overrides = {}) {
  return hold({ kind: 'openplay', booking_id: null, court_id: null, customer_access_token: null,
    event_id: ids.event, event_title: 'Open Play', subtotal: 150, convenience_fee: 10, total: 160,
    fee_payer: 'player', receipt_prefix: `test-venue/open-play/${ids.event}/${ids.hold}/`, ...overrides });
}
function deferred() {
  let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve };
}
function flow({ kind = 'court', initialHold = null, free = false, rpc, auth, upload } = {}) {
  const nodes = {
    playerName: { value: 'Test Player', setCustomValidity() {} },
    playerEmail: { value: 'player@example.invalid' }, playerPhone: { value: '' },
    gcashForm: { reportValidity: () => true }, paymentSubmitButton: {},
    paymentScreenshot: { files: [] }
  };
  const details = kind === 'court'
    ? { kind, playerId: ids.player, court: { id: ids.court }, range: { start: '2030-11-08T02:00:00Z' }, startHour: 10, endHour: 12, amounts: { total: 700, free: false } }
    : { kind, playerId: ids.player, event: { id: ids.event }, amounts: { total: free ? 0 : 160, free } };
  if (initialHold) details.hold = normalizeCheckoutHold(initialHold);
  const calls = [], errors = [], completed = [], rendered = [], uploads = [];
  const context = vm.createContext({
    checkout: details, recoverableHold: null, slug: 'test-venue',
    paymentSubmission: submissionGuard(), $: (id) => nodes[id],
    checkoutError: (message = '') => { if (message) errors.push(message); },
    setPaymentBusy() {}, updateHoldPresentation() {}, updateSummary() {}, renderCheckoutRecovery() {},
    renderCheckout: (value) => rendered.push(value.hold),
    rememberBookingAccessToken: () => true,
    completeCheckout: (value) => completed.push(value.hold),
    paymentButtonLabel: () => 'Continue',
    requireBookingReadiness, normalizeCheckoutHold, holdRemainingMs, validateReceipt,
    checkoutRequestKey: (selection) => checkoutRequestKey(selection, { stores: [], randomUUID: () => ids.token }),
    receiptTypes: ['image/png'], uuid: () => ids.token, fileExtension: () => 'png',
    uploadReceipt: async (file, path) => { uploads.push(path); if (upload) return upload(file, path); },
    console: { warn() {} },
    supabase: {
      auth: { getUser: auth || (async () => ({ data: { user: { id: ids.player } }, error: null })) },
      rpc: async (name, args) => { calls.push({ name, args }); return rpc ? rpc(name, args) : { data: readiness, error: null }; }
    }
  });
  vm.runInContext(slice('async function checkBookingReadiness()', 'function checkoutSelection('), context);
  vm.runInContext(slice('function checkoutSelection(', 'function detailsFromHold('), context);
  vm.runInContext(slice('async function submitPayment(event)', 'async function loadVenueEvents()'), context);
  return { context, details, nodes, calls, errors, completed, rendered, uploads,
    submit: () => context.submitPayment({ preventDefault() {} }) };
}

test('a missing, old, or incomplete readiness contract never opens safe checkout', () => {
  for (const value of [null, {}, { ...readiness, version: 0 }, { ...readiness, ready: false }, { ...readiness, idempotent_submission: false }]) {
    assert.throws(() => requireBookingReadiness(value), /do not transfer money/i);
  }
  assert.equal(requireBookingReadiness(readiness), readiness);
});

test('hold contract rejects wrong ownership, wrong selection, missing prices, and player court surcharges', () => {
  assert.equal(normalizeCheckoutHold(hold()).total, 700);
  assert.equal(normalizeCheckoutHold(hold({ subtotal: 0, total: 0 })).total, 0);
  assert.throws(() => normalizeCheckoutHold(hold(), { playerId: ids.event }));
  assert.throws(() => normalizeCheckoutHold(hold(), { courtId: ids.event }));
  assert.throws(() => normalizeCheckoutHold(hold(), { startsAt: '2030-11-09T02:00:00Z' }));
  for (const value of [null, undefined, '', 'NaN', Infinity]) assert.throws(() => normalizeCheckoutHold(hold({ total: value })));
  assert.throws(() => normalizeCheckoutHold(hold({ convenience_fee: 20, total: 720 })));
  assert.throws(() => normalizeCheckoutHold(openPlayHold({ convenience_fee: 0, total: 150 })));
  assert.equal(normalizeCheckoutHold(openPlayHold({ subtotal: 0, convenience_fee: 0, total: 0, fee_payer: 'none' })).total, 0);
});

test('hold countdown follows server time and monotonic elapsed time', () => {
  const reservation = normalizeCheckoutHold(hold(), {}, 500);
  assert.equal(holdRemainingMs(reservation, 500), 20 * 60 * 1000);
  assert.equal(holdRemainingMs(reservation, 600500), 10 * 60 * 1000);
  assert.equal(holdRemainingMs(reservation, 1200500), 0);
  assert.equal(holdRemainingMs({ ...reservation, status: 'submitted' }, 500), 0);
});

test('request keys survive retry and timezone serialization, and rotate only on an explicit fresh request', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const selection = { playerId: ids.player, venueSlug: 'key-test', kind: 'court', courtId: ids.court, startsAt: '2030-11-08T02:00:00.000Z', durationHours: 2 };
  const first = checkoutRequestKey(selection, { stores: [storage], randomUUID: () => ids.hold });
  const retry = checkoutRequestKey({ ...selection, startsAt: '2030-11-08T02:00:00+00:00' }, { stores: [storage], randomUUID: () => { throw new Error('Must reuse'); } });
  assert.equal(first, retry);
  assert.ok(values.has(CHECKOUT_REQUEST_KEY));
  assert.notEqual(checkoutRequestKey(selection, { fresh: true, stores: [storage], randomUUID: () => ids.token }), first);
});

test('missing migration fails closed without creating a hold, uploading proof, or rendering a QR', async () => {
  const f = flow({ rpc: async () => ({ data: null, error: new Error('Function not found') }) });
  await f.submit();
  assert.deepEqual(f.calls.map((call) => call.name), ['courtly_booking_readiness']);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.match(f.errors[0], /do not transfer money/i);
});

test('paid court checkout obtains one server hold and authoritative price before requesting any receipt', async () => {
  const f = flow({ rpc: async (name) => ({ data: name === 'courtly_booking_readiness' ? readiness : hold({ subtotal: 800, total: 800 }), error: null }) });
  await f.submit();
  assert.deepEqual(f.calls.map((call) => call.name), ['courtly_booking_readiness', 'create_court_checkout_hold']);
  assert.equal(f.details.amounts.total, 800);
  assert.equal(f.details.hold.hold_id, ids.hold);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.completed.length, 0);
  assert.match(f.errors[0], /Review this amount before paying/);
});

test('rapid checkout taps while authentication is pending create just one hold request', async () => {
  const wait = deferred();
  const f = flow({ auth: () => wait.promise, rpc: async (name) => ({ data: name === 'courtly_booking_readiness' ? readiness : hold(), error: null }) });
  const first = f.submit(), second = f.submit();
  wait.resolve({ data: { user: { id: ids.player } }, error: null });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((call) => call.name === 'create_court_checkout_hold').length, 1);
  assert.equal(f.context.paymentSubmission.busy, false);
});

test('free Open Play confirms the held place with zero fee and no upload', async () => {
  const freeHold = openPlayHold({ subtotal: 0, convenience_fee: 0, total: 0, fee_payer: 'none' });
  const f = flow({ kind: 'openplay', free: true, rpc: async (name) => ({ data: name === 'courtly_booking_readiness' ? readiness
    : name === 'submit_checkout_hold' ? { ...freeHold, status: 'confirmed', payment_status: 'confirmed', registration_id: ids.registration } : freeHold, error: null }) });
  await f.submit();
  assert.deepEqual(f.calls.map((call) => call.name), ['courtly_booking_readiness', 'create_open_play_checkout_hold', 'submit_checkout_hold']);
  assert.equal(f.calls.at(-1).args.p_receipt_path, null);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.completed[0].registration_id, ids.registration);
  assert.equal(f.details.amounts.total, 0);
});

test('an uploaded receipt is recoverable after reload without selecting or uploading the image again', async () => {
  const path = `${hold().receipt_prefix}existing.png`;
  const recovered = hold({ uploaded_receipt_path: path });
  const f = flow({ initialHold: recovered, rpc: async (name) => ({ data: name === 'get_checkout_hold' ? recovered : { ...recovered, status: 'submitted', payment_status: 'awaiting_verification' }, error: null }) });
  await f.submit();
  assert.deepEqual(f.calls.map((call) => call.name), ['get_checkout_hold', 'submit_checkout_hold']);
  assert.equal(f.calls.at(-1).args.p_receipt_path, path);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.completed.length, 1);
});

test('a response lost after server commit is recovered as success without a new reservation or payment submission', async () => {
  let committed = false;
  const f = flow({ initialHold: hold(), rpc: async (name) => {
    if (name === 'get_checkout_hold') return { data: hold(committed ? { status: 'submitted', payment_status: 'awaiting_verification' } : {}), error: null };
    committed = true;
    return { data: null, error: new Error('Response lost after commit') };
  } });
  f.nodes.paymentScreenshot.files = [{ type: 'image/png', size: 50 }];
  await f.submit();
  assert.equal(f.details.hold.hold_id, ids.hold);
  await f.submit();
  assert.equal(f.calls.filter((call) => call.name === 'submit_checkout_hold').length, 1);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.completed.length, 1);
  assert.equal(f.calls.some((call) => /create_|cancel_/.test(call.name)), false);
});

test('an expired hold never uploads, creates a replacement, or asks for another payment automatically', async () => {
  const expired = hold({ status: 'expired' });
  const f = flow({ initialHold: expired, rpc: async () => ({ data: expired, error: null }) });
  await f.submit();
  assert.deepEqual(f.calls.map((call) => call.name), ['get_checkout_hold']);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.completed.length, 0);
  assert.match(f.errors[0], /contact the venue.*before paying again/i);
});

test('a stale hold refresh cannot restore payable UI after a later submission attempt', async () => {
  const pending = deferred();
  let renders = 0, applied = 0;
  const details = { hold: normalizeCheckoutHold(hold()), revision: 0 };
  const context = vm.createContext({ checkout: details, checkoutRefreshBusy: false,
    paymentSubmission: submissionGuard(), $: () => ({ hidden: false }), updateHoldPresentation() {},
    applyCheckoutHold: () => { applied += 1; }, renderCheckout: () => { renders += 1; },
    checkoutError() {}, supabase: { rpc: () => pending.promise }
  });
  vm.runInContext(slice('async function refreshCheckoutHold()', 'async function restoreCheckoutHold()'), context);
  const earlier = context.refreshCheckoutHold();
  details.revision += 1; // A submit starts while the availability response is in flight.
  details.hold.status = 'submitted';
  pending.resolve({ data: hold(), error: null });
  await earlier;
  assert.equal(applied, 0);
  assert.equal(renders, 0);
  assert.equal(details.hold.status, 'submitted');
});

test('payment rendering never uses public venue QR details before a verified hold exists', () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { children: [], replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
    return nodes.get(id);
  };
  const details = { kind: 'court', court: { name: 'Court 1' }, date: '2030-11-08', startHour: 10, endHour: 12, amounts: { registration: 700, fee: 0, total: 700, free: false } };
  const context = vm.createContext({ checkout: details, venue: { payment_qr_url: 'https://example.invalid/unsafe-before-hold.png' },
    $: get, setText: (id, text) => { get(id).textContent = text; }, money: String, dateLabel: String, formatHour: String,
    paymentButtonLabel: () => '', CONVENIENCE_FEE_LABEL: 'Convenience Fee', platformFee: () => 10, holdRemainingMs, updateHoldPresentation() {},
    slug: 'test-venue', URL, window: { location: { origin: 'https://example.invalid' } }, document: { createElement: () => ({}) } });
  vm.runInContext(slice('function renderCheckout(details', 'function updateHoldPresentation()'), context);
  context.renderCheckout(details);
  assert.equal(get('gcashQrWrap').children.length, 0);
  assert.equal(get('gcashRecipient').textContent, '');
  details.hold = normalizeCheckoutHold(hold());
  context.renderCheckout(details);
  assert.equal(get('gcashQrWrap').children[0].src, 'https://example.invalid/qr.png');
  details.hold.status = 'expired';
  context.renderCheckout(details);
  assert.equal(get('gcashQrWrap').children.length, 0);
});

function sqlFunction(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = migration.indexOf('$$;', start);
  assert.ok(end > start);
  return migration.slice(start, end);
}

test('SQL contract serializes court replacement and preserves the production exclusion constraint', () => {
  const sql = sqlFunction('create_court_checkout_hold');
  const lock = sql.indexOf("pg_advisory_xact_lock(hashtext('courtly-court')");
  const expiry = sql.indexOf("UPDATE public.bookings SET status='cancelled'");
  const insert = sql.indexOf('INSERT INTO public.bookings');
  assert.ok(lock >= 0 && lock < expiry && expiry < insert);
  assert.match(sql.slice(expiry, insert), /status='pending' AND payment_status='unpaid'[\s\S]*expires_at[\s\S]*<=clock_timestamp\(\)/);
  assert.doesNotMatch(migration, /DROP\s+CONSTRAINT[^;]*bookings_no_overlapping_active_slots/i);
  assert.match(migration, /courtly_block_capacity_guard BEFORE INSERT OR UPDATE/);
  assert.match(sqlFunction('attach_booking_receipt'), /pg_advisory_xact_lock[\s\S]*FOR UPDATE[\s\S]*already_submitted/);
});

test('SQL capacity counts active Open Play holds and converts exactly one registration at the held price', () => {
  const create = sqlFunction('create_open_play_checkout_hold');
  const lock = create.indexOf('pg_advisory_xact_lock'), count = create.indexOf('SELECT (SELECT count(*)'), insert = create.indexOf('INSERT INTO public.courtly_checkout_holds');
  assert.ok(lock >= 0 && lock < count && count < insert);
  assert.match(create.slice(count, insert), /registration_id IS NULL AND cancelled_at IS NULL AND expires_at>clock_timestamp\(\)/);
  const submit = sqlFunction('submit_checkout_hold');
  assert.ok(submit.indexOf('pg_advisory_xact_lock') < submit.indexOf('FOR UPDATE'));
  assert.ok(submit.indexOf('h.submitted_at IS NOT NULL') < submit.indexOf('h.expires_at<=clock_timestamp()'));
  assert.match(submit, /\(h.snapshot->>'subtotal'\)::numeric,\(h.snapshot->>'convenience_fee'\)::numeric/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS open_play_checkout_hold_unique/);
  assert.match(sqlFunction('get_open_play_registration_counts'), /courtly_checkout_holds[\s\S]*expires_at>statement_timestamp/);
});

test('Open Play checks owner eligibility before taking payment and honors only validated existing holds', () => {
  const create = sqlFunction('create_open_play_checkout_hold');
  assert.ok(create.indexOf('courtly_venue_terms_acceptance') < create.indexOf('INSERT INTO public.courtly_checkout_holds'));
  assert.match(create, /billing_status[\s\S]*suspended/);
  assert.match(migration, /WHEN \(NEW.checkout_hold_id IS NULL\) EXECUTE FUNCTION public.courtly_require_owner_terms_before_transaction/);
  const guard = sqlFunction('courtly_guard_open_play_capacity');
  assert.match(guard, /IF NEW.checkout_hold_id IS NOT NULL THEN[\s\S]*h.player_id=NEW.player_id[\s\S]*NEW.fee=\(h.snapshot->>'subtotal'\)::numeric[\s\S]*RAISE EXCEPTION/);
});

test('SQL idempotency aliases and private receipt ownership cannot be bypassed by old browser RPCs', () => {
  assert.match(migration, /PRIMARY KEY \(player_id,request_key\)/);
  const existing = sqlFunction('courtly_checkout_existing');
  assert.ok(existing.indexOf('pg_advisory_xact_lock') < existing.indexOf('SELECT h.*'));
  assert.match(existing, /fingerprint IS DISTINCT FROM p_fingerprint/);
  assert.match(existing, /Includes expired requests/);
  assert.match(migration, /REVOKE ALL ON public.courtly_checkout_holds,public.courtly_checkout_request_keys FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /p.proname IN \('create_booking_request','register_open_play_player','cancel_unpaid_booking_request'\)[\s\S]*REVOKE ALL ON FUNCTION/);
  const submit = sqlFunction('submit_checkout_hold');
  assert.match(submit, /player_id=auth.uid\(\)/);
  assert.match(submit, /starts_with\(p_receipt_path,h.snapshot->>'receipt_prefix'\)/);
  assert.match(submit, /owner_id[\s\S]*=auth.uid\(\)::text/);
  assert.match(migration, /CHECK\(transaction_fee_payer IN \('player','owner','venue_owner','none'\)\)/);
  assert.doesNotMatch(migration, /UPDATE public.open_play_registrations SET (?:fee|transaction_fee)/i);
});
