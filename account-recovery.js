// Account recovery shares the existing Supabase client. These helpers never
// decide account permissions; each destination keeps its normal role checks.
export const RECOVERY_RETURN_KEY = 'courtly.recovery.return.v1';
export const RECOVERY_SESSION_KEY = 'courtly.recovery.session.v1';
const RETURN_LIFETIME = 60 * 60 * 1000;
const RESET_LIFETIME = 30 * 60 * 1000;
const ROLES = {
  player: { login: '/player-login.html', home: '/player-dashboard.html' },
  owner: { login: '/login.html', home: '/owner-portal.html' },
  coach: { login: '/coach-login.html', home: '/coach-portal.html' },
  club: { login: '/club-login.html', home: '/club-dashboard.html' }
};
export const RESET_REQUEST_MESSAGE = 'If an account uses this email address, you’ll receive a password reset link. Check your inbox and spam folder.';

export function safeReturnTo(value, fallback = ROLES.player.home, origin = location.origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || /^\/(?:forgot-password|reset-password|player-login|coach-login|club-login|login)(?:\.html)?\/?$/i.test(url.pathname)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}

export function recoveryContext(value = {}, origin = location.origin) {
  const role = Object.hasOwn(ROLES, value.role) ? value.role : 'player';
  return { role, returnTo: safeReturnTo(value.returnTo, ROLES[role].home, origin) };
}

export function contextFromUrl(url, role) {
  return recoveryContext({ role: role || url.searchParams.get('role'), returnTo: url.searchParams.get('returnTo') || url.searchParams.get('next') }, url.origin);
}

export function recoveryLoginUrl(context, origin = location.origin) {
  const safe = recoveryContext(context, origin);
  return `${ROLES[safe.role].login}?returnTo=${encodeURIComponent(safe.returnTo)}`;
}

export function recoveryRequestUrl(context, origin = location.origin) {
  const safe = recoveryContext(context, origin);
  return `/forgot-password.html?role=${safe.role}&returnTo=${encodeURIComponent(safe.returnTo)}`;
}

export function setupRecoveryLink(element, role, url = new URL(location.href)) {
  const context = contextFromUrl(url, role);
  if (element) element.href = recoveryRequestUrl(context, url.origin);
  return context;
}

function read(storage, key) {
  try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; }
}
function write(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* Recovery also works with storage disabled. */ }
}
function remove(storage, key) {
  try { storage?.removeItem(key); } catch { /* Storage may be disabled. */ }
}

export function savedRecoveryContext(storage, origin, now = Date.now()) {
  const saved = read(storage, RECOVERY_RETURN_KEY);
  return saved && saved.until > now && saved.until <= now + RETURN_LIFETIME
    ? recoveryContext(saved, origin) : recoveryContext({}, origin);
}

export function createRecoveryRequest({ auth, context, origin, storage, now = Date.now }) {
  let pending = false;
  let nextAttemptAt = 0;
  const safe = recoveryContext(context, origin);
  return {
    async send(email) {
      if (pending) return { ignored: true };
      if (now() < nextAttemptAt) throw new Error('Please wait a minute before requesting another link.');
      if (!auth) throw new Error('Password recovery is temporarily unavailable. Please try again later.');
      pending = true;
      try {
        // Fixed redirect path keeps the production allowlist exact. Only safe
        // navigation context is stored locally; never emails or auth tokens.
        let result;
        try {
          result = await auth.resetPasswordForEmail(email.trim(), {
            redirectTo: new URL('/reset-password.html', origin).href
          });
        } catch {
          throw new Error('We couldn’t request a reset link right now. Please try again later or contact Courtly support.');
        }
        const { error } = result;
        if (error && !['user_not_found', 'email_not_found'].includes(error.code)) {
          if (error.status === 429 || /rate_limit|over_email_send_rate_limit/.test(error.code || '')) throw new Error('Too many reset requests. Please wait a few minutes and try again.');
          throw new Error('We couldn’t request a reset link right now. Please try again later or contact Courtly support.');
        }
        write(storage, RECOVERY_RETURN_KEY, { ...safe, until: now() + RETURN_LIFETIME });
        nextAttemptAt = now() + 60_000;
        return { message: RESET_REQUEST_MESSAGE };
      } finally { pending = false; }
    }
  };
}

function callbackDetails(url) {
  const values = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(url.hash.slice(1))) values.set(key, value);
  if (values.has('error') || values.has('error_code') || values.has('error_description')) return { kind: 'invalid' };
  if (values.get('type') === 'recovery' && values.get('token_hash')) return { kind: 'tokenHash', tokenHash: values.get('token_hash') };
  if (values.has('access_token') || values.has('refresh_token')) {
    return values.get('type') === 'recovery' && values.get('access_token') && values.get('refresh_token')
      ? { kind: 'implicit', accessToken: values.get('access_token') } : { kind: 'invalid' };
  }
  if (values.get('code')) return { kind: 'code', code: values.get('code') };
  return values.has('type') ? { kind: 'invalid' } : { kind: 'none' };
}

function sessionId(session) {
  try {
    const raw = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(raw));
    return typeof claims.session_id === 'string' ? claims.session_id : null;
  } catch { return null; }
}

function accountContext(user, context, origin) {
  const type = String(user?.user_metadata?.account_type || '').toLowerCase();
  if (['admin', 'courtly_admin'].includes(type)) return recoveryContext({ role: 'owner', returnTo: '/admin-billing.html' }, origin);
  const role = ({ player: 'player', coach: 'coach', club: 'club', sports_club: 'club', venue_owner: 'owner', owner: 'owner', business_owner: 'owner', admin: 'owner', courtly_admin: 'owner' })[type];
  return role && role !== context.role ? recoveryContext({ role }, origin) : context;
}

const INVALID_LINK = 'This reset link is invalid or has expired. Request a new link and use the most recent email.';
function invalidSession(error) {
  return error?.status === 401 || ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'otp_expired', 'bad_jwt', 'reauthentication_needed', 'reauthentication_not_valid'].includes(error?.code);
}

export function createPasswordReset({ auth, initialUrl, sessionStorage, returnStorage, now = Date.now, onState = () => {} }) {
  const url = new URL(initialUrl);
  const callback = callbackDetails(url);
  let state = { status: 'checking', message: '', context: savedRecoveryContext(returnStorage, url.origin, now()) };
  let verified = null;
  let recoveryEvent = null;
  let subscription = null;
  let started = null;
  function publish(next) { state = { ...state, ...next }; onState({ ...state }); return { ...state }; }
  function invalid() {
    verified = null;
    remove(sessionStorage, RECOVERY_SESSION_KEY);
    return publish({ status: 'invalid', message: INVALID_LINK });
  }
  function sameSession(session) {
    return !!session && session.user?.id === verified?.userId &&
      (verified.sessionId ? sessionId(session) === verified.sessionId : session.access_token === verified.accessToken);
  }
  async function start() {
    if (!auth) return publish({ status: 'unavailable', message: 'Password recovery is temporarily unavailable. Please try again later.' });
    if (callback.kind === 'invalid') return invalid();
    subscription = auth.onAuthStateChange((event, session) => {
      // Keep this callback synchronous: Auth methods can hold the auth lock.
      if (event === 'PASSWORD_RECOVERY') recoveryEvent = session;
      if (state.status === 'ready' && (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && !sameSession(session)))) invalid();
    })?.data?.subscription;
    try {
      const initialized = await auth.initialize();
      let session;
      let resetUntil = now() + RESET_LIFETIME;
      if (callback.kind === 'tokenHash') {
        const result = await auth.verifyOtp({ token_hash: callback.tokenHash, type: 'recovery' });
        if (result.error) throw result.error;
        session = result.data?.session;
      } else if (callback.kind === 'code') {
        // The existing client uses implicit flow. This also accepts a PKCE
        // callback only when its stored verifier identifies a recovery flow.
        // Supabase dispatches a URL recovery event on the next task after
        // initialize() resolves. Let it arrive before considering an exchange.
        if (!initialized?.error) await new Promise(resolve => setTimeout(resolve, 0));
        if (!initialized?.error && recoveryEvent) session = recoveryEvent;
        else {
          const result = await auth.exchangeCodeForSession(callback.code);
          if (result.error || result.data?.redirectType !== 'recovery') return invalid();
          session = result.data?.session;
        }
      } else {
        if (initialized?.error) throw initialized.error;
        const result = await auth.getSession();
        if (result.error) throw result.error;
        session = result.data?.session;
        if (callback.kind === 'implicit' && session?.access_token !== callback.accessToken) return invalid();
        if (callback.kind === 'none') {
          const marker = read(sessionStorage, RECOVERY_SESSION_KEY);
          if (!marker || marker.until <= now() || marker.until > now() + RESET_LIFETIME ||
              !marker.sessionId || marker.sessionId !== sessionId(session) || marker.userId !== session?.user?.id) return invalid();
          resetUntil = marker.until;
        }
      }
      if (!session?.user?.id || !session.access_token) return invalid();
      const current = await auth.getUser();
      if (current.error) throw current.error;
      if (current.data?.user?.id !== session.user.id) return invalid();
      const context = accountContext(current.data.user, state.context, url.origin);
      verified = { userId: session.user.id, sessionId: sessionId(session), accessToken: session.access_token, until: resetUntil };
      if (verified.sessionId) write(sessionStorage, RECOVERY_SESSION_KEY, { userId: verified.userId, sessionId: verified.sessionId, until: verified.until });
      return publish({ status: 'ready', context, message: 'Choose a new password for your Courtly account.' });
    } catch (error) {
      if (error?.status === 0 || error?.name === 'AuthRetryableFetchError' || error instanceof TypeError) return publish({ status: 'unavailable', message: 'We couldn’t verify this link. Check your connection and reopen the link from your email.' });
      return invalid();
    }
  }
  return {
    getState: () => ({ ...state }),
    start() { return started || (started = start()); },
    dispose() { subscription?.unsubscribe(); },
    async submit(password, confirmation) {
      if (state.status === 'saving' || state.status === 'complete') return { ...state };
      if (state.status !== 'ready' || !verified || verified.until <= now()) return invalid();
      if (password.length < 8) return publish({ message: 'Use at least 8 characters for your new password.' });
      if (password !== confirmation) return publish({ message: 'Your passwords do not match. Enter the same new password in both fields.' });
      publish({ status: 'saving', message: 'Updating your password…' });
      try {
        const sessionResult = await auth.getSession();
        if (sessionResult.error) throw sessionResult.error;
        if (!sameSession(sessionResult.data?.session)) return invalid();
        const result = await auth.updateUser({ password });
        if (result.error) throw result.error;
        if (result.data?.user?.id !== verified.userId) throw new Error('We couldn’t confirm the update. Please try again.');
        // The password is committed. A subsequent sign-out failure must never
        // invite another password mutation or claim the change failed.
        remove(sessionStorage, RECOVERY_SESSION_KEY);
        remove(returnStorage, RECOVERY_RETURN_KEY);
        publish({ status: 'complete', message: 'Your password has been updated. Log in with your new password to continue.' });
        try {
          const signedOut = await auth.signOut({ scope: 'local' });
          if (signedOut.error) throw signedOut.error;
        } catch {
          publish({ status: 'complete', message: 'Your password has been updated. This browser is still signed in; continue to return to your account.' });
        }
        return { ...state };
      } catch (error) {
        if (invalidSession(error)) return invalid();
        const message = error?.code === 'same_password' ? 'Choose a different password from your current password.'
          : error?.code === 'weak_password' ? (error.message || 'Choose a stronger password and try again.')
          : error?.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.'
          : 'We couldn’t update your password. Please try again.';
        return publish({ status: 'ready', message });
      }
    }
  };
}
