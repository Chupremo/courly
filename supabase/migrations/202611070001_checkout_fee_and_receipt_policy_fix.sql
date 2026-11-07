-- Courtly production checkout hotfix: flat PHP 10 court-booking fee and safe receipt upload policy.
-- Fixes payment receipt uploads failing with "permission denied for table community_events".
BEGIN;

-- Storage INSERT policies all participate in authorization. The original banner
-- policy queried community_events directly as the caller, so an unrelated
-- payment-receipt upload could fail because authenticated users do not have
-- table SELECT on community_events. Keep that table private and move the
-- authorization check behind a tightly-scoped SECURITY DEFINER helper.
CREATE OR REPLACE FUNCTION public.courtly_community_banner_upload_allowed(p_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,storage,auth,pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (storage.foldername(p_name))[1]=auth.uid()::text
    AND EXISTS(
      SELECT 1
      FROM public.community_events e
      WHERE e.id::text=(storage.foldername(p_name))[2]
        AND e.host_id=auth.uid()
        AND e.status='published'
    );
$$;
REVOKE ALL ON FUNCTION public.courtly_community_banner_upload_allowed(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_community_banner_upload_allowed(text) TO authenticated;

DROP POLICY IF EXISTS "Courtly players upload own activity banners" ON storage.objects;
CREATE POLICY "Courtly players upload own activity banners"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK(
  bucket_id='courtly-community-banners'
  AND public.courtly_community_banner_upload_allowed(name)
);

-- Court rental Convenience Fee is a flat PHP 10 per successful booking.
-- The venue owner pays it; it is not added to the player's total.
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
      p_starts_at,v_end,p_duration_hours,v_subtotal,10,v_subtotal,'pending','unpaid',coalesce(v.payment_method,'GCash'),v_expiry)
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

COMMENT ON COLUMN public.bookings.platform_fee IS
  'Courtly Convenience Fee owed by venue owner: flat PHP 10 per court booking. Not added to player total.';

-- Correct active unpaid holds created under the previous per-hour fee rule.
UPDATE public.bookings
SET platform_fee=10, updated_at=clock_timestamp()
WHERE status='pending'
  AND payment_status='unpaid'
  AND platform_fee IS DISTINCT FROM 10;

UPDATE public.courtly_checkout_holds
SET snapshot=jsonb_set(snapshot,'{owner_fee}',to_jsonb(10::numeric),true)
WHERE kind='court'
  AND submitted_at IS NULL
  AND cancelled_at IS NULL
  AND expires_at>clock_timestamp();

NOTIFY pgrst,'reload schema';
COMMIT;
