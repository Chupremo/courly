-- Courtly hybrid fee policy (2026-11-05)
-- Court rentals: PHP 10 per booked court-hour, paid by the venue owner.
-- Paid Open Play: PHP 10 transaction fee added to the player's event registration price.
-- Free Open Play: no transaction fee and no payment receipt required.
-- IMPORTANT: venue GCash QR payments are received by the venue. Player-paid Open Play
-- transaction fees are tracked as Courtly remittance due; this migration does not move money.

BEGIN;

-- Preserve historical Open Play registrations under their former owner-paid treatment.
-- New paid registrations will explicitly use transaction_fee_payer = 'player'.
ALTER TABLE public.open_play_registrations
  ADD COLUMN IF NOT EXISTS transaction_fee_payer text NOT NULL DEFAULT 'venue_owner';

ALTER TABLE public.open_play_registrations
  DROP CONSTRAINT IF EXISTS open_play_registrations_transaction_fee_payer_check;
ALTER TABLE public.open_play_registrations
  ADD CONSTRAINT open_play_registrations_transaction_fee_payer_check
  CHECK (transaction_fee_payer IN ('player', 'venue_owner', 'none'));

-- Free Open Play registrations do not need a receipt.
ALTER TABLE public.open_play_registrations
  ALTER COLUMN receipt_path DROP NOT NULL;

-- Canonical amount due from the player. Historical owner-paid fees are excluded.
ALTER TABLE public.open_play_registrations
  ADD COLUMN IF NOT EXISTS player_total numeric(10,2)
  GENERATED ALWAYS AS (
    fee + CASE
      WHEN transaction_fee_payer = 'player' THEN transaction_fee
      ELSE 0
    END
  ) STORED;

COMMENT ON COLUMN public.open_play_registrations.transaction_fee_payer IS
  'Who bears the Open Play transaction fee. Legacy rows default to venue_owner; new paid registrations use player; free registrations use none.';
COMMENT ON COLUMN public.open_play_registrations.player_total IS
  'Checkout amount: event fee plus transaction_fee only when transaction_fee_payer is player.';

-- Replace the registration RPC. Pricing and fee payer are always calculated server-side
-- from the published event record; browser-supplied prices are never trusted.
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
    v_ref,
    v_event.id::text,
    v_event.id,
    v_event.title,
    v_venue.slug,
    v_venue.name,
    (v_event.starts_at AT TIME ZONE v_venue.timezone)::date,
    to_char(v_event.starts_at AT TIME ZONE v_venue.timezone, 'HH12:MI AM'),
    v_event.location_text,
    trim(p_player_name),
    lower(trim(p_player_email)),
    nullif(trim(p_player_phone), ''),
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

REVOKE ALL ON FUNCTION public.register_open_play_player(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_open_play_player(uuid, text, text, text, text) TO anon, authenticated;

-- Replace owner transaction report to expose the payer and full player checkout total.
DROP FUNCTION IF EXISTS public.get_owner_open_play_transactions(text);
CREATE FUNCTION public.get_owner_open_play_transactions(p_venue_slug text DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  registration_reference text,
  event_title text,
  event_date date,
  event_time text,
  player_name text,
  player_email text,
  player_phone text,
  fee numeric,
  transaction_fee numeric,
  transaction_fee_payer text,
  player_total numeric,
  payment_status text,
  registration_status text,
  receipt_path text,
  created_at timestamptz,
  venue_slug text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in as the venue owner';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.registration_reference,
    r.event_title,
    r.event_date,
    r.event_time,
    r.player_name,
    r.player_email,
    r.player_phone,
    r.fee,
    r.transaction_fee,
    r.transaction_fee_payer,
    r.player_total,
    r.payment_status,
    r.registration_status,
    r.receipt_path,
    r.created_at,
    r.venue_slug
  FROM public.open_play_registrations r
  JOIN public.venues v
    ON v.id = r.venue_id
    OR (r.venue_id IS NULL AND lower(trim(v.slug)) = lower(trim(r.venue_slug)))
  WHERE v.owner_id = auth.uid()
    AND (p_venue_slug IS NULL OR v.slug = p_venue_slug)
  ORDER BY r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_owner_open_play_transactions(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_open_play_transactions(text) TO authenticated;

-- Owner earnings distinguish registration revenue, player-paid pass-through fees,
-- and legacy owner-borne fees. Player-paid fees are never deducted from event revenue.
DROP FUNCTION IF EXISTS public.get_owner_open_play_earnings(text);
CREATE FUNCTION public.get_owner_open_play_earnings(p_venue_slug text)
RETURNS TABLE (
  registration_count bigint,
  confirmed_registration_count bigint,
  paid_count bigint,
  awaiting_count bigint,
  confirmed_registration_revenue numeric,
  player_paid_transaction_fees numeric,
  legacy_owner_fees numeric,
  total_player_amount_received numeric,
  venue_net_registration_revenue numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.venues v
    WHERE v.slug = p_venue_slug AND v.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to view Open Play earnings';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE r.registration_status <> 'cancelled')::bigint,
    count(*) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed')::bigint,
    count(*) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed' AND r.fee > 0)::bigint,
    count(*) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'awaiting_verification')::bigint,
    COALESCE(sum(r.fee) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed'), 0)::numeric,
    COALESCE(sum(r.transaction_fee) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed' AND r.transaction_fee_payer = 'player'), 0)::numeric,
    COALESCE(sum(r.transaction_fee) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed' AND r.transaction_fee_payer = 'venue_owner'), 0)::numeric,
    COALESCE(sum(r.player_total) FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed'), 0)::numeric,
    COALESCE(sum(r.fee - CASE WHEN r.transaction_fee_payer = 'venue_owner' THEN r.transaction_fee ELSE 0 END)
      FILTER (WHERE r.registration_status <> 'cancelled' AND r.payment_status = 'confirmed'), 0)::numeric
  FROM public.open_play_registrations r
  WHERE r.venue_slug = p_venue_slug;
END;
$$;

REVOKE ALL ON FUNCTION public.get_owner_open_play_earnings(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_open_play_earnings(text) TO authenticated;

COMMIT;

-- Post-migration verification
SELECT
  column_name,
  data_type,
  is_nullable,
  is_generated
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'open_play_registrations'
  AND column_name IN ('transaction_fee_payer', 'transaction_fee', 'player_total', 'receipt_path')
ORDER BY ordinal_position;

SELECT
  p.oid::regprocedure AS function_name,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('register_open_play_player', 'get_owner_open_play_transactions', 'get_owner_open_play_earnings')
ORDER BY p.proname;

-- Refresh Supabase PostgREST metadata for the updated columns and RPC return shapes.
NOTIFY pgrst, 'reload schema';
