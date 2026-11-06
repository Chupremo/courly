import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeReturnTo, recoveryContext, contextFromUrl, recoveryLoginUrl, recoveryRequestUrl,
  createRecoveryRequest, createPasswordReset, savedRecoveryContext,
  RECOVERY_RETURN_KEY, RECOVERY_SESSION_KEY, RESET_REQUEST_MESSAGE
} from '../account-recovery.js';

const origin = 'https://courtly.test';
const resetUrl = `${origin}/reset-password.html`;
function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
function session(userId = 'player-one', type = 'player', id = 'recovery-session') {
  const payload = Buffer.from(JSON.stringify({ session_id: id, sub: userId })).toString('base64url');
  return { access_token: `header.${payload}.signature`, user: { id: userId, user_metadata: { account_type: type } } };
}
function link(value) {
  return `${resetUrl}#access_token=${value.access_token}&refresh_token=private-refresh&expires_in=3600&token_type=bearer&type=recovery`;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function setup(options = {}) {
  let current = options.session || session();
  let listener;
  let updates = 0;
  let verifies = 0;
  let exchanges = 0;
  let time = 1_000_000;
  const tab = options.tab || storage();
  const local = options.local || storage();
  const auth = {
    onAuthStateChange(fn) { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    async initialize() {
      if (options.recoveryEvent) listener('PASSWORD_RECOVERY', current);
      return { error: options.initializeError || null };
    },
    async getSession() { return { data: { session: current }, error: null }; },
    async getUser() { return { data: { user: current?.user }, error: options.userError || null }; },
    async verifyOtp(input) {
      verifies++;
      assert.equal(input.type, 'recovery');
      return { data: { session: current }, error: options.otpError || null };
    },
    async exchangeCodeForSession() {
      exchanges++;
      return { data: { session: current, redirectType: options.redirectType || 'recovery' }, error: null };
    },
    async updateUser(input) {
      updates++;
      assert.deepEqual(input, { password: 'new-secure-password' });
      if (options.updatePromise) await options.updatePromise;
      return { data: { user: current?.user }, error: options.updateError || null };
    },
    async signOut(input) {
      assert.deepEqual(input, { scope: 'local' });
      if (options.signOutError) throw new Error('Network unavailable');
      current = null;
      listener('SIGNED_OUT', null);
      return { error: null };
    }
  };
  const reset = createPasswordReset({ auth, initialUrl: options.url || link(current), sessionStorage: tab, returnStorage: local, now: () => time });
  return { reset, auth, tab, local, updates: () => updates, verifies: () => verifies, exchanges: () => exchanges,
    setSession(value) { current = value; }, setTime(value) { time = value; }, emit: (event, value) => listener(event, value) };
}

test('recovery return destinations stay on this origin and avoid auth loops', () => {
  const fallback = '/player-dashboard.html';
  for (const value of ['https://evil.test/', '//evil.test/', '/\\evil.test/', 'javascript:alert(1)', '/\n/evil.test', '/reset-password.html', '/player-login.html?returnTo=/login']) {
    assert.equal(safeReturnTo(value, fallback, origin), fallback, value);
  }
  assert.equal(safeReturnTo('/venue.html?slug=real-court#booking', fallback, origin), '/venue.html?slug=real-court#booking');
  assert.equal(recoveryContext({ role: '__proto__', returnTo: '//evil.test' }, origin).role, 'player');
  const coach = contextFromUrl(new URL(`${origin}/coach-login.html?next=%2Fcoach-portal.html%3Fview%3Dsessions`), 'coach');
  assert.equal(recoveryLoginUrl(coach, origin), '/coach-login.html?returnTo=%2Fcoach-portal.html%3Fview%3Dsessions');
  assert.equal(recoveryRequestUrl(coach, origin), '/forgot-password.html?role=coach&returnTo=%2Fcoach-portal.html%3Fview%3Dsessions');
});

test('reset requests use an exact callback and never store the email or tokens', async () => {
  const local = storage();
  let input;
  const request = createRecoveryRequest({ auth: { resetPasswordForEmail: async (...args) => { input = args; return { error: null }; } }, origin, storage: local, now: () => 500, context: { role: 'player', returnTo: '/venue.html?slug=real' } });
  const result = await request.send(' player@example.test ');
  assert.deepEqual(input, ['player@example.test', { redirectTo: resetUrl }]);
  assert.equal(result.message, RESET_REQUEST_MESSAGE);
  assert.deepEqual(savedRecoveryContext(local, origin, 501), { role: 'player', returnTo: '/venue.html?slug=real' });
  assert.doesNotMatch(local.getItem(RECOVERY_RETURN_KEY), /example|email|token/i);
  assert.equal(savedRecoveryContext(local, origin, 4_000_000).returnTo, '/player-dashboard.html');
});

test('unknown-account responses are generic and service errors do not expose raw details', async () => {
  for (const error of [null, { code: 'user_not_found', message: 'Account is missing' }, { code: 'email_not_found' }]) {
    const request = createRecoveryRequest({ auth: { resetPasswordForEmail: async () => ({ error }) }, origin, context: {} });
    assert.equal((await request.send('anyone@example.test')).message, RESET_REQUEST_MESSAGE);
  }
  const request = createRecoveryRequest({ auth: { resetPasswordForEmail: async () => { throw new Error('private provider detail'); } }, origin, context: {} });
  await assert.rejects(request.send('anyone@example.test'), /couldn’t request a reset link/);
});

test('repeated taps send one email request and a short cooldown prevents immediate resend', async () => {
  const pending = deferred();
  let calls = 0;
  const request = createRecoveryRequest({ auth: { resetPasswordForEmail: async () => { calls++; return pending.promise; } }, origin, context: {}, now: () => 500 });
  const first = request.send('player@example.test');
  assert.equal((await request.send('player@example.test')).ignored, true);
  assert.equal(calls, 1);
  pending.resolve({ error: null });
  await first;
  await assert.rejects(request.send('player@example.test'), /wait a minute/);
  assert.equal(calls, 1);
});

test('an ordinary signed-in session cannot open the reset form without a verified recovery link', async () => {
  const app = setup({ url: resetUrl, recoveryEvent: true });
  assert.equal((await app.reset.start()).status, 'invalid');
  await app.reset.submit('new-secure-password', 'new-secure-password');
  assert.equal(app.updates(), 0);
});

test('expired and mismatched links never fall back to an unrelated valid login session', async () => {
  for (const url of [`${resetUrl}#error=access_denied&error_code=otp_expired&error_description=private`, link(session('someone-else')), `${resetUrl}#type=signup&access_token=other&refresh_token=other`]) {
    const app = setup({ url });
    const state = await app.reset.start();
    assert.equal(state.status, 'invalid');
    assert.doesNotMatch(state.message, /private/);
    await app.reset.submit('new-secure-password', 'new-secure-password');
    assert.equal(app.updates(), 0);
  }
  const failed = setup({ initializeError: { code: 'otp_expired' } });
  assert.equal((await failed.reset.start()).status, 'invalid');
});

test('a validated implicit recovery callback works even when its auth event was already emitted', async () => {
  const app = setup();
  assert.equal((await app.reset.start()).status, 'ready');
  const marker = JSON.parse(app.tab.getItem(RECOVERY_SESSION_KEY));
  assert.equal(marker.userId, 'player-one');
  assert.equal(marker.sessionId, 'recovery-session');
  assert.doesNotMatch(app.tab.getItem(RECOVERY_SESSION_KEY), /access_token|refresh_token|signature|password/);
});

test('reloading a validated reset tab resumes only its same unexpired recovery session', async () => {
  const original = setup();
  await original.reset.start();
  const until = JSON.parse(original.tab.getItem(RECOVERY_SESSION_KEY)).until;
  const reloaded = setup({ url: resetUrl, tab: original.tab });
  reloaded.setTime(1_100_000);
  assert.equal((await reloaded.reset.start()).status, 'ready');
  assert.equal(JSON.parse(original.tab.getItem(RECOVERY_SESSION_KEY)).until, until, 'reload must not extend reset authorization');
  const wrong = setup({ url: resetUrl, tab: original.tab, session: session('player-one', 'player', 'different-session') });
  assert.equal((await wrong.reset.start()).status, 'invalid');
});

test('an expired recovery marker cannot authorize a reset', async () => {
  const original = setup();
  await original.reset.start();
  const reloaded = setup({ url: resetUrl, tab: original.tab });
  reloaded.setTime(4_000_000);
  assert.equal((await reloaded.reset.start()).status, 'invalid');
});

test('password mismatch, short passwords and rapid repeated submits never duplicate updates', async () => {
  const pending = deferred();
  const app = setup({ updatePromise: pending.promise });
  await app.reset.start();
  assert.equal((await app.reset.submit('short', 'short')).status, 'ready');
  assert.match((await app.reset.submit('new-secure-password', 'different-password')).message, /do not match/);
  assert.equal(app.updates(), 0);
  const first = app.reset.submit('new-secure-password', 'new-secure-password');
  await app.reset.submit('new-secure-password', 'new-secure-password');
  await Promise.resolve();
  assert.equal(app.updates(), 1);
  pending.resolve();
  assert.equal((await first).status, 'complete');
  await app.reset.submit('new-secure-password', 'new-secure-password');
  assert.equal(app.updates(), 1);
  assert.equal(app.tab.getItem(RECOVERY_SESSION_KEY), null);
});

test('a change of signed-in account or session blocks password mutation for the wrong account', async () => {
  for (const replacement of [session('another-player'), session('player-one', 'player', 'new-login-session')]) {
    const app = setup();
    await app.reset.start();
    app.setSession(replacement);
    assert.equal((await app.reset.submit('new-secure-password', 'new-secure-password')).status, 'invalid');
    assert.equal(app.updates(), 0);
  }
});

test('backend password-policy failures retain the form, while an expired session requests a fresh link', async () => {
  const weak = setup({ updateError: { code: 'weak_password', message: 'Password needs more character types.' } });
  await weak.reset.start();
  const retry = await weak.reset.submit('new-secure-password', 'new-secure-password');
  assert.equal(retry.status, 'ready');
  assert.equal(retry.message, 'Password needs more character types.');
  const expired = setup({ updateError: { code: 'session_not_found', status: 401 } });
  await expired.reset.start();
  assert.equal((await expired.reset.submit('new-secure-password', 'new-secure-password')).status, 'invalid');
});

test('a sign-out failure after a committed password change remains success and cannot submit again', async () => {
  const app = setup({ signOutError: true });
  await app.reset.start();
  const state = await app.reset.submit('new-secure-password', 'new-secure-password');
  assert.equal(state.status, 'complete');
  assert.match(state.message, /password has been updated/);
  await app.reset.submit('new-secure-password', 'new-secure-password');
  assert.equal(app.updates(), 1);
});

test('custom token-hash emails and PKCE callbacks must establish a recovery session', async () => {
  const token = setup({ url: `${resetUrl}?type=recovery&token_hash=private-hash` });
  assert.equal((await token.reset.start()).status, 'ready');
  assert.equal(token.verifies(), 1);
  const expired = setup({ url: `${resetUrl}?type=recovery&token_hash=expired`, otpError: { code: 'otp_expired' } });
  assert.equal((await expired.reset.start()).status, 'invalid');
  const code = setup({ url: `${resetUrl}?code=private-code` });
  assert.equal((await code.reset.start()).status, 'ready');
  assert.equal(code.exchanges(), 1);
  const signup = setup({ url: `${resetUrl}?code=signup-code`, redirectType: 'signup' });
  assert.equal((await signup.reset.start()).status, 'invalid');
});

test('cross-device recovery routes known account roles to their own login when local context is absent', async () => {
  for (const [type, expected] of [['venue_owner', '/login.html'], ['coach', '/coach-login.html'], ['club', '/club-login.html'], ['player', '/player-login.html']]) {
    const app = setup({ session: session('member', type) });
    const state = await app.reset.start();
    assert.ok(recoveryLoginUrl(state.context, origin).startsWith(expected + '?'));
  }
  const admin = setup({ session: session('admin', 'courtly_admin') });
  const state = await admin.reset.start();
  assert.equal(state.context.returnTo, '/admin-billing.html');
});

test('unavailable configuration and network verification failures never expose an active reset form', async () => {
  const noAuth = createPasswordReset({ auth: null, initialUrl: resetUrl });
  assert.equal((await noAuth.start()).status, 'unavailable');
  const network = setup({ userError: { name: 'AuthRetryableFetchError' } });
  assert.equal((await network.reset.start()).status, 'unavailable');
  assert.equal(network.updates(), 0);
});
