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

function signupEmailHtml(actionLink) {
  const safe = String(actionLink).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#15213d">
    <div style="padding:24px;background:#001a47"><img src="https://www.courtlyph.com/assets/courtly-logo.png" alt="Courtly" style="max-width:180px;max-height:64px;object-fit:contain"></div>
    <div style="padding:28px">
      <h2 style="margin:0 0 14px">Confirm your Courtly player account</h2>
      <p>Confirm your email address to finish creating your Courtly player account.</p>
      <p style="margin:24px 0"><a href="${safe}" style="display:inline-block;background:#001a47;color:#fff;text-decoration:none;padding:13px 18px;border-radius:8px;font-weight:700">Confirm email address</a></p>
      <p style="font-size:12px;color:#64748b">If you did not create this account, you can ignore this email.</p>
    </div>
  </div>`;
}

function createHandler(dependencies = {}) {
  return async function playerSignup(req, res) {
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
    const email = clean(body.email).toLowerCase();
    const password = String(body.password || '');
    const fullName = clean(body.fullName, 100);
    const playerName = clean(body.playerName, 40);
    const phone = clean(body.phone, 30);
    const skillLevel = clean(body.skillLevel, 40);
    const isPrivate = Boolean(body.isPrivate);
    const returnTo = clean(body.returnTo, 500);
    if (!EMAIL_RE.test(email) || password.length < 8 || !fullName || !playerName || !phone) {
      return sendJson(res, 400, { success: false, code: 'INVALID_SIGNUP', error: 'Please check your registration details and try again.' });
    }

    const now = Date.now();
    const key = email;
    const last = recent.get(key) || 0;
    if (now - last < 60000) {
      return sendJson(res, 429, { success: false, code: 'SIGNUP_COOLDOWN', error: 'A verification email was already requested. Please wait a minute before trying again.' });
    }
    recent.set(key, now);
    if (recent.size > 500) {
      for (const [k, t] of recent) if (now - t > 10 * 60 * 1000) recent.delete(k);
    }

    const redirectTo = `https://www.courtlyph.com/player-login.html?confirmed=1&returnTo=${encodeURIComponent(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/player-dashboard.html?welcome=1')}`;
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data, error } = await admin.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      options: {
        redirectTo,
        data: {
          account_type: 'player',
          full_name: fullName,
          player_name: playerName,
          phone,
          skill_level: skillLevel,
          is_private: isPrivate
        }
      }
    });

    if (error || !data?.properties?.action_link) {
      recent.delete(key);
      const message = String(error?.message || '').toLowerCase();
      const exists = message.includes('already') || message.includes('registered') || message.includes('exists');
      return sendJson(res, exists ? 409 : 503, {
        success: false,
        code: exists ? 'ACCOUNT_EXISTS' : 'SIGNUP_LINK_FAILED',
        error: exists ? 'An account already exists for this email. Please sign in instead.' : 'We could not prepare your verification email. Please try again.'
      });
    }

    let response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Confirm your Courtly player account',
          html: signupEmailHtml(data.properties.action_link)
        })
      });
    } catch {
      recent.delete(key);
      return sendJson(res, 503, { success: false, code: 'EMAIL_PROVIDER_UNAVAILABLE', error: 'We could not send your verification email. Please try again.' });
    }

    if (!response.ok) {
      recent.delete(key);
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
