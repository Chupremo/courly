-- Courtly player-only booking gate (2026-11-05)
-- Public visitors can still discover venues and view court availability.
-- Booking and Open Play registration RPCs now require a signed-in player profile.
-- This does not change existing bookings, payments, fees or invoices.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS customer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

create or replace function public.create_booking_request(
  p_venue_slug text,
  p_court_id uuid,
  p_starts_at timestamptz,
  p_duration_hours integer,
  p_player_name text,
  p_player_email text,
  p_player_phone text default null,
  p_payment_method text default 'GCash'
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_venue public.venues%rowtype;
  v_court public.courts%rowtype;
  v_ends_at timestamptz;
  v_subtotal numeric(10,2) := 0;
  v_fee numeric(10,2);
  v_hour_start timestamptz;
  v_local_time time;
  v_is_peak boolean;
  i integer;
  v_booking public.bookings%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.player_profiles pp where pp.id = auth.uid()) then
    raise exception 'Please log in or create a Courtly player account before booking a court';
  end if;
  if coalesce(trim(p_player_name),'')='' or coalesce(trim(p_player_email),'')='' then
    raise exception 'Please provide your name and email address';
  end if;
  if p_duration_hours is null or p_duration_hours < 1 or p_duration_hours > 8 then
    raise exception 'Booking duration must be between 1 and 8 hours';
  end if;
  if p_starts_at is null or p_starts_at <= now() then raise exception 'Choose a future start time'; end if;
  if extract(minute from p_starts_at) <> 0 or extract(second from p_starts_at) <> 0 then
    raise exception 'Court reservations must start on the hour';
  end if;
  select * into v_venue from public.venues where slug=p_venue_slug and is_published=true;
  if not found then raise exception 'This venue is not available for booking'; end if;
  select * into v_court from public.courts where id=p_court_id and venue_id=v_venue.id and is_active=true;
  if not found then raise exception 'This court is not available'; end if;
  v_ends_at := p_starts_at + make_interval(hours => p_duration_hours);
  if (p_starts_at at time zone v_venue.timezone)::time < v_venue.hours_open
     or (v_ends_at at time zone v_venue.timezone)::time > v_venue.hours_close then
    raise exception 'The requested time is outside this venue''s operating hours';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_court_id::text), hashtext((p_starts_at at time zone v_venue.timezone)::date::text));
  if exists (
    select 1 from public.bookings b
    where b.court_id=p_court_id and b.starts_at < v_ends_at and b.ends_at > p_starts_at
      and b.status in ('pending','confirmed')
      and not (b.status='pending' and b.payment_status='unpaid' and b.created_at < now()-interval '20 minutes')
  ) then raise exception 'That court and time have just been reserved. Please select another slot'; end if;
  if exists (select 1 from public.court_blocks cb where cb.court_id=p_court_id and cb.starts_at < v_ends_at and cb.ends_at > p_starts_at) then
    raise exception 'That court is unavailable for the selected time';
  end if;
  for i in 0..(p_duration_hours-1) loop
    v_hour_start := p_starts_at + make_interval(hours => i);
    v_local_time := (v_hour_start at time zone v_venue.timezone)::time;
    v_is_peak := false;
    if v_venue.peak_hours_start is not null and v_venue.peak_hours_end is not null then
      if v_venue.peak_hours_start < v_venue.peak_hours_end then
        v_is_peak := v_local_time >= v_venue.peak_hours_start and v_local_time < v_venue.peak_hours_end;
      elsif v_venue.peak_hours_start > v_venue.peak_hours_end then
        v_is_peak := v_local_time >= v_venue.peak_hours_start or v_local_time < v_venue.peak_hours_end;
      end if;
    end if;
    v_subtotal := v_subtotal + case when v_is_peak then v_court.peak_rate else v_court.off_peak_rate end;
  end loop;
  v_fee := 10 * p_duration_hours;
  insert into public.bookings(
    venue_id,court_id,customer_user_id,customer_name,customer_email,customer_phone,starts_at,ends_at,
    duration_hours,subtotal,platform_fee,total,status,payment_status,payment_method,expires_at
  ) values (
    v_venue.id,v_court.id,auth.uid(),trim(p_player_name),lower(trim(p_player_email)),nullif(trim(p_player_phone),''),
    p_starts_at,v_ends_at,p_duration_hours,v_subtotal,v_fee,v_subtotal,'pending','unpaid',
    coalesce(nullif(trim(p_payment_method),''),'GCash'),now()+interval '20 minutes'
  ) returning * into v_booking;
  return jsonb_build_object(
    'id',v_booking.id,'reference',v_booking.reference,'venue_slug',v_venue.slug,
    'venue_name',v_venue.name,'court_id',v_court.id,'court_name',v_court.name,
    'starts_at',v_booking.starts_at,'ends_at',v_booking.ends_at,
    'duration_hours',v_booking.duration_hours,'subtotal',v_booking.subtotal,
    'platform_fee',v_booking.platform_fee,'total',v_booking.total,
    'customer_access_token',v_booking.customer_access_token,
    'payment_status',v_booking.payment_status,'status',v_booking.status
  );
end; $$;
REVOKE ALL ON FUNCTION public.create_booking_request(text,uuid,timestamptz,integer,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_booking_request(text,uuid,timestamptz,integer,text,text,text,text) TO authenticated;

create or replace function public.attach_booking_receipt(p_booking_id uuid,p_receipt_path text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_booking public.bookings%rowtype; v_slug text;
begin
  if auth.uid() is null or not exists (select 1 from public.player_profiles pp where pp.id = auth.uid()) then
    raise exception 'Please log in with your Courtly player account before submitting payment';
  end if;
  select b.* into v_booking from public.bookings b where b.id=p_booking_id;
  select v.slug into v_slug from public.bookings b join public.venues v on v.id=b.venue_id where b.id=p_booking_id;
  if not found or v_booking.id is null or v_booking.customer_user_id is distinct from auth.uid() or v_booking.status <> 'pending'
     or v_booking.payment_status <> 'unpaid' or v_booking.created_at < now()-interval '20 minutes'
     or v_booking.expires_at is null or v_booking.expires_at <= now() then
    raise exception 'This booking request has expired. Please start again';
  end if;
  if p_receipt_path not like v_slug||'/'||p_booking_id::text||'/%' then
    raise exception 'Invalid receipt path for this booking';
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id='courtly-payment-receipts' and o.name=p_receipt_path) then
    raise exception 'The uploaded payment receipt could not be found. Please upload it again';
  end if;
  if exists (select 1 from public.bookings other
    where other.id <> p_booking_id and other.court_id=v_booking.court_id
      and other.starts_at < v_booking.ends_at and other.ends_at > v_booking.starts_at
      and other.status in ('pending','confirmed')
      and not (other.status='pending' and other.payment_status='unpaid' and other.created_at < now()-interval '20 minutes')) then
    raise exception 'This timeslot has already been taken. Please contact the venue before paying again';
  end if;
  update public.bookings set payment_receipt_path=p_receipt_path,
    payment_status='awaiting_verification',receipt_submitted_at=now(),expires_at=null,updated_at=now()
  where id=p_booking_id;
  return jsonb_build_object('success',true,'reference',v_booking.reference,'booking_id',p_booking_id);
end; $$;
REVOKE ALL ON FUNCTION public.attach_booking_receipt(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_booking_receipt(uuid,text) TO authenticated;

create or replace function public.cancel_unpaid_booking_request(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  if auth.uid() is null or not exists (select 1 from public.player_profiles pp where pp.id = auth.uid()) then
    raise exception 'Please log in with your Courtly player account';
  end if;
  update public.bookings set status='cancelled',cancelled_at=now(),updated_at=now()
  where id=p_booking_id and customer_user_id=auth.uid() and status='pending' and payment_status='unpaid'
    and created_at > now()-interval '20 minutes';
  get diagnostics n=row_count;
  return n=1;
end; $$;
REVOKE ALL ON FUNCTION public.cancel_unpaid_booking_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_unpaid_booking_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_open_play_player(
  p_event_id uuid,
  p_player_name text,
  p_player_email text,
  p_player_phone text,
  p_receipt_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.open_play_events%ROWTYPE;
  v_venue public.venues%ROWTYPE;
  v_count integer;
  v_ref text;
  v_registration public.open_play_registrations%ROWTYPE;
  v_transaction_fee numeric(10,2);
  v_fee_payer text;
  v_payment_status text;
  v_registration_status text;
  v_receipt_path text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please log in or create a Courtly player account before joining Open Play';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.player_profiles pp WHERE pp.id = auth.uid()) THEN
    RAISE EXCEPTION 'Your Courtly player profile is not ready. Please complete registration and try again';
  END IF;

  IF COALESCE(trim(p_player_name), '') = ''
     OR COALESCE(trim(p_player_email), '') = '' THEN
    RAISE EXCEPTION 'Name and email are required';
  END IF;

  SELECT * INTO v_event
  FROM public.open_play_events
  WHERE id = p_event_id
    AND is_published = true
    AND starts_at >= now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This Open Play event is no longer available';
  END IF;

  SELECT * INTO v_venue
  FROM public.venues
  WHERE id = v_event.venue_id
    AND is_published = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This venue is not currently accepting registrations';
  END IF;

  -- Paid events require a receipt for the exact total: event fee + PHP 10.
  -- Free events have no receipt, no transaction fee, and are confirmed immediately.
  IF v_event.fee > 0 THEN
    IF COALESCE(trim(p_receipt_path), '') = '' THEN
      RAISE EXCEPTION 'Upload your payment receipt to register for this paid Open Play event';
    END IF;

    IF p_receipt_path NOT LIKE v_venue.slug || '/open-play/' || v_event.id::text || '/%' THEN
      RAISE EXCEPTION 'Invalid receipt path for this Open Play event';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'courtly-payment-receipts'
        AND o.name = p_receipt_path
    ) THEN
      RAISE EXCEPTION 'The uploaded payment receipt could not be found. Please upload it again';
    END IF;

    v_transaction_fee := 10;
    v_fee_payer := 'player';
    v_payment_status := 'awaiting_verification';
    v_registration_status := 'reserved';
    v_receipt_path := p_receipt_path;
  ELSE
    v_transaction_fee := 0;
    v_fee_payer := 'none';
    v_payment_status := 'confirmed';
    v_registration_status := 'confirmed';
    v_receipt_path := NULL;
  END IF;

  -- Serialize capacity checks so the last place cannot be double-registered.
  PERFORM pg_advisory_xact_lock(hashtext(v_event.id::text));

  SELECT count(*) INTO v_count
  FROM public.open_play_registrations
  WHERE event_uuid = v_event.id
    AND registration_status <> 'cancelled';

  IF v_event.registration_limit IS NOT NULL
     AND v_count >= v_event.registration_limit THEN
    RAISE EXCEPTION 'This Open Play session is fully booked';
  END IF;

  v_ref := 'OP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  INSERT INTO public.open_play_registrations (
    venue_id,
    player_id,
    registration_reference,
    event_id,
    event_uuid,
    event_title,
    venue_slug,
    venue_name,
    event_date,
    event_time,
    location_text,
    player_name,
    player_email,
    player_phone,
    fee,
    transaction_fee,
    transaction_fee_payer,
    receipt_path,
    payment_status,
    registration_status
  ) VALUES (
    v_venue.id,
    auth.uid(),
    v_ref,
    v_event.id::text,
    v_event.id,
    v_event.title,
    v_venue.slug,
    v_venue.name,
    (v_event.starts_at AT TIME ZONE v_venue.timezone)::date,
    to_char(v_event.starts_at AT TIME ZONE v_venue.timezone, 'HH12:MI AM'),
    v_event.location_text,
    COALESCE(NULLIF(trim((SELECT pp.player_name FROM public.player_profiles pp WHERE pp.id = auth.uid())), ''), NULLIF(trim((SELECT pp.full_name FROM public.player_profiles pp WHERE pp.id = auth.uid())), ''), trim(p_player_name)),
    lower(COALESCE(NULLIF(trim(auth.jwt() ->> 'email'), ''), trim(p_player_email))),
    COALESCE(NULLIF(trim((SELECT pp.phone FROM public.player_profiles pp WHERE pp.id = auth.uid())), ''), nullif(trim(p_player_phone), '')),
    v_event.fee,
    v_transaction_fee,
    v_fee_payer,
    v_receipt_path,
    v_payment_status,
    v_registration_status
  ) RETURNING * INTO v_registration;

  RETURN jsonb_build_object(
    'id', v_registration.id,
    'registration_reference', v_ref,
    'registered_count', v_count + 1,
    'fee', v_event.fee,
    'transaction_fee', v_transaction_fee,
    'transaction_fee_payer', v_fee_payer,
    'player_total', v_registration.player_total,
    'total_due', v_registration.player_total,
    'payment_status', v_registration.payment_status,
    'registration_status', v_registration.registration_status,
    'requires_payment', (v_event.fee > 0)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.register_open_play_player(uuid,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_open_play_player(uuid,text,text,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
