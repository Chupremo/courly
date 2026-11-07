import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeNodeHandler } from '../cloudflare/api-adapter.mjs';
import { createApiHandlers, WORKERS_DELIVERY_BATCH_LIMIT } from '../cloudflare/api-routes.mjs';
import notifications from '../api/notifications/process.js';
import billingEmails from '../send-billing-emails.js';

const env = {
  SUPABASE_URL: 'https://database.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key',
  SUPABASE_ANON_KEY: 'fictional-anon-key',
  RESEND_API_KEY: 'fictional-email-key',
  CRON_SECRET: 'fictional-cron-secret',
  COURTLY_FROM_EMAIL: 'Courtly <receipts@example.test>',
  COURTLY_EMAIL_ENABLED: 'true'
};
const now = () => Date.parse('2026-11-07T02:00:00Z');
const routes = [
  { path: '/api/notifications/process', category: 'booking', factory: notifications.createHandler, setupRequests: 1 },
  { path: '/api/cron/send-billing-emails', category: 'billing', factory: billingEmails.createHandler, setupRequests: 2 }
];

// Exercise the real backend and delivery handlers through their HTTP boundary.
// Only fetch is replaced: every Supabase and provider request is counted.
function syntheticQueue(category) {
  const jobs = Array.from({ length: 25 }, (_, index) => ({
    id: '11111111-1111-4111-8111-' + String(index).padStart(12, '0'),
    lease_token: 'lease-' + index,
    category,
    kind: category === 'billing' ? 'billing' : 'notification',
    event_type: 'payment_confirmed',
    source_type: 'court_booking',
    recipient_email: `player-${index}@example.test`,
    status: 'pending',
    payload: category === 'billing'
      ? { subject: 'Test invoice', html: '<p>Test invoice is ready.</p>' }
      : { amount: 100, reference: 'TEST-' + index, description: 'Test booking', player_name: 'Test Player' }
  }));
  let requests = 0;
  let providerRequests = 0;

  async function fetchImpl(address, options = {}) {
    requests++;
    const url = new URL(address);
    const values = options.body ? JSON.parse(options.body) : {};
    if (url.origin === 'https://api.resend.com') {
      assert.equal(url.pathname, '/emails');
      providerRequests++;
      return Response.json({ id: 'synthetic-message-' + providerRequests });
    }
    assert.equal(url.origin, env.SUPABASE_URL, 'No real external requests are allowed.');
    const rpc = url.pathname.replace('/rest/v1/rpc/', '');
    if (rpc === 'courtly_notification_readiness') return Response.json({ version: 1, ready: true });
    if (rpc === 'queue_courtly_billing_email_notices') return Response.json(null);
    if (rpc === 'courtly_delivery_claim') {
      assert.equal(values.p_limit, 1);
      assert.equal(values.p_category, category);
      const job = jobs.find(row => row.status === 'pending');
      if (job) job.status = 'processing';
      return Response.json(job ? [job] : []);
    }
    if (rpc === 'courtly_delivery_prepare') {
      const job = jobs.find(row => row.id === values.p_job_id);
      assert.equal(job?.lease_token, values.p_lease_token);
      job.provider_payload = values.p_provider_payload;
      return Response.json([job]);
    }
    if (rpc === 'courtly_delivery_finish') {
      const job = jobs.find(row => row.id === values.p_job_id);
      assert.equal(job?.lease_token, values.p_lease_token);
      assert.equal(values.p_outcome, 'sent');
      job.status = values.p_outcome;
      return Response.json(true);
    }
    assert.fail('Unexpected RPC: ' + rpc);
  }
  return { fetchImpl, jobs, count: () => ({ requests, providerRequests }) };
}

for (const { path, category, factory, setupRequests } of routes) {
  test(`Workers ${category} batch stays below 50 subrequests and leaves remaining jobs pending`, async () => {
    const queue = syntheticQueue(category);
    const handlers = createApiHandlers(env, { fetchImpl: queue.fetchImpl, now, pace: async () => {} });
    const response = await invokeNodeHandler(new Request('https://courtly.example.test' + path, {
      headers: { Authorization: 'Bearer ' + env.CRON_SECRET }
    }), handlers[path]);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.sent, WORKERS_DELIVERY_BATCH_LIMIT);
    assert.equal(result.claimed, WORKERS_DELIVERY_BATCH_LIMIT);
    assert.equal(queue.count().providerRequests, 8);
    assert.equal(queue.count().requests, setupRequests + 4 * 8);
    assert.ok(queue.count().requests < 50);
    assert.equal(queue.jobs.filter(job => job.status === 'pending').length, 17);
    assert.equal(queue.jobs.filter(job => job.status === 'processing').length, 0);
  });

  test(`Vercel ${category} handler retains its existing 20-job batch`, async () => {
    const queue = syntheticQueue(category);
    const handler = factory({ env, fetchImpl: queue.fetchImpl, now, pace: async () => {} });
    const response = await invokeNodeHandler(new Request('https://courtly.example.test' + path, {
      headers: { Authorization: 'Bearer ' + env.CRON_SECRET }
    }), handler);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sent, 20);
    assert.deepEqual(queue.count(), { requests: setupRequests + 4 * 20, providerRequests: 20 });
    assert.equal(queue.jobs.filter(job => job.status === 'pending').length, 5);
  });
}
