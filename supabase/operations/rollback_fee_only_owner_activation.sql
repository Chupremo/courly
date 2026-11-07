-- ROLLBACK OPTION FOR proposed_fee_only_owner_activation.sql
-- PROPOSED ONLY - DO NOT RUN IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
-- Restores the original PR #27 seven-day trial behavior and existing billing terms gate.
-- Historical bookings, invoices and fee-ledger rows are not rewritten.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname='courtly-expire-owner-trials';
  END IF;
END $$;

DROP TRIGGER IF EXISTS courtly_guard_venue_activation_state ON public.venues;
DROP FUNCTION IF EXISTS public.courtly_guard_venue_activation_state();

DROP TRIGGER IF EXISTS courtly_apply_owner_plan_to_booking ON public.bookings;
DROP FUNCTION IF EXISTS public.courtly_apply_owner_plan_to_booking();

DROP FUNCTION IF EXISTS public.courtly_expire_owner_trials();
DROP FUNCTION IF EXISTS public.get_courtly_admin_owner_accounts();
DROP FUNCTION IF EXISTS public.set_courtly_owner_account_status(uuid,text,text);
DROP FUNCTION IF EXISTS public.courtly_owner_can_manage_venue(uuid);

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_activation_status_check;

UPDATE public.venues
SET activation_status=CASE
  WHEN activation_status='on_hold' THEN 'frozen'
  WHEN activation_status IN ('suspended','banned') THEN 'frozen'
  WHEN activation_status='active' THEN 'active'
  ELSE 'trial'
END;

ALTER TABLE public.venues
  ALTER COLUMN trial_started_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN trial_ends_at SET DEFAULT (clock_timestamp()+interval '7 days'),
  ALTER COLUMN activation_status SET DEFAULT 'trial';

ALTER TABLE public.venues
  ADD CONSTRAINT venues_activation_status_check
  CHECK (activation_status IN ('trial','active','frozen'));

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
      AND (
        v.activation_status='active'
        OR (
          coalesce(v.activation_status,'trial')='trial'
          AND coalesce(v.trial_ends_at,clock_timestamp())>clock_timestamp()
        )
      )
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
    'status',
      CASE
        WHEN v.activation_status='active' THEN 'active'
        WHEN v.activation_status='frozen' THEN 'frozen'
        WHEN coalesce(v.trial_ends_at,clock_timestamp())<=clock_timestamp() THEN 'expired'
        ELSE 'trial'
      END,
    'trial_started_at',v.trial_started_at,
    'trial_ends_at',v.trial_ends_at,
    'days_remaining',
      greatest(0,ceil(extract(epoch from (coalesce(v.trial_ends_at,clock_timestamp())-clock_timestamp()))/86400.0))
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
USING (
  owner_id=auth.uid()
  AND (
    activation_status='active'
    OR (
      coalesce(activation_status,'trial')='trial'
      AND coalesce(trial_ends_at,clock_timestamp())>clock_timestamp()
    )
  )
)
WITH CHECK (
  owner_id=auth.uid()
  AND (
    activation_status='active'
    OR (
      coalesce(activation_status,'trial')='trial'
      AND coalesce(trial_ends_at,clock_timestamp())>clock_timestamp()
    )
  )
);

DROP POLICY IF EXISTS "Owners can manage own courts" ON public.courts;
CREATE POLICY "Owners can manage own courts" ON public.courts
FOR ALL TO authenticated
USING (public.courtly_owner_trial_open(venue_id))
WITH CHECK (public.courtly_owner_trial_open(venue_id));

DROP POLICY IF EXISTS "Owners can update bookings for own venues" ON public.bookings;
CREATE POLICY "Owners can update bookings for own venues" ON public.bookings
FOR UPDATE TO authenticated
USING (public.courtly_owner_trial_open(venue_id))
WITH CHECK (public.courtly_owner_trial_open(venue_id));

-- Restore the original paid-terms requirement for all new booking/open-play transactions.
CREATE OR REPLACE FUNCTION public.courtly_require_owner_terms_before_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_owner_id uuid;
  v_billing_status text;
  v_terms_version text;
BEGIN
  SELECT owner_id,billing_status
  INTO v_owner_id,v_billing_status
  FROM public.venues
  WHERE id=NEW.venue_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The venue for this transaction could not be found';
  END IF;

  IF v_billing_status='suspended' THEN
    RAISE EXCEPTION 'This venue is temporarily unavailable for new bookings while its Courtly account is suspended';
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
$$;
REVOKE ALL ON FUNCTION public.courtly_require_owner_terms_before_transaction() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_require_owner_terms_before_transaction() TO postgres;

COMMENT ON COLUMN public.bookings.platform_fee IS
  'Courtly fee deducted from owner payout: PHP 10 per booked court-hour under the pre-proposal implementation.';

NOTIFY pgrst,'reload schema';
COMMIT;
