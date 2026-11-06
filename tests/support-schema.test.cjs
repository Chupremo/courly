const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.COURTLY_TEST_PGLITE_PATH || '@electric-sql/pglite')); } catch { /* Optional local PostgreSQL runtime. */ }

test('private support migration enforces roles, account ownership and request limits in PostgreSQL', {
  skip: PGlite ? false : 'Set COURTLY_TEST_PGLITE_PATH to an installed @electric-sql/pglite package for local SQL checks.'
}, async t => {
  const db = new PGlite();
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const admin = '33333333-3333-4333-8333-333333333333';
  const ids = [1, 2, 3, 4].map(n => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`);
  const bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const migration = readFileSync(join(__dirname, '../supabase/migrations/202611060007_support_requests.sql'), 'utf8');
  const billing = readFileSync(join(__dirname, '../006_weekly_owner_billing_invoices.sql'), 'utf8');
  const adminFunction = billing.slice(billing.indexOf('CREATE OR REPLACE FUNCTION public.is_courtly_admin()'), billing.indexOf('-- The existing Auth trigger'));
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  async function as(role, uid, run) {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
    try { return await run(); }
    finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
  }
  const submit = (id, subject = 'Account help') => rows('select submit_courtly_support_request($1,$2,$3,$4) as id', [id, 'account', subject, 'Please help me with my account.']);
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;
      create table public.courtly_admin_users(user_id uuid primary key references auth.users(id),email text,created_at timestamptz default now());
      insert into auth.users(id,raw_user_meta_data) values ('${a}','{}'),('${b}','{"account_type":"courtly_admin"}'),('${admin}','{}');
      insert into public.courtly_admin_users(user_id,email) values ('${admin}','admin@example.test');
    `);
    await db.exec(adminFunction);
    await db.exec(migration);

    await t.test('anonymous users cannot read, submit or review requests', async () => {
      await as('anon', null, async () => {
        await assert.rejects(rows('select * from courtly_support_requests'), /permission denied/);
        await assert.rejects(submit(ids[0]), /permission denied/);
        await assert.rejects(rows("select review_courtly_support_request($1,'resolved','reply')", [ids[0]]), /permission denied/);
      });
      await as('authenticated', null, () => assert.rejects(submit(ids[0]), /Please sign in/));
    });

    await t.test('submissions are idempotent and users can read only their own requests', async () => {
      await as('authenticated', a, async () => {
        assert.equal((await submit(ids[0]))[0].id, ids[0]);
        assert.equal((await submit(ids[0]))[0].id, ids[0]);
        assert.equal((await rows('select * from courtly_support_requests')).length, 1);
        await assert.rejects(submit(ids[0], 'Changed contents'), /reference is already in use/);
      });
      await as('authenticated', b, async () => {
        assert.equal((await rows('select * from courtly_support_requests')).length, 0);
        await assert.rejects(submit(ids[0]), /reference is already in use/);
        await submit(bId);
        assert.equal((await rows('select * from courtly_support_requests'))[0].id, bId);
      });
      assert.equal((await rows('select count(*)::int as n from courtly_support_requests'))[0].n, 2);
    });

    await t.test('editable account metadata cannot grant administrator permissions or direct table writes', async () => {
      await as('authenticated', b, async () => {
        assert.equal((await rows('select is_courtly_admin() as allowed'))[0].allowed, false);
        await assert.rejects(rows("select review_courtly_support_request($1,'resolved','unauthorized reply')", [ids[0]]), /administrator access required/);
        await assert.rejects(rows("update courtly_support_requests set admin_reply='unauthorized' where id=$1", [bId]), /permission denied/);
        await assert.rejects(rows('delete from courtly_support_requests where id=$1', [bId]), /permission denied/);
      });
    });

    await t.test('only allowlisted administrators can review all requests and their replies remain private', async () => {
      await as('authenticated', admin, async () => {
        assert.equal((await rows('select * from courtly_support_requests')).length, 2);
        await rows("select review_courtly_support_request($1,'resolved','Verified account reply')", [ids[0]]);
      });
      await as('authenticated', a, async () => {
        const result = (await rows('select * from courtly_support_requests where id=$1', [ids[0]]))[0];
        assert.equal(result.status, 'resolved');
        assert.equal(result.admin_reply, 'Verified account reply');
      });
      await as('authenticated', b, async () => assert.equal((await rows('select * from courtly_support_requests where id=$1', [ids[0]])).length, 0));
    });

    await t.test('three requests per account per hour are allowed; retries do not consume extra capacity', async () => {
      await as('authenticated', a, async () => {
        await submit(ids[1]); await submit(ids[2]);
        await assert.rejects(submit(ids[3]), /three requests in the last hour/);
        assert.equal((await submit(ids[0]))[0].id, ids[0]);
        assert.equal((await rows('select * from courtly_support_requests')).length, 3);
      });
      await as('authenticated', b, async () => assert.equal((await rows('select * from courtly_support_requests')).length, 1));
    });

    await t.test('migration can be reapplied without changing private requests or replies', async () => {
      await db.exec(migration);
      assert.equal((await rows('select count(*)::int as n from courtly_support_requests'))[0].n, 4);
      assert.equal((await rows('select admin_reply from courtly_support_requests where id=$1', [ids[0]]))[0].admin_reply, 'Verified account reply');
    });
  } finally { await db.close(); }
});
