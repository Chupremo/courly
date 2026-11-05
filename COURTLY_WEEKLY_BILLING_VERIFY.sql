-- Run after migrations 006 and 007 to verify the Courtly weekly billing setup.

-- 1) Billing settings and effective date (the effective date prevents back-billing).
SELECT singleton, terms_version, billing_effective_at, invoice_due_hours,
       payment_method, payment_account_name,
       CASE WHEN payment_qr_url IS NULL THEN false ELSE true END AS has_payment_qr
FROM public.courtly_platform_settings;

-- 2) Billing tables.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'courtly_admin_users', 'courtly_venue_terms_acceptance',
    'courtly_fee_ledger', 'courtly_invoices', 'courtly_invoice_lines',
    'courtly_remittances', 'courtly_billing_email_events'
  )
ORDER BY table_name;

-- 3) Supabase scheduled jobs. Expected: Friday 01:00 UTC and every five minutes.
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN (
  'courtly-weekly-invoice-generation',
  'courtly-overdue-enforcement'
)
ORDER BY jobname;

-- 4) Ledger totals by fee source and type. This is read-only.
SELECT fee_type, count(*) AS entries, sum(fee_amount)::numeric(12,2) AS net_amount
FROM public.courtly_fee_ledger
GROUP BY fee_type
ORDER BY fee_type;

-- 5) Current invoice balances and listing suspension state. This is read-only.
SELECT v.name AS venue, v.slug, v.billing_status, v.is_published,
       i.invoice_number, i.status, i.amount_due, i.amount_paid,
       (i.amount_due - i.amount_paid)::numeric(12,2) AS balance,
       i.issued_at, i.due_at
FROM public.venues v
LEFT JOIN public.courtly_invoices i ON i.venue_id = v.id
ORDER BY v.name, i.issued_at DESC;
