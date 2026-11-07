-- ROLLBACK OPTION FOR proposed_fee_only_owner_activation.sql
-- PROPOSED ONLY - DO NOT RUN IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
--
-- Purpose: restore the pre-trial owner-management permissions and remove the
-- new activation/publication guard without reintroducing a seven-day expiry.
-- It intentionally does NOT rewrite historical booking fees or invoice ledger rows.

BEGIN;

DROP TRIGGER IF EXISTS courtly_guard_venue_activation_state ON public.venues;
DROP FUNCTION IF EXISTS public.courtly_guard_venue_activation_state();

DROP FUNCTION IF EXISTS public.set_courtly_venue_activation(uuid,text);

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_public_activation_check;

DROP TRIGGER IF EXISTS courtly_set_flat_court_booking_fee ON public.bookings;
DROP FUNCTION IF EXISTS public.courtly_set_flat_court_booking_fee();

-- Return future accounts to the original always-usable defaults.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_activation_status_check;
ALTER TABLE public.venues
  ALTER COLUMN activation_status SET DEFAULT 'active',
  ALTER COLUMN is_published SET DEFAULT true;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_activation_status_check
  CHECK (activation_status IN ('pending','active','suspended'));

-- Do not restore trial expiry. Keep owner workspace permissions based on ownership.
CREATE OR REPLACE FUNCTION public.courtly_owner_trial_open(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.venues v
    WHERE v.id=p_venue_id AND v.owner_id=auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_owner_trial_open(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_trial_open(uuid) TO authenticated;

DROP POLICY IF EXISTS "Owners can update own venues" ON public.venues;
CREATE POLICY "Owners can update own venues" ON public.venues
FOR UPDATE TO authenticated
USING (owner_id=auth.uid())
WITH CHECK (owner_id=auth.uid());

DROP POLICY IF EXISTS "Owners can manage own courts" ON public.courts;
CREATE POLICY "Owners can manage own courts" ON public.courts
FOR ALL TO authenticated
USING (EXISTS(
  SELECT 1 FROM public.venues v
  WHERE v.id=venue_id AND v.owner_id=auth.uid()
))
WITH CHECK (EXISTS(
  SELECT 1 FROM public.venues v
  WHERE v.id=venue_id AND v.owner_id=auth.uid()
));

DROP POLICY IF EXISTS "Owners can update bookings for own venues" ON public.bookings;
CREATE POLICY "Owners can update bookings for own venues" ON public.bookings
FOR UPDATE TO authenticated
USING (EXISTS(
  SELECT 1 FROM public.venues v
  WHERE v.id=venue_id AND v.owner_id=auth.uid()
))
WITH CHECK (EXISTS(
  SELECT 1 FROM public.venues v
  WHERE v.id=venue_id AND v.owner_id=auth.uid()
));

COMMENT ON COLUMN public.bookings.platform_fee IS
  'Courtly Convenience Fee stored on the booking. Historical values are preserved.';

NOTIFY pgrst,'reload schema';
COMMIT;
