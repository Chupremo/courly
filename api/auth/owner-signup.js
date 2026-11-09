const { createClient } = require('@supabase/supabase-js');

const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const recent = new Map();

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(String(req.body || '{}')); } catch { return {}; }
}

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function allowedOrigin(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  return /^https:\/\/(www\.)?courtlyph\.com$/i.test(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
    || /^capacitor:\/\/localhost$/i.test(origin);
}

function ownerEmailHtml(actionLink, businessName) {
  const safeLink = String(actionLink).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeBusiness = String(businessName || 'your venue').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#15213d">
    <div style="padding:24px;background:#001a47"><img src="https://www.courtlyph.com/assets/courtly-logo.png" alt="Courtly" style="max-width:180px;max-height:64px;object-fit:contain"></div>
    <div style="padding:28px">
      <h2 style="margin:0 0 14px">Confirm your Courtly venue owner account</h2>
      <p>Confirm your email address to finish setting up <strong>${safeBusiness}</strong> on Courtly.</p>
      <p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;background:#001a47;color:#fff;text-decoration:none;padding:13px 18px;border-radius:8px;font-weight:700">Confirm owner account</a></p>
      <p>After confirmation, return to Courtly and sign in to manage your venue, bookings, Open Play, payments and earnings.</p>
      <p style="font-size:12px;color:#64748b">If you did not create this account, you can ignore this email.</p>
    </div>
  </div>`;
}

function createHandler(dependencies = {}) {
  return async function ownerSignup(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { success: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' });
    }
    if (!allowedOrigin(req)) return sendJson(res, 403, { success: false, code: 'ORIGIN_NOT_ALLOWED', error: 'Request origin is not allowed.' });

    const env = dependencies.env || process.env;
    const supabaseUrl = clean(env.SUPABASE_URL || env.VITE_SUPABASE_URL, 500).replace(/\/$/, '');
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY, 5000);
    const resendKey = clean(env.RESEND_API_KEY, 5000);
    const from = clean(env.COURTLY_FROM_EMAIL || env.COURTLY_RECEIPT_FROM, 320);
    if (!supabaseUrl || !serviceRoleKey || !resendKey || !from) {
      return sendJson(res, 503, { success: false, code: 'EMAIL_NOT_CONFIGURED', error: 'Account email delivery is temporarily unavailable.' });
    }

    const body = bodyOf(req);
    const email = clean(body.email, 320).toLowerCase();
    const password = String(body.password || '');
    const ownerName = clean(body.ownerName, 100);
    const ownerPhone = clean(body.ownerPhone, 30);
    const businessName = clean(body.businessName, 120);
    const businessAddress = clean(body.businessAddress, 220);
    const city = clean(body.city, 120);
    const sport = clean(body.sport, 80) || 'Multi-sport';
    const courtCount = clean(body.courtCount, 20) || '1';
    const returnTo = clean(body.returnTo, 500);

    if (!EMAIL_RE.test(email) || password.length < 8 || !businessName) {
      return sendJson(res, 400, { success: false, code: 'INVALID_SIGNUP', error: 'Please check your owner registration details and try again.' });
    }

    const now = Date.now();
    const last = recent.get(email) || 0;
    if (now - last < 60000) {
      return sendJson(res, 429, { success: false, code: 'SIGNUP_COOLDOWN', error: 'A verification email was already requested. Please wait a minute before trying again.' });
    }
    recent.set(email, now);
    if (recent.size > 500) {
      for (const [key, time] of recent) if (now - time > 10 * 60 * 1000) recent.delete(key);
    }

    const safeReturn = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/owner-portal.html';
    const redirectTo = `https://www.courtlyph.com/login.html?confirmed=1&returnTo=${encodeURIComponent(safeReturn)}`;
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data, error } = await admin.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      options: {
        redirectTo,
        data: {
          account_type: 'venue_owner',
          owner_name: ownerName,
          owner_phone: ownerPhone,
          business_name: businessName,
          business_address: businessAddress,
          city,
          sport,
          court_count: courtCount
        }
      }
    });

    if (error || !data?.properties?.action_link || !data?.user?.id) {
      recent.delete(email);
      const message = String(error?.message || '').toLowerCase();
      const exists = message.includes('already') || message.includes('registered') || message.includes('exists');
      return sendJson(res, exists ? 409 : 503, {
        success: false,
        code: exists ? 'ACCOUNT_EXISTS' : 'SIGNUP_LINK_FAILED',
        error: exists ? 'An account already exists for this email. Please sign in instead.' : 'We could not prepare your verification email. Please try again.'
      });
    }

    const { error: roleError } = await admin.auth.admin.updateUserById(data.user.id, {
      app_metadata: { account_type: 'venue_owner' }
    });
    if (roleError) {
      recent.delete(email);
      return sendJson(res, 503, { success: false, code: 'OWNER_ROLE_SETUP_FAILED', error: 'We could not finish preparing your owner account. Please try again.' });
    }

    let response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Confirm your Courtly venue owner account',
          html: ownerEmailHtml(data.properties.action_link, businessName)
        })
      });
    } catch {
      recent.delete(email);
      return sendJson(res, 503, { success: false, code: 'EMAIL_PROVIDER_UNAVAILABLE', error: 'We could not send your verification email. Please try again.' });
    }

    if (!response.ok) {
      recent.delete(email);
      return sendJson(res, response.status === 429 ? 429 : 503, {
        success: false,
        code: response.status === 429 ? 'EMAIL_PROVIDER_RATE_LIMIT' : 'EMAIL_SEND_FAILED',
        error: response.status === 429 ? 'Email delivery is busy right now. Please wait a minute and try again.' : 'We could not send your verification email. Please try again.'
      });
    }

    return sendJson(res, 200, { success: true, confirmationRequired: true });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
