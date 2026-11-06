const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { createBackend, ServiceError } = require('../server/courtly-backend.cjs');
const { processDeliveryJobs, buildProviderPayload } = require('../server/courtly-delivery.cjs');
const { createHandler: notificationHandler } = require('../api/notifications/process.js');
const { createHandler: receiptHandler } = require('../api/receipts/issue.js');
const { createHandler: downloadHandler } = require('../api/receipts/download.js');
const { createHandler: billingHandler } = require('../send-billing-emails.js');

const PLAYER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const RECEIPT = '55555555-5555-4555-8555-555555555555';
const ENV = {
  SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  SUPABASE_ANON_KEY: 'test-public-key', RESEND_API_KEY: 'test-resend-key',
  COURTLY_FROM_EMAIL: 'Courtly <receipts@example.test>', COURTLY_EMAIL_ENABLED: 'true',
  CRON_SECRET: 'test-cron-secret-at-least-16-characters', VITE_APP_URL: 'https://www.courtlyph.com'
};
const NOW = Date.parse('2026-11-06T04:00:00Z');
const source = { type: 'open_play_registration', id: SOURCE };
const receipt = {
  id: RECEIPT, receipt_number: 'CR-20261106-000001', source_type: source.type, source_id: SOURCE,
  player_id: PLAYER, player_email: 'player@example.test', player_name: 'Player <script>alert(1)</script>',
  description: 'Open Play at Test Venue', reference: 'OP-TEST-001', amount: 110,
  paid_at: '2026-11-06T03:00:00Z', payment_method: 'GCash', email_status: 'pending'
};

function job(overrides = {}) {
  return {
    id: JOB, category: 'booking', kind: 'receipt', source_type: source.type, source_id: SOURCE,
    event_type: 'payment_confirmed', recipient_email: receipt.player_email, payload: structuredClone(receipt),
    status: 'pending', attempts: 0, next_attempt_at: new Date(NOW).toISOString(), ...overrides
  };
}

// A contract stub for worker tests. The SQL claim/lease implementation is
// exercised separately by notification-schema.test.cjs against PostgreSQL.
function queueBackend(initial = job()) {
  const state = { row: structuredClone(initial), time: NOW, calls: [], failAck: false };
  const backend = {
    authenticate: async () => ({ id: OWNER }),
    authorizeSource: async () => ({ payment_status: 'confirmed', player_id: PLAYER }),
    readiness: async () => ({ ready: true, version: 1 }),
    rest: async () => [{ ...receipt, email_status: state.row.status === 'sent' ? 'sent' : 'pending' }],
    async rpc(name, values = {}) {
      state.calls.push([name, structuredClone(values)]);
      const row = state.row;
      if (name === 'courtly_delivery_reconcile_source' || name === 'queue_courtly_billing_email_notices') return null;
      if (name === 'courtly_delivery_source_status') return [{ id: row.id, kind: row.kind, event: row.event_type, status: row.status }];
      if (name === 'courtly_delivery_claim') {
        if (values.p_source_id && (values.p_source_id !== row.source_id || values.p_source_type !== row.source_type)) return [];
        if (values.p_category !== row.category) return [];
        const due = ['pending', 'retry'].includes(row.status) && Date.parse(row.next_attempt_at) <= state.time;
        const expired = row.status === 'processing' && Date.parse(row.lease_until) <= state.time;
        if (!due && !expired) return [];
        row.status = 'processing'; row.attempts++; row.lease_token = randomUUID();
        row.lease_until = new Date(state.time + 120000).toISOString();
        return [structuredClone(row)];
      }
      if (name === 'courtly_delivery_prepare') {
        if (values.p_lease_token !== row.lease_token) return [];
        row.provider_payload ||= structuredClone(values.p_provider_payload);
        row.first_attempt_at ||= new Date(state.time).toISOString();
        return [structuredClone(row)];
      }
      if (name === 'courtly_delivery_finish') {
        if (state.failAck) { state.failAck = false; throw new Error('Database connection lost'); }
        if (values.p_lease_token !== row.lease_token) return false;
        row.status = values.p_outcome;
        row.next_attempt_at = new Date(state.time + 60000).toISOString();
        row.provider_message_id = values.p_provider_id;
        row.lease_token = null; row.lease_until = null;
        return true;
      }
      throw new Error('Unexpected RPC: ' + name);
    }
  };
  return { state, backend, now: () => state.time };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
}
const request = (body = source) => ({ method: 'POST', headers: { authorization: 'Bearer test-user-token' }, body });
const noWait = async () => {};
const ok = (body = { id: 'provider-message-1' }) => new Response(JSON.stringify(body), { status: 200 });

test('disabled mail and missing sender never claim work or call the provider', async () => {
  let called = false;
  const dependencies = { backend: { rpc() { called = true; } }, fetchImpl() { called = true; }, env: { ...ENV, COURTLY_EMAIL_ENABLED: 'false' } };
  await assert.rejects(processDeliveryJobs(dependencies), { code: 'EMAIL_DELIVERY_PAUSED' });
  await assert.rejects(processDeliveryJobs({ ...dependencies, env: { ...ENV, COURTLY_FROM_EMAIL: '' } }), { code: 'EMAIL_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('an interrupted provider request retries the identical payload and key', async () => {
  const queue = queueBackend();
  const requests = [];
  let accepted = false;
  const fetchImpl = async (_url, options) => {
    requests.push({ key: options.headers['Idempotency-Key'], body: options.body });
    if (!accepted) { accepted = true; throw new Error('Connection lost after provider accepted'); }
    return ok();
  };
  const first = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(first.retry, 1);
  queue.state.time += 61000;
  queue.state.row.payload.description = 'Edited after first attempt';
  const second = await processDeliveryJobs({ ...queue, env: { ...ENV, COURTLY_FROM_EMAIL: 'New <new@example.test>' }, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(second.sent, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].key, 'courtly-delivery/' + JOB);
});

test('provider success plus failed database acknowledgement recovers after lease expiry', async () => {
  const queue = queueBackend();
  queue.state.failAck = true;
  const providerKeys = new Set();
  let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; providerKeys.add(options.headers['Idempotency-Key']); return ok(); };
  const first = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(first.deferred, 1);
  assert.equal(queue.state.row.status, 'processing');
  await processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(calls, 1, 'an unexpired lease is not sent concurrently');
  queue.state.time += 120001;
  const recovered = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(recovered.sent, 1);
  assert.equal(calls, 2);
  assert.equal(providerKeys.size, 1, 'both attempts address the same provider operation');
});

test('two workers cannot send the same claimed delivery concurrently', async () => {
  const queue = queueBackend();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => { calls++; entered(); await gate; return ok(); };
  const first = processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  await started;
  const second = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl, pace: noWait, limit: 1 });
  assert.equal(second.claimed, 0);
  release(); await first;
  assert.equal(calls, 1);
});

test('expired deduplication protection requires review without another provider send', async () => {
  const queue = queueBackend(job({ first_attempt_at: new Date(NOW - 24 * 3600000).toISOString() }));
  let calls = 0;
  const result = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl: async () => { calls++; return ok(); }, pace: noWait, limit: 1 });
  assert.equal(result.needs_review, 1);
  assert.equal(calls, 0);
});

test('rate limiting schedules a retry and does not burn through the remaining batch', async () => {
  const queue = queueBackend();
  const result = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl: async () => new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429 }), pace: noWait });
  assert.equal(result.retry, 1);
  assert.equal(queue.state.calls.filter(([name]) => name === 'courtly_delivery_claim').length, 1);
  assert.ok(Date.parse(queue.state.row.next_attempt_at) > NOW);
});

test('an idempotency payload conflict is held for review, not retried as a new email', async () => {
  const queue = queueBackend();
  const result = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl: async () => new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 }), pace: noWait, limit: 1 });
  assert.equal(result.needs_review, 1);
});

test('lost lease before preparing a payload prevents any provider request', async () => {
  const queue = queueBackend();
  const original = queue.backend.rpc;
  queue.backend.rpc = (name, values) => name === 'courtly_delivery_prepare' ? Promise.resolve([]) : original(name, values);
  let calls = 0;
  const result = await processDeliveryJobs({ ...queue, env: ENV, fetchImpl: async () => { calls++; return ok(); }, pace: noWait, limit: 1 });
  assert.equal(result.deferred, 1);
  assert.equal(calls, 0);
});

test('receipt body escapes user text and attaches a PDF for the stored player total', () => {
  const payload = buildProviderPayload(job(), ENV);
  assert.match(payload.html, /₱110\.00/);
  assert.match(payload.html, /&lt;script&gt;/);
  assert.doesNotMatch(payload.html, /<script>/);
  const pdf = Buffer.from(payload.attachments[0].content, 'base64').toString();
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /Amount paid: PHP 110\.00/);
  assert.doesNotMatch(pdf, /OFFICIAL/);
});

test('notification POST authorizes the actor and source before queueing any work', async () => {
  const queue = queueBackend();
  queue.backend.authorizeSource = async () => { throw new ServiceError(403, 'NOT_AUTHORIZED', 'Not your booking.'); };
  const res = response();
  await notificationHandler({ ...queue, env: ENV })(request({ ...source, recipient_email: 'attacker@example.test' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(queue.state.calls.length, 0);
});

test('missing migration fails closed before provider calls or source reconciliation', async () => {
  const queue = queueBackend();
  queue.backend.readiness = async () => { throw new ServiceError(503, 'MIGRATION_REQUIRED', 'Apply migration.'); };
  const res = response();
  await notificationHandler({ ...queue, env: ENV })(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(queue.state.calls.length, 0);
});

test('source-scoped dispatch ignores client email content and reports queued retries as 202', async () => {
  const queue = queueBackend();
  const res = response();
  await notificationHandler({ ...queue, env: ENV, fetchImpl: async () => { throw new Error('Offline'); }, pace: noWait })(request({ ...source, recipient_email: 'attacker@example.test', html: '<script>bad</script>' }), res);
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body);
  assert.equal(body.deliveries[0].status, 'retry');
  assert.equal(queue.state.row.provider_payload.to[0], receipt.player_email);
  const claim = queue.state.calls.find(([name]) => name === 'courtly_delivery_claim')[1];
  assert.equal(claim.p_source_id, SOURCE);
  assert.equal(claim.p_source_type, source.type);
});

test('cron authentication is mandatory and protected health checks are read-only', async () => {
  const queue = queueBackend();
  const handler = notificationHandler({ ...queue, env: ENV });
  const denied = response();
  await handler({ method: 'GET', headers: {}, query: {} }, denied);
  assert.equal(denied.statusCode, 401);
  const health = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET }, query: { check: '1' } }, health);
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).schema.version, 1);
  assert.equal(queue.state.calls.length, 0);
});

test('Vault scheduler signatures expire and are bound to the route and health-check mode', async () => {
  const queue = queueBackend();
  const handler = notificationHandler({ ...queue, env: ENV });
  const sign = (path, timestamp = String(Math.floor(NOW / 1000))) => ({
    'x-courtly-cron-timestamp': timestamp,
    'x-courtly-cron-signature': createHmac('sha256', ENV.CRON_SECRET).update(`courtly-cron:${timestamp}:${path}`).digest('hex')
  });
  const valid = response();
  await handler({ method: 'GET', headers: sign('/api/notifications/process?check=1'), query: { check: '1' } }, valid);
  assert.equal(valid.statusCode, 200);
  const changedRoute = response();
  await handler({ method: 'GET', headers: sign('/api/cron/send-billing-emails?check=1'), query: { check: '1' } }, changedRoute);
  assert.equal(changedRoute.statusCode, 401);
  const changedMode = response();
  await handler({ method: 'GET', headers: sign('/api/notifications/process?check=1'), query: {} }, changedMode);
  assert.equal(changedMode.statusCode, 401);
  const expired = response();
  await handler({ method: 'GET', headers: sign('/api/notifications/process?check=1', String(Math.floor(NOW / 1000) - 301)), query: { check: '1' } }, expired);
  assert.equal(expired.statusCode, 401);
  assert.equal(queue.state.calls.length, 0);
});

test('billing cron uses the durable billing category and does not generate invoices again', async () => {
  const queue = queueBackend(job({ category: 'billing', kind: 'billing', payload: { subject: 'Invoice ready', html: '<p>Invoice 1</p>' } }));
  const res = response();
  await billingHandler({ ...queue, env: ENV, fetchImpl: async () => ok(), pace: noWait })({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).sent, 1);
  assert.ok(queue.state.calls.some(([name]) => name === 'queue_courtly_billing_email_notices'));
  assert.ok(queue.state.calls.some(([name, values]) => name === 'courtly_delivery_claim' && values.p_category === 'billing'));
  assert.ok(queue.state.calls.every(([name]) => !/generate|enforce/.test(name)));
  assert.equal(typeof require('../api/cron/send-billing-emails.js'), 'function');
});

test('receipt issue supports paid Open Play and retains its single saved receipt', async () => {
  const queue = queueBackend();
  const res = response();
  await receiptHandler({ ...queue, env: ENV, fetchImpl: async () => ok(), pace: noWait })(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).receipt.id, RECEIPT);
  assert.equal(JSON.parse(res.body).delivery, 'sent');
});

test('unconfirmed payments cannot create or send a payment receipt', async () => {
  const queue = queueBackend();
  queue.backend.authorizeSource = async () => ({ payment_status: 'awaiting_verification' });
  const res = response();
  await receiptHandler({ ...queue, env: ENV })(request(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(queue.state.calls.length, 0);
});

test('receipt downloads stay private and work while email sending is disabled', async () => {
  const queue = queueBackend();
  queue.backend.authenticate = async () => ({ id: PLAYER });
  let filter;
  queue.backend.rest = async path => { filter = path; return [receipt]; };
  const res = response();
  await downloadHandler({ ...queue, env: {} })({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { id: RECEIPT } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(filter, new RegExp('player_id=eq.' + PLAYER));
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  queue.backend.authenticate = async () => ({ id: OWNER });
  const denied = response();
  await downloadHandler({ ...queue, env: {} })({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { id: RECEIPT } }, denied);
  assert.equal(denied.statusCode, 404);
});

test('database source authorization accepts the recorded owner and rejects another account', async () => {
  const fetchImpl = async url => ok(url.includes('/venues?') ? [{ owner_id: OWNER }] : [{ venue_id: SOURCE, player_id: PLAYER }]);
  const backend = createBackend({ env: ENV, fetchImpl });
  await backend.authorizeSource(source, { id: OWNER });
  await backend.authorizeSource(source, { id: PLAYER });
  await assert.rejects(backend.authorizeSource(source, { id: JOB }), { code: 'NOT_AUTHORIZED' });
});
