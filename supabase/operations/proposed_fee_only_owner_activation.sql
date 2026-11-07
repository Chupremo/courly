-- PROPOSED ONLY - DO NOT RUN IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
-- Courtly fee-only owner activation model.
--
-- Dependencies:
--   1) 006_weekly_owner_billing_invoices.sql (public.is_courtly_admin + billing state)
--   2) supabase/migrations/202611070002_owner_7_day_trial.sql (legacy activation columns)
--   3) supabase/migrations/202611060005_booking_checkout_holds.sql (current court checkout)
--
-- Goals:
--   * No 7-day owner workspace expiry.
--   * New owners can configure their venue indefinitely while verification is pending.
--   * Courtly activation controls PUBLIC LISTING / NEW BOOKINGS only.
--   * Existing reservations, payment review, calendar management and billing remain manageable.
--   * New court bookings carry a flat PHP 10 owner Convenience Fee per booking transaction.
--   * Existing confirmed/invoiced fees are not rewritten.

BEGIN;

-- 1) Replace trial semantics with a durable verification state.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_activation_status_check;

UPDATE public.venues
SET activation_status = CASE
      WHEN owner_id IS NOT NULL THEN 'active'
      ELSE 'pending'
    END,
    trial_started_at = NULL,
    trial_ends_at = NULL
WHERE activation_status IS DISTINCT FROM CASE
      WHEN owner_id IS NOT NULL THEN 'active'
      ELSE 'pending'
    END
   OR trial_started_at IS NOT NULL
   OR trial_ends_at IS NOT NULL;

ALTER TABLE public.venues
  ALTER COLUMN activation_status SET DEFAULT 'pending',
  ALTER COLUMN trial_started_at DROP DEFAULT,
  ALTER COLUMN trial_ends_at DROP DEFAULT,
  ALTER COLUMN is_published SET DEFAULT false;

ALTER TABLE public.venues
  ADD CONSTRAINT venues_activation_status_check
  CHECK (activation_status IN ('pending','active','suspended'));

-- Existing venues are grandfathered as active above and keep their current
-- is_published value. New owner venues default to pending + unpublished.

-- 2) Activation never controls owner workspace write access.
-- Keep the legacy helper for compatibility, but make it an ownership check only.
CREATE OR REPLACE FUNCTION public.courtly_owner_trial_open(p_venue_id uuid)
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
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_owner_trial_open(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_trial_open(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.courtly_owner_trial_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
  SELECT jsonb_build_object(
    'venue_id',v.id,
    'status',coalesce(v.activation_status,'pending'),
    'trial_started_at',NULL,
    'trial_ends_at',NULL,
    'days_remaining',NULL,
    'workspace_read_only',false,
    'public_bookings_enabled',
      coalesce(v.activation_status,'pending')='active'
      AND v.is_published=true
      AND coalesce(v.billing_status,'active')='active'
  )
  FROM public.venues v
  WHERE v.owner_id=auth.uid()
  ORDER BY v.created_at
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.courtly_owner_trial_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_trial_status() TO authenticated;

DROP POLICY IF EXISTS "Owners can update own venues" ON public.venues;
CREATE POLICY "Owners can update own venues" ON public.venues
FOR UPDATE TO authenticated
USING (owner_id=auth.uid())
WITH CHECK (owner_id=auth.uid());

DROP POLICY IF EXISTS "Owners can manage own courts" ON public.courts;
CREATE POLICY "Owners can manage own courts" ON public.courts
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id AND v.owner_id=auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id AND v.owner_id=auth.uid()
  )
);

DROP POLICY IF EXISTS "Owners can update bookings for own venues" ON public.bookings;
CREATE POLICY "Owners can update bookings for own venues" ON public.bookings
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id AND v.owner_id=auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.id=venue_id AND v.owner_id=auth.uid()
  )
);

-- 3) Owners cannot self-activate or self-publish.
-- Courtly admins use the RPC below. Trusted backend jobs (auth.uid() IS NULL)
-- keep working for billing/maintenance.
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
       OR NEW.is_published IS DISTINCT FROM OLD.is_published THEN
      RAISE EXCEPTION 'Courtly verification controls venue activation and public publishing';
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

CREATE OR REPLACE FUNCTION public.set_courtly_venue_activation(
  p_venue_id uuid,
  p_status text
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
  IF p_status NOT IN ('pending','active','suspended') THEN
    RAISE EXCEPTION 'Invalid activation status';
  END IF;

  SELECT * INTO v FROM public.venues WHERE id=p_venue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venue not found'; END IF;

  IF p_status='active' AND coalesce(v.billing_status,'active')<>'active' THEN
    RAISE EXCEPTION 'Resolve the venue billing suspension before activation';
  END IF;

  UPDATE public.venues
  SET activation_status=p_status,
      is_published=(p_status='active'),
      updated_at=now()
  WHERE id=p_venue_id
  RETURNING * INTO v;

  RETURN jsonb_build_object(
    'success',true,
    'venue_id',v.id,
    'activation_status',v.activation_status,
    'is_published',v.is_published
  );
END;
$$;
REVOKE ALL ON FUNCTION public.set_courtly_venue_activation(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_courtly_venue_activation(uuid,text) TO authenticated;

-- 4) Enforce flat PHP 10 fee for every NEW court booking.
-- The weekly ledger already records NEW.platform_fee only after payment is
-- confirmed and the booking is confirmed/completed, so pending/cancelled
-- bookings do not become billable.
CREATE OR REPLACE FUNCTION public.courtly_set_flat_court_booking_fee()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  NEW.platform_fee := 10;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS courtly_set_flat_court_booking_fee ON public.bookings;
CREATE TRIGGER courtly_set_flat_court_booking_fee
BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.courtly_set_flat_court_booking_fee();

COMMENT ON COLUMN public.bookings.platform_fee IS
  'Courtly Convenience Fee charged to the venue owner: flat PHP 10 per completed court-booking transaction. Stored on creation; ledgered only after confirmation.';

-- Defensive transition only for bookings that have not yet become billable.
-- This deliberately does NOT rewrite confirmed, completed or invoiced history.
UPDATE public.bookings
SET platform_fee=10
WHERE status='pending'
  AND payment_status IN ('unpaid','awaiting_verification')
  AND platform_fee IS DISTINCT FROM 10;

-- 5) A public venue must be activated and billing-current.
-- This prevents accidental publication of pending/suspended owners.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_public_activation_check;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_public_activation_check
  CHECK (
    is_published=false
    OR (
      activation_status='active'
      AND coalesce(billing_status,'active')='active'
    )
  );

NOTIFY pgrst,'reload schema';
COMMIT;
