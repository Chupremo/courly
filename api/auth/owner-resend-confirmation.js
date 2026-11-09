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
function clean(value, max = 320) { return String(value || '').trim().slice(0, max); }
function allowedOrigin(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  return /^https:\/\/(www\.)?courtlyph\.com$/i.test(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
    || /^capacitor:\/\/localhost$/i.test(origin);
}
function emailHtml(actionLink) {
  const safe = String(actionLink).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#15213d">
    <div style="padding:24px;background:#001a47"><img src="https://www.courtlyph.com/assets/courtly-logo.png" alt="Courtly" style="max-width:180px;max-height:64px;object-fit:contain"></div>
    <div style="padding:28px">
      <h2 style="margin:0 0 14px">Verify your Courtly owner email</h2>
      <p>Use the button below to verify your email address and continue to your Courtly owner account.</p>
      <p style="margin:24px 0"><a href="${safe}" style="display:inline-block;background:#001a47;color:#fff;text-decoration:none;padding:13px 18px;border-radius:8px;font-weight:700">Verify email and continue</a></p>
      <p style="font-size:12px;color:#64748b">If you did not request this email, you can ignore it.</p>
    </div>
  </div>`;
}
function createHandler(dependencies = {}) {
  return async function ownerResend(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow','POST');
      return sendJson(res,405,{success:false,error:'Method not allowed.'});
    }
    if (!allowedOrigin(req)) return sendJson(res,403,{success:false,error:'Request origin is not allowed.'});
    const env = dependencies.env || process.env;
    const supabaseUrl = clean(env.SUPABASE_URL || env.VITE_SUPABASE_URL,500).replace(/\/$/,'');
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY,5000);
    const resendKey = clean(env.RESEND_API_KEY,5000);
    const from = clean(env.COURTLY_FROM_EMAIL || env.COURTLY_RECEIPT_FROM,320);
    const email = clean(bodyOf(req).email).toLowerCase();
    if (!EMAIL_RE.test(email)) return sendJson(res,400,{success:false,error:'Enter a valid email address.'});
    if (!supabaseUrl || !serviceRoleKey || !resendKey || !from) return sendJson(res,503,{success:false,error:'Email delivery is temporarily unavailable.'});

    const now = Date.now(), last = recent.get(email) || 0;
    if (now - last < 60000) return sendJson(res,429,{success:false,error:'A verification email was already requested. Please wait a minute before trying again.'});
    recent.set(email,now);

    const admin = createClient(supabaseUrl,serviceRoleKey,{auth:{autoRefreshToken:false,persistSession:false}});
    let owner = null;
    for (let page=1; page<=10 && !owner; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return sendJson(res,503,{success:false,error:'We could not check your account. Please try again.'});
      owner = (data?.users || []).find(user => String(user.email || '').toLowerCase() === email) || null;
      if ((data?.users || []).length < 1000) break;
    }
    // Keep the response non-enumerating for unknown addresses.
    if (!owner) return sendJson(res,200,{success:true});
    if (owner.email_confirmed_at) return sendJson(res,200,{success:true,alreadyConfirmed:true});

    const { data: venue } = await admin.from('venues').select('id').eq('owner_id',owner.id).limit(1).maybeSingle();
    const role = String(owner.app_metadata?.account_type || owner.user_metadata?.account_type || '').toLowerCase();
    if (!venue && !['venue_owner','owner','business_owner'].includes(role)) return sendJson(res,200,{success:true});

    const redirectTo = 'https://www.courtlyph.com/login.html?confirmed=1&returnTo=%2Fowner-portal.html';
    const { data, error } = await admin.auth.admin.generateLink({ type:'magiclink', email, options:{ redirectTo } });
    if (error || !data?.properties?.action_link) {
      recent.delete(email);
      return sendJson(res,503,{success:false,error:'We could not prepare your verification link. Please try again.'});
    }

    const response = await fetch('https://api.resend.com/emails',{
      method:'POST',
      signal:AbortSignal.timeout(8000),
      headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({from,to:[email],subject:'Verify your Courtly owner email',html:emailHtml(data.properties.action_link)})
    }).catch(()=>null);
    if (!response?.ok) {
      recent.delete(email);
      return sendJson(res,response?.status===429?429:503,{success:false,error:response?.status===429?'Email delivery is busy right now. Please wait a minute and try again.':'We could not send your verification email. Please try again.'});
    }
    return sendJson(res,200,{success:true});
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
