-- Courtly migration 008: live owner fee balance and activity ledger
-- Apply AFTER migrations 006 and 007.
-- Friday invoices remain weekly statements of charges already visible in the live ledger.
-- This migration does not create charges, change fee rates, or alter existing invoices.

BEGIN;

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
  v_fee_activity jsonb;
  v_invoice_balance numeric(12,2) := 0;
  v_unbilled_charges numeric(12,2) := 0;
  v_pending_credits numeric(12,2) := 0;
  v_unbilled_balance numeric(12,2) := 0;
  v_total_balance numeric(12,2) := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in as the venue owner';
  END IF;

  SELECT * INTO v_venue
  FROM public.venues
  WHERE owner_id = auth.uid()
  ORDER BY created_at
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No venue is linked to this owner account';
  END IF;

  SELECT * INTO v_settings
  FROM public.courtly_platform_settings
  WHERE singleton = true;

  v_terms_version := v_settings.terms_version;

  SELECT EXISTS (
    SELECT 1
    FROM public.courtly_venue_terms_acceptance t
    WHERE t.venue_id = v_venue.id
      AND t.owner_id = auth.uid()
      AND t.terms_version = v_terms_version
  ) INTO v_terms_accepted;

  -- Balance already placed on issued invoices.
  SELECT COALESCE(SUM(GREATEST(i.amount_due - i.amount_paid, 0)), 0)::numeric(12,2)
    INTO v_invoice_balance
  FROM public.courtly_invoices i
  WHERE i.venue_id = v_venue.id
    AND i.owner_id = auth.uid()
    AND i.status <> 'void';

  -- Fees are recorded in the ledger when each qualifying transaction succeeds.
  -- Positive entries are new charges; negative entries are cancellation/refund credits.
  SELECT
    COALESCE(SUM(CASE WHEN l.fee_amount > 0 THEN l.fee_amount ELSE 0 END), 0)::numeric(12,2),
    COALESCE(SUM(CASE WHEN l.fee_amount < 0 THEN ABS(l.fee_amount) ELSE 0 END), 0)::numeric(12,2)
  INTO v_unbilled_charges, v_pending_credits
  FROM public.courtly_fee_ledger l
  WHERE l.venue_id = v_venue.id
    AND l.owner_id = auth.uid()
    AND l.invoice_id IS NULL;

  -- Credits remain visible separately and are netted into the next statement.
  v_unbilled_balance := GREATEST(v_unbilled_charges - v_pending_credits, 0);
  v_total_balance := v_invoice_balance + v_unbilled_balance;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'invoice_number', i.invoice_number,
    'period_start', i.period_start,
    'period_end', i.period_end,
    'issued_at', i.issued_at,
    'due_at', i.due_at,
    'amount_due', i.amount_due,
    'amount_paid', i.amount_paid,
    'balance', GREATEST(i.amount_due - i.amount_paid, 0),
    'status', i.status,
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('description', ln.description, 'amount', ln.amount) ORDER BY ln.created_at)
      FROM public.courtly_invoice_lines ln
      WHERE ln.invoice_id = i.id
    ), '[]'::jsonb)
  ) ORDER BY i.issued_at DESC), '[]'::jsonb)
  INTO v_invoices
  FROM public.courtly_invoices i
  WHERE i.venue_id = v_venue.id
    AND i.owner_id = auth.uid();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'invoice_id', r.invoice_id,
    'amount', r.amount,
    'payment_method', r.payment_method,
    'payment_reference', r.payment_reference,
    'status', r.status,
    'owner_note', r.owner_note,
    'admin_note', r.admin_note,
    'submitted_at', r.submitted_at,
    'reviewed_at', r.reviewed_at
  ) ORDER BY r.submitted_at DESC), '[]'::jsonb)
  INTO v_remittances
  FROM public.courtly_remittances r
  WHERE r.venue_id = v_venue.id
    AND r.owner_id = auth.uid();

  -- Return every recent fee/credit entry so owners can audit how the live balance was built.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', x.id,
    'source_type', x.source_type,
    'source_id', x.source_id,
    'fee_type', x.fee_type,
    'description', x.description,
    'fee_amount', x.fee_amount,
    'occurred_at', x.occurred_at,
    'invoice_id', x.invoice_id,
    'invoice_number', x.invoice_number,
    'billing_status', CASE
      WHEN x.fee_amount < 0 THEN 'credit'
      WHEN x.invoice_id IS NULL THEN 'accrued'
      ELSE 'invoiced'
    END
  ) ORDER BY x.occurred_at DESC), '[]'::jsonb)
  INTO v_fee_activity
  FROM (
    SELECT
      l.id, l.source_type, l.source_id, l.fee_type, l.description,
      l.fee_amount, l.occurred_at, l.invoice_id, i.invoice_number
    FROM public.courtly_fee_ledger l
    LEFT JOIN public.courtly_invoices i ON i.id = l.invoice_id
    WHERE l.venue_id = v_venue.id
      AND l.owner_id = auth.uid()
    ORDER BY l.occurred_at DESC
    LIMIT 100
  ) x;

  RETURN jsonb_build_object(
    'venue', jsonb_build_object(
      'id', v_venue.id,
      'name', v_venue.name,
      'slug', v_venue.slug,
      'billing_status', v_venue.billing_status,
      'is_published', v_venue.is_published,
      'billing_suspended_at', v_venue.billing_suspended_at,
      'billing_suspend_reason', v_venue.billing_suspend_reason
    ),
    'terms', jsonb_build_object('version', v_terms_version, 'accepted', v_terms_accepted),
    'summary', jsonb_build_object(
      'outstanding_balance', v_total_balance,
      'total_owed', v_total_balance,
      'invoiced_balance', v_invoice_balance,
      'unbilled_balance', v_unbilled_balance,
      'pending_credits', v_pending_credits,
      'updated_at', now()
    ),
    'fee_activity', v_fee_activity,
    'invoices', v_invoices,
    'remittances', v_remittances,
    'payment_details', jsonb_build_object(
      'method', v_settings.payment_method,
      'account_name', v_settings.payment_account_name,
      'account_number', v_settings.payment_account_number,
      'qr_url', v_settings.payment_qr_url,
      'instructions', v_settings.payment_instructions,
      'due_hours', 72
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_owner_courtly_billing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_courtly_billing() TO authenticated;

-- Update the admin summary too, so Courtly can see accrued fees before Friday's invoice.
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
  v_unbilled numeric(12,2) := 0;
BEGIN
  IF NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Courtly administrator access required';
  END IF;

  SELECT * INTO v_settings
  FROM public.courtly_platform_settings
  WHERE singleton = true;

  SELECT COALESCE(SUM(GREATEST(net_fee, 0)), 0)::numeric(12,2)
  INTO v_unbilled
  FROM (
    SELECT l.venue_id, l.owner_id, SUM(l.fee_amount) AS net_fee
    FROM public.courtly_fee_ledger l
    WHERE l.invoice_id IS NULL
    GROUP BY l.venue_id, l.owner_id
  ) accrued;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'invoice_number', i.invoice_number,
    'venue_id', i.venue_id,
    'venue_name', v.name,
    'venue_slug', v.slug,
    'owner_id', i.owner_id,
    'owner_email', v.admin_email,
    'issued_at', i.issued_at,
    'due_at', i.due_at,
    'amount_due', i.amount_due,
    'amount_paid', i.amount_paid,
    'balance', GREATEST(i.amount_due - i.amount_paid, 0),
    'status', i.status,
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('description', ln.description, 'amount', ln.amount) ORDER BY ln.created_at)
      FROM public.courtly_invoice_lines ln
      WHERE ln.invoice_id = i.id
    ), '[]'::jsonb)
  ) ORDER BY i.issued_at DESC), '[]'::jsonb)
  INTO v_invoices
  FROM public.courtly_invoices i
  JOIN public.venues v ON v.id = i.venue_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'invoice_id', r.invoice_id,
    'invoice_number', i.invoice_number,
    'venue_id', r.venue_id,
    'venue_name', v.name,
    'owner_email', v.admin_email,
    'amount', r.amount,
    'payment_method', r.payment_method,
    'payment_reference', r.payment_reference,
    'proof_path', r.proof_path,
    'status', r.status,
    'owner_note', r.owner_note,
    'admin_note', r.admin_note,
    'submitted_at', r.submitted_at
  ) ORDER BY r.submitted_at DESC), '[]'::jsonb)
  INTO v_remittances
  FROM public.courtly_remittances r
  JOIN public.courtly_invoices i ON i.id = r.invoice_id
  JOIN public.venues v ON v.id = r.venue_id;

  SELECT jsonb_build_object(
    'outstanding', COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE status <> 'void' AND amount_due > amount_paid), 0),
    'overdue', COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE status = 'overdue' AND amount_due > amount_paid), 0),
    'unbilled_accrued', v_unbilled,
    'total_owed', COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE status <> 'void' AND amount_due > amount_paid), 0) + v_unbilled,
    'pending_remittances', COUNT(*) FILTER (WHERE status = 'submitted'),
    'suspended_venues', (SELECT COUNT(*) FROM public.venues WHERE billing_status = 'suspended')
  )
  INTO v_summary
  FROM public.courtly_invoices;

  RETURN jsonb_build_object(
    'summary', v_summary,
    'invoices', v_invoices,
    'remittances', v_remittances,
    'settings', jsonb_build_object(
      'terms_version', v_settings.terms_version,
      'payment_method', v_settings.payment_method,
      'payment_account_name', v_settings.payment_account_name,
      'payment_account_number', v_settings.payment_account_number,
      'payment_qr_url', v_settings.payment_qr_url,
      'payment_instructions', v_settings.payment_instructions,
      'due_hours', 72
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_courtly_admin_billing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_courtly_admin_billing() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
