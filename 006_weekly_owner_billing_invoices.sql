-- Courtly weekly owner billing, remittance and listing suspension
-- Apply AFTER migrations 001, 002/003 (player accounts), and 005 (hybrid fees).
-- Existing bookings/registrations are not back-billed: billing starts at billing_effective_at.
-- Venue owners keep direct receipt of player payments and remit Courtly fees weekly.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Platform settings and admin allowlist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.courtly_platform_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  terms_version text NOT NULL DEFAULT '2026-11-05-v1',
  billing_effective_at timestamptz NOT NULL DEFAULT now(),
  invoice_due_hours integer NOT NULL DEFAULT 72 CHECK (invoice_due_hours = 72),
  payment_method text NOT NULL DEFAULT 'GCash',
  payment_account_name text,
  payment_account_number text,
  payment_qr_url text,
  payment_instructions text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.courtly_platform_settings(singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.courtly_platform_settings
  DROP CONSTRAINT IF EXISTS courtly_platform_settings_invoice_due_hours_check;
ALTER TABLE public.courtly_platform_settings
  ADD CONSTRAINT courtly_platform_settings_invoice_due_hours_check
  CHECK (invoice_due_hours = 72);
UPDATE public.courtly_platform_settings SET invoice_due_hours = 72 WHERE singleton = true;

CREATE TABLE IF NOT EXISTS public.courtly_admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_courtly_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.courtly_admin_users a
      WHERE a.user_id = auth.uid()
    );
$$;
REVOKE ALL ON FUNCTION public.is_courtly_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_courtly_admin() TO authenticated;

-- The existing Auth trigger creates a venue for every non-player signup.
-- Ensure dedicated Courtly admin accounts do not accidentally receive a venue.
CREATE OR REPLACE FUNCTION public.courtly_create_owner_venue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  business_name text;
  business_address text;
  venue_sport text;
  requested_count text;
  court_total integer := 1;
  base_slug text;
  candidate_slug text;
  suffix integer := 2;
  new_venue_id uuid;
  i integer;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'account_type','') IN ('player','courtly_admin') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.venues WHERE owner_id=NEW.id) THEN RETURN NEW; END IF;

  business_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'business_name'),''),'My Courtly Venue');
  business_address := NULLIF(trim(NEW.raw_user_meta_data->>'business_address'),'');
  venue_sport := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''),'Multi-sport');
  requested_count := COALESCE(NEW.raw_user_meta_data->>'court_count','1');
  court_total := CASE
    WHEN requested_count IN ('4–5','4-5') THEN 4
    WHEN requested_count IN ('6–10','6-10') THEN 6
    WHEN requested_count='11+' THEN 11
    ELSE GREATEST(1,LEAST(50,COALESCE(NULLIF(regexp_replace(requested_count,'[^0-9]','','g'),'')::integer,1)))
  END;
  base_slug := public.courtly_make_slug(business_name);
  PERFORM pg_advisory_xact_lock(hashtext(base_slug));
  candidate_slug := base_slug;
  WHILE EXISTS (SELECT 1 FROM public.venues WHERE slug=candidate_slug) LOOP
    candidate_slug := base_slug || '-' || suffix::text;
    suffix := suffix + 1;
  END LOOP;
  INSERT INTO public.venues(owner_id,slug,name,address,city,admin_email,owner_name,phone,sport)
  VALUES (NEW.id,candidate_slug,business_name,business_address,
    NULLIF(trim(NEW.raw_user_meta_data->>'city'),''),NEW.email,
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_name'),''),
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_phone'),''),venue_sport)
  RETURNING id INTO new_venue_id;
  FOR i IN 1..court_total LOOP
    INSERT INTO public.courts(venue_id,name,sport,hourly_rate,is_active,display_order)
    VALUES (new_venue_id,'Court '||i,venue_sport,350,true,i)
    ON CONFLICT (venue_id,name) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Venue billing state (never delete venue or booking records on suspension)
-- ---------------------------------------------------------------------------
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS billing_was_published boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS billing_suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_suspend_reason text;

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_billing_status_check;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_billing_status_check
  CHECK (billing_status IN ('active', 'suspended'));

CREATE TABLE IF NOT EXISTS public.courtly_venue_terms_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, owner_id, terms_version)
);
CREATE INDEX IF NOT EXISTS courtly_terms_owner_idx
  ON public.courtly_venue_terms_acceptance(owner_id, accepted_at DESC);

CREATE OR REPLACE FUNCTION public.courtly_guard_venue_billing_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Dashboard/cron operations have no end-user auth.uid(); allow trusted backend execution.
  IF auth.uid() IS NOT NULL AND NOT public.is_courtly_admin() THEN
    IF NEW.billing_status IS DISTINCT FROM OLD.billing_status
       OR NEW.billing_was_published IS DISTINCT FROM OLD.billing_was_published
       OR NEW.billing_suspended_at IS DISTINCT FROM OLD.billing_suspended_at
       OR NEW.billing_suspend_reason IS DISTINCT FROM OLD.billing_suspend_reason THEN
      RAISE EXCEPTION 'Billing status is managed by Courtly and cannot be edited by venue owners';
    END IF;
    IF OLD.billing_status = 'suspended'
       AND NEW.is_published IS DISTINCT FROM OLD.is_published THEN
      RAISE EXCEPTION 'Your venue listing is temporarily suspended for an outstanding Courtly invoice. Settle the invoice to reactivate it.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS courtly_guard_venue_billing_state ON public.venues;
CREATE TRIGGER courtly_guard_venue_billing_state
BEFORE UPDATE ON public.venues
FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_venue_billing_state();

-- New court/Open Play transactions require acceptance of the current owner terms.
CREATE OR REPLACE FUNCTION public.courtly_require_owner_terms_before_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id uuid;
  v_billing_status text;
  v_terms_version text;
BEGIN
  SELECT owner_id, billing_status
    INTO v_owner_id, v_billing_status
  FROM public.venues
  WHERE id = NEW.venue_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The venue for this transaction could not be found';
  END IF;

  IF v_billing_status = 'suspended' THEN
    RAISE EXCEPTION 'This venue is temporarily unavailable for new bookings while its Courtly account is suspended';
  END IF;

  SELECT terms_version INTO v_terms_version
  FROM public.courtly_platform_settings
  WHERE singleton = true;

  IF v_owner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.courtly_venue_terms_acceptance t
    WHERE t.venue_id = NEW.venue_id
      AND t.owner_id = v_owner_id
      AND t.terms_version = v_terms_version
  ) THEN
    RAISE EXCEPTION 'The venue owner must accept the current Courtly Venue Owner Terms before accepting new bookings or Open Play registrations';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS courtly_require_terms_for_booking ON public.bookings;
CREATE TRIGGER courtly_require_terms_for_booking
BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.courtly_require_owner_terms_before_transaction();

DROP TRIGGER IF EXISTS courtly_require_terms_for_open_play ON public.open_play_registrations;
CREATE TRIGGER courtly_require_terms_for_open_play
BEFORE INSERT ON public.open_play_registrations
FOR EACH ROW EXECUTE FUNCTION public.courtly_require_owner_terms_before_transaction();

CREATE OR REPLACE FUNCTION public.accept_courtly_venue_terms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version text;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in as the venue owner to accept the terms';
  END IF;

  SELECT terms_version INTO v_version
  FROM public.courtly_platform_settings WHERE singleton = true;

  INSERT INTO public.courtly_venue_terms_acceptance(venue_id, owner_id, terms_version)
  SELECT id, auth.uid(), v_version
  FROM public.venues
  WHERE owner_id = auth.uid()
  ON CONFLICT (venue_id, owner_id, terms_version) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF NOT EXISTS (SELECT 1 FROM public.venues WHERE owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'No venue is linked to this owner account';
  END IF;

  RETURN jsonb_build_object('success', true, 'terms_version', v_version, 'new_acceptances', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_courtly_venue_terms() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_courtly_venue_terms() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Invoices, fee ledger, invoice lines and owner remittances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.courtly_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  amount_due numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  amount_paid numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued','partially_paid','paid','overdue','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (due_at = issued_at + interval '72 hours')
);
CREATE INDEX IF NOT EXISTS courtly_invoices_owner_idx
  ON public.courtly_invoices(owner_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS courtly_invoices_venue_status_idx
  ON public.courtly_invoices(venue_id, status, due_at);

CREATE TABLE IF NOT EXISTS public.courtly_fee_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('court_booking','open_play_registration')),
  source_id uuid NOT NULL,
  fee_type text NOT NULL,
  description text NOT NULL,
  fee_amount numeric(12,2) NOT NULL CHECK (fee_amount <> 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid REFERENCES public.courtly_invoices(id) ON DELETE RESTRICT,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, fee_type)
);
CREATE INDEX IF NOT EXISTS courtly_fee_ledger_uninvoiced_idx
  ON public.courtly_fee_ledger(venue_id, occurred_at) WHERE invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS courtly_fee_ledger_owner_idx
  ON public.courtly_fee_ledger(owner_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.courtly_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.courtly_invoices(id) ON DELETE CASCADE,
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES public.courtly_fee_ledger(id) ON DELETE RESTRICT,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS courtly_invoice_lines_invoice_idx
  ON public.courtly_invoice_lines(invoice_id);

ALTER TABLE public.courtly_fee_ledger
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.courtly_invoices(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoiced_at timestamptz;

CREATE TABLE IF NOT EXISTS public.courtly_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.courtly_invoices(id) ON DELETE RESTRICT,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL,
  payment_reference text NOT NULL,
  proof_path text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  owner_note text,
  admin_note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS courtly_remittances_reference_ci_uidx
  ON public.courtly_remittances (lower(trim(payment_method)), lower(trim(payment_reference)));
CREATE INDEX IF NOT EXISTS courtly_remittances_owner_idx
  ON public.courtly_remittances(owner_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS courtly_remittances_status_idx
  ON public.courtly_remittances(status, submitted_at);

CREATE TABLE IF NOT EXISTS public.courtly_billing_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.courtly_invoices(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  event_type text NOT NULL,
  subject text NOT NULL,
  html_body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  send_after timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, event_type)
);
CREATE INDEX IF NOT EXISTS courtly_billing_email_queue_idx
  ON public.courtly_billing_email_events(status, send_after);

-- ---------------------------------------------------------------------------
-- 4) Fee ledger triggers: one charge per successful source; credit on refund
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.courtly_record_booking_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id uuid;
  v_effective_at timestamptz;
  v_existing_fee numeric(12,2);
BEGIN
  SELECT billing_effective_at INTO v_effective_at
  FROM public.courtly_platform_settings WHERE singleton = true;

  SELECT owner_id INTO v_owner_id FROM public.venues WHERE id = NEW.venue_id;
  IF v_owner_id IS NULL OR NEW.created_at < v_effective_at THEN
    RETURN NEW;
  END IF;

  -- Serialize fee-ledger writes with weekly invoice generation so a fee cannot
  -- be marked invoiced without a matching invoice line during a Friday run.
  PERFORM pg_advisory_xact_lock(hashtext('courtly-weekly-invoice-generation'));

  IF NEW.payment_status = 'confirmed'
     AND NEW.status IN ('confirmed','completed')
     AND COALESCE(NEW.platform_fee, 0) > 0 THEN
    INSERT INTO public.courtly_fee_ledger(
      venue_id, owner_id, source_type, source_id, fee_type,
      description, fee_amount, occurred_at
    ) VALUES (
      NEW.venue_id, v_owner_id, 'court_booking', NEW.id,
      'court_rental_platform_fee',
      'Court rental platform fee · ' || NEW.reference || ' · ' || NEW.duration_hours || ' court-hour(s)',
      NEW.platform_fee, COALESCE(NEW.confirmed_at, NEW.paid_at, NEW.updated_at, now())
    ) ON CONFLICT (source_type, source_id, fee_type) DO NOTHING;
  END IF;

  IF NEW.status IN ('cancelled','rejected') OR NEW.payment_status IN ('refunded','rejected') THEN
    SELECT fee_amount INTO v_existing_fee
    FROM public.courtly_fee_ledger
    WHERE source_type = 'court_booking'
      AND source_id = NEW.id
      AND fee_type = 'court_rental_platform_fee';

    IF v_existing_fee IS NOT NULL THEN
      INSERT INTO public.courtly_fee_ledger(
        venue_id, owner_id, source_type, source_id, fee_type,
        description, fee_amount, occurred_at
      ) VALUES (
        NEW.venue_id, v_owner_id, 'court_booking', NEW.id,
        'court_rental_fee_credit',
        'Credit for cancelled/refunded court booking · ' || NEW.reference,
        -ABS(v_existing_fee), now()
      ) ON CONFLICT (source_type, source_id, fee_type) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS courtly_record_booking_fee ON public.bookings;
CREATE TRIGGER courtly_record_booking_fee
AFTER INSERT OR UPDATE OF status, payment_status ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.courtly_record_booking_fee();

CREATE OR REPLACE FUNCTION public.courtly_record_open_play_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id uuid;
  v_effective_at timestamptz;
  v_venue_id uuid;
  v_existing_fee numeric(12,2);
  v_fee_type text;
BEGIN
  SELECT billing_effective_at INTO v_effective_at
  FROM public.courtly_platform_settings WHERE singleton = true;

  v_venue_id := NEW.venue_id;
  IF v_venue_id IS NULL THEN
    SELECT id INTO v_venue_id FROM public.venues
    WHERE lower(trim(slug)) = lower(trim(NEW.venue_slug)) LIMIT 1;
  END IF;
  SELECT owner_id INTO v_owner_id FROM public.venues WHERE id = v_venue_id;

  IF v_owner_id IS NULL OR NEW.created_at < v_effective_at THEN
    RETURN NEW;
  END IF;

  -- Keep Open Play fee/credit entries in the same serialized ledger stream
  -- as court-booking fees and weekly invoice generation.
  PERFORM pg_advisory_xact_lock(hashtext('courtly-weekly-invoice-generation'));

  IF NEW.payment_status = 'confirmed'
     AND NEW.registration_status = 'confirmed'
     AND NEW.fee > 0
     AND NEW.transaction_fee > 0
     AND NEW.transaction_fee_payer IN ('player','venue_owner') THEN
    v_fee_type := CASE
      WHEN NEW.transaction_fee_payer = 'player' THEN 'open_play_player_transaction_fee'
      ELSE 'open_play_legacy_owner_fee'
    END;

    INSERT INTO public.courtly_fee_ledger(
      venue_id, owner_id, source_type, source_id, fee_type,
      description, fee_amount, occurred_at
    ) VALUES (
      v_venue_id, v_owner_id, 'open_play_registration', NEW.id,
      v_fee_type,
      CASE WHEN NEW.transaction_fee_payer = 'player'
        THEN 'Open Play player transaction fee · ' || NEW.registration_reference
        ELSE 'Legacy Open Play owner-paid fee · ' || NEW.registration_reference
      END,
      NEW.transaction_fee, COALESCE(NEW.updated_at, now())
    ) ON CONFLICT (source_type, source_id, fee_type) DO NOTHING;
  END IF;

  IF NEW.registration_status = 'cancelled' OR NEW.payment_status = 'rejected' THEN
    SELECT fee_amount INTO v_existing_fee
    FROM public.courtly_fee_ledger
    WHERE source_type = 'open_play_registration'
      AND source_id = NEW.id
      AND fee_type IN ('open_play_player_transaction_fee','open_play_legacy_owner_fee')
    ORDER BY created_at LIMIT 1;

    IF v_existing_fee IS NOT NULL THEN
      INSERT INTO public.courtly_fee_ledger(
        venue_id, owner_id, source_type, source_id, fee_type,
        description, fee_amount, occurred_at
      ) VALUES (
        v_venue_id, v_owner_id, 'open_play_registration', NEW.id,
        'open_play_fee_credit',
        'Credit for cancelled/rejected Open Play registration · ' || NEW.registration_reference,
        -ABS(v_existing_fee), now()
      ) ON CONFLICT (source_type, source_id, fee_type) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS courtly_record_open_play_fee ON public.open_play_registrations;
CREATE TRIGGER courtly_record_open_play_fee
AFTER INSERT OR UPDATE OF payment_status, registration_status ON public.open_play_registrations
FOR EACH ROW EXECUTE FUNCTION public.courtly_record_open_play_fee();

-- Expose whether each Open Play row falls within the new billing period. This
-- keeps the owner dashboard's remittance estimate aligned with the fee ledger
-- and prevents old test/legacy registrations from appearing on new invoices.
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
  venue_slug text,
  billing_eligible boolean
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
    r.id, r.registration_reference, r.event_title, r.event_date, r.event_time,
    r.player_name, r.player_email, r.player_phone, r.fee, r.transaction_fee,
    r.transaction_fee_payer, r.player_total, r.payment_status,
    r.registration_status, r.receipt_path, r.created_at, r.venue_slug,
    (r.created_at >= s.billing_effective_at) AS billing_eligible
  FROM public.open_play_registrations r
  JOIN public.venues v
    ON v.id = r.venue_id
    OR (r.venue_id IS NULL AND lower(trim(v.slug)) = lower(trim(r.venue_slug)))
  CROSS JOIN public.courtly_platform_settings s
  WHERE v.owner_id = auth.uid()
    AND s.singleton = true
    AND (p_venue_slug IS NULL OR v.slug = p_venue_slug)
  ORDER BY r.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.get_owner_open_play_transactions(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_open_play_transactions(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5) Weekly invoice generation and overdue enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_weekly_courtly_invoices()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group record;
  v_invoice_id uuid;
  v_invoice_number text;
  v_created integer := 0;
  v_amount numeric(12,2);
  v_due_hours integer := 72;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Only Courtly administrators can generate invoices';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('courtly-weekly-invoice-generation'));

  SELECT invoice_due_hours INTO v_due_hours
  FROM public.courtly_platform_settings WHERE singleton = true;

  FOR v_group IN
    SELECT l.venue_id, l.owner_id,
           min(l.occurred_at) AS period_start,
           max(l.occurred_at) AS period_end,
           sum(l.fee_amount)::numeric(12,2) AS net_amount
    FROM public.courtly_fee_ledger l
    WHERE l.invoice_id IS NULL
    GROUP BY l.venue_id, l.owner_id
    HAVING sum(l.fee_amount) > 0
    ORDER BY min(l.occurred_at)
  LOOP
    v_invoice_number := 'CV-' || to_char(now() AT TIME ZONE 'Asia/Manila','YYYYMMDD')
      || '-' || upper(substr(replace(v_group.venue_id::text,'-',''),1,6))
      || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,4));

    INSERT INTO public.courtly_invoices(
      invoice_number, venue_id, owner_id, period_start, period_end,
      issued_at, due_at, amount_due, status
    ) VALUES (
      v_invoice_number, v_group.venue_id, v_group.owner_id,
      v_group.period_start, v_group.period_end,
      now(), now() + make_interval(hours => v_due_hours),
      v_group.net_amount, 'issued'
    ) RETURNING id INTO v_invoice_id;

    INSERT INTO public.courtly_invoice_lines(invoice_id, ledger_entry_id, description, amount)
    SELECT v_invoice_id, l.id, l.description, l.fee_amount
    FROM public.courtly_fee_ledger l
    WHERE l.venue_id = v_group.venue_id
      AND l.owner_id = v_group.owner_id
      AND l.invoice_id IS NULL;

    UPDATE public.courtly_fee_ledger
    SET invoice_id = v_invoice_id, invoiced_at = now()
    WHERE venue_id = v_group.venue_id
      AND owner_id = v_group.owner_id
      AND invoice_id IS NULL;

    SELECT COALESCE(sum(amount),0)::numeric(12,2) INTO v_amount
    FROM public.courtly_invoice_lines WHERE invoice_id = v_invoice_id;
    UPDATE public.courtly_invoices SET amount_due = v_amount, updated_at = now()
    WHERE id = v_invoice_id;

    INSERT INTO public.courtly_billing_email_events(
      venue_id, invoice_id, recipient_email, event_type, subject, html_body
    )
    SELECT v_group.venue_id, v_invoice_id, v.admin_email,
      'invoice_issued',
      'Courtly invoice ' || v_invoice_number || ' is ready',
      '<p>Your Courtly weekly invoice <strong>' || v_invoice_number || '</strong> is ready.</p>'
      || '<p>Amount due: <strong>PHP ' || to_char(v_amount,'FM999,999,990.00') || '</strong></p>'
      || '<p>Payment is due within 72 hours. Sign in to your Courtly owner portal to view the invoice and remittance instructions.</p>'
    FROM public.venues v
    WHERE v.id = v_group.venue_id AND NULLIF(trim(v.admin_email),'') IS NOT NULL
    ON CONFLICT (invoice_id,event_type) DO NOTHING;

    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object('success',true,'invoices_created',v_created,'generated_at',now());
END;
$$;
REVOKE ALL ON FUNCTION public.generate_weekly_courtly_invoices() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_weekly_courtly_invoices() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_overdue_courtly_venues()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suspended integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Only Courtly administrators or the scheduled billing process can enforce overdue invoices';
  END IF;

  -- A submitted remittance covering the full remaining balance pauses suspension
  -- while Courtly manually verifies it. Rejected/insufficient remittances do not.
  UPDATE public.courtly_invoices i
  SET status = 'overdue', updated_at = now()
  WHERE i.status IN ('issued','partially_paid')
    AND i.due_at <= now()
    AND (i.amount_due - i.amount_paid) > 0
    AND COALESCE((
      SELECT sum(r.amount)
      FROM public.courtly_remittances r
      WHERE r.invoice_id = i.id AND r.status = 'submitted'
    ),0) < (i.amount_due - i.amount_paid);

  WITH overdue_venues AS (
    SELECT DISTINCT i.venue_id
    FROM public.courtly_invoices i
    WHERE i.status = 'overdue'
      AND (i.amount_due - i.amount_paid) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.courtly_remittances r
        WHERE r.invoice_id = i.id AND r.status = 'submitted'
        GROUP BY r.invoice_id
        HAVING sum(r.amount) >= (i.amount_due - i.amount_paid)
      )
  )
  UPDATE public.venues v
  SET billing_was_published = CASE WHEN v.billing_status = 'suspended' THEN v.billing_was_published ELSE v.is_published END,
      is_published = false,
      billing_status = 'suspended',
      billing_suspended_at = COALESCE(v.billing_suspended_at, now()),
      billing_suspend_reason = 'An outstanding Courtly invoice was not remitted within 72 hours.'
  FROM overdue_venues o
  WHERE v.id = o.venue_id AND v.billing_status <> 'suspended';

  GET DIAGNOSTICS v_suspended = ROW_COUNT;
  RETURN jsonb_build_object('success',true,'venues_suspended',v_suspended,'checked_at',now());
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_overdue_courtly_venues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_overdue_courtly_venues() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Owner billing portal RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_owner_courtly_billing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_venue public.venues%ROWTYPE;
  v_terms_version text;
  v_terms_accepted boolean;
  v_settings public.courtly_platform_settings%ROWTYPE;
  v_invoices jsonb;
  v_remittances jsonb;
  v_balance numeric(12,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in as the venue owner'; END IF;

  SELECT * INTO v_venue FROM public.venues
  WHERE owner_id = auth.uid() ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No venue is linked to this owner account'; END IF;

  SELECT * INTO v_settings FROM public.courtly_platform_settings WHERE singleton = true;
  v_terms_version := v_settings.terms_version;
  SELECT EXISTS (
    SELECT 1 FROM public.courtly_venue_terms_acceptance t
    WHERE t.venue_id = v_venue.id AND t.owner_id = auth.uid() AND t.terms_version = v_terms_version
  ) INTO v_terms_accepted;

  SELECT COALESCE(sum(amount_due - amount_paid),0)::numeric(12,2)
    INTO v_balance
  FROM public.courtly_invoices
  WHERE venue_id = v_venue.id AND status <> 'void' AND amount_due > amount_paid;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',i.id,'invoice_number',i.invoice_number,'period_start',i.period_start,
    'period_end',i.period_end,'issued_at',i.issued_at,'due_at',i.due_at,
    'amount_due',i.amount_due,'amount_paid',i.amount_paid,
    'balance',i.amount_due-i.amount_paid,'status',i.status,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('description',ln.description,'amount',ln.amount) ORDER BY ln.created_at)
      FROM public.courtly_invoice_lines ln WHERE ln.invoice_id=i.id),'[]'::jsonb)
  ) ORDER BY i.issued_at DESC),'[]'::jsonb)
  INTO v_invoices
  FROM public.courtly_invoices i WHERE i.venue_id = v_venue.id AND i.owner_id = auth.uid();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',r.id,'invoice_id',r.invoice_id,'amount',r.amount,'payment_method',r.payment_method,
    'payment_reference',r.payment_reference,'status',r.status,'owner_note',r.owner_note,
    'admin_note',r.admin_note,'submitted_at',r.submitted_at,'reviewed_at',r.reviewed_at
  ) ORDER BY r.submitted_at DESC),'[]'::jsonb)
  INTO v_remittances
  FROM public.courtly_remittances r WHERE r.venue_id = v_venue.id AND r.owner_id = auth.uid();

  RETURN jsonb_build_object(
    'venue',jsonb_build_object('id',v_venue.id,'name',v_venue.name,'slug',v_venue.slug,
      'billing_status',v_venue.billing_status,'is_published',v_venue.is_published,
      'billing_suspended_at',v_venue.billing_suspended_at,'billing_suspend_reason',v_venue.billing_suspend_reason),
    'terms',jsonb_build_object('version',v_terms_version,'accepted',v_terms_accepted),
    'summary',jsonb_build_object('outstanding_balance',v_balance),
    'invoices',v_invoices,
    'remittances',v_remittances,
    'payment_details',jsonb_build_object(
      'method',v_settings.payment_method,'account_name',v_settings.payment_account_name,
      'account_number',v_settings.payment_account_number,'qr_url',v_settings.payment_qr_url,
      'instructions',v_settings.payment_instructions,'due_hours',72
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_owner_courtly_billing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_courtly_billing() TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_courtly_remittance(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_reference text,
  p_proof_path text DEFAULT NULL,
  p_owner_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice public.courtly_invoices%ROWTYPE;
  v_id uuid;
  v_pending numeric(12,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in to submit a remittance'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter a remittance amount greater than zero'; END IF;
  IF COALESCE(trim(p_payment_reference),'') = '' THEN RAISE EXCEPTION 'Enter your payment transaction reference'; END IF;
  IF COALESCE(trim(p_payment_method),'') = '' THEN RAISE EXCEPTION 'Select a payment method'; END IF;

  SELECT * INTO v_invoice FROM public.courtly_invoices
  WHERE id = p_invoice_id AND owner_id = auth.uid()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found for this owner'; END IF;
  IF v_invoice.status = 'paid' OR v_invoice.status = 'void' THEN RAISE EXCEPTION 'This invoice has no outstanding balance'; END IF;

  SELECT COALESCE(sum(amount),0) INTO v_pending
  FROM public.courtly_remittances
  WHERE invoice_id = p_invoice_id AND status = 'submitted';

  IF p_amount > (v_invoice.amount_due - v_invoice.amount_paid - v_pending) THEN
    RAISE EXCEPTION 'The submitted amount is higher than the remaining unsubmitted invoice balance';
  END IF;

  IF p_proof_path IS NOT NULL THEN
    IF p_proof_path NOT LIKE auth.uid()::text || '/' || p_invoice_id::text || '/%' THEN
      RAISE EXCEPTION 'Invalid remittance proof path';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'courtly-remittance-proofs' AND o.name = p_proof_path
    ) THEN
      RAISE EXCEPTION 'Remittance proof upload was not found';
    END IF;
  END IF;

  INSERT INTO public.courtly_remittances(
    invoice_id,venue_id,owner_id,amount,payment_method,payment_reference,proof_path,owner_note
  ) VALUES (
    p_invoice_id,v_invoice.venue_id,auth.uid(),p_amount,trim(p_payment_method),trim(p_payment_reference),p_proof_path,nullif(trim(p_owner_note),'')
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success',true,'remittance_id',v_id,'status','submitted');
END;
$$;
REVOKE ALL ON FUNCTION public.submit_courtly_remittance(uuid,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_courtly_remittance(uuid,numeric,text,text,text,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7) Courtly admin functions: review remittances and configure remittance details
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_courtly_admin_billing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings public.courtly_platform_settings%ROWTYPE;
  v_invoices jsonb;
  v_remittances jsonb;
  v_summary jsonb;
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  SELECT * INTO v_settings FROM public.courtly_platform_settings WHERE singleton = true;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',i.id,'invoice_number',i.invoice_number,'venue_id',i.venue_id,'venue_name',v.name,
    'venue_slug',v.slug,'owner_id',i.owner_id,'owner_email',v.admin_email,
    'issued_at',i.issued_at,'due_at',i.due_at,'amount_due',i.amount_due,
    'amount_paid',i.amount_paid,'balance',i.amount_due-i.amount_paid,'status',i.status,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('description',ln.description,'amount',ln.amount) ORDER BY ln.created_at)
      FROM public.courtly_invoice_lines ln WHERE ln.invoice_id=i.id),'[]'::jsonb)
  ) ORDER BY i.issued_at DESC),'[]'::jsonb)
  INTO v_invoices
  FROM public.courtly_invoices i JOIN public.venues v ON v.id=i.venue_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',r.id,'invoice_id',r.invoice_id,'invoice_number',i.invoice_number,
    'venue_id',r.venue_id,'venue_name',v.name,'owner_email',v.admin_email,
    'amount',r.amount,'payment_method',r.payment_method,'payment_reference',r.payment_reference,
    'proof_path',r.proof_path,'status',r.status,'owner_note',r.owner_note,
    'admin_note',r.admin_note,'submitted_at',r.submitted_at
  ) ORDER BY r.submitted_at DESC),'[]'::jsonb)
  INTO v_remittances
  FROM public.courtly_remittances r
  JOIN public.courtly_invoices i ON i.id=r.invoice_id
  JOIN public.venues v ON v.id=r.venue_id;

  SELECT jsonb_build_object(
    'outstanding',COALESCE(sum(amount_due-amount_paid) FILTER (WHERE status <> 'void' AND amount_due>amount_paid),0),
    'overdue',COALESCE(sum(amount_due-amount_paid) FILTER (WHERE status='overdue' AND amount_due>amount_paid),0),
    'pending_remittances',count(*) FILTER (WHERE status='submitted'),
    'suspended_venues', (SELECT count(*) FROM public.venues WHERE billing_status='suspended')
  ) INTO v_summary FROM public.courtly_invoices;

  RETURN jsonb_build_object(
    'summary',v_summary,'invoices',v_invoices,'remittances',v_remittances,
    'settings',jsonb_build_object('terms_version',v_settings.terms_version,
      'payment_method',v_settings.payment_method,'payment_account_name',v_settings.payment_account_name,
      'payment_account_number',v_settings.payment_account_number,'payment_qr_url',v_settings.payment_qr_url,
      'payment_instructions',v_settings.payment_instructions,'due_hours',72)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_courtly_admin_billing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_courtly_admin_billing() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_courtly_billing_settings(
  p_terms_version text,
  p_payment_method text,
  p_payment_account_name text,
  p_payment_account_number text,
  p_payment_qr_url text,
  p_payment_instructions text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  IF COALESCE(trim(p_terms_version),'') = '' THEN RAISE EXCEPTION 'Terms version is required'; END IF;
  UPDATE public.courtly_platform_settings
  SET terms_version=trim(p_terms_version),
      payment_method=COALESCE(NULLIF(trim(p_payment_method),''),'GCash'),
      payment_account_name=NULLIF(trim(p_payment_account_name),''),
      payment_account_number=NULLIF(trim(p_payment_account_number),''),
      payment_qr_url=NULLIF(trim(p_payment_qr_url),''),
      payment_instructions=NULLIF(trim(p_payment_instructions),''),
      updated_at=now()
  WHERE singleton=true;
  RETURN jsonb_build_object('success',true);
END;
$$;
REVOKE ALL ON FUNCTION public.update_courtly_billing_settings(text,text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_courtly_billing_settings(text,text,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_courtly_remittance(
  p_remittance_id uuid,
  p_decision text,
  p_admin_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remittance public.courtly_remittances%ROWTYPE;
  v_invoice public.courtly_invoices%ROWTYPE;
  v_new_paid numeric(12,2);
  v_reactivated integer := 0;
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;

  SELECT * INTO v_remittance FROM public.courtly_remittances
  WHERE id=p_remittance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Remittance not found'; END IF;
  IF v_remittance.status = p_decision THEN
    RETURN jsonb_build_object('success',true,'already_processed',true,'status',v_remittance.status);
  END IF;
  IF v_remittance.status <> 'submitted' THEN
    RAISE EXCEPTION 'This remittance has already been reviewed';
  END IF;

  SELECT * INTO v_invoice FROM public.courtly_invoices WHERE id=v_remittance.invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  UPDATE public.courtly_remittances
  SET status=p_decision, admin_note=NULLIF(trim(p_admin_note),''),
      reviewed_at=now(), reviewed_by=auth.uid()
  WHERE id=p_remittance_id;

  IF p_decision='approved' THEN
    v_new_paid := v_invoice.amount_paid + v_remittance.amount;
    IF v_new_paid > v_invoice.amount_due THEN
      RAISE EXCEPTION 'Approved remittance would exceed the invoice amount';
    END IF;
    UPDATE public.courtly_invoices
    SET amount_paid=v_new_paid,
        status=CASE WHEN v_new_paid >= amount_due THEN 'paid'
                    WHEN due_at <= now() THEN 'overdue'
                    ELSE 'partially_paid' END,
        updated_at=now()
    WHERE id=v_invoice.id;

    IF v_new_paid >= v_invoice.amount_due THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.courtly_invoices i
        WHERE i.venue_id=v_invoice.venue_id
          AND i.id<>v_invoice.id
          AND i.status IN ('issued','partially_paid','overdue')
          AND i.due_at <= now()
          AND i.amount_due>i.amount_paid
      ) THEN
        UPDATE public.venues
        SET billing_status='active',
            is_published=billing_was_published,
            billing_suspended_at=NULL,
            billing_suspend_reason=NULL
        WHERE id=v_invoice.venue_id AND billing_status='suspended';
        GET DIAGNOSTICS v_reactivated = ROW_COUNT;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success',true,'already_processed',false,
    'status',p_decision,'venue_reactivated',(v_reactivated > 0));
END;
$$;
REVOKE ALL ON FUNCTION public.review_courtly_remittance(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_courtly_remittance(uuid,text,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8) Billing email notice queue (Vercel/Resend sender is optional)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_courtly_billing_email_notices()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Courtly administrator access required';
  END IF;

  -- Invoice-issued event is normally created by the invoice generator. This
  -- backstop queues any missing notice for an existing invoice.
  INSERT INTO public.courtly_billing_email_events(
    venue_id, invoice_id, recipient_email, event_type, subject, html_body
  )
  SELECT i.venue_id, i.id, v.admin_email, 'invoice_issued',
    'Courtly invoice ' || i.invoice_number || ' is ready',
    '<p>Your Courtly weekly invoice <strong>' || i.invoice_number || '</strong> is ready.</p>'
    || '<p>Amount due: <strong>PHP ' || to_char(i.amount_due-i.amount_paid,'FM999,999,990.00') || '</strong></p>'
    || '<p>Please settle within 72 hours through your owner portal.</p>'
  FROM public.courtly_invoices i JOIN public.venues v ON v.id=i.venue_id
  WHERE NULLIF(trim(v.admin_email),'') IS NOT NULL
  ON CONFLICT (invoice_id,event_type) DO NOTHING;

  INSERT INTO public.courtly_billing_email_events(
    venue_id, invoice_id, recipient_email, event_type, subject, html_body
  )
  SELECT i.venue_id, i.id, v.admin_email, 'reminder_48h',
    'Reminder: Courtly invoice ' || i.invoice_number,
    '<p>This is a reminder that Courtly invoice <strong>' || i.invoice_number || '</strong> is approaching its 72-hour deadline.</p>'
    || '<p>Outstanding balance: PHP ' || to_char(i.amount_due-i.amount_paid,'FM999,999,990.00') || '</p>'
  FROM public.courtly_invoices i JOIN public.venues v ON v.id=i.venue_id
  WHERE i.status IN ('issued','partially_paid')
    AND i.due_at BETWEEN now()+interval '24 hours' AND now()+interval '48 hours'
    AND NULLIF(trim(v.admin_email),'') IS NOT NULL
  ON CONFLICT (invoice_id,event_type) DO NOTHING;

  INSERT INTO public.courtly_billing_email_events(
    venue_id, invoice_id, recipient_email, event_type, subject, html_body
  )
  SELECT i.venue_id, i.id, v.admin_email, 'reminder_24h',
    'Final reminder: Courtly invoice ' || i.invoice_number,
    '<p>Courtly invoice <strong>' || i.invoice_number || '</strong> is due within 24 hours.</p>'
    || '<p>Outstanding balance: PHP ' || to_char(i.amount_due-i.amount_paid,'FM999,999,990.00') || '</p>'
  FROM public.courtly_invoices i JOIN public.venues v ON v.id=i.venue_id
  WHERE i.status IN ('issued','partially_paid')
    AND i.due_at BETWEEN now() AND now()+interval '24 hours'
    AND NULLIF(trim(v.admin_email),'') IS NOT NULL
  ON CONFLICT (invoice_id,event_type) DO NOTHING;

  INSERT INTO public.courtly_billing_email_events(
    venue_id, invoice_id, recipient_email, event_type, subject, html_body
  )
  SELECT i.venue_id, i.id, v.admin_email, 'overdue',
    'Overdue: Courtly invoice ' || i.invoice_number,
    '<p>Courtly invoice <strong>' || i.invoice_number || '</strong> is overdue.</p>'
    || '<p>Please sign in to submit your remittance details. Venue listings may be suspended when overdue balances remain unpaid.</p>'
  FROM public.courtly_invoices i JOIN public.venues v ON v.id=i.venue_id
  WHERE i.status='overdue' AND NULLIF(trim(v.admin_email),'') IS NOT NULL
  ON CONFLICT (invoice_id,event_type) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success',true,'queued_last_insert',v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.queue_courtly_billing_email_notices() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_courtly_billing_email_notices() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9) RLS and private remittance proof bucket
-- ---------------------------------------------------------------------------
ALTER TABLE public.courtly_platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_venue_terms_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_fee_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_remittances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courtly_billing_email_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courtly_terms_owner_read ON public.courtly_venue_terms_acceptance;
CREATE POLICY courtly_terms_owner_read ON public.courtly_venue_terms_acceptance
FOR SELECT TO authenticated USING (owner_id=auth.uid() OR public.is_courtly_admin());

DROP POLICY IF EXISTS courtly_invoice_owner_read ON public.courtly_invoices;
CREATE POLICY courtly_invoice_owner_read ON public.courtly_invoices
FOR SELECT TO authenticated USING (owner_id=auth.uid() OR public.is_courtly_admin());

DROP POLICY IF EXISTS courtly_ledger_owner_read ON public.courtly_fee_ledger;
CREATE POLICY courtly_ledger_owner_read ON public.courtly_fee_ledger
FOR SELECT TO authenticated USING (owner_id=auth.uid() OR public.is_courtly_admin());

DROP POLICY IF EXISTS courtly_invoice_lines_owner_read ON public.courtly_invoice_lines;
CREATE POLICY courtly_invoice_lines_owner_read ON public.courtly_invoice_lines
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.courtly_invoices i WHERE i.id=courtly_invoice_lines.invoice_id AND (i.owner_id=auth.uid() OR public.is_courtly_admin()))
);

DROP POLICY IF EXISTS courtly_remittance_owner_read ON public.courtly_remittances;
CREATE POLICY courtly_remittance_owner_read ON public.courtly_remittances
FOR SELECT TO authenticated USING (owner_id=auth.uid() OR public.is_courtly_admin());

-- All writes go through the SECURITY DEFINER RPCs; clients cannot edit invoices or fee ledger rows.
REVOKE ALL ON public.courtly_platform_settings,
  public.courtly_admin_users,
  public.courtly_venue_terms_acceptance,
  public.courtly_invoices,
  public.courtly_fee_ledger,
  public.courtly_invoice_lines,
  public.courtly_remittances,
  public.courtly_billing_email_events
FROM anon, authenticated;
GRANT SELECT ON public.courtly_venue_terms_acceptance,
  public.courtly_invoices,
  public.courtly_fee_ledger,
  public.courtly_invoice_lines,
  public.courtly_remittances
TO authenticated;

-- The server-side Vercel email worker uses the service role to read and update
-- the outbox. Keep this grant server-side; never expose the key in browser code.
GRANT SELECT, UPDATE ON public.courtly_billing_email_events TO service_role;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('courtly-remittance-proofs','courtly-remittance-proofs',false,10485760,ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=10485760,
  allowed_mime_types=ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

DROP POLICY IF EXISTS courtly_owner_upload_remittance_proof ON storage.objects;
CREATE POLICY courtly_owner_upload_remittance_proof ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id='courtly-remittance-proofs'
  AND (storage.foldername(name))[1]=auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.courtly_invoices i
    WHERE i.id::text=(storage.foldername(name))[2]
      AND i.owner_id=auth.uid()
  )
);

DROP POLICY IF EXISTS courtly_owner_read_remittance_proof ON storage.objects;
CREATE POLICY courtly_owner_read_remittance_proof ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id='courtly-remittance-proofs'
  AND ((storage.foldername(name))[1]=auth.uid()::text OR public.is_courtly_admin())
);

-- ---------------------------------------------------------------------------
-- 10) Verification and PostgREST schema refresh
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

SELECT table_name
FROM information_schema.tables
WHERE table_schema='public'
  AND table_name IN (
    'courtly_platform_settings','courtly_admin_users','courtly_venue_terms_acceptance',
    'courtly_invoices','courtly_fee_ledger','courtly_invoice_lines',
    'courtly_remittances','courtly_billing_email_events'
  )
ORDER BY table_name;

COMMIT;
