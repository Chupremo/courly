-- Courtly checkout protection, contract version 1.
-- Apply AFTER the consolidated backend, player accounts (002), and hybrid fees (005).
-- No historical booking/registration amounts, statuses or fee payers are rewritten.
-- Expiry is enforced by database time in every capacity/receipt operation; no cron is required.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.player_profiles') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='open_play_registrations' AND column_name='player_total')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='player_id') THEN
    RAISE EXCEPTION 'Checkout holds require the consolidated backend, player accounts (002), and hybrid fee policy (005). Apply those prerequisites first.';
  END IF;
END $$;

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS customer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Production also contains the historical payer label "owner". Preserve it,
-- while allowing the canonical zero-fee and owner-paid labels for new records.
ALTER TABLE public.open_play_registrations DROP CONSTRAINT IF EXISTS open_play_registrations_transaction_fee_payer_check;
ALTER TABLE public.open_play_registrations ADD CONSTRAINT open_play_registrations_transaction_fee_payer_check
  CHECK(transaction_fee_payer IN ('player','owner','venue_owner','none'));
ALTER TABLE public.open_play_registrations ALTER COLUMN receipt_path DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.courtly_checkout_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('court','openplay')),
  fingerprint text NOT NULL,
  booking_id uuid UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT,
  event_id uuid REFERENCES public.open_play_events(id) ON DELETE SET NULL,
  registration_id uuid UNIQUE REFERENCES public.open_play_registrations(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  cancelled_at timestamptz,
  CHECK ((kind='court' AND booking_id IS NOT NULL AND event_id IS NULL AND registration_id IS NULL)
      OR (kind='openplay' AND booking_id IS NULL))
);
CREATE INDEX IF NOT EXISTS courtly_checkout_player_selection_idx ON public.courtly_checkout_holds(player_id,fingerprint,created_at DESC);
CREATE INDEX IF NOT EXISTS courtly_checkout_event_capacity_idx ON public.courtly_checkout_holds(event_id,expires_at)
  WHERE kind='openplay' AND registration_id IS NULL AND cancelled_at IS NULL;

-- Different tabs may generate different request keys for the same reservation.
-- Persist every key as an alias so even a lost response can be safely replayed.
CREATE TABLE IF NOT EXISTS public.courtly_checkout_request_keys (
  player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  hold_id uuid NOT NULL REFERENCES public.courtly_checkout_holds(id) ON DELETE CASCADE,
  PRIMARY KEY (player_id,request_key)
);
ALTER TABLE public.courtly_checkout_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_checkout_request_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.courtly_checkout_holds,public.courtly_checkout_request_keys FROM PUBLIC,anon,authenticated;

ALTER TABLE public.open_play_registrations ADD COLUMN IF NOT EXISTS checkout_hold_id uuid REFERENCES public.courtly_checkout_holds(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS open_play_checkout_hold_unique ON public.open_play_registrations(checkout_hold_id) WHERE checkout_hold_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.courtly_checkout_existing(p_request_key uuid,p_fingerprint text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_hold public.courtly_checkout_holds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.player_profiles WHERE id=auth.uid()) THEN
    RAISE EXCEPTION 'Please sign in with your Courtly player account';
  END IF;
  IF p_request_key IS NULL THEN RAISE EXCEPTION 'A checkout request key is required'; END IF;
  -- Fixed lock order: player, then court/event, then hold/booking row.
  PERFORM pg_advisory_xact_lock(hashtext('courtly-checkout-player'),hashtext(auth.uid()::text));
  SELECT h.* INTO v_hold FROM public.courtly_checkout_request_keys k
    JOIN public.courtly_checkout_holds h ON h.id=k.hold_id
    WHERE k.player_id=auth.uid() AND k.request_key=p_request_key;
  IF FOUND THEN
    IF v_hold.fingerprint IS DISTINCT FROM p_fingerprint THEN
      RAISE EXCEPTION 'This checkout request belongs to a different selection. Please review your booking again';
    END IF;
    RETURN v_hold.id; -- Includes expired requests: a retry must never silently create another hold.
  END IF;
  SELECT h.* INTO v_hold FROM public.courtly_checkout_holds h
    LEFT JOIN public.bookings b ON b.id=h.booking_id
    LEFT JOIN public.open_play_registrations r ON r.id=h.registration_id
    WHERE h.player_id=auth.uid() AND h.fingerprint=p_fingerprint AND h.cancelled_at IS NULL
      AND ((h.kind='court' AND b.status IN ('pending','confirmed')
             AND (b.payment_status<>'unpaid' OR coalesce(b.expires_at,b.created_at+interval '20 minutes')>clock_timestamp()))
        OR (h.kind='openplay' AND r.registration_status<>'cancelled')
        OR (h.kind='openplay' AND h.registration_id IS NULL AND h.event_id IS NOT NULL AND h.expires_at>clock_timestamp()))
    ORDER BY h.created_at DESC LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.courtly_checkout_request_keys(player_id,request_key,hold_id) VALUES(auth.uid(),p_request_key,v_hold.id);
    RETURN v_hold.id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.courtly_checkout_existing(uuid,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.courtly_checkout_response(p_hold_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  h public.courtly_checkout_holds%ROWTYPE;
  b public.bookings%ROWTYPE;
  r public.open_play_registrations%ROWTYPE;
  v_status text := 'held'; v_payment text := 'unpaid'; v_uploaded text; v_prefix text;
BEGIN
  SELECT * INTO h FROM public.courtly_checkout_holds WHERE id=p_hold_id AND player_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkout not found for this player account'; END IF;
  IF h.kind='court' THEN
    SELECT * INTO b FROM public.bookings WHERE id=h.booking_id;
    v_payment := b.payment_status;
    v_status := CASE WHEN b.status IN ('cancelled','rejected') THEN b.status
      WHEN b.payment_status='confirmed' THEN 'confirmed'
      WHEN b.payment_status IN ('rejected','refunded') THEN b.payment_status
      WHEN b.payment_status='awaiting_verification' THEN 'submitted'
      WHEN coalesce(b.expires_at,b.created_at+interval '20 minutes')<=clock_timestamp() THEN 'expired'
      ELSE 'held' END;
  ELSIF h.registration_id IS NOT NULL THEN
    SELECT * INTO r FROM public.open_play_registrations WHERE id=h.registration_id;
    v_payment := r.payment_status;
    v_status := CASE WHEN r.registration_status='cancelled' THEN 'cancelled'
      WHEN r.payment_status='rejected' THEN 'rejected'
      WHEN r.payment_status='confirmed' THEN 'confirmed' ELSE 'submitted' END;
  ELSIF h.cancelled_at IS NOT NULL OR h.event_id IS NULL THEN v_status := 'cancelled';
  ELSIF h.expires_at<=clock_timestamp() THEN v_status := 'expired';
  END IF;
  v_prefix := h.snapshot->>'receipt_prefix';
  SELECT o.name INTO v_uploaded FROM storage.objects o
    WHERE o.bucket_id='courtly-payment-receipts' AND starts_with(o.name,v_prefix)
      AND coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text
    ORDER BY o.created_at DESC LIMIT 1;
  RETURN h.snapshot || jsonb_build_object(
    'version',1,'hold_id',h.id,'kind',h.kind,'player_id',h.player_id,
    'booking_id',h.booking_id,'registration_id',h.registration_id,
    'status',v_status,'payment_status',v_payment,'expires_at',h.expires_at,
    'server_now',clock_timestamp(),'uploaded_receipt_path',v_uploaded,
    'customer_access_token',b.customer_access_token
  );
END $$;
REVOKE ALL ON FUNCTION public.courtly_checkout_response(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_checkout_hold(p_hold_id uuid DEFAULT NULL,p_venue_slug text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in with your Courtly player account'; END IF;
  IF p_hold_id IS NOT NULL THEN RETURN public.courtly_checkout_response(p_hold_id); END IF;
  -- Recovery works even when local/session storage is unavailable.
  SELECT h.id INTO v_id FROM public.courtly_checkout_holds h JOIN public.venues v ON v.id=h.venue_id
    WHERE h.player_id=auth.uid() AND v.slug=p_venue_slug AND h.created_at>clock_timestamp()-interval '24 hours'
    ORDER BY (h.submitted_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at>clock_timestamp()) DESC,h.created_at DESC LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  RETURN public.courtly_checkout_response(v_id);
END $$;
REVOKE ALL ON FUNCTION public.get_checkout_hold(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_hold(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_court_checkout_hold(
  p_request_key uuid,p_venue_slug text,p_court_id uuid,p_starts_at timestamptz,p_duration_hours integer,
  p_player_name text,p_player_email text,p_player_phone text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v public.venues%ROWTYPE; c public.courts%ROWTYPE; b public.bookings%ROWTYPE;
  v_id uuid; v_fingerprint text; v_end timestamptz; v_expiry timestamptz;
  v_subtotal numeric(10,2):=0; v_rate numeric; v_off numeric; v_peak numeric;
  v_local_start timestamp; v_local_end timestamp; v_hour time; v_is_peak boolean; i integer;
BEGIN
  v_fingerprint := 'court:'||p_court_id::text||':'||(p_starts_at AT TIME ZONE 'UTC')::text||':'||p_duration_hours::text;
  IF v_fingerprint IS NULL THEN RAISE EXCEPTION 'Choose a court and valid booking time'; END IF;
  v_id := public.courtly_checkout_existing(p_request_key,v_fingerprint);
  IF v_id IS NOT NULL THEN RETURN public.courtly_checkout_response(v_id); END IF;
  IF coalesce(trim(p_player_name),'')='' OR char_length(trim(p_player_name))>120
     OR coalesce(trim(p_player_email),'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR char_length(p_player_email)>254 OR char_length(coalesce(p_player_phone,''))>40 THEN
    RAISE EXCEPTION 'Enter a valid player name, email address and phone number';
  END IF;
  IF p_duration_hours IS NULL OR p_duration_hours<1 OR p_duration_hours>8
     OR p_starts_at IS NULL OR p_starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'Choose a future booking of 1 to 8 hours'; END IF;
  SELECT * INTO v FROM public.venues WHERE slug=p_venue_slug AND is_published FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This venue is not available for booking'; END IF;
  SELECT * INTO c FROM public.courts WHERE id=p_court_id AND venue_id=v.id AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This court is not available'; END IF;
  v_end := p_starts_at+make_interval(hours=>p_duration_hours);
  v_local_start := p_starts_at AT TIME ZONE v.timezone;
  v_local_end := v_end AT TIME ZONE v.timezone;
  IF extract(minute FROM v_local_start)<>0 OR extract(second FROM v_local_start)<>0
     OR v_local_start::time<v.hours_open
     OR v_local_end>(v_local_start::date+v.hours_close)
     OR v.hours_close<=v.hours_open THEN
    RAISE EXCEPTION 'Choose whole hours within this venue''s opening times';
  END IF;
  -- All new checkout operations and conflict triggers use the same court lock.
  PERFORM pg_advisory_xact_lock(hashtext('courtly-court'),hashtext(c.id::text));
  -- Preserve the live exclusion constraint on pending/confirmed bookings.
  -- Expire only unpaid holds at runtime, before reusing their slot; never touch
  -- a submitted receipt, confirmed payment, or an unexpired reservation.
  UPDATE public.bookings SET status='cancelled',cancelled_at=coalesce(cancelled_at,clock_timestamp()),updated_at=clock_timestamp()
    WHERE court_id=c.id AND status='pending' AND payment_status='unpaid'
      AND coalesce(expires_at,created_at+interval '20 minutes')<=clock_timestamp();
  IF EXISTS(SELECT 1 FROM public.bookings x WHERE x.court_id=c.id AND x.starts_at<v_end AND x.ends_at>p_starts_at
      AND x.status IN ('pending','confirmed')
      AND NOT(x.status='pending' AND x.payment_status='unpaid' AND coalesce(x.expires_at,x.created_at+interval '20 minutes')<=clock_timestamp())) THEN
    RAISE EXCEPTION 'That court and time are already reserved. Please choose another slot';
  END IF;
  IF EXISTS(SELECT 1 FROM public.court_blocks x WHERE x.court_id=c.id AND x.starts_at<v_end AND x.ends_at>p_starts_at) THEN
    RAISE EXCEPTION 'That court is unavailable for the selected time';
  END IF;
  v_off:=coalesce(c.off_peak_rate,c.hourly_rate); v_peak:=coalesce(c.peak_rate,v_off);
  IF v_off IS NULL OR v_peak IS NULL OR v_off<0 OR v_peak<0 OR v_off::text='NaN' OR v_peak::text='NaN' THEN
    RAISE EXCEPTION 'This court''s price is unavailable. Please contact the venue';
  END IF;
  FOR i IN 0..p_duration_hours-1 LOOP
    v_hour:=((p_starts_at+make_interval(hours=>i)) AT TIME ZONE v.timezone)::time;
    v_is_peak:=v.peak_hours_start IS NOT NULL AND v.peak_hours_end IS NOT NULL AND
      ((v.peak_hours_start<v.peak_hours_end AND v_hour>=v.peak_hours_start AND v_hour<v.peak_hours_end)
       OR(v.peak_hours_start>v.peak_hours_end AND(v_hour>=v.peak_hours_start OR v_hour<v.peak_hours_end)));
    v_rate:=CASE WHEN v_is_peak THEN v_peak ELSE v_off END;
    v_subtotal:=v_subtotal+v_rate;
  END LOOP;
  IF v_subtotal>0 AND coalesce(trim(v.payment_qr_url),'')='' AND coalesce(trim(v.payment_account),'')='' THEN
    RAISE EXCEPTION 'This venue has not supplied payment details. Please contact the venue';
  END IF;
  v_expiry:=least(clock_timestamp()+interval '20 minutes',p_starts_at);
  INSERT INTO public.bookings(venue_id,court_id,customer_user_id,player_id,customer_name,customer_email,customer_phone,
    starts_at,ends_at,duration_hours,subtotal,platform_fee,total,status,payment_status,payment_method,expires_at)
    VALUES(v.id,c.id,auth.uid(),auth.uid(),trim(p_player_name),lower(trim(p_player_email)),nullif(trim(p_player_phone),''),
      p_starts_at,v_end,p_duration_hours,v_subtotal,10*p_duration_hours,v_subtotal,'pending','unpaid',coalesce(v.payment_method,'GCash'),v_expiry)
    RETURNING * INTO b;
  v_id:=gen_random_uuid();
  INSERT INTO public.courtly_checkout_holds(id,player_id,venue_id,kind,fingerprint,booking_id,expires_at,snapshot)
    VALUES(v_id,auth.uid(),v.id,'court',v_fingerprint,b.id,v_expiry,jsonb_build_object(
      'reference',b.reference,'venue_slug',v.slug,'venue_name',v.name,'timezone',v.timezone,'court_id',c.id,'court_name',c.name,
      'starts_at',b.starts_at,'ends_at',b.ends_at,'duration_hours',b.duration_hours,
      'subtotal',b.subtotal,'convenience_fee',0,'owner_fee',b.platform_fee,'fee_payer','venue_owner','total',b.total,
      'payment_method',v.payment_method,'payment_account',v.payment_account,'payment_instructions',v.payment_instructions,'payment_qr_url',v.payment_qr_url,
      'player_name',b.customer_name,'player_email',b.customer_email,'player_phone',b.customer_phone,
      'receipt_prefix',v.slug||'/'||b.id::text||'/'||v_id::text||'/'));
  INSERT INTO public.courtly_checkout_request_keys(player_id,request_key,hold_id) VALUES(auth.uid(),p_request_key,v_id);
  RETURN public.courtly_checkout_response(v_id);
END $$;
REVOKE ALL ON FUNCTION public.create_court_checkout_hold(uuid,text,uuid,timestamptz,integer,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_court_checkout_hold(uuid,text,uuid,timestamptz,integer,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_open_play_checkout_hold(
  p_request_key uuid,p_event_id uuid,p_player_name text,p_player_email text,p_player_phone text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v public.venues%ROWTYPE; e public.open_play_events%ROWTYPE;
  v_id uuid; v_fingerprint text; v_count bigint; v_fee numeric(10,2); v_expiry timestamptz; v_terms_version text;
BEGIN
  v_fingerprint:='openplay:'||p_event_id::text;
  IF v_fingerprint IS NULL THEN RAISE EXCEPTION 'Choose an Open Play session'; END IF;
  v_id:=public.courtly_checkout_existing(p_request_key,v_fingerprint);
  IF v_id IS NOT NULL THEN RETURN public.courtly_checkout_response(v_id); END IF;
  IF coalesce(trim(p_player_name),'')='' OR char_length(trim(p_player_name))>120
     OR coalesce(trim(p_player_email),'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR char_length(p_player_email)>254 OR char_length(coalesce(p_player_phone,''))>40 THEN
    RAISE EXCEPTION 'Enter a valid player name, email address and phone number';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_event_id::text));
  SELECT * INTO e FROM public.open_play_events WHERE id=p_event_id AND is_published AND starts_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This Open Play session is no longer available'; END IF;
  SELECT * INTO v FROM public.venues WHERE id=e.venue_id AND is_published FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This venue is not accepting registrations'; END IF;
  -- A held place is a reservation commitment. Check the same owner eligibility
  -- as a court booking now, before asking the player to transfer any money.
  IF coalesce(to_jsonb(v)->>'billing_status','active')='suspended' THEN
    RAISE EXCEPTION 'This venue is temporarily unavailable for new reservations';
  END IF;
  IF v.owner_id IS NOT NULL AND to_regclass('public.courtly_venue_terms_acceptance') IS NOT NULL
     AND to_regclass('public.courtly_platform_settings') IS NOT NULL THEN
    SELECT terms_version INTO v_terms_version FROM public.courtly_platform_settings WHERE singleton=true FOR SHARE;
    IF NOT EXISTS(SELECT 1 FROM public.courtly_venue_terms_acceptance
      WHERE venue_id=v.id AND owner_id=v.owner_id AND terms_version=v_terms_version) THEN
      RAISE EXCEPTION 'The venue owner must accept the current booking terms before accepting reservations';
    END IF;
  END IF;
  IF e.fee IS NULL OR e.fee<0 OR e.fee::text='NaN' THEN RAISE EXCEPTION 'This session''s price is unavailable'; END IF;
  IF e.fee>0 AND coalesce(trim(v.payment_qr_url),'')='' AND coalesce(trim(v.payment_account),'')='' THEN
    RAISE EXCEPTION 'This venue has not supplied payment details. Please contact the venue';
  END IF;
  IF EXISTS(SELECT 1 FROM public.open_play_registrations WHERE event_uuid=e.id AND player_id=auth.uid() AND registration_status<>'cancelled') THEN
    RAISE EXCEPTION 'You are already registered for this session. View the registration in your player account';
  END IF;
  SELECT (SELECT count(*) FROM public.open_play_registrations WHERE event_uuid=e.id AND registration_status<>'cancelled')
       + (SELECT count(*) FROM public.courtly_checkout_holds WHERE event_id=e.id AND registration_id IS NULL AND cancelled_at IS NULL AND expires_at>clock_timestamp()) INTO v_count;
  IF e.registration_limit IS NOT NULL AND v_count>=e.registration_limit THEN RAISE EXCEPTION 'This Open Play session is fully booked'; END IF;
  v_id:=gen_random_uuid(); v_fee:=CASE WHEN e.fee>0 THEN 10 ELSE 0 END;
  v_expiry:=least(clock_timestamp()+interval '20 minutes',e.starts_at);
  INSERT INTO public.courtly_checkout_holds(id,player_id,venue_id,kind,fingerprint,event_id,expires_at,snapshot)
    VALUES(v_id,auth.uid(),v.id,'openplay',v_fingerprint,e.id,v_expiry,jsonb_build_object(
      'reference','OP-'||upper(substr(replace(v_id::text,'-',''),1,12)),
      'venue_slug',v.slug,'venue_name',v.name,'timezone',v.timezone,'event_id',e.id,'event_title',e.title,
      'starts_at',e.starts_at,'event_date',(e.starts_at AT TIME ZONE v.timezone)::date,
      'event_time',to_char(e.starts_at AT TIME ZONE v.timezone,'HH12:MI AM'),'location_text',e.location_text,
      'subtotal',e.fee,'convenience_fee',v_fee,'owner_fee',0,'total',e.fee+v_fee,'fee_payer',CASE WHEN e.fee>0 THEN 'player' ELSE 'none' END,
      'owner_terms_version',v_terms_version,
      'payment_method',v.payment_method,'payment_account',v.payment_account,'payment_instructions',v.payment_instructions,'payment_qr_url',v.payment_qr_url,
      'player_name',trim(p_player_name),'player_email',lower(trim(p_player_email)),'player_phone',nullif(trim(p_player_phone),''),
      'receipt_prefix',v.slug||'/open-play/'||e.id::text||'/'||v_id::text||'/'));
  INSERT INTO public.courtly_checkout_request_keys(player_id,request_key,hold_id) VALUES(auth.uid(),p_request_key,v_id);
  RETURN public.courtly_checkout_response(v_id);
END $$;
REVOKE ALL ON FUNCTION public.create_open_play_checkout_hold(uuid,uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_open_play_checkout_hold(uuid,uuid,text,text,text) TO authenticated;

-- Keep the attachment RPC for legitimate pre-existing court holds. It is also
-- used by the new checkout, and safely acknowledges repeated successful submits.
CREATE OR REPLACE FUNCTION public.attach_booking_receipt(p_booking_id uuid,p_receipt_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.bookings%ROWTYPE; v_slug text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in with your Courtly player account'; END IF;
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND coalesce(customer_user_id,player_id)=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found for this player account'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('courtly-court'),hashtext(b.court_id::text));
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF b.status IN ('pending','confirmed') AND b.payment_status IN ('awaiting_verification','confirmed') AND b.payment_receipt_path IS NOT NULL THEN
    RETURN jsonb_build_object('success',true,'already_submitted',true,'reference',b.reference,'booking_id',b.id);
  END IF;
  IF b.status<>'pending' OR b.payment_status<>'unpaid' OR coalesce(b.expires_at,b.created_at+interval '20 minutes')<=clock_timestamp() THEN
    RAISE EXCEPTION 'This hold has expired or is no longer payable. If you already paid, contact the venue with your reference before paying again';
  END IF;
  SELECT slug INTO v_slug FROM public.venues WHERE id=b.venue_id;
  IF p_receipt_path IS NULL OR NOT starts_with(p_receipt_path,v_slug||'/'||b.id::text||'/')
     OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE bucket_id='courtly-payment-receipts' AND name=p_receipt_path
       AND coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) THEN
    RAISE EXCEPTION 'Your uploaded payment receipt could not be found. Please upload it again';
  END IF;
  IF EXISTS(SELECT 1 FROM public.bookings x WHERE x.id<>b.id AND x.court_id=b.court_id AND x.starts_at<b.ends_at AND x.ends_at>b.starts_at
    AND x.status IN ('pending','confirmed') AND NOT(x.status='pending' AND x.payment_status='unpaid' AND coalesce(x.expires_at,x.created_at+interval '20 minutes')<=clock_timestamp()))
    OR EXISTS(SELECT 1 FROM public.court_blocks x WHERE x.court_id=b.court_id AND x.starts_at<b.ends_at AND x.ends_at>b.starts_at) THEN
    RAISE EXCEPTION 'This time is no longer available. Contact the venue with your reference before paying again';
  END IF;
  UPDATE public.bookings SET payment_receipt_path=p_receipt_path,payment_status='awaiting_verification',
    receipt_submitted_at=clock_timestamp(),expires_at=NULL,updated_at=clock_timestamp() WHERE id=b.id;
  UPDATE public.courtly_checkout_holds SET submitted_at=coalesce(submitted_at,clock_timestamp()) WHERE booking_id=b.id;
  RETURN jsonb_build_object('success',true,'reference',b.reference,'booking_id',b.id);
END $$;
REVOKE ALL ON FUNCTION public.attach_booking_receipt(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.attach_booking_receipt(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_checkout_hold(p_hold_id uuid,p_receipt_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h public.courtly_checkout_holds%ROWTYPE; v_registration_id uuid; v_total numeric; v_court_id uuid;
BEGIN
  SELECT * INTO h FROM public.courtly_checkout_holds WHERE id=p_hold_id AND player_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkout not found for this player account'; END IF;
  IF h.kind='court' THEN
    SELECT court_id INTO v_court_id FROM public.bookings WHERE id=h.booking_id;
    PERFORM pg_advisory_xact_lock(hashtext('courtly-court'),hashtext(v_court_id::text));
  ELSE PERFORM pg_advisory_xact_lock(hashtext(h.event_id::text)); END IF;
  SELECT * INTO h FROM public.courtly_checkout_holds WHERE id=p_hold_id FOR UPDATE;
  IF h.submitted_at IS NOT NULL OR h.registration_id IS NOT NULL THEN RETURN public.courtly_checkout_response(h.id); END IF;
  IF h.cancelled_at IS NOT NULL OR h.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'This hold has expired. If you already paid, contact the venue with your reference before paying again';
  END IF;
  v_total:=(h.snapshot->>'total')::numeric;
  IF v_total>0 AND (p_receipt_path IS NULL OR NOT starts_with(p_receipt_path,h.snapshot->>'receipt_prefix')
    OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE bucket_id='courtly-payment-receipts' AND name=p_receipt_path
      AND coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text)) THEN
    RAISE EXCEPTION 'Your uploaded payment receipt could not be found. Please upload it again';
  END IF;
  IF h.kind='court' THEN
    -- Court rates of zero remain legitimate. They need no transfer or receipt.
    IF v_total=0 THEN
      UPDATE public.bookings SET payment_status='awaiting_verification',expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=h.booking_id AND status='pending' AND payment_status='unpaid'
          AND coalesce(expires_at,created_at+interval '20 minutes')>clock_timestamp();
      IF NOT FOUND THEN RAISE EXCEPTION 'This court hold is no longer available'; END IF;
    ELSE PERFORM public.attach_booking_receipt(h.booking_id,p_receipt_path); END IF;
  ELSE
    IF h.event_id IS NULL THEN RAISE EXCEPTION 'This event is no longer available. Contact the venue if you already paid'; END IF;
    -- Conversion uses the held price/fee payer, even if the venue edits its price.
    INSERT INTO public.open_play_registrations(venue_id,player_id,checkout_hold_id,registration_reference,event_id,event_uuid,event_title,
      venue_slug,venue_name,event_date,event_time,location_text,player_name,player_email,player_phone,
      fee,transaction_fee,transaction_fee_payer,receipt_path,payment_status,registration_status)
    VALUES(h.venue_id,h.player_id,h.id,h.snapshot->>'reference',h.event_id::text,h.event_id,h.snapshot->>'event_title',
      h.snapshot->>'venue_slug',h.snapshot->>'venue_name',(h.snapshot->>'event_date')::date,h.snapshot->>'event_time',h.snapshot->>'location_text',
      h.snapshot->>'player_name',h.snapshot->>'player_email',h.snapshot->>'player_phone',
      (h.snapshot->>'subtotal')::numeric,(h.snapshot->>'convenience_fee')::numeric,h.snapshot->>'fee_payer',
      CASE WHEN v_total>0 THEN p_receipt_path ELSE NULL END,
      CASE WHEN v_total>0 THEN 'awaiting_verification' ELSE 'confirmed' END,
      CASE WHEN v_total>0 THEN 'reserved' ELSE 'confirmed' END)
    RETURNING id INTO v_registration_id;
    UPDATE public.courtly_checkout_holds SET registration_id=v_registration_id WHERE id=h.id;
  END IF;
  UPDATE public.courtly_checkout_holds SET submitted_at=clock_timestamp() WHERE id=h.id;
  RETURN public.courtly_checkout_response(h.id);
END $$;
REVOKE ALL ON FUNCTION public.submit_checkout_hold(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_checkout_hold(uuid,text) TO authenticated;

-- Cross-tab creation is protected in the RPC; these triggers also serialize
-- other writers (including owner blocks) against the same capacity locks.
CREATE OR REPLACE FUNCTION public.courtly_guard_court_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='bookings' THEN
    IF NEW.status NOT IN ('pending','confirmed') OR (NEW.status='pending' AND NEW.payment_status='unpaid'
      AND coalesce(NEW.expires_at,NEW.created_at+interval '20 minutes')<=clock_timestamp()) THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' THEN
      IF NEW.court_id=OLD.court_id AND NEW.starts_at=OLD.starts_at AND NEW.ends_at=OLD.ends_at
        AND OLD.status IN ('pending','confirmed') AND NOT(OLD.status='pending' AND OLD.payment_status='unpaid'
          AND coalesce(OLD.expires_at,OLD.created_at+interval '20 minutes')<=clock_timestamp()) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('courtly-court'),hashtext(NEW.court_id::text));
  IF EXISTS(SELECT 1 FROM public.bookings b WHERE b.court_id=NEW.court_id
      AND (TG_TABLE_NAME<>'bookings' OR b.id<>NEW.id) AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at
      AND b.status IN ('pending','confirmed') AND NOT(b.status='pending' AND b.payment_status='unpaid'
        AND coalesce(b.expires_at,b.created_at+interval '20 minutes')<=clock_timestamp())) THEN
    RAISE EXCEPTION 'This court already has a reservation at that time';
  END IF;
  IF TG_TABLE_NAME='bookings' AND EXISTS(SELECT 1 FROM public.court_blocks b WHERE b.court_id=NEW.court_id AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at) THEN
    RAISE EXCEPTION 'This court is blocked at that time';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.courtly_guard_court_capacity() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS courtly_booking_capacity_guard ON public.bookings;
CREATE TRIGGER courtly_booking_capacity_guard BEFORE INSERT OR UPDATE OF court_id,starts_at,ends_at,status,payment_status,expires_at ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_court_capacity();
DROP TRIGGER IF EXISTS courtly_block_capacity_guard ON public.court_blocks;
CREATE TRIGGER courtly_block_capacity_guard BEFORE INSERT OR UPDATE OF court_id,starts_at,ends_at ON public.court_blocks
  FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_court_capacity();

CREATE OR REPLACE FUNCTION public.courtly_guard_open_play_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_limit integer; v_count bigint;
BEGIN
  IF NEW.registration_status='cancelled' OR NEW.event_uuid IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.event_uuid=OLD.event_uuid AND OLD.registration_status<>'cancelled' THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.event_uuid::text));
  -- A held place is already counted; conversion must not be rejected after payment
  -- because the owner reduced the limit or changed the published event price.
  IF NEW.checkout_hold_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.courtly_checkout_holds h
      WHERE h.id=NEW.checkout_hold_id AND h.kind='openplay' AND h.event_id=NEW.event_uuid AND h.player_id=NEW.player_id
        AND h.registration_id IS NULL AND h.cancelled_at IS NULL AND h.expires_at>clock_timestamp()
        AND NEW.fee=(h.snapshot->>'subtotal')::numeric AND NEW.transaction_fee=(h.snapshot->>'convenience_fee')::numeric
        AND NEW.transaction_fee_payer=h.snapshot->>'fee_payer') THEN
      RAISE EXCEPTION 'This checkout hold is no longer valid for that registration';
    END IF;
    RETURN NEW;
  END IF;
  SELECT registration_limit INTO v_limit FROM public.open_play_events WHERE id=NEW.event_uuid;
  SELECT (SELECT count(*) FROM public.open_play_registrations r WHERE r.event_uuid=NEW.event_uuid AND r.id<>NEW.id AND r.registration_status<>'cancelled')
       + (SELECT count(*) FROM public.courtly_checkout_holds h WHERE h.event_id=NEW.event_uuid AND h.registration_id IS NULL AND h.cancelled_at IS NULL AND h.expires_at>clock_timestamp()) INTO v_count;
  IF v_limit IS NOT NULL AND v_count>=v_limit THEN RAISE EXCEPTION 'This Open Play session is fully booked'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.courtly_guard_open_play_capacity() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS courtly_open_play_capacity_guard ON public.open_play_registrations;
CREATE TRIGGER courtly_open_play_capacity_guard BEFORE INSERT OR UPDATE OF event_uuid,registration_status ON public.open_play_registrations
  FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_open_play_capacity();

-- Honor a reservation made while the owner was eligible, just as court receipt
-- attachment honors its existing booking. A new/current terms check still runs
-- for every registration without a validated pre-payment hold. The guard above
-- rejects forged, mismatched or expired hold references before conversion.
DO $$ DECLARE r record;
BEGIN
  FOR r IN SELECT tgname FROM pg_trigger WHERE tgrelid='public.open_play_registrations'::regclass
    AND NOT tgisinternal AND tgfoid=to_regprocedure('public.courtly_require_owner_terms_before_transaction()') LOOP
    EXECUTE format('DROP TRIGGER %I ON public.open_play_registrations',r.tgname);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.open_play_registrations FOR EACH ROW WHEN (NEW.checkout_hold_id IS NULL) EXECUTE FUNCTION public.courtly_require_owner_terms_before_transaction()',r.tgname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_public_booked_slots(p_venue_slug text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(court_id uuid,starts_at timestamptz,ends_at timestamptz,slot_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT b.court_id,b.starts_at,b.ends_at,'booking'::text FROM public.bookings b JOIN public.venues v ON v.id=b.venue_id
    WHERE v.slug=p_venue_slug AND v.is_published AND b.starts_at<p_to AND b.ends_at>p_from AND b.status IN ('pending','confirmed')
      AND NOT(b.status='pending' AND b.payment_status='unpaid' AND coalesce(b.expires_at,b.created_at+interval '20 minutes')<=statement_timestamp())
  UNION ALL SELECT b.court_id,b.starts_at,b.ends_at,'blocked'::text FROM public.court_blocks b JOIN public.venues v ON v.id=b.venue_id
    WHERE v.slug=p_venue_slug AND v.is_published AND b.starts_at<p_to AND b.ends_at>p_from;
$$;
REVOKE ALL ON FUNCTION public.get_public_booked_slots(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_booked_slots(text,timestamptz,timestamptz) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_open_play_registration_counts(p_event_ids text[])
RETURNS TABLE(event_id text,registered_count bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT x.event_id,sum(x.n)::bigint FROM (
    SELECT r.event_uuid::text AS event_id,count(*) AS n FROM public.open_play_registrations r
      WHERE r.event_uuid::text=ANY(coalesce(p_event_ids,ARRAY[]::text[])) AND r.registration_status<>'cancelled' GROUP BY r.event_uuid
    UNION ALL
    SELECT h.event_id::text,count(*) FROM public.courtly_checkout_holds h
      WHERE h.event_id::text=ANY(coalesce(p_event_ids,ARRAY[]::text[])) AND h.registration_id IS NULL
        AND h.cancelled_at IS NULL AND h.expires_at>statement_timestamp() GROUP BY h.event_id
  ) x GROUP BY x.event_id;
$$;
REVOKE ALL ON FUNCTION public.get_open_play_registration_counts(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_open_play_registration_counts(text[]) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.courtly_receipt_upload_allowed(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS(SELECT 1 FROM public.courtly_checkout_holds h
      WHERE h.player_id=auth.uid() AND h.submitted_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at>statement_timestamp()
        AND starts_with(p_name,h.snapshot->>'receipt_prefix'))
    OR EXISTS(SELECT 1 FROM public.bookings b JOIN public.venues v ON v.id=b.venue_id
      WHERE coalesce(b.customer_user_id,b.player_id)=auth.uid() AND starts_with(p_name,v.slug||'/'||b.id::text||'/')
        AND b.status='pending' AND b.payment_status='unpaid' AND coalesce(b.expires_at,b.created_at+interval '20 minutes')>statement_timestamp())
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_receipt_upload_allowed(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_receipt_upload_allowed(text) TO authenticated;
DROP POLICY IF EXISTS "Customers can upload Courtly payment receipts" ON storage.objects;
DROP POLICY IF EXISTS "Courtly upload receipt for active booking or event" ON storage.objects;
CREATE POLICY "Courtly upload receipt for active booking or event" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK(bucket_id='courtly-payment-receipts' AND public.courtly_receipt_upload_allowed(name));

-- Retire browser entry points that do not carry a persistent idempotency key.
-- Existing legitimate records, owner review functions and receipt reads remain intact.
DO $$ DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('create_booking_request','register_open_play_player','cancel_unpaid_booking_request') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.courtly_booking_readiness()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('version',1,'ready',NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('create_booking_request','register_open_play_player','cancel_unpaid_booking_request')
        AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
      AND (SELECT count(*)=3 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
        AND tgname IN ('courtly_booking_capacity_guard','courtly_block_capacity_guard','courtly_open_play_capacity_guard'))
      AND EXISTS(SELECT 1 FROM storage.buckets WHERE id='courtly-payment-receipts' AND public=false)
      AND NOT has_table_privilege('authenticated','public.courtly_checkout_holds','INSERT')
      AND NOT has_table_privilege('anon','public.courtly_checkout_holds','INSERT'),
    'court_holds',true,'open_play_holds',true,'idempotent_submission',true,'server_pricing',true,'hold_seconds',1200);
$$;
REVOKE ALL ON FUNCTION public.courtly_booking_readiness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.courtly_booking_readiness() TO anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
