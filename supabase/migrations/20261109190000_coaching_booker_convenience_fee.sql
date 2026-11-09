-- Coaching fee policy revision: ₱25 paid by the booker per successful booking.
-- The coach's published coaching rate is not reduced by this fee.

begin;

alter table public.coaching_bookings
  rename column coach_transaction_fee to booker_convenience_fee;

alter table public.coaching_bookings
  alter column booker_convenience_fee set default 25;

alter table public.coaching_bookings
  drop constraint if exists coaching_bookings_coach_transaction_fee_check;

alter table public.coaching_bookings
  drop constraint if exists coaching_bookings_booker_convenience_fee_check;

update public.coaching_bookings
set booker_convenience_fee = 25
where booker_convenience_fee is distinct from 25;

alter table public.coaching_bookings
  add constraint coaching_bookings_booker_convenience_fee_check
  check (booker_convenience_fee = 25::numeric);

create or replace function public.create_coaching_booking(
  p_coach_id uuid,
  p_starts_at timestamptz,
  p_duration_hours integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','auth','pg_temp'
as $function$
DECLARE
  v_coach public.coach_profiles%ROWTYPE;
  v_end timestamptz;
  v_ref text;
  v_id uuid;
  v_local timestamp;
  v_dow integer;
  v_fee numeric := 25;
  v_subtotal numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.player_profiles WHERE id=auth.uid()) THEN
    RAISE EXCEPTION 'Create or sign in to a Courtly player account before booking a coach';
  END IF;
  IF p_duration_hours IS NULL OR p_duration_hours NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'Choose between 1 and 8 coaching hours';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at <= now() THEN
    RAISE EXCEPTION 'Choose a future coaching timeslot';
  END IF;

  SELECT * INTO v_coach
  FROM public.coach_profiles
  WHERE id=p_coach_id AND is_published=true AND billing_status='active'
  FOR SHARE;

  IF NOT FOUND OR v_coach.hourly_rate<=0 THEN
    RAISE EXCEPTION 'This coach is not currently accepting bookings';
  END IF;
  IF COALESCE(v_coach.payment_provider,'')='' OR
     (COALESCE(v_coach.payment_qr_path,'')='' AND COALESCE(v_coach.payment_account_number,'')='') THEN
    RAISE EXCEPTION 'This coach has not completed payment setup yet. Please contact the coach or choose another coach.';
  END IF;

  v_end := p_starts_at + make_interval(hours=>p_duration_hours);
  v_local := p_starts_at AT TIME ZONE 'Asia/Manila';
  v_dow := extract(dow FROM v_local)::integer;
  v_subtotal := v_coach.hourly_rate * p_duration_hours;

  PERFORM pg_advisory_xact_lock(hashtext('coach-slot:' || p_coach_id::text));

  IF NOT EXISTS(
    SELECT 1 FROM public.coach_availability a
    WHERE a.coach_id=p_coach_id
      AND a.weekday=v_dow
      AND a.is_active
      AND v_local::time >= a.start_time
      AND (v_local::time + make_interval(hours=>p_duration_hours)) <= a.end_time
      AND mod((extract(epoch FROM (v_local::time-a.start_time))::integer / 60),a.slot_minutes)=0
  ) THEN
    RAISE EXCEPTION 'That time is outside the coach''s available schedule';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.coaching_bookings b
    WHERE b.coach_id=p_coach_id
      AND b.booking_status IN ('pending_payment','awaiting_verification','confirmed')
      AND (b.expires_at IS NULL OR b.expires_at>now())
      AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,v_end,'[)')
  ) THEN
    RAISE EXCEPTION 'That coaching slot has just been taken. Please choose another time';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.coach_blocked_slots x
    WHERE x.coach_id=p_coach_id
      AND tstzrange(x.starts_at,x.ends_at,'[)') && tstzrange(p_starts_at,v_end,'[)')
  ) THEN
    RAISE EXCEPTION 'The coach is unavailable during that time';
  END IF;

  v_ref := 'CO-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,9));

  INSERT INTO public.coaching_bookings(
    booking_reference,coach_id,player_id,coach_name_snapshot,coach_slug_snapshot,sport_snapshot,
    starts_at,ends_at,duration_hours,hourly_rate,subtotal,booker_convenience_fee,
    payment_status,booking_status,expires_at
  )
  VALUES(
    v_ref,p_coach_id,auth.uid(),v_coach.coach_name,v_coach.slug,v_coach.sport,
    p_starts_at,v_end,p_duration_hours,v_coach.hourly_rate,v_subtotal,v_fee,
    'pending','pending_payment',now()+interval '5 minutes'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'booking_id',v_id,
    'booking_reference',v_ref,
    'coach_name',v_coach.coach_name,
    'hourly_rate',v_coach.hourly_rate,
    'duration_hours',p_duration_hours,
    'subtotal',v_subtotal,
    'booker_convenience_fee',v_fee,
    'player_total',v_subtotal+v_fee,
    'fee_payer','booker',
    'payment_provider',v_coach.payment_provider,
    'payment_account_name',v_coach.payment_account_name,
    'payment_account_number',v_coach.payment_account_number,
    'payment_qr_path',v_coach.payment_qr_path,
    'payment_instructions',v_coach.payment_instructions,
    'expires_at',now()+interval '5 minutes'
  );
END;
$function$;

create or replace function public.review_coaching_booking(
  p_booking_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','auth','pg_temp'
as $function$
DECLARE
  v_booking public.coaching_bookings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in as the coach'; END IF;
  IF p_decision NOT IN ('confirmed','rejected') THEN RAISE EXCEPTION 'Invalid payment decision'; END IF;

  SELECT * INTO v_booking
  FROM public.coaching_bookings
  WHERE id=p_booking_id AND coach_id=auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Coaching session not found'; END IF;
  IF v_booking.payment_status=p_decision THEN
    RETURN jsonb_build_object('success',true,'already_processed',true,'status',p_decision);
  END IF;
  IF v_booking.payment_status<>'awaiting_verification' THEN
    RAISE EXCEPTION 'This coaching payment has already been processed';
  END IF;

  UPDATE public.coaching_bookings
  SET payment_status=p_decision,
      booking_status=CASE WHEN p_decision='confirmed' THEN 'confirmed' ELSE 'rejected' END,
      coach_note=COALESCE(NULLIF(trim(p_note),''),coach_note),
      confirmed_at=CASE WHEN p_decision='confirmed' THEN now() ELSE confirmed_at END,
      updated_at=now()
  WHERE id=p_booking_id;

  RETURN jsonb_build_object(
    'success',true,
    'already_processed',false,
    'status',p_decision,
    'booker_convenience_fee',CASE WHEN p_decision='confirmed' THEN v_booking.booker_convenience_fee ELSE 0 END,
    'fee_payer','booker'
  );
END;
$function$;

create or replace function public.courtly_record_coach_session_fee()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
BEGIN
  IF NEW.payment_status='confirmed' AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    INSERT INTO public.coach_fee_ledger(
      coach_id,booking_id,fee_type,description,fee_amount,occurred_at
    )
    VALUES(
      NEW.coach_id,
      NEW.id,
      'coaching_session_fee',
      'Booker-paid Courtly Convenience Fee collected with coaching booking · '||NEW.booking_reference,
      NEW.booker_convenience_fee,
      now()
    )
    ON CONFLICT(booking_id,fee_type) DO NOTHING;
  END IF;

  IF NEW.payment_status='refunded' AND OLD.payment_status='confirmed' THEN
    INSERT INTO public.coach_fee_ledger(
      coach_id,booking_id,fee_type,description,fee_amount,occurred_at
    )
    VALUES(
      NEW.coach_id,
      NEW.id,
      'coaching_session_credit',
      'Credit for refunded booker-paid Convenience Fee · '||NEW.booking_reference,
      -ABS(NEW.booker_convenience_fee),
      now()
    )
    ON CONFLICT(booking_id,fee_type) DO NOTHING;
  END IF;

  NEW.updated_at:=now();
  RETURN NEW;
END;
$function$;

revoke execute on function public.get_coach_sessions() from public, anon;
grant execute on function public.get_coach_sessions() to authenticated;

revoke execute on function public.get_my_coaching_sessions() from public, anon;
grant execute on function public.get_my_coaching_sessions() to authenticated;

commit;
