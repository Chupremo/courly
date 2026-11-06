const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let PGlite;
try {
  ({ PGlite } = require(process.env.COURTLY_TEST_PGLITE_PATH || '@electric-sql/pglite'));
} catch { /* Optional PostgreSQL test runtime; no production dependency. */ }

test('notification migration runs against isolated PostgreSQL', {
  skip: PGlite ? false : 'Set COURTLY_TEST_PGLITE_PATH to an installed @electric-sql/pglite package to run SQL integration checks.'
}, async t => {
  const db = new PGlite();
  const player = '11111111-1111-4111-8111-111111111111';
  const owner = '22222222-2222-4222-8222-222222222222';
  const venue = '33333333-3333-4333-8333-333333333333';
  const court = '44444444-4444-4444-8444-444444444444';
  const paidOpenPlay = '55555555-5555-4555-8555-555555555555';
  const freeOpenPlay = '66666666-6666-4666-8666-666666666666';
  const coaching = '77777777-7777-4777-8777-777777777777';
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const jobs = (type, id) => rows('select * from courtly_delivery_jobs where source_type=$1 and source_id=$2 order by created_at,id', [type, id]);
  const claim = (type, id, limit = 20) => rows('select * from courtly_delivery_claim($1,$2,$3,$4)', [limit, 'booking', type, id]);
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${player}','player@example.test','{"full_name":"Test Player"}'),('${owner}','owner@example.test','{}');
      create table venues(id uuid primary key,owner_id uuid,name text,admin_email text,timezone text,
        notify_email boolean default true,notify_pending boolean default true,notify_cancelled boolean default true);
      insert into venues(id,owner_id,name,admin_email,timezone) values
        ('${venue}','${owner}','Test Venue','venue@example.test','Asia/Manila');
      create table bookings(id uuid primary key,reference text,venue_id uuid,player_id uuid,customer_user_id uuid,
        customer_name text,customer_email text,total numeric,subtotal numeric,platform_fee numeric,
        status text,payment_status text,payment_method text,payment_receipt_path text,receipt_submitted_at timestamptz,
        starts_at timestamptz,ends_at timestamptz,paid_at timestamptz,confirmed_at timestamptz,
        created_at timestamptz default now(),updated_at timestamptz default now());
      create table open_play_registrations(id uuid primary key,registration_reference text,venue_id uuid,player_id uuid,
        player_name text,player_email text,event_title text,fee numeric,transaction_fee numeric,
        transaction_fee_payer text,player_total numeric,payment_status text,registration_status text,receipt_path text,
        event_date date,event_time text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table coaching_bookings(id uuid primary key,booking_reference text,coach_id uuid,player_id uuid,
        coach_name_snapshot text,subtotal numeric,payment_status text,booking_status text,receipt_path text,
        starts_at timestamptz,ends_at timestamptz,confirmed_at timestamptz,
        created_at timestamptz default now(),updated_at timestamptz default now());
      create table courtly_billing_email_events(id uuid primary key default gen_random_uuid(),venue_id uuid,
        invoice_id uuid,recipient_email text,event_type text,subject text,html_body text,
        status text default 'queued',send_after timestamptz default now(),sent_at timestamptz,last_error text,
        created_at timestamptz default now());
      create table courtly_invoices(id uuid primary key,status text,amount_due numeric,amount_paid numeric,due_at timestamptz);
    `);
    // Match the production receipt prerequisite rather than mocking its table.
    let receiptsMigration = readFileSync(join(__dirname, '../supabase/migrations/202611060001_payment_receipts.sql'), 'utf8');
    await db.exec(`create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;`);
    await db.exec(receiptsMigration);
    await db.exec(`insert into payment_receipts(source_type,source_id,player_id,player_email,description,reference,amount,email_status)
      values ('court_booking','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${player}','player@example.test','Legacy pending','LEGACY-1',100,'pending'),
        ('court_booking','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${player}','player@example.test','Legacy unknown','LEGACY-2',100,'processing');`);
    const migration = readFileSync(join(__dirname, '../supabase/migrations/202611060006_notification_delivery.sql'), 'utf8');
    await db.exec(migration);

    await t.test('readiness and database role boundaries are correct', async () => {
      const state = (await rows('select courtly_notification_readiness() as value'))[0].value;
      assert.equal(state.ready, true);
      assert.equal(state.coaching, true);
      const grants = (await rows(`select
        has_table_privilege('authenticated','courtly_delivery_jobs','select') as table_read,
        has_function_privilege('anon','courtly_delivery_claim(integer,text,text,uuid)','execute') as claim,
        has_function_privilege('anon','courtly_notification_readiness()','execute') as readiness`))[0];
      assert.deepEqual(grants, { table_read: false, claim: false, readiness: true });
    });

    await t.test('legacy processing outcomes need review, while unsent pending work is recoverable', async () => {
      const previous = await rows('select reference,email_status,j.status from payment_receipts r join courtly_delivery_jobs j on j.receipt_id=r.id order by reference');
      assert.deepEqual(previous.map(row => [row.reference, row.email_status, row.status]), [
        ['LEGACY-1', 'pending', 'pending'], ['LEGACY-2', 'failed', 'needs_review']
      ]);
    });

    await t.test('abandoned unpaid holds do not create notification jobs', async () => {
      await db.query(`insert into bookings(id,reference,venue_id,player_id,customer_user_id,customer_name,customer_email,
        total,subtotal,platform_fee,status,payment_status,payment_receipt_path)
        values ($1,'CT-TEST',$2,$3,$3,'Test Player','entered@example.test',700,700,20,'pending','unpaid','proof-1')`, [court, venue, player]);
      assert.equal((await jobs('court_booking', court)).length, 0);
      await db.query(`update bookings set status='cancelled' where id=$1`, [court]);
      assert.equal((await jobs('court_booking', court)).length, 0);
      await db.query(`update bookings set status='pending',payment_status='awaiting_verification' where id=$1`, [court]);
      const submitted = await jobs('court_booking', court);
      assert.equal(submitted.length, 2);
      assert.equal(submitted.find(row => row.payload.audience === 'player').recipient_email, 'player@example.test');
    });

    await t.test('payment confirmation and its receipt/outbox commit atomically without adding owner fees', async () => {
      await db.exec('begin');
      await db.query(`update bookings set payment_status='confirmed',status='confirmed',confirmed_at=now() where id=$1`, [court]);
      assert.equal((await rows('select * from payment_receipts where source_id=$1', [court])).length, 1);
      await db.exec('rollback');
      assert.equal((await rows('select * from payment_receipts where source_id=$1', [court])).length, 0);
      await db.query(`update bookings set payment_status='confirmed',status='confirmed',confirmed_at=now() where id=$1`, [court]);
      const saved = (await rows('select * from payment_receipts where source_id=$1', [court]))[0];
      assert.equal(Number(saved.amount), 700);
      const outbox = await jobs('court_booking', court);
      assert.equal(outbox.filter(row => row.kind === 'receipt').length, 1);
      assert.equal(outbox.filter(row => row.status === 'superseded').length, 2);
      await db.query('select courtly_delivery_reconcile_source($1,$2)', ['court_booking', court]);
      assert.equal((await jobs('court_booking', court)).length, outbox.length);
    });

    await t.test('paid Open Play receipts include the player-paid fee; free sessions get only confirmations', async () => {
      await db.query(`insert into open_play_registrations(id,registration_reference,venue_id,player_id,player_name,
        player_email,event_title,fee,transaction_fee,transaction_fee_payer,player_total,payment_status,registration_status)
        values ($1,'OP-PAID',$3,$4,'Test Player','player@example.test','Open Play',100,10,'player',110,'confirmed','confirmed'),
          ($2,'OP-FREE',$3,$4,'Test Player','player@example.test','Free Open Play',0,0,'none',0,'confirmed','confirmed')`, [paidOpenPlay, freeOpenPlay, venue, player]);
      const paid = await rows('select * from payment_receipts where source_id=$1', [paidOpenPlay]);
      assert.equal(paid.length, 1);
      assert.equal(Number(paid[0].amount), 110);
      assert.equal((await rows('select * from payment_receipts where source_id=$1', [freeOpenPlay])).length, 0);
      assert.equal((await jobs('open_play_registration', freeOpenPlay)).filter(row => row.event_type === 'booking_confirmed').length, 2);
    });

    await t.test('coaching payments use the session subtotal and owner preferences only suppress owner alerts', async () => {
      await db.query(`insert into coaching_bookings(id,booking_reference,coach_id,player_id,coach_name_snapshot,subtotal,
        payment_status,booking_status,confirmed_at) values($1,'COACH-1',$2,$3,'Test Coach',500,'confirmed','confirmed',now())`, [coaching, owner, player]);
      assert.equal(Number((await rows('select amount from payment_receipts where source_id=$1', [coaching]))[0].amount), 500);
      await db.query('update venues set notify_email=false where id=$1', [venue]);
      await db.query(`update open_play_registrations set registration_status='cancelled' where id=$1`, [freeOpenPlay]);
      const cancelled = (await jobs('open_play_registration', freeOpenPlay)).filter(row => row.event_type === 'booking_cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].payload.audience, 'player');
    });

    await t.test('claims exclude live leases and a stale worker cannot finish a reclaimed job', async () => {
      const first = await claim('court_booking', court);
      assert.equal(first.length, 2);
      assert.equal((await claim('court_booking', court)).length, 0);
      const selected = first.find(row => row.kind === 'receipt');
      await db.query(`update courtly_delivery_jobs set lease_until=now()-interval '1 second' where id=$1`, [selected.id]);
      const recovered = (await claim('court_booking', court))[0];
      assert.equal(recovered.id, selected.id);
      assert.notEqual(recovered.lease_token, selected.lease_token);
      const stale = (await rows(`select courtly_delivery_finish($1,$2,'sent','old-provider-id',null) as done`, [selected.id, selected.lease_token]))[0];
      assert.equal(stale.done, false);
      const payload = { from: 'Courtly <receipt@example.test>', to: ['player@example.test'], subject: 'Receipt', html: '<p>Paid</p>' };
      await db.query('select * from courtly_delivery_prepare($1,$2,$3)', [recovered.id, recovered.lease_token, JSON.stringify(payload)]);
      const prepared = (await rows('select * from courtly_delivery_prepare($1,$2,$3)', [recovered.id, recovered.lease_token, JSON.stringify({ ...payload, subject: 'Changed' })]))[0];
      assert.deepEqual(prepared.provider_payload, payload);
      const done = (await rows(`select courtly_delivery_finish($1,$2,'sent','provider-confirmed',null) as done`, [recovered.id, recovered.lease_token]))[0];
      assert.equal(done.done, true);
      assert.equal((await rows('select email_status,email_provider_id from payment_receipts where source_id=$1', [court]))[0].email_provider_id, 'provider-confirmed');
    });

    await t.test('expired unknown outcomes are held before provider idempotency expires', async () => {
      const claimed = await claim('open_play_registration', paidOpenPlay);
      assert.equal(claimed.length, 2);
      await db.query(`update courtly_delivery_jobs set first_attempt_at=now()-interval '24 hours',lease_until=now()-interval '1 second'
        where source_type='open_play_registration' and source_id=$1`, [paidOpenPlay]);
      assert.equal((await claim('open_play_registration', paidOpenPlay)).length, 0);
      assert.ok((await jobs('open_play_registration', paidOpenPlay)).every(row => row.status === 'needs_review'));
    });

    await t.test('billing claims discard settled invoices and obsolete reminders', async () => {
      await db.exec(`insert into courtly_invoices(id,status,amount_due,amount_paid,due_at) values
        ('88888888-8888-4888-8888-888888888888','paid',100,100,now()+interval '1 day'),
        ('99999999-9999-4999-8999-999999999999','overdue',100,0,now()-interval '1 day');
        insert into courtly_billing_email_events(invoice_id,recipient_email,event_type,subject,html_body) values
        ('88888888-8888-4888-8888-888888888888','owner@example.test','invoice_issued','Settled','<p>Old notice</p>'),
        ('99999999-9999-4999-8999-999999999999','owner@example.test','reminder_24h','Old reminder','<p>Old notice</p>'),
        ('99999999-9999-4999-8999-999999999999','owner@example.test','overdue','Current notice','<p>Overdue</p>'),
        ('88888888-8888-4888-8888-888888888888','owner@example.test','reminder_48h','Already delivered','<p>Sent earlier</p>');
        update courtly_billing_email_events set status='sent',sent_at=now() where subject='Already delivered';`);
      const batch = await rows(`select * from courtly_delivery_claim(20,'billing')`);
      assert.equal(batch.length, 1);
      assert.equal(batch[0].event_type, 'overdue');
      assert.equal((await rows(`select * from courtly_delivery_jobs where category='billing' and status='superseded'`)).length, 2);
      assert.equal((await rows(`select * from courtly_delivery_jobs where category='billing' and status='sent'`)).length, 1);
    });

    await t.test('a disabled required trigger makes readiness fail closed and migration is re-runnable', async () => {
      await db.exec('alter table bookings disable trigger courtly_notify_court_booking');
      assert.equal((await rows('select courtly_notification_readiness() as value'))[0].value.ready, false);
      await db.exec(migration);
      assert.equal((await rows('select courtly_notification_readiness() as value'))[0].value.ready, true);
      assert.equal((await rows('select * from payment_receipts where source_id=$1', [court])).length, 1);
    });
  } finally {
    await db.close();
  }
});
