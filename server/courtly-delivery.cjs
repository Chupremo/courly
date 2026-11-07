const { ServiceError } = require('./courtly-backend.cjs');
const { makeReceiptPdf } = require('./courtly-receipt-pdf.cjs');
const { setTimeout: pause } = require('node:timers/promises');

const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const emailAddress = value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(String(value || ''));

function emailConfiguration(env = process.env) {
  const missing = [];
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.COURTLY_FROM_EMAIL) missing.push('COURTLY_FROM_EMAIL');
  return { enabled: env.COURTLY_EMAIL_ENABLED === 'true', configured: missing.length === 0, missing };
}

function requireEmailConfiguration(env = process.env) {
  const state = emailConfiguration(env);
  if (!state.enabled) throw new ServiceError(503, 'EMAIL_DELIVERY_PAUSED', 'Email delivery is paused. Your booking, payment and queued notification are saved.');
  if (!state.configured) throw new ServiceError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured. Your booking, payment and queued notification are saved.');
  for (const sender of [env.COURTLY_FROM_EMAIL, env.COURTLY_RECEIPT_FROM].filter(Boolean)) {
    const address = sender.match(/<([^<>]+)>$/)?.[1] || sender;
    if (/[\r\n]/.test(sender) || !emailAddress(address)) throw new ServiceError(503, 'SENDER_INVALID', 'The email sender configuration needs attention.');
  }
  return state;
}

function appBase(env) {
  const value = env.COURTLY_APP_URL || env.VITE_APP_URL || 'https://www.courtlyph.com';
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ServiceError(503, 'APP_URL_INVALID', 'The application URL configuration needs attention.');
  }
  return url.origin;
}

function envelope(title, content, href, linkLabel, base) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#15213d"><div style="padding:24px;background:#001a47"><img src="${esc(base)}/assets/courtly-logo.png" alt="Courtly" style="max-width:180px;max-height:64px;object-fit:contain"></div><div style="padding:28px"><h2>${esc(title)}</h2>${content}<p><a href="${esc(href)}">${esc(linkLabel)}</a></p><p style="font-size:12px;color:#64748b">Your booking and payment status in Courtly is the authoritative record.</p></div></div>`;
}

function buildProviderPayload(job, env) {
  const base = appBase(env);
  if (!emailAddress(job.recipient_email)) throw new ServiceError(422, 'RECIPIENT_INVALID', 'Recipient email needs attention.');
  const data = job.payload || {};
  const from = job.kind === 'receipt' ? (env.COURTLY_RECEIPT_FROM || env.COURTLY_FROM_EMAIL) : env.COURTLY_FROM_EMAIL;
  if (job.kind === 'billing') {
    if (!data.subject || !data.html) throw new ServiceError(422, 'MESSAGE_INVALID', 'Billing message is incomplete.');
    return {
      from, to: [job.recipient_email], subject: String(data.subject).replace(/[\r\n]/g, ' ').slice(0, 200),
      html: envelope('Your Courtly billing update', String(data.html), base + '/owner-portal.html?view=billing', 'View your invoices', base)
    };
  }
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new ServiceError(422, 'MESSAGE_INVALID', 'The saved amount needs attention.');
  const reference = String(data.reference || '').replace(/[\r\n]/g, ' ').slice(0, 120);
  if (job.kind === 'receipt') {
    if (!data.receipt_number || !Number.isFinite(Date.parse(data.paid_at))) throw new ServiceError(422, 'MESSAGE_INVALID', 'The saved receipt needs attention.');
    const paid = new Date(data.paid_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
    const content = `<p>Hi ${esc(data.player_name)}, your payment has been verified. Your payment receipt is attached.</p><p><strong>Receipt:</strong> ${esc(data.receipt_number)}<br><strong>Booking:</strong> ${esc(reference)}<br><strong>Description:</strong> ${esc(data.description)}<br><strong>Amount paid:</strong> ₱${amount.toFixed(2)}<br><strong>Date paid:</strong> ${esc(paid)}</p>`;
    const href = base + (job.source_type === 'coaching_booking' ? '/my-coaching-sessions.html' : '/player-dashboard.html?view=bookings');
    return {
      from, to: [job.recipient_email], subject: 'Your Courtly payment receipt ' + data.receipt_number,
      html: envelope('Payment confirmed', content, href, 'View your Courtly activity', base),
      attachments: [{ filename: String(data.receipt_number).replace(/[^a-z0-9_-]/gi, '') + '.pdf', content: makeReceiptPdf(data).toString('base64') }]
    };
  }
  const owner = data.audience === 'owner';
  const messages = {
    payment_submitted: owner
      ? ['Payment receipt to review', `${data.player_name} submitted payment proof. Review it in Courtly before confirming payment.`]
      : ['Payment proof received', 'Your payment proof was received. The venue owner or coach still needs to verify it.'],
    payment_confirmed: ['Payment confirmed', owner ? 'Payment has been confirmed for this booking.' : 'Your payment has been verified and your booking is confirmed.'],
    booking_confirmed: ['Registration confirmed', 'This free registration is confirmed. No payment is required.'],
    payment_rejected: ['Payment proof needs attention', owner ? 'The submitted payment proof was rejected. Check the booking for the current status.' : 'The venue owner or coach could not verify your payment proof. Open Courtly for the current status and contact them before paying again.'],
    booking_cancelled: ['Booking cancelled', 'This booking or registration has been cancelled. Contact the venue or coach about any payment already made. Cancellation does not automatically refund a QR payment.'],
    payment_refunded: ['Payment marked refunded', 'The venue owner or coach marked this payment as refunded. Contact them if you have not received it.']
  };
  const message = messages[job.event_type];
  if (!message) throw new ServiceError(422, 'MESSAGE_INVALID', 'Notification type is not supported.');
  let when = '';
  if (data.starts_at && Number.isFinite(Date.parse(data.starts_at))) {
    when = new Date(data.starts_at).toLocaleString('en-PH', { timeZone: data.timezone || 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
  } else when = [data.event_date, data.event_time].filter(Boolean).join(' · ');
  const content = `<p>${esc(message[1])}</p><p><strong>Reference:</strong> ${esc(reference)}<br><strong>Booking:</strong> ${esc(data.description)}${when ? '<br><strong>When:</strong> ' + esc(when) : ''}<br><strong>Player total:</strong> ₱${amount.toFixed(2)}</p>`;
  const path = owner ? (job.source_type === 'coaching_booking' ? '/coach-portal.html' : '/owner-portal.html?view=bookings')
    : (job.source_type === 'coaching_booking' ? '/my-coaching-sessions.html' : '/player-dashboard.html?view=bookings');
  return { from, to: [job.recipient_email], subject: `${message[0]} · ${reference}`, html: envelope(message[0], content, base + path, owner ? 'Open your workspace' : 'View your booking', base) };
}

async function processDeliveryJobs({ backend, env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  category = 'booking', source = null, limit = 4, maxDeliveryJobs = 20, deadline = now() + 45000, pace = pause }) {
  requireEmailConfiguration(env);
  const result = { claimed: 0, sent: 0, retry: 0, needs_review: 0, deferred: 0 };

  async function finish(job, outcome, providerId, error) {
    try {
      return await backend.rpc('courtly_delivery_finish', {
        p_job_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome,
        p_provider_id: providerId || null, p_error: error || null
      });
    } catch {
      // A persisted lease and provider key make the next attempt safe even
      // when the provider accepted the email but this acknowledgement failed.
      console.error('Courtly delivery acknowledgement deferred', { job: job.id });
      return false;
    }
  }

  for (let index = 0; index < Math.min(limit, maxDeliveryJobs, 20); index++) {
    if (index) await pace(550);
    // Leave room for claim + prepare + provider + acknowledgement timeouts.
    if (now() + 32000 > deadline) break;
    // Claim one at a time: a function timeout cannot strand a whole batch.
    const rows = await backend.rpc('courtly_delivery_claim', {
      p_limit: 1, p_category: category, p_source_type: source?.type || null, p_source_id: source?.id || null
    });
    let job = rows?.[0];
    if (!job) break;
    result.claimed++;
    let outcome = 'retry', providerId = null, error = null, providerUnavailable = false;
    try {
      if (job.first_attempt_at && now() - Date.parse(job.first_attempt_at) >= IDEMPOTENCY_WINDOW_MS) {
        throw new ServiceError(422, 'DEDUPLICATION_WINDOW_EXPIRED', 'Provider deduplication window elapsed; verify delivery before retrying.');
      }
      const payload = job.provider_payload || buildProviderPayload(job, env);
      const prepared = await backend.rpc('courtly_delivery_prepare', {
        p_job_id: job.id, p_lease_token: job.lease_token, p_provider_payload: payload
      });
      if (!prepared?.[0]) { result.deferred++; continue; }
      job = prepared[0];
      let response;
      try {
        response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `courtly-delivery/${job.id}` },
          body: JSON.stringify(job.provider_payload)
        });
      } catch {
        providerUnavailable = true;
        throw new ServiceError(502, 'PROVIDER_OUTCOME_UNKNOWN', 'Provider response was interrupted; retry with the same delivery key.');
      }
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body.id === 'string' && body.id) {
        outcome = 'sent'; providerId = body.id;
      } else {
        const transient = response.ok || response.status === 429 || response.status >= 500
          || (response.status === 409 && body.name === 'concurrent_idempotent_requests');
        outcome = transient ? 'retry' : 'needs_review';
        providerUnavailable = response.status === 429 || response.status >= 500;
        error = response.ok ? 'Provider accepted the request without a message ID; reconcile using the same key.'
          : `Email provider returned HTTP ${response.status}${body.name ? ' (' + String(body.name).slice(0, 80).replace(/[^a-z0-9_-]/gi, '') + ')' : ''}.`;
      }
    } catch (failure) {
      outcome = failure.status === 422 ? 'needs_review' : 'retry';
      error = failure instanceof ServiceError ? failure.message : 'Message processing failed; retry without changing its delivery key.';
    }
    if (await finish(job, outcome, providerId, error)) result[outcome]++;
    else result.deferred++;
    if (providerUnavailable) break;
  }
  return result;
}

module.exports = { IDEMPOTENCY_WINDOW_MS, emailConfiguration, requireEmailConfiguration, buildProviderPayload, processDeliveryJobs };
