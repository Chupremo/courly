import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../player-register.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import[^;]+;/gm, '')
  .replaceAll('import.meta.env', 'env');

function setup({ profileFailure = false, signupPromise = null, valid = true } = {}) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', checked: false, disabled: false, hidden: true, textContent: '', innerHTML: '',
      className: '', listeners: {}, classList: { add() {}, remove() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { return valid; }, focus() { this.focused = true; }
    });
    return nodes.get(id);
  }
  const values = { fullName: 'Test Player', playerName: 'Player', email: 'player@example.test', confirmEmail: 'player@example.test', phone: '09000000000', skillLevel: 'Beginner', password: 'example-password', confirmPassword: 'example-password' };
  for (const [id, value] of Object.entries(values)) node(id).value = value;
  node('agreeTerms').checked = true;
  let signups = 0;
  const result = { data: { user: { id: 'test-player' }, session: { user: { id: 'test-player' } } }, error: null };
  const context = {
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [] },
    location: { search: '?returnTo=%2Fvenue.html%3Fslug%3Dsample', origin: 'https://courtly.test', hostname: 'courtly.test', replace() {} },
    window: { dispatchEvent() {} }, URL, URLSearchParams, Event,
    env: {}, console: { error() {}, warn() {} }, setTimeout() {},
    supabaseConfigError: '',
    fetch: async () => { signups++; if(signupPromise) await signupPromise; return {ok:true,json:async()=>({success:true})}; },
    supabase: {
      rpc: async () => ({ data: 0, error: null }),
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        signUp: async () => { signups++; return signupPromise ? await signupPromise : result; }
      }
    },
    syncPlayerProfile: async () => { if (profileFailure) throw new Error('Profile service unavailable'); return { player_name: 'Player' }; }
  };
  vm.runInNewContext(source, context);
  const submit = () => node('registerForm').listeners.submit({ preventDefault() {} });
  return { node, submit, signups: () => signups, result };
}

test('a successful server sign-up prevents duplicate account creation', async () => {
  const app = setup({ profileFailure: true });
  await app.submit();
  assert.equal(app.signups(), 1);
  assert.equal(app.node('submitButton').disabled, true);
  assert.equal(app.node('registrationNext').hidden, false);
  assert.equal(app.node('registrationNextLink').href, '/player-login.html?returnTo=%2Fvenue.html%3Fslug%3Dsample');
  assert.match(app.node('message').textContent, /account .*has been created/i);
  await app.submit();
  assert.equal(app.signups(), 1);
});

test('rapid repeated submissions create one sign-up request', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = setup({ signupPromise: pending });
  const first = app.submit();
  await app.submit();
  await Promise.resolve();
  assert.equal(app.signups(), 1);
  finish(app.result);
  await first;
});

test('invalid native form fields never reach account creation', async () => {
  const app = setup({ valid: false });
  await app.submit();
  assert.equal(app.signups(), 0);
});

test('email mismatch gives an error on the confirmation field and stops sign-up', async () => {
  const app = setup();
  app.node('confirmEmail').value = 'different@example.test';
  await app.submit();
  assert.equal(app.signups(), 0);
  assert.match(app.node('confirmEmail').validationMessage, /do not match/);
  assert.equal(app.node('confirmEmail').focused, true);
});

test('switching from registration to login preserves the booking destination', () => {
  const app = setup();
  assert.equal(app.node('.login-cta').href, '/player-login.html?returnTo=%2Fvenue.html%3Fslug%3Dsample');
});

