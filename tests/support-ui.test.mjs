import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../support.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/init\(\)\.catch\([^\n]+\);\s*$/, '');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function app({ admin = false, requests } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: true, className: '', dataset: {}, value: 'open', listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; }, reset() { this.resets = (this.resets || 0) + 1; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  let authChange;
  const context = vm.createContext({
    document: { body: { dataset: { supportMode: admin ? 'admin' : '' } }, getElementById: node },
    supabase: {
      auth: { onAuthStateChange(fn) { authChange = fn; }, getSession: async () => ({ data: { session: { user: { id: 'account-a' } } }, error: null }) },
      rpc: async () => ({ data: admin, error: null }),
      from() {
        const query = { select: () => query, order: () => query, limit: () => query, eq: () => query,
          then(resolve, reject) { return (requests ? requests() : Promise.resolve({ data: [], error: null })).then(resolve, reject); } };
        return query;
      }
    }, Date, console
  });
  vm.runInContext(source, context);
  return { context, node, auth: (event, session) => authChange(event, session) };
}
const privateRow = { id: 'private-id', subject: 'Private account issue', message: 'Private message for account A.', category: 'privacy', status: 'open', admin_reply: '', created_at: '2026-11-07T00:00:00Z' };

test('signing out clears private support content and rejects an in-flight previous-user response', async () => {
  const pending = deferred();
  const started = deferred();
  const instance = app({ requests: () => { started.resolve(); return pending.promise; } });
  const initialized = instance.context.init();
  await started.promise;
  instance.node('supportRequests').innerHTML = 'Previously rendered private account details';
  instance.auth('SIGNED_OUT', null);
  pending.resolve({ data: [privateRow], error: null });
  await initialized;
  assert.equal(instance.node('supportRequests').innerHTML, '');
  assert.equal(instance.node('supportWorkspace').hidden, true);
  assert.equal(instance.node('supportSignIn').hidden, false);
  assert.match(instance.node('supportStatus').textContent, /sign-in changed/);
});

test('switching accounts clears old requests, the private form and any administrator link', async () => {
  const instance = app();
  await instance.context.init();
  instance.node('supportRequests').innerHTML = 'Account A private requests';
  instance.node('supportAdminLink').hidden = false;
  instance.auth('SIGNED_IN', { user: { id: 'account-b' } });
  assert.equal(instance.node('supportRequests').innerHTML, '');
  assert.equal(instance.node('supportAdminLink').hidden, true);
  assert.equal(instance.node('supportForm').resets, 1);
  assert.equal(instance.node('supportWorkspace').hidden, true);
});

test('support text and replies cannot escape their text or textarea contexts', () => {
  const instance = app({ admin: true });
  const attack = '</textarea><img src=x onerror=alert(1)><script>alert(2)</script>"';
  const rendered = instance.context.requestMarkup({ ...privateRow, subject: attack, message: attack, admin_reply: attack });
  assert.doesNotMatch(rendered, /<script>|<img src=x|<\/textarea><img/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /&quot;/);
  const resolved = instance.context.requestMarkup({ ...privateRow, status: 'resolved' });
  assert.match(resolved, /marked resolved/);
  assert.doesNotMatch(resolved, /waiting for a reply/);
});
