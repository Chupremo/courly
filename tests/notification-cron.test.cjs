const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHmac } = require('node:crypto');
const { requireCron } = require('../server/courtly-backend.cjs');

let PGlite, pgcrypto;
try {
  const location = process.env.COURTLY_TEST_PGLITE_PATH || '@electric-sql/pglite';
  ({ PGlite } = require(location));
  ({ pgcrypto } = require(location.startsWith('/') ? join(location, 'dist/contrib/pgcrypto.cjs') : '@electric-sql/pglite/contrib/pgcrypto'));
} catch { /* Optional local-only SQL test runtime. */ }

test('scheduler SQL signs fixed worker paths without queueing the Vault secret', {
  skip: PGlite && pgcrypto ? false : 'Set COURTLY_TEST_PGLITE_PATH to run the PostgreSQL scheduler test.'
}, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const secret = 'fictional-test-secret-with-at-least-thirty-two-characters';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema extensions; create extension pgcrypto with schema extensions;
      create schema vault;
      create table vault.decrypted_secrets(name text primary key,decrypted_secret text not null);
      create schema net;
      create table net.http_request_queue(id bigint generated always as identity primary key,url text,headers jsonb,timeout_milliseconds integer);
      create function net.http_get(url text,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 2000)
      returns bigint language plpgsql as $$declare result bigint; begin
        insert into net.http_request_queue(url,headers,timeout_milliseconds) values(url,headers,timeout_milliseconds) returning id into result;
        return result;
      end $$;
    `);
    await db.query('insert into vault.decrypted_secrets values($1,$2)', ['courtly_delivery_cron_secret', secret]);
    const script = readFileSync(join(__dirname, '../supabase/operations/enable-delivery-cron.sql'), 'utf8');
    // pg_cron/pg_net workers are intentionally not started in a unit test.
    // Execute the real operator function against a capture-only HTTP function.
    await db.exec(script.slice(script.indexOf('create table if not exists'), script.indexOf('-- Named upserts')));
    await db.query(`select courtly_dispatch_delivery_cron('booking')`);
    await db.query(`select courtly_dispatch_delivery_cron('billing',false)`);
    const captured = (await db.query('select * from net.http_request_queue order by id')).rows;
    assert.equal(captured.length, 2);
    assert.equal(captured[0].url, 'https://www.courtlyph.com/api/notifications/process?check=1');
    assert.equal(captured[1].url, 'https://www.courtlyph.com/api/cron/send-billing-emails');
    for (const row of captured) {
      assert.equal(row.timeout_milliseconds, 55000);
      assert.ok(!JSON.stringify(row.headers).includes(secret));
      assert.equal(row.headers.Authorization, undefined);
      const path = new URL(row.url).pathname + new URL(row.url).search;
      const stamp = row.headers['X-Courtly-Cron-Timestamp'];
      const expected = createHmac('sha256', secret).update(`courtly-cron:${stamp}:${path}`).digest('hex');
      assert.equal(row.headers['X-Courtly-Cron-Signature'], expected);
      const headers = Object.fromEntries(Object.entries(row.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.doesNotThrow(() => requireCron({ headers }, { CRON_SECRET: secret }, path));
    }
    await assert.rejects(db.query(`select courtly_dispatch_delivery_cron('https://attacker.example',false)`));
    assert.equal((await db.query('select count(*) from net.http_request_queue')).rows[0].count, 2);
    const grants = (await db.query(`select has_function_privilege('authenticated','courtly_dispatch_delivery_cron(text,boolean)','execute') as browser,
      has_function_privilege('service_role','courtly_dispatch_delivery_cron(text,boolean)','execute') as api`)).rows[0];
    assert.deepEqual(grants, { browser: false, api: false });
  } finally { await db.close(); }
});
