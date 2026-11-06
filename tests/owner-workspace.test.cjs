const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const portalSource = fs.readFileSync(path.join(root, 'owner-portal.html'), 'utf8')
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace('\ninitializeOwnerPortal();', '');
const bridgeSource = fs.readFileSync(path.join(root, 'owner-portal-bridge.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export async function loadOwnerWorkspace', 'async function loadOwnerWorkspace');
const openPlaySource = fs.readFileSync(path.join(root, 'open-play-owner-sync.js'), 'utf8').replace(/^import .*;\n/gm, '');
const billingSource = fs.readFileSync(path.join(root, 'owner-billing.js'), 'utf8').replace(/^import .*;\n/gm, '');

function element() {
  return { textContent: '', innerHTML: '', dataset: {}, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }, focus() {} };
}
function environment({ demo = false, storage = new Map(), document: suppliedDocument } = {}) {
  const nodes = new Map(['content', 'toast', 'pageTitle', 'headerVenue', 'workspaceModeLabel', 'sidebarBrand', 'avatar'].map(id => [id, element()]));
  const document = suppliedDocument || { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [],
    querySelector: () => null, addEventListener() {}, visibilityState: 'visible' };
  const context = { document, URL, URLSearchParams, Date, Intl, structuredClone, Map, Set, Promise,
    dispatchBookingNotifications: async () => ({ status: 'unavailable', deliveries: [] }),
    console: { warn() {}, error() {}, info() {} },
    location: { search: demo ? '?demo=demo-lipa-pickleball-hub' : '', href: 'https://courtly.test/owner-portal.html', origin: 'https://courtly.test' },
    history: { pushState() {} }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    Event: class { constructor(type) { this.type = type; } }, CSS: { escape: value => String(value) },
    confirm: () => true, alert() {}, supabaseConfigError: 'Missing test configuration' };
  context.window = context;
  vm.createContext(context);
  return { context, nodes, storage };
}
function portal(options) {
  const env = environment(options);
  vm.runInContext(portalSource + '\nrender=()=>{}; workspaceReady=true;', env.context);
  return env;
}
function read(context, expression) { return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function queryService(handle) {
  const calls = [];
  return {
    calls,
    rpc: async () => ({ data: true, error: null }),
    from(table) {
      const call = { table, operation: 'select', filters: [] };
      const builder = {
        select() { return builder; }, single() { return builder; }, maybeSingle() { return builder; }, order() { return builder; },
        update(payload) { call.operation = 'update'; call.payload = payload; return builder; },
        upsert(payload) { call.operation = 'upsert'; call.payload = payload; return builder; },
        delete() { call.operation = 'delete'; return builder; },
        eq(key, value) { call.filters.push(['eq', key, value]); return builder; },
        in(key, value) { call.filters.push(['in', key, value]); return builder; },
        lt(key, value) { call.filters.push(['lt', key, value]); return builder; },
        gt(key, value) { call.filters.push(['gt', key, value]); return builder; },
        then(resolve, reject) { calls.push(call); return Promise.resolve(handle(call)).then(resolve, reject); }
      };
      return builder;
    }
  };
}

test('demo court approvals and cancellations persist locally without invoking live RPCs', async () => {
  const { context, storage } = portal({ demo: true });
  context.courtlyReviewBooking = context.courtlyCancelBooking = () => { throw new Error('Live RPC must not run in a demo'); };
  await vm.runInContext('confirmPay("CT-DEMO-002")', context);
  assert.equal(read(context, 'db.bookings[1].status'), 'Confirmed');
  await vm.runInContext('cancel("CT-DEMO-002")', context);
  assert.equal(read(context, 'db.bookings[1].status'), 'Cancelled');
  assert.equal(JSON.parse(storage.get('courtlyOwnerPortalDemoV1:demo-lipa-pickleball-hub')).bookings[1].status, 'Cancelled');
  vm.runInContext('db.venue.baseRate=475; db.venue.courtCount=3; persist();', context);
  const reopened = portal({ demo: true, storage });
  assert.equal(read(reopened.context, 'db.venue.baseRate'), 475);
  assert.equal(read(reopened.context, 'db.venue.courtCount'), 3);
});

test('overview prioritizes payment review and lists only today’s confirmed court bookings in time order', () => {
  const { context } = portal({ demo: true });
  vm.runInContext(`
    const today=venueToday();
    db.bookings=[
      {id:'late',date:today,time:'4:00 PM – 5:00 PM',court:'Court 1',player:'Later',status:'Confirmed'},
      {id:'cancelled',date:today,time:'8:00 AM – 9:00 AM',court:'Court 1',status:'Cancelled'},
      {id:'early',date:today,time:'9:30 AM – 10:30 AM',court:'Court 2',player:'Earlier',status:'Completed'},
      {id:'pending',date:today,time:'8:00 AM – 9:00 AM',court:'Court 1',status:'Pending'},
      {id:'another-day',date:'2099-01-01',time:'8:00 AM – 9:00 AM',court:'Court 1',status:'Confirmed'}
    ];
  `, context);
  assert.deepEqual(read(context, 'todayConfirmedBookings().map(booking=>booking.id)'), ['early', 'late']);
  const html = read(context, 'overview()');
  assert.ok(html.indexOf('id="ownerPaymentReview"') < html.indexOf('class="stats"'));
  assert.ok(html.indexOf('id="ownerTodayBookings"') < html.indexOf('Recent reservations'));
  assert.match(html, /View today’s calendar/);
});

test('cancelling a paid booking explains refunds separately and does not mark its payment refunded', async () => {
  const { context } = portal();
  let prompt = '';
  context.confirm = message => { prompt = message; return true; };
  context.courtlyCancelBooking = async () => true;
  vm.runInContext('db.bookings=[{id:"paid-booking",status:"Confirmed",paymentStatus:"Paid"}];', context);
  await vm.runInContext('cancel("paid-booking")', context);
  assert.match(prompt, /does not refund any payment/);
  assert.equal(read(context, 'db.bookings[0].status'), 'Cancelled');
  assert.equal(read(context, 'db.bookings[0].paymentStatus'), 'Paid');
});

test('payment approval stays pending until the server succeeds and ignores repeated taps', async () => {
  const { context, nodes } = portal();
  const pending = deferred(); let calls = 0;
  context.courtlyReviewBooking = () => { calls += 1; return pending.promise; };
  vm.runInContext('db.bookings=[{id:"booking-1",status:"Pending",paymentStatus:"Unpaid",price:350,duration:1}];', context);
  const first = vm.runInContext('confirmPay("booking-1")', context);
  await vm.runInContext('confirmPay("booking-1")', context);
  assert.equal(calls, 1);
  assert.equal(read(context, 'db.bookings[0].status'), 'Pending');
  pending.reject(new Error('The network is unavailable'));
  await first;
  assert.equal(read(context, 'db.bookings[0].status'), 'Pending');
  assert.match(nodes.get('toast').textContent, /network is unavailable/);
  context.courtlyReviewBooking = async () => ({ status: 'confirmed' });
  await vm.runInContext('confirmPay("booking-1")', context);
  assert.equal(read(context, 'db.bookings[0].status'), 'Confirmed');
});

test('calendar ignores rejected bookings and covers partial-hour bookings and multi-hour blocks', () => {
  const { context } = portal();
  vm.runInContext(`db.bookings=[{id:"rejected",court:"East court",date:"2026-11-12",time:"9:00 AM – 10:00 AM",duration:1,status:"Rejected"},
    {id:"confirmed",court:"East court",date:"2026-11-12",time:"9:30 AM – 11:30 AM",duration:2,status:"Confirmed"}];
    db.blocks=[{id:"block",court:"West court",date:"2026-11-12",time:"10:00 AM",duration:3}];
    db.courts=[{name:"East court",is_active:true},{name:"Closed court",is_active:false}];`, context);
  assert.equal(read(context, 'calendarSlot("2026-11-12","East court","9:00").booking.id'), 'confirmed');
  assert.equal(read(context, 'calendarSlot("2026-11-12","East court","11:00").booking.id'), 'confirmed');
  assert.equal(vm.runInContext('calendarSlot("2026-11-12","East court","12:00").booking', context), undefined);
  assert.equal(read(context, 'calendarSlot("2026-11-12","West court","12:00").block.id'), 'block');
  assert.equal(vm.runInContext('calendarSlot("2026-11-12","West court","13:00").block', context), undefined);
  assert.deepEqual(read(context, 'activeCourtNames()'), ['East court']);
  assert.equal(vm.runInContext('bookingEndDate({endsAt:"2026-11-12T03:30:00Z",date:"2026-11-12",time:"9:30 AM – 11:30 AM"}).toISOString()', context), '2026-11-12T03:30:00.000Z');
});

test('a failed calendar save rolls back the block and does not announce success', async () => {
  const { context, nodes } = portal();
  context.courtlyPersistOwnerWorkspace = async () => { throw new Error('Could not save this block'); };
  await vm.runInContext('blockSlot("2026-11-12","Court 1","9:00 AM")', context);
  assert.deepEqual(read(context, 'db.blocks'), []);
  assert.equal(nodes.get('toast').textContent, 'Could not save this block');
});

test('payment settings save only payment fields and use the state captured when queued', async () => {
  const env = environment(); const service = queryService(() => ({ data: null, error: null }));
  env.context.supabase = service; vm.runInContext(bridgeSource, env.context);
  const state = { venue: { id: 'venue-a', paymentName: 'GCash QR', paymentAccount: 'Original account', paymentInstructions: 'Use reference', qrData: '' }, courts: [], openPlays: [], blocks: [] };
  env.context.state = state;
  const saved = vm.runInContext('queueOwnerWorkspaceSave(state,{scope:"payments"})', env.context);
  state.venue.paymentAccount = 'Unsaved next edit';
  await saved;
  assert.deepEqual(service.calls.map(call => call.table), ['venues']);
  assert.equal(service.calls[0].payload.payment_account, 'Original account');
  assert.equal(service.calls[0].payload.hours_open, undefined);
  assert.equal(state.venue.paymentAccount, 'Unsaved next edit');
});

test('court settings preserve named court identities and never reactivate unrelated inactive courts', async () => {
  const env = environment();
  const existing = [
    { id: 'court-a', name: 'East Badminton', sport: 'Badminton', is_active: true, image_url: '/east.jpg', image_fit: 'contain' },
    { id: 'court-b', name: 'Retired Court', sport: 'Pickleball', is_active: false },
    { id: 'court-c', name: 'West court', sport: 'Badminton', is_active: true }
  ];
  const service = queryService(call => ({ data: call.table === 'courts' && call.operation === 'select' ? existing : call.operation === 'upsert' ? call.payload : null, error: null }));
  env.context.supabase = service; vm.runInContext(bridgeSource, env.context);
  env.context.state = { venue: { id: 'venue-a', courtCount: 1, baseRate: 400, peakRate: 500, hoursOpen: '08:00', hoursClose: '22:00', sport: 'Pickleball' }, courts: [existing[0], existing[2]] };
  await vm.runInContext('queueOwnerWorkspaceSave(state,{scope:"courts"})', env.context);
  const upsert = service.calls.find(call => call.operation === 'upsert');
  assert.equal(upsert.payload.length, 1);
  assert.equal(upsert.payload[0].id, 'court-a');
  assert.equal(upsert.payload[0].name, 'East Badminton');
  assert.equal(upsert.payload[0].sport, 'Badminton');
  assert.equal(upsert.payload[0].image_url, '/east.jpg');
  const disabled = service.calls.find(call => call.table === 'courts' && call.operation === 'update');
  assert.deepEqual(JSON.parse(JSON.stringify(disabled.filters.find(filter => filter[0] === 'in')[2])), ['court-c']);
  assert.equal(env.context.state.venue.courtImages[0].id, 'court-a');
});

test('removing one block does not diff or delete other blocks and preserves venue scoping', async () => {
  const env = environment(); const service = queryService(() => ({ data: null, error: null }));
  env.context.supabase = service; vm.runInContext(bridgeSource, env.context);
  env.context.state = { venue: { id: 'venue-a' }, blocks: [{ id: 'keep-me' }] };
  await vm.runInContext('queueOwnerWorkspaceSave(state,{scope:"block",id:"remove-me",remove:true})', env.context);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].table, 'court_blocks');
  assert.equal(service.calls[0].operation, 'delete');
  assert.deepEqual(JSON.parse(JSON.stringify(service.calls[0].filters)), [['eq', 'venue_id', 'venue-a'], ['eq', 'id', 'remove-me']]);
});

test('receipt delivery failure cannot undo or report failure for a confirmed payment', async () => {
  const env = environment(); let confirmations = 0;
  env.context.supabase = { rpc: async () => { confirmations += 1; return { data: { status: 'confirmed' }, error: null }; },
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-session' } } }) } };
  env.context.dispatchBookingNotifications = async () => { throw new Error('Receipt server offline'); };
  vm.runInContext(bridgeSource, env.context);
  const result = await vm.runInContext('reviewBooking("booking-1","confirmed")', env.context);
  assert.equal(result.status, 'confirmed');
  assert.equal(confirmations, 1);
});

test('owner rejection and cancellation dispatch only after their backend action succeeds', async () => {
  const env = environment(); const notifications = []; let fail = false;
  env.context.supabase = { rpc: async () => ({ data: true, error: fail ? new Error('Action denied') : null }) };
  env.context.dispatchBookingNotifications = async (_client, source) => { notifications.push(source); return { status: 'queued' }; };
  vm.runInContext(bridgeSource, env.context);
  await vm.runInContext('reviewBooking("booking-1","rejected")', env.context);
  await vm.runInContext('cancelBooking("booking-2")', env.context);
  assert.deepEqual(JSON.parse(JSON.stringify(notifications)), [{ type: 'court_booking', id: 'booking-1' }, { type: 'court_booking', id: 'booking-2' }]);
  fail = true;
  await assert.rejects(vm.runInContext('cancelBooking("booking-3")', env.context), /Action denied/);
  assert.equal(notifications.length, 2);
});

test('demo Open Play review and count refresh never query the live service', async () => {
  const env = environment({ demo: true });
  let notifications = 0;
  env.context.dispatchBookingNotifications = async () => { notifications++; return { status: 'queued' }; };
  env.storage.set('courtlyOwnerPortalDemoV1:demo-lipa-pickleball-hub', JSON.stringify({ venue: { slug: 'demo-lipa-pickleball-hub', name: 'Demo venue' } }));
  env.context.supabase = { auth: { getUser: () => { throw new Error('Live auth must not run'); } }, rpc: () => { throw new Error('Live RPC must not run'); } };
  vm.runInContext(openPlaySource, env.context);
  await vm.runInContext('refreshOpenPlayRegistrationCounts()', env.context);
  await vm.runInContext('reviewPayment("demo-op-002","confirmed",true)', env.context);
  const rows = JSON.parse(env.storage.get('courtlyDemoOpenPlayTransactionsV1:demo-lipa-pickleball-hub'));
  assert.equal(rows.find(row => row.id === 'demo-op-002').payment_status, 'confirmed');
  assert.equal(notifications, 0);
});

test('cancelled Open Play reservations cannot display approval actions', () => {
  const env = environment(); env.context.supabase = null; vm.runInContext(openPlaySource, env.context);
  env.context.cancelled = { id: 'registration-1', player_name: 'Test Player', registration_status: 'cancelled', payment_status: 'awaiting_verification', fee: 150 };
  assert.equal(vm.runInContext('reservationStatus(cancelled)', env.context), 'Cancelled');
  const markup = vm.runInContext('transactionMarkup([cancelled])', env.context);
  assert.doesNotMatch(markup, /data-op-review=/);
});

test('background billing refresh preserves an unfinished remittance form', async () => {
  const env = environment(); let calls = 0;
  env.context.supabase = { auth: { getUser: async () => { calls += 1; return { data: { user: { id: 'owner-a' } } }; } } };
  vm.runInContext(billingSource, env.context);
  const host = element(); host.innerHTML = 'Unfinished payment form'; env.nodes.set('ownerBillingApp', host);
  vm.runInContext('lastBillingHost=document.getElementById("ownerBillingApp");billingFormDirty=true;', env.context);
  assert.equal(await vm.runInContext('loadCourtlyOwnerBilling({silent:true})', env.context), false);
  assert.equal(calls, 0);
  assert.equal(host.innerHTML, 'Unfinished payment form');
});

test('a saved remittance remains successful if balance refresh fails and cannot be resubmitted', async () => {
  const env = environment(); const alerts = []; let submissions = 0;
  env.context.alert = message => alerts.push(message);
  env.context.File = class {};
  env.context.FormData = class { get(name) { return { amount: '100', method: 'GCash', reference: 'TEST-REFERENCE', note: '', proof: null }[name]; } };
  env.context.supabase = {
    auth: { getUser: async () => ({ data: { user: { id: 'owner-a' } }, error: null }) },
    rpc: async name => {
      if (name === 'submit_courtly_remittance') { submissions += 1; return { error: null }; }
      throw new Error('Balance refresh is temporarily unavailable');
    }
  };
  vm.runInContext(billingSource, env.context);
  env.nodes.set('ownerBillingApp', element());
  const button = element(); const form = { dataset: { remitForm: 'invoice-a' }, querySelector: () => button };
  env.context.submitEvent = { currentTarget: form, preventDefault() {} };
  await vm.runInContext('submitRemittance(submitEvent)', env.context);
  assert.equal(form.dataset.submitted, 'true');
  assert.equal(button.disabled, true);
  assert.match(alerts[0], /^Remittance submitted\./);
  assert.match(alerts[0], /submission was saved/);
  await vm.runInContext('submitRemittance(submitEvent)', env.context);
  assert.equal(submissions, 1);
});
