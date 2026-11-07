-- PROPOSED ONLY - DO NOT RUN IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
-- Courtly 7-day owner trial + admin activation model.
--
-- Commercial rules:
--   * Trial lasts 7 days.
--   * Trial court bookings incur PHP 0 Courtly owner fee.
--   * Full activation is admin-only.
--   * After full activation, NEW court bookings incur PHP 10 per booked court-hour.
--   * Bookings created during trial remain fee-free even if confirmed after activation.
--   * Expired trials become ON HOLD automatically and stop accepting new bookings.
--   * Suspended / banned / on-hold venues cannot accept new bookings.
--
-- No historical confirmed/invoiced fee rows are rewritten.

BEGIN;

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_activation_status_check;

ALTER TABLE public.venues
  ALTER COLUMN trial_started_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN trial_ends_at SET DEFAULT (clock_timestamp() + interval '7 days'),
  ALTER COLUMN activation_status SET DEFAULT 'trial';

ALTER TABLE public.venues
  ADD CONSTRAINT venues_activation_status_check
  CHECK (activation_status IN ('trial','active','on_hold','suspended','banned'));

-- Preserve existing owner rows during rollout. Existing trial rows keep their
-- current trial dates; active rows stay active.
UPDATE public.venues
SET trial_started_at = coalesce(trial_started_at, created_at, clock_timestamp()),
    trial_ends_at = coalesce(trial_ends_at, coalesce(trial_started_at, created_at, clock_timestamp()) + interval '7 days')
WHERE activation_status='trial';

-- Owner workspace writes are allowed during trial and while on hold/suspended.
-- A banned venue remains readable but cannot be modified by the owner.
CREATE OR REPLACE FUNCTION public.courtly_owner_can_manage_venue(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1
    FROM public.venues v
    WHERE v.id=p_venue_id
      AND v.owner_id=auth.uid()
      AND coalesce(v.activation_status,'trial') <> 'banned'
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_owner_can_manage_venue(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_can_manage_venue(uuid) TO authenticated;

DROP POLICY IF EXISTS "Owners can update own venues" ON public.venues;
CREATE POLICY "Owners can update own venues" ON public.venues
FOR UPDATE TO authenticated
USING (owner_id=auth.uid() AND coalesce(activation_status,'trial') <> 'banned')
WITH CHECK (owner_id=auth.uid() AND coalesce(activation_status,'trial') <> 'banned');

DROP POLICY IF EXISTS "Owners can manage own courts" ON public.courts;
CREATE POLICY "Owners can manage own courts" ON public.courts
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id
      AND v.owner_id=auth.uid()
      AND coalesce(v.activation_status,'trial') <> 'banned'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id
      AND v.owner_id=auth.uid()
      AND coalesce(v.activation_status,'trial') <> 'banned'
  )
);

DROP POLICY IF EXISTS "Owners can update bookings for own venues" ON public.bookings;
CREATE POLICY "Owners can update bookings for own venues" ON public.bookings
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id
      AND v.owner_id=auth.uid()
      AND coalesce(v.activation_status,'trial') <> 'banned'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id
      AND v.owner_id=auth.uid()
      AND coalesce(v.activation_status,'trial') <> 'banned'
  )
);

-- Owners cannot change lifecycle status or publishing themselves.
CREATE OR REPLACE FUNCTION public.courtly_guard_venue_activation_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND OLD.owner_id=auth.uid()
     AND NOT public.is_courtly_admin() THEN
    IF NEW.activation_status IS DISTINCT FROM OLD.activation_status
       OR NEW.trial_started_at IS DISTINCT FROM OLD.trial_started_at
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
       OR NEW.is_published IS DISTINCT FROM OLD.is_published THEN
      RAISE EXCEPTION 'Courtly Administration controls venue activation and account status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_guard_venue_activation_state() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS courtly_guard_venue_activation_state ON public.venues;
CREATE TRIGGER courtly_guard_venue_activation_state
BEFORE UPDATE ON public.venues
FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_venue_activation_state();

-- Trial expiration: convert trial -> on_hold and stop new public bookings.
CREATE OR REPLACE FUNCTION public.courtly_expire_owner_trials()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.venues
  SET activation_status='on_hold',
      is_published=false,
      updated_at=now()
  WHERE activation_status='trial'
    AND trial_ends_at IS NOT NULL
    AND trial_ends_at <= clock_timestamp();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_expire_owner_trials() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_expire_owner_trials() TO service_role;

-- If pg_cron is available, run the expiration sweep every five minutes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname='courtly-expire-owner-trials';

    PERFORM cron.schedule(
      'courtly-expire-owner-trials',
      '*/5 * * * *',
      'select public.courtly_expire_owner_trials();'
    );
  END IF;
END $$;

-- Trial accounts do not need to accept the paid Courtly billing terms before
-- accepting bookings. Full activation keeps the existing terms requirement.
CREATE OR REPLACE FUNCTION public.courtly_require_owner_terms_before_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $
DECLARE
  v_owner_id uuid;
  v_billing_status text;
  v_activation_status text;
  v_terms_version text;
BEGIN
  SELECT owner_id,billing_status,coalesce(activation_status,'trial')
  INTO v_owner_id,v_billing_status,v_activation_status
  FROM public.venues
  WHERE id=NEW.venue_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The venue for this transaction could not be found';
  END IF;

  IF v_activation_status NOT IN ('trial','active') THEN
    RAISE EXCEPTION 'This venue is not currently accepting new bookings';
  END IF;

  IF v_billing_status='suspended' THEN
    RAISE EXCEPTION 'This venue is temporarily unavailable for new bookings while its Courtly account is suspended';
  END IF;

  -- Trial is intentionally fee-free and does not require the paid billing terms.
  IF v_activation_status='trial' THEN
    RETURN NEW;
  END IF;

  SELECT terms_version INTO v_terms_version
  FROM public.courtly_platform_settings
  WHERE singleton=true;

  IF v_owner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.courtly_venue_terms_acceptance t
    WHERE t.venue_id=NEW.venue_id
      AND t.owner_id=v_owner_id
      AND t.terms_version=v_terms_version
  ) THEN
    RAISE EXCEPTION 'The venue owner must accept the current Courtly Venue Owner Terms before accepting new bookings or Open Play registrations';
  END IF;

  RETURN NEW;
END;
$;
REVOKE ALL ON FUNCTION public.courtly_require_owner_terms_before_transaction() FROM PUBLIC,anon,authenticated;

-- Booking gate + fee assignment.
-- This runs before every booking insert, including SECURITY DEFINER checkout RPCs.
CREATE OR REPLACE FUNCTION public.courtly_apply_owner_plan_to_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_status text;
  v_trial_ends_at timestamptz;
BEGIN
  SELECT coalesce(v.activation_status,'trial'), v.trial_ends_at
  INTO v_status, v_trial_ends_at
  FROM public.venues v
  WHERE v.id=NEW.venue_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venue not found';
  END IF;

  IF v_status='trial' AND v_trial_ends_at IS NOT NULL AND v_trial_ends_at <= clock_timestamp() THEN
    UPDATE public.venues
    SET activation_status='on_hold', is_published=false, updated_at=now()
    WHERE id=NEW.venue_id AND activation_status='trial';
    RAISE EXCEPTION 'This venue trial is on hold. Please contact Courtly Administration.';
  END IF;

  IF v_status NOT IN ('trial','active') THEN
    RAISE EXCEPTION 'This venue is not currently accepting new bookings';
  END IF;

  IF v_status='trial' THEN
    NEW.platform_fee := 0;
  ELSE
    NEW.platform_fee := 10 * greatest(coalesce(NEW.duration_hours,1),1);
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_apply_owner_plan_to_booking() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS courtly_apply_owner_plan_to_booking ON public.bookings;
CREATE TRIGGER courtly_apply_owner_plan_to_booking
BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.courtly_apply_owner_plan_to_booking();

COMMENT ON COLUMN public.bookings.platform_fee IS
  'Courtly owner fee snapshotted when the booking is created. Trial = PHP 0. Fully active = PHP 10 per booked court-hour. Historical booking fees do not change when account status changes.';

-- Admin dashboard data.
CREATE OR REPLACE FUNCTION public.get_courtly_admin_owner_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Courtly administrator access required';
  END IF;

  PERFORM public.courtly_expire_owner_trials();

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'venue_id',v.id,
    'venue_name',v.name,
    'slug',v.slug,
    'owner_id',v.owner_id,
    'owner_name',v.owner_name,
    'owner_email',coalesce(v.admin_email,u.email),
    'phone',v.phone,
    'address',v.address,
    'city',v.city,
    'sport',v.sport,
    'activation_status',coalesce(v.activation_status,'trial'),
    'trial_started_at',v.trial_started_at,
    'trial_ends_at',v.trial_ends_at,
    'is_published',v.is_published,
    'billing_status',v.billing_status,
    'created_at',v.created_at,
    'booking_count',(select count(*) from public.bookings b where b.venue_id=v.id),
    'confirmed_booking_count',(select count(*) from public.bookings b where b.venue_id=v.id and b.status in ('confirmed','completed')),
    'trial_days_remaining',case
      when v.activation_status='trial' and v.trial_ends_at is not null
      then greatest(0,ceil(extract(epoch from (v.trial_ends_at-clock_timestamp()))/86400.0))::int
      else null
    end
  ) ORDER BY
    case coalesce(v.activation_status,'trial')
      when 'on_hold' then 1
      when 'trial' then 2
      when 'suspended' then 3
      when 'active' then 4
      when 'banned' then 5
      else 6 end,
    v.created_at DESC),'[]'::jsonb)
  INTO v_rows
  FROM public.venues v
  LEFT JOIN auth.users u ON u.id=v.owner_id;

  RETURN jsonb_build_object('venues',v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.get_courtly_admin_owner_accounts() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_courtly_admin_owner_accounts() TO authenticated;

-- Admin lifecycle controls.
CREATE OR REPLACE FUNCTION public.set_courtly_owner_account_status(
  p_venue_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v public.venues%ROWTYPE;
BEGIN
  IF NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Courtly administrator access required';
  END IF;

  IF p_status NOT IN ('trial','active','on_hold','suspended','banned') THEN
    RAISE EXCEPTION 'Invalid owner account status';
  END IF;

  SELECT * INTO v
  FROM public.venues
  WHERE id=p_venue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venue not found';
  END IF;

  IF p_status='active' AND coalesce(v.billing_status,'active')='suspended' THEN
    RAISE EXCEPTION 'Resolve the billing suspension before full activation';
  END IF;

  UPDATE public.venues
  SET activation_status=p_status,
      is_published=(p_status IN ('trial','active')),
      trial_started_at=CASE
        WHEN p_status='trial' THEN clock_timestamp()
        ELSE trial_started_at
      END,
      trial_ends_at=CASE
        WHEN p_status='trial' THEN clock_timestamp()+interval '7 days'
        ELSE trial_ends_at
      END,
      billing_suspend_reason=CASE
        WHEN p_status IN ('suspended','banned','on_hold')
        THEN coalesce(nullif(trim(p_reason),''),billing_suspend_reason)
        ELSE billing_suspend_reason
      END,
      updated_at=now()
  WHERE id=p_venue_id
  RETURNING * INTO v;

  RETURN jsonb_build_object(
    'success',true,
    'venue_id',v.id,
    'activation_status',v.activation_status,
    'is_published',v.is_published,
    'trial_started_at',v.trial_started_at,
    'trial_ends_at',v.trial_ends_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.set_courtly_owner_account_status(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_courtly_owner_account_status(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.courtly_owner_trial_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
DECLARE
  v public.venues%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v
  FROM public.venues
  WHERE owner_id=auth.uid()
  ORDER BY created_at
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  v_status:=coalesce(v.activation_status,'trial');
  IF v_status='trial' AND v.trial_ends_at IS NOT NULL AND v.trial_ends_at<=clock_timestamp() THEN
    v_status:='on_hold';
  END IF;

  RETURN jsonb_build_object(
    'venue_id',v.id,
    'status',v_status,
    'trial_started_at',v.trial_started_at,
    'trial_ends_at',v.trial_ends_at,
    'days_remaining',case
      when v_status='trial' and v.trial_ends_at is not null
      then greatest(0,ceil(extract(epoch from (v.trial_ends_at-clock_timestamp()))/86400.0))::int
      else 0
    end,
    'owner_fee_per_hour',case when v_status='active' then 10 else 0 end,
    'public_bookings_enabled',v_status in ('trial','active') and v.is_published=true,
    'workspace_read_only',v_status='banned'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_owner_trial_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_trial_status() TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
