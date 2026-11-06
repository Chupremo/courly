const { createHmac, timingSafeEqual } = require('node:crypto');

const SOURCE_TABLES = Object.freeze({
  court_booking: 'bookings',
  coaching_booking: 'coaching_bookings',
  open_play_registration: 'open_play_registrations'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res, error, context) {
  // Do not log provider responses, access tokens, addresses or booking details.
  console.error(context, { code: error.code || 'UNEXPECTED_ERROR', status: error.status || 500 });
  return json(res, error.status || 503, {
    success: false,
    code: error.code || 'DELIVERY_UNAVAILABLE',
    error: error instanceof ServiceError ? error.message : 'Delivery is temporarily unavailable. Your saved booking or payment is unchanged.'
  });
}

function bearer(req) {
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || '';
}

function requireCron(req, env, path, now = Date.now) {
  const secret = env.CRON_SECRET || '';
  const supplied = bearer(req);
  if (!secret) throw new ServiceError(503, 'CRON_NOT_CONFIGURED', 'The scheduled delivery service is not configured.');
  const expectedBuffer = Buffer.from(secret);
  const actualBuffer = Buffer.from(supplied);
  if (expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)) return;
  // pg_net queues readable request headers. Send a short-lived signature from
  // Vault instead of placing the reusable cron secret in that queue.
  const timestamp = String(req.headers?.['x-courtly-cron-timestamp'] || '');
  const signature = String(req.headers?.['x-courtly-cron-signature'] || '');
  if (path && /^\d{10}$/.test(timestamp) && /^[a-f0-9]{64}$/.test(signature)
    && Math.abs(Math.floor(now() / 1000) - Number(timestamp)) <= 300) {
    const expected = createHmac('sha256', secret).update(`courtly-cron:${timestamp}:${path}`).digest('hex');
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return;
  }
  throw new ServiceError(401, 'UNAUTHORIZED', 'Unauthorized cron request.');
}

function readBody(req) {
  try {
    const body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? JSON.parse(String(req.body)) : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    return body;
  } catch {
    throw new ServiceError(400, 'INVALID_REQUEST', 'Send a JSON booking type and ID.');
  }
}

function sourceReference(body) {
  const { type, id } = body || {};
  if (!Object.hasOwn(SOURCE_TABLES, type) || !UUID.test(String(id || ''))) {
    throw new ServiceError(400, 'INVALID_SOURCE', 'Choose a valid booking or Open Play registration.');
  }
  return { type, id };
}

function createBackend({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!base || !serviceKey) throw new ServiceError(503, 'DATABASE_NOT_CONFIGURED', 'The delivery database is not configured.');

  async function request(path, options = {}, auth = serviceKey, apiKey = serviceKey) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        ...options,
        signal: AbortSignal.timeout(8000),
        headers: { apikey: apiKey, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...options.headers }
      });
    } catch {
      throw new ServiceError(503, 'DATABASE_UNAVAILABLE', 'The delivery database could not be reached. Please try again.');
    }
    let data;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ServiceError(503, 'DATABASE_UNAVAILABLE', 'The delivery database returned an invalid response.');
    }
    if (!response.ok) {
      if (path === '/auth/v1/user' && [401, 403].includes(response.status)) {
        throw new ServiceError(401, 'SESSION_EXPIRED', 'Please sign in again.');
      }
      const missing = ['PGRST202', 'PGRST205', '42P01', '42883', '42703'].includes(data?.code);
      throw new ServiceError(503, missing ? 'MIGRATION_REQUIRED' : 'DATABASE_UNAVAILABLE', missing
        ? 'The delivery database update is not installed. Your saved booking or payment is unchanged.'
        : 'The delivery database could not complete this request. Please try again.');
    }
    return data;
  }

  const rest = (path, options) => request('/rest/v1/' + path, options);
  const rpc = (name, values = {}) => rest('rpc/' + name, { method: 'POST', body: JSON.stringify(values) });

  async function authenticate(req) {
    const token = bearer(req);
    if (!token) throw new ServiceError(401, 'SIGN_IN_REQUIRED', 'Sign in to manage booking notifications or receipts.');
    if (!anonKey) throw new ServiceError(503, 'AUTH_NOT_CONFIGURED', 'The delivery authentication service is not configured.');
    const user = await request('/auth/v1/user', {}, token, anonKey);
    if (!UUID.test(user?.id || '')) throw new ServiceError(401, 'SESSION_EXPIRED', 'Please sign in again.');
    return user;
  }

  async function authorizeSource(source, actor) {
    const rows = await rest(`${SOURCE_TABLES[source.type]}?id=eq.${source.id}&select=*`);
    const row = rows?.[0];
    if (!row) throw new ServiceError(404, 'BOOKING_NOT_FOUND', 'This booking or registration could not be found.');
    let allowed = actor.id === row.player_id || actor.id === row.customer_user_id;
    if (source.type === 'coaching_booking') allowed ||= actor.id === row.coach_id;
    else if (!allowed && UUID.test(row.venue_id || '')) {
      const venues = await rest(`venues?id=eq.${row.venue_id}&select=owner_id`);
      allowed = venues?.[0]?.owner_id === actor.id;
    }
    if (!allowed) throw new ServiceError(403, 'NOT_AUTHORIZED', 'You cannot manage delivery for this booking or registration.');
    return row;
  }

  async function readiness() {
    const result = await rpc('courtly_notification_readiness');
    if (result?.version !== 1 || result.ready !== true) {
      throw new ServiceError(503, 'MIGRATION_REQUIRED', 'The delivery database update is not ready. Your saved booking or payment is unchanged.');
    }
    return result;
  }

  return { rest, rpc, authenticate, authorizeSource, readiness };
}

module.exports = { ServiceError, SOURCE_TABLES, UUID, json, fail, bearer, requireCron, readBody, sourceReference, createBackend };
