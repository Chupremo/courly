-- Rollback-only release rehearsal. Run as the database administrator.
-- For a pre-deployment rehearsal, insert migrations 202611060005 and (optionally)
-- 202611060006 at the marker below, REMOVING their outer BEGIN/COMMIT statements.
-- NEVER paste an inner COMMIT: it would defeat this rehearsal's rollback.
-- No API/worker is invoked. Synthetic addresses use .invalid. Paid bookings are
-- only submitted for review, never marked paid, so no receipt sequence is used.
-- If any statement fails, execute ROLLBACK immediately before another query.
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

-- INSERT MIGRATION BODIES HERE (WITHOUT THEIR BEGIN/COMMIT WRAPPERS).

CREATE TEMP TABLE courtly_qa_checks(check_name text NOT NULL) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.courtly_qa_assert(p_ok boolean,p_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'COURTLY QA FAILED: %',p_name; END IF;
  INSERT INTO pg_temp.courtly_qa_checks VALUES(p_name);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.courtly_qa_identity(p_id uuid,p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',p_id::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_id,'role','authenticated','email',p_email)::text,true);
END $$;

-- This metadata-only object exercises the DB attachment checks. It is not a
-- real receipt upload and is rolled back together with the fixture records.
CREATE OR REPLACE FUNCTION pg_temp.courtly_qa_proof(p_path text,p_player uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='owner_id') THEN
    EXECUTE 'INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES($1,$2,$3,$4)'
      USING 'courtly-payment-receipts',p_path,p_player::text,'{"mimetype":"image/png","size":16}'::jsonb;
  ELSE
    INSERT INTO storage.objects(bucket_id,name,owner,metadata)
      VALUES('courtly-payment-receipts',p_path,p_player,'{"mimetype":"image/png","size":16}'::jsonb);
  END IF;
END $$;

DO $qa$
DECLARE
  p1 constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea1';
  p2 constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea2';
  qa_venue_id constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea3';
  court_id constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea4';
  paid_event constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea5';
  free_event constant uuid := 'd671c08a-7ef0-4626-865f-8cbd90188ea6';
  venue_slug constant text := 'courtly-rollback-qa-d671c08a';
  email1 constant text := 'courtly-rollback-qa-a-d671c08a@example.invalid';
  email2 constant text := 'courtly-rollback-qa-b-d671c08a@example.invalid';
  starts timestamptz := (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Manila')+interval '2 days 10 hours') AT TIME ZONE 'Asia/Manila';
  key1 uuid := gen_random_uuid(); key2 uuid := gen_random_uuid(); expiry_key uuid := gen_random_uuid();
  h jsonb; h2 jsonb; op jsonb; free_op jsonb; expired_hold jsonb; replacement jsonb;
  result jsonb; ready jsonb; path text; rejected boolean; terms text; f record;
  delivery_installed boolean := to_regprocedure('public.courtly_notification_readiness()') IS NOT NULL;
  jobs_before integer; bookings_before bigint; registrations_before bigint; users_before bigint;
BEGIN
  ready := public.courtly_booking_readiness();
  PERFORM pg_temp.courtly_qa_assert((ready->>'version')::int=1 AND (ready->>'ready')::boolean
    AND (ready->>'court_holds')::boolean AND (ready->>'open_play_holds')::boolean
    AND (ready->>'idempotent_submission')::boolean AND (ready->>'server_pricing')::boolean,'booking readiness contract');
  PERFORM pg_temp.courtly_qa_assert(has_function_privilege('anon','public.courtly_booking_readiness()','EXECUTE')
    AND NOT has_function_privilege('anon','public.create_court_checkout_hold(uuid,text,uuid,timestamptz,integer,text,text,text)','EXECUTE')
    AND NOT has_function_privilege('anon','public.submit_checkout_hold(uuid,text)','EXECUTE')
    AND has_function_privilege('authenticated','public.create_court_checkout_hold(uuid,text,uuid,timestamptz,integer,text,text,text)','EXECUTE')
    AND has_function_privilege('authenticated','public.submit_checkout_hold(uuid,text)','EXECUTE'),'anonymous/authenticated RPC permissions');
  PERFORM pg_temp.courtly_qa_assert(NOT has_table_privilege('anon','public.courtly_checkout_holds','SELECT')
    AND NOT has_table_privilege('authenticated','public.courtly_checkout_holds','INSERT')
    AND NOT has_function_privilege('authenticated','public.courtly_checkout_existing(uuid,text)','EXECUTE'),'private hold and helper permissions');
  FOR f IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('create_booking_request','register_open_play_player','cancel_unpaid_booking_request') LOOP
    PERFORM pg_temp.courtly_qa_assert(NOT has_function_privilege('anon',f.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',f.oid,'EXECUTE'),'legacy endpoint closed: '||f.proname);
  END LOOP;
  IF delivery_installed THEN
    EXECUTE 'SELECT public.courtly_notification_readiness()' INTO ready;
    PERFORM pg_temp.courtly_qa_assert((ready->>'version')::int=1 AND (ready->>'ready')::boolean,'notification readiness contract');
  END IF;

  PERFORM pg_temp.courtly_qa_assert(NOT EXISTS(SELECT 1 FROM auth.users WHERE id IN (p1,p2) OR email IN(email1,email2))
    AND NOT EXISTS(SELECT 1 FROM public.venues WHERE id=qa_venue_id OR slug=venue_slug),'fixture identities are unused');
  SELECT count(*) INTO bookings_before FROM public.bookings;
  SELECT count(*) INTO registrations_before FROM public.open_play_registrations;
  SELECT count(*) INTO users_before FROM auth.users;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(p1,'authenticated','authenticated',email1,clock_timestamp(),'{"provider":"email","providers":["email"]}',
      '{"account_type":"player","full_name":"Rollback QA Player A","player_name":"rollback_qa_a_d671"}',clock_timestamp(),clock_timestamp()),
      (p2,'authenticated','authenticated',email2,clock_timestamp(),'{"provider":"email","providers":["email"]}',
      '{"account_type":"player","full_name":"Rollback QA Player B","player_name":"rollback_qa_b_d671"}',clock_timestamp(),clock_timestamp());
  INSERT INTO public.player_profiles(id,full_name,player_name,email)
    VALUES(p1,'Rollback QA Player A','rollback_qa_a_d671',email1),(p2,'Rollback QA Player B','rollback_qa_b_d671',email2)
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.venues(id,owner_id,slug,name,timezone,hours_open,hours_close,peak_hours_start,peak_hours_end,is_published,payment_method,payment_account,payment_qr_url,admin_email)
    VALUES(qa_venue_id,p1,venue_slug,'Rollback QA Venue','Asia/Manila','08:00','22:00','18:00','22:00',true,'GCash','ROLLBACK TEST ONLY','https://example.invalid/qa-qr.png',email1);
  IF to_regclass('public.courtly_venue_terms_acceptance') IS NOT NULL THEN
    SELECT terms_version INTO terms FROM public.courtly_platform_settings WHERE singleton;
    INSERT INTO public.courtly_venue_terms_acceptance(venue_id,owner_id,terms_version) VALUES(qa_venue_id,p1,terms);
  END IF;
  INSERT INTO public.courts(id,venue_id,name,hourly_rate,off_peak_rate,peak_rate,is_active)
    VALUES(court_id,qa_venue_id,'Rollback QA Court',350,350,500,true);
  INSERT INTO public.open_play_events(id,venue_id,title,details,starts_at,location_text,fee,registration_limit,is_published)
    VALUES(paid_event,qa_venue_id,'Rollback paid session','Isolated rollback test; not a real event',starts+interval '1 day','Rollback QA only',150,1,true),
      (free_event,qa_venue_id,'Rollback free session','Isolated rollback test; not a real event',starts+interval '2 days','Rollback QA only',0,1,true);

  PERFORM pg_temp.courtly_qa_identity(p1,email1);
  h := public.create_court_checkout_hold(key1,venue_slug,court_id,starts,2,'QA Player A',email1,NULL);
  PERFORM pg_temp.courtly_qa_assert(h->>'status'='held' AND (h->>'total')::numeric=700
    AND (h->>'convenience_fee')::numeric=0 AND (h->>'owner_fee')::numeric=20,'court hold precedes payment and preserves fees');
  h2 := public.create_court_checkout_hold(key1,venue_slug,court_id,starts,2,'QA Player A',email1,NULL);
  PERFORM pg_temp.courtly_qa_assert(h2->>'hold_id'=h->>'hold_id','same request key returns the same court hold');
  h2 := public.create_court_checkout_hold(key2,venue_slug,court_id,starts,2,'QA Player A',email1,NULL);
  PERFORM pg_temp.courtly_qa_assert(h2->>'hold_id'=h->>'hold_id'
    AND (SELECT count(*)=2 FROM public.courtly_checkout_request_keys WHERE hold_id=(h->>'hold_id')::uuid),'second-tab request key aliases the same hold');
  rejected:=false;
  BEGIN
    PERFORM public.create_court_checkout_hold(key1,venue_slug,court_id,starts+interval '2 hours',1,'QA Player A',email1,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%different selection%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'reused request key cannot change the selected booking');
  PERFORM pg_temp.courtly_qa_identity(p2,email2);
  rejected:=false;
  BEGIN PERFORM public.get_checkout_hold((h->>'hold_id')::uuid,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%not found for this player%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'another player cannot read the hold');
  rejected:=false;
  BEGIN PERFORM public.submit_checkout_hold((h->>'hold_id')::uuid,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%not found for this player%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'another player cannot submit the hold');
  rejected:=false;
  BEGIN PERFORM public.create_court_checkout_hold(gen_random_uuid(),venue_slug,court_id,starts,2,'QA Player B',email2,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%already reserved%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'another player cannot take a held court interval');

  PERFORM pg_temp.courtly_qa_identity(p1,email1);
  UPDATE public.courts SET off_peak_rate=900,peak_rate=950 WHERE id=court_id;
  h2:=public.get_checkout_hold((h->>'hold_id')::uuid,NULL);
  PERFORM pg_temp.courtly_qa_assert((h2->>'total')::numeric=700,'held court price survives a later rate edit');
  path:=(h->>'receipt_prefix')||'qa-proof.png';
  PERFORM pg_temp.courtly_qa_assert(public.courtly_receipt_upload_allowed(path),'holder can upload proof while the hold is active');
  PERFORM pg_temp.courtly_qa_proof(path,p1);
  IF delivery_installed THEN
    SELECT count(*) INTO jobs_before FROM public.courtly_delivery_jobs WHERE source_id=(h->>'booking_id')::uuid;
    PERFORM pg_temp.courtly_qa_assert(jobs_before=0,'unpaid hold creates no delivery jobs');
  END IF;
  result:=public.submit_checkout_hold((h->>'hold_id')::uuid,path);
  PERFORM pg_temp.courtly_qa_assert(result->>'status'='submitted' AND result->>'payment_status'='awaiting_verification'
    AND (result->>'total')::numeric=700,'court proof keeps its held price and becomes awaiting verification');
  IF delivery_installed THEN SELECT count(*) INTO jobs_before FROM public.courtly_delivery_jobs WHERE source_id=(h->>'booking_id')::uuid; END IF;
  h2:=public.submit_checkout_hold((h->>'hold_id')::uuid,path);
  PERFORM pg_temp.courtly_qa_assert(h2->>'booking_id'=h->>'booking_id' AND h2->>'status'='submitted','court proof replay returns its existing result');
  IF delivery_installed THEN
    PERFORM pg_temp.courtly_qa_assert(jobs_before>0 AND (SELECT count(*)=jobs_before FROM public.courtly_delivery_jobs WHERE source_id=(h->>'booking_id')::uuid),'court replay does not duplicate durable notifications');
  END IF;

  op:=public.create_open_play_checkout_hold(gen_random_uuid(),paid_event,'QA Player A',email1,NULL);
  PERFORM pg_temp.courtly_qa_assert((op->>'subtotal')::numeric=150 AND (op->>'convenience_fee')::numeric=10 AND (op->>'total')::numeric=160,'paid Open Play reserves the final place at 150 plus 10');
  PERFORM pg_temp.courtly_qa_identity(p2,email2);
  rejected:=false;
  BEGIN PERFORM public.create_open_play_checkout_hold(gen_random_uuid(),paid_event,'QA Player B',email2,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%fully booked%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'another player cannot take the final held Open Play place');
  PERFORM pg_temp.courtly_qa_identity(p1,email1);
  UPDATE public.open_play_events SET fee=999 WHERE id=paid_event;
  IF to_regclass('public.courtly_venue_terms_acceptance') IS NOT NULL THEN
    DELETE FROM public.courtly_venue_terms_acceptance t WHERE t.venue_id=qa_venue_id;
    rejected:=false;
    BEGIN PERFORM public.create_open_play_checkout_hold(gen_random_uuid(),free_event,'QA Player A',email1,NULL);
    EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%accept the current booking terms%'; END;
    PERFORM pg_temp.courtly_qa_assert(rejected,'new Open Play holds check owner eligibility before payment');
  END IF;
  path:=(op->>'receipt_prefix')||'qa-proof.png';
  PERFORM pg_temp.courtly_qa_proof(path,p1);
  result:=public.submit_checkout_hold((op->>'hold_id')::uuid,path);
  PERFORM pg_temp.courtly_qa_assert(result->>'status'='submitted' AND (result->>'total')::numeric=160
    AND (SELECT fee=150 AND transaction_fee=10 AND transaction_fee_payer='player' AND player_total=160
      FROM public.open_play_registrations WHERE id=(result->>'registration_id')::uuid),'Open Play honors held price and eligibility after owner changes');
  h2:=public.submit_checkout_hold((op->>'hold_id')::uuid,path);
  PERFORM pg_temp.courtly_qa_assert(h2->>'registration_id'=result->>'registration_id'
    AND (SELECT count(*)=1 FROM public.open_play_registrations WHERE checkout_hold_id=(op->>'hold_id')::uuid),'Open Play proof replay creates exactly one registration');
  IF to_regclass('public.courtly_venue_terms_acceptance') IS NOT NULL THEN
    INSERT INTO public.courtly_venue_terms_acceptance(venue_id,owner_id,terms_version) VALUES(qa_venue_id,p1,terms);
  END IF;
  PERFORM pg_temp.courtly_qa_identity(p2,email2);
  free_op:=public.create_open_play_checkout_hold(gen_random_uuid(),free_event,'QA Player B',email2,NULL);
  result:=public.submit_checkout_hold((free_op->>'hold_id')::uuid,NULL);
  PERFORM pg_temp.courtly_qa_assert(result->>'status'='confirmed' AND (result->>'total')::numeric=0
    AND (SELECT fee=0 AND transaction_fee=0 AND transaction_fee_payer='none' AND player_total=0 AND receipt_path IS NULL
      FROM public.open_play_registrations WHERE id=(result->>'registration_id')::uuid),'free Open Play confirms with zero fee and no receipt');

  PERFORM pg_temp.courtly_qa_identity(p1,email1);
  expired_hold:=public.create_court_checkout_hold(expiry_key,venue_slug,court_id,starts+interval '4 hours',1,'QA Player A',email1,NULL);
  UPDATE public.courtly_checkout_holds SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=(expired_hold->>'hold_id')::uuid;
  UPDATE public.bookings SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=(expired_hold->>'booking_id')::uuid;
  rejected:=false;
  BEGIN PERFORM public.submit_checkout_hold((expired_hold->>'hold_id')::uuid,NULL);
  EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%hold has expired%'; END;
  PERFORM pg_temp.courtly_qa_assert(rejected,'expired hold refuses late payment submission');
  h2:=public.create_court_checkout_hold(expiry_key,venue_slug,court_id,starts+interval '4 hours',1,'QA Player A',email1,NULL);
  PERFORM pg_temp.courtly_qa_assert(h2->>'hold_id'=expired_hold->>'hold_id' AND h2->>'status'='expired','expired request replay cannot silently create a new hold');
  PERFORM pg_temp.courtly_qa_identity(p2,email2);
  replacement:=public.create_court_checkout_hold(gen_random_uuid(),venue_slug,court_id,starts+interval '4 hours',1,'QA Player B',email2,NULL);
  PERFORM pg_temp.courtly_qa_assert(replacement->>'status'='held' AND replacement->>'hold_id'<>expired_hold->>'hold_id'
    AND (SELECT status='cancelled' AND payment_status='unpaid' FROM public.bookings WHERE id=(expired_hold->>'booking_id')::uuid),'expired slot is reusable without dropping the exclusion constraint');

  PERFORM pg_temp.courtly_qa_assert((SELECT count(*)=3 FROM public.bookings b WHERE b.venue_id=qa_venue_id)
    AND (SELECT count(*)=2 FROM public.open_play_registrations r WHERE r.venue_id=qa_venue_id),'only the expected fixture reservations were created');
  PERFORM pg_temp.courtly_qa_assert((SELECT count(*)=bookings_before FROM public.bookings b WHERE b.venue_id<>qa_venue_id)
    AND (SELECT count(*)=registrations_before FROM public.open_play_registrations r WHERE r.venue_id IS DISTINCT FROM qa_venue_id)
    AND (SELECT count(*)=users_before FROM auth.users WHERE id NOT IN(p1,p2)),'existing customer record counts are unchanged');
  IF delivery_installed THEN
    PERFORM pg_temp.courtly_qa_assert(NOT EXISTS(SELECT 1 FROM public.courtly_delivery_jobs WHERE recipient_user_id IN(p1,p2)
      AND (status<>'pending' OR attempts<>0 OR recipient_email NOT LIKE '%@example.invalid')),'fixture notifications remain unsent and target only invalid addresses');
    PERFORM pg_temp.courtly_qa_assert(NOT EXISTS(SELECT 1 FROM public.courtly_delivery_jobs WHERE source_id=(expired_hold->>'booking_id')::uuid),'expired unpaid holds create no cancellation email');
    PERFORM pg_temp.courtly_qa_assert(NOT EXISTS(SELECT 1 FROM public.payment_receipts WHERE player_id IN(p1,p2)),'no paid receipt or receipt number is issued by the rehearsal');
  END IF;
END $qa$;

SELECT jsonb_build_object('passed_checks',count(*),'checks',jsonb_agg(check_name ORDER BY check_name)) AS rollback_qa_checks FROM pg_temp.courtly_qa_checks;
ROLLBACK;

-- This final read runs after rollback and is safe even when the new migrations
-- did not previously exist. A true result proves fixture accounts/venue are gone.
SELECT jsonb_build_object('passed',
  NOT EXISTS(SELECT 1 FROM auth.users WHERE id IN('d671c08a-7ef0-4626-865f-8cbd90188ea1'::uuid,'d671c08a-7ef0-4626-865f-8cbd90188ea2'::uuid))
  AND NOT EXISTS(SELECT 1 FROM public.venues WHERE id='d671c08a-7ef0-4626-865f-8cbd90188ea3'::uuid),
  'rolled_back',true,'emails_sent',false,'fixture_accounts_persisted',false) AS checkout_rollback_verification;
