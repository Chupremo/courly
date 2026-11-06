import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dispatchBookingNotifications, notificationDeliveryMessage, deliveryState } from '../notification-client.js';

const source = { type: 'coaching_booking', id: '00000000-0000-4000-8000-000000000001' };
const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }) } };
const response = (body, ok = true) => ({ ok, json: async () => body });

test('notification dispatch authenticates a source-scoped request and reads actual per-job status', async () => {
  let request;
  const result = await dispatchBookingNotifications(client, source, { fetchImpl: async (url, options) => {
    request = { url, options };
    return response({ success: true, deliveries: [{ kind: 'receipt', status: 'processing' }, { kind: 'notification', status: 'sent' }] });
  } });
  assert.equal(request.url, '/api/notifications/process');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.options.body), source);
  assert.equal(result.status, 'queued');
  assert.equal(result.receiptStatus, 'queued');
  const message = notificationDeliveryMessage(result, { receipt: true });
  assert.match(message, /receipt email queued/);
  assert.doesNotMatch(message, /sent|emailed/);
});

test('successful HTTP responses with no delivery evidence cannot claim email was sent', async () => {
  const result = await dispatchBookingNotifications(client, source, { fetchImpl: async () => response({ success: true }) });
  assert.equal(result.status, 'unavailable');
  assert.match(notificationDeliveryMessage(result), /status is unavailable/);
  assert.equal(deliveryState([{ status: 'sent' }, { status: 'superseded' }]), 'sent');
  assert.equal(deliveryState([{ status: 'needs_review' }, { status: 'sent' }]), 'needs_review');
});

test('configuration pauses and delivery/network failures resolve without failing the booking', async () => {
  const paused = await dispatchBookingNotifications(client, source, { fetchImpl: async () => response({ success: false, code: 'EMAIL_DELIVERY_PAUSED' }, false) });
  assert.equal(paused.status, 'paused');
  assert.doesNotMatch(notificationDeliveryMessage(paused), /sent|emailed/);
  const failed = await dispatchBookingNotifications(client, source, { fetchImpl: async () => { throw new Error('Offline'); } });
  assert.equal(failed.status, 'unavailable');
  const missing = await dispatchBookingNotifications(null, source, { fetchImpl: () => { throw new Error('Must not fetch'); } });
  assert.equal(missing.status, 'unavailable');
});

test('a stalled authentication lookup cannot leave a committed review waiting indefinitely', async () => {
  const stalled = { auth: { getSession: () => new Promise(() => {}) } };
  const result = await dispatchBookingNotifications(stalled, source, { timeoutMs: 5, fetchImpl: () => { throw new Error('Must not send without a session'); } });
  assert.equal(result.status, 'unavailable');
});

const portalSource = readFileSync(new URL('../coach-portal.js', import.meta.url), 'utf8');
const actionSource = portalSource.slice(portalSource.indexOf('function setSessionReviewBusy('), portalSource.indexOf('function bindSessionActions('));
function reviewApp({ result, refreshFailure = false } = {}) {
  const buttons = ['confirmed', 'rejected'].map(decision => ({ dataset: { review: source.id, decision }, disabled: false }));
  const notices = [];
  let mutations = 0;
  let deliveries = 0;
  const context = vm.createContext({
    sessions: [{ id: source.id, payment_status: 'awaiting_verification', booking_status: 'pending' }],
    pendingSessionReviews: new Set(), coreRefreshId: 0,
    document: { querySelectorAll: () => buttons }, prompt: () => '', confirm: () => true,
    supabase: { rpc: async () => { mutations++; return result ? await result : { data: { success: true }, error: null }; } },
    refreshCore: async () => { if (refreshFailure) throw new Error('Dashboard offline'); }, render() {},
    msg: (message, type) => notices.push({ message, type }), notificationDeliveryMessage,
    dispatchBookingNotifications: async () => { deliveries++; return { status: 'queued', receiptStatus: 'queued' }; }
  });
  vm.runInContext(actionSource, context);
  return { context, buttons, notices, mutations: () => mutations, deliveries: () => deliveries };
}

test('coach review guards both action buttons while the mutation is pending', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = reviewApp({ result: pending });
  const first = app.context.reviewSessionPayment(app.buttons[0]);
  await app.context.reviewSessionPayment(app.buttons[1]);
  assert.equal(app.mutations(), 1);
  assert.equal(app.deliveries(), 0);
  assert.ok(app.buttons.every(button => button.disabled));
  finish({ data: { success: true }, error: null });
  await first;
  assert.equal(app.deliveries(), 1);
  assert.equal(app.context.sessions[0].payment_status, 'confirmed');
  assert.ok(app.notices.every(notice => notice.type === 'success'));
});

test('a committed coach review survives refresh failure and reports queued receipt delivery truthfully', async () => {
  const app = reviewApp({ refreshFailure: true });
  await app.context.reviewSessionPayment(app.buttons[0]);
  const last = app.notices.at(-1);
  assert.equal(last.type, 'success');
  assert.match(last.message, /Payment confirmed/);
  assert.match(last.message, /receipt email queued/);
  assert.match(last.message, /review was saved/);
  assert.doesNotMatch(last.message, /emailed to the player/);
  assert.ok(app.buttons.every(button => button.disabled));
  await app.context.reviewSessionPayment(app.buttons[0]);
  assert.equal(app.mutations(), 1);
});

test('failed coach reviews never dispatch an email or mark the payment confirmed', async () => {
  const app = reviewApp({ result: Promise.resolve({ data: null, error: new Error('Review denied') }) });
  await app.context.reviewSessionPayment(app.buttons[0]);
  assert.equal(app.deliveries(), 0);
  assert.equal(app.context.sessions[0].payment_status, 'awaiting_verification');
  assert.ok(app.buttons.every(button => !button.disabled));
  assert.equal(app.notices.at(-1).message, 'Review denied');
});
