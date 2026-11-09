import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { invokeNodeHandler, MAX_API_BODY_BYTES } from '../cloudflare/api-adapter.mjs';
import { createApiHandlers } from '../cloudflare/api-routes.mjs';
import receiptPdf from '../server/courtly-receipt-pdf.cjs';

const id = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://database.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key',
  SUPABASE_ANON_KEY: 'fictional-anon-key',
  CRON_SECRET: 'fictional-cron-secret'
};
const noFetch = () => assert.fail('This test must not make any network requests.');
const request = (path, options) => new Request('https://courtly.example.test' + path, options);

test('adapter forwards JSON, authorisation, repeated query values and response headers', async () => {
  const response = await invokeNodeHandler(request('/api/example?id=first&id=second&__proto__=safe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fictional-token' },
    body: JSON.stringify({ type: 'court_booking', id })
  }), async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fictional-token');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(req.query.id, ['first', 'second']);
    assert.equal(req.query.__proto__, 'safe');
    assert.equal(Object.getPrototypeOf(req.query), null);
    assert.deepEqual(JSON.parse(String(req.body)), { type: 'court_booking', id });
    res.statusCode = 202;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ queued: true }));
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { queued: true });
});

test('adapter rejects a body above its bound without invoking a handler', async () => {
  let called = false;
  const response = await invokeNodeHandler(request('/api/receipts/issue', {
    method: 'POST', body: new Uint8Array(MAX_API_BODY_BYTES + 1)
  }), () => { called = true; });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'REQUEST_TOO_LARGE');
  assert.equal(called, false);
});

test('existing handler returns its JSON validation error before contacting services', async t => {
  t.mock.method(console, 'error', () => {});
  const handlers = createApiHandlers(env, { fetchImpl: noFetch });
  const response = await invokeNodeHandler(request('/api/receipts/issue', {
    method: 'POST', body: '{invalid json'
  }), handlers['/api/receipts/issue']);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_REQUEST');
});

test('existing receipt handler rejects an unauthenticated request without network access', async t => {
  t.mock.method(console, 'error', () => {});
  const handlers = createApiHandlers(env, { fetchImpl: noFetch });
  const response = await invokeNodeHandler(request('/api/receipts/issue', {
    method: 'POST', body: JSON.stringify({ type: 'court_booking', id })
  }), handlers['/api/receipts/issue']);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'SIGN_IN_REQUIRED');
});

test('cron handlers reject missing configuration and invalid authorisation', async t => {
  t.mock.method(console, 'error', () => {});
  for (const path of ['/api/notifications/process', '/api/cron/send-billing-emails']) {
    const unconfigured = createApiHandlers({}, { fetchImpl: noFetch });
    const missing = await invokeNodeHandler(request(path), unconfigured[path]);
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).code, 'CRON_NOT_CONFIGURED');
    const configured = createApiHandlers(env, { fetchImpl: noFetch });
    const unauthorised = await invokeNodeHandler(request(path, {
      headers: { Authorization: 'Bearer wrong-secret' }
    }), configured[path]);
    assert.equal(unauthorised.status, 401);
    assert.equal((await unauthorised.json()).code, 'UNAUTHORIZED');
  }
});

test('signed read-only cron checks preserve headers and do not process deliveries', async () => {
  const now = 1_799_999_900_000;
  const timestamp = String(Math.floor(now / 1000));
  for (const path of ['/api/notifications/process', '/api/cron/send-billing-emails']) {
    const signedPath = path + '?check=1';
    const signature = createHmac('sha256', env.CRON_SECRET)
      .update(`courtly-cron:${timestamp}:${signedPath}`).digest('hex');
    const handlers = createApiHandlers(env, {
      now: () => now,
      fetchImpl: noFetch,
      backend: {
        readiness: async () => ({ version: 1, ready: true }),
        rpc: noFetch
      }
    });
    const response = await invokeNodeHandler(request(signedPath, {
      headers: {
        'X-Courtly-Cron-Timestamp': timestamp,
        'X-Courtly-Cron-Signature': signature
      }
    }), handlers[path]);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).schema, { version: 1, ready: true });
  }
});

test('receipt downloads preserve PDF bytes and attachment headers', async () => {
  const receipt = {
    id, player_id: actorId, receipt_number: 'COURTLY-123',
    paid_at: '2026-11-06T10:00:00Z', player_name: 'Test Player',
    description: 'Test court booking', reference: 'TEST-123',
    payment_method: 'Venue payment', amount: 100
  };
  const handlers = createApiHandlers(env, {
    fetchImpl: noFetch,
    backend: {
      authenticate: async req => {
        assert.equal(req.headers.authorization, 'Bearer fictional-player-token');
        return { id: actorId };
      },
      rest: async path => {
        assert.match(path, new RegExp(`player_id=eq\\.${actorId}`));
        return [receipt];
      }
    }
  });
  const response = await invokeNodeHandler(request('/api/receipts/download?id=' + id, {
    headers: { Authorization: 'Bearer fictional-player-token' }
  }), handlers['/api/receipts/download']);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="COURTLY-123.pdf"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), receiptPdf.makeReceiptPdf(receipt));
});

test('repeated receipt IDs remain invalid and another player’s receipt remains inaccessible', async t => {
  t.mock.method(console, 'error', () => {});
  const handlers = createApiHandlers(env, {
    fetchImpl: noFetch,
    backend: {
      authenticate: async () => ({ id: actorId }),
      rest: async () => [{ id, player_id: id }]
    }
  });
  const repeated = await invokeNodeHandler(request(`/api/receipts/download?id=${id}&id=${id}`), handlers['/api/receipts/download']);
  assert.equal(repeated.status, 400);
  assert.equal((await repeated.json()).code, 'INVALID_RECEIPT');
  const anotherPlayer = await invokeNodeHandler(request(`/api/receipts/download?id=${id}`), handlers['/api/receipts/download']);
  assert.equal(anotherPlayer.status, 404);
  assert.equal((await anotherPlayer.json()).code, 'RECEIPT_NOT_FOUND');
});

test('unsupported methods preserve the handler’s Allow header', async () => {
  const handlers = createApiHandlers(env, { fetchImpl: noFetch });
  const response = await invokeNodeHandler(request('/api/receipts/issue'), handlers['/api/receipts/issue']);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('unexpected errors reveal neither request credentials nor exception contents', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  const secret = 'fictional-token-that-must-not-be-logged';
  const response = await invokeNodeHandler(request('/api/example', {
    headers: { Authorization: `Bearer ${secret}` }
  }), () => { throw new Error('Provider response containing ' + secret); });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(secret));
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(logs).includes('Provider response'));
});

test('activity shares use the supplied Worker bindings and escape event content', async () => {
  const handlers = createApiHandlers(env, {
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith(env.SUPABASE_URL + '/rest/v1/community_events?'));
      assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      return Response.json([{ id, status: 'published', title: '<Test activity>', sport: 'Tennis', city: 'Test city' }]);
    }
  });
  const response = await invokeNodeHandler(request('/api/community-event-share?id=' + id), handlers['/api/community-event-share']);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.ok(html.includes('&lt;Test activity&gt;'));
  assert.ok(!html.includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test('activity lookup failures keep sensitive provider exception contents out of logs', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  const handlers = createApiHandlers(env, {
    fetchImpl: async () => { throw new Error('Credential ' + env.SUPABASE_SERVICE_ROLE_KEY); }
  });
  const response = await invokeNodeHandler(request('/api/community-event-share?id=' + id), handlers['/api/community-event-share']);
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!JSON.stringify(logs).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});


test('account deletion requires explicit DELETE confirmation before backend work', async t => {
  t.mock.method(console, 'error', () => {});
  let authenticated = false;
  const handlers = createApiHandlers(env, {
    backend: {
      authenticate: async () => { authenticated = true; return { id: actorId }; }
    }
  });
  const response = await invokeNodeHandler(request('/api/account/delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer fictional-player-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'NO' })
  }), handlers['/api/account/delete']);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CONFIRMATION_REQUIRED');
  assert.equal(authenticated, false);
});

test('account deletion anonymises retained records, removes avatar, then deletes auth user', async () => {
  const calls = [];
  const handlers = createApiHandlers(env, {
    backend: {
      authenticate: async req => {
        assert.equal(req.headers.authorization, 'Bearer fictional-player-token');
        return { id: actorId };
      },
      rest: async path => {
        assert.equal(path, `player_profiles?id=eq.${actorId}&select=id,avatar_url`);
        return [{ id: actorId, avatar_url: actorId + '/avatar.webp' }];
      },
      rpc: async (name, args) => {
        calls.push(['rpc', name, args]);
        assert.equal(name, 'courtly_prepare_player_account_deletion');
        assert.deepEqual(args, { p_user_id: actorId });
        return true;
      }
    },
    admin: {
      storage: {
        from: bucket => {
          assert.equal(bucket, 'courtly-player-avatars');
          return {
            remove: async paths => {
              calls.push(['remove', paths]);
              assert.deepEqual(paths, [actorId + '/avatar.webp']);
              return { error: null };
            }
          };
        }
      },
      auth: {
        admin: {
          deleteUser: async idToDelete => {
            calls.push(['deleteUser', idToDelete]);
            assert.equal(idToDelete, actorId);
            return { error: null };
          }
        }
      }
    }
  });
  const response = await invokeNodeHandler(request('/api/account/delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer fictional-player-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'DELETE' })
  }), handlers['/api/account/delete']);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(calls.map(row => row[0]), ['remove', 'rpc', 'deleteUser']);
});
