-- Courtly owner 7-day trial.
-- Existing owner venues receive a fresh 7-day trial when this migration is applied.
-- New owner venues receive 7 days automatically.
BEGIN;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS activation_status text;

UPDATE public.venues
SET
  trial_started_at = COALESCE(trial_started_at, clock_timestamp()),
  trial_ends_at = COALESCE(trial_ends_at, clock_timestamp() + interval '7 days'),
  activation_status = COALESCE(NULLIF(activation_status,''), 'trial')
WHERE owner_id IS NOT NULL;

ALTER TABLE public.venues
  ALTER COLUMN trial_started_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN trial_ends_at SET DEFAULT (clock_timestamp() + interval '7 days'),
  ALTER COLUMN activation_status SET DEFAULT 'trial';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='venues_activation_status_check'
      AND conrelid='public.venues'::regclass
  ) THEN
    ALTER TABLE public.venues
      ADD CONSTRAINT venues_activation_status_check
      CHECK (activation_status IN ('trial','active','frozen'));
  END IF;
END $$;

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

-- Enforce trial/activation on the core owner-managed tables.
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

NOTIFY pgrst,'reload schema';
COMMIT;
