# Courtly — Weekly Owner Billing & Remittance Implementation

This update implements Courtly's venue-owner fee collection model:

- Free venue listing; no monthly, setup, registration or upfront fees.
- Court rentals: the venue owner owes Courtly PHP 10 per successfully paid and confirmed court-hour.
- Paid Open Play: the player pays a PHP 10 Transaction Fee on top of the event registration amount. When the venue receives the full player payment through its own QR, the owner holds that PHP 10 for Courtly and remits it with the weekly invoice.
- Free Open Play: no Transaction Fee.
- The owner portal shows a live running balance as qualifying fees are recorded; it separates accrued (not yet invoiced) fees from issued invoice balances. The dashboard refreshes automatically every 60 seconds while open.
- Itemized weekly statements are generated every Friday at 09:00 Asia/Manila from fee-ledger entries already visible to the owner. Friday does not create new fees or change the total owed; it groups accrued entries into an invoice that is due exactly 72 hours after issue.
- If the invoice remains overdue and no sufficient remittance is pending verification, Courtly suspends/unpublishes the venue from new discovery, court bookings and Open Play registrations. Owners retain access to their portal and existing confirmed bookings remain in place.
- Once Courtly approves enough remittance to clear all overdue balances, the venue's prior publication state is restored. A venue that the owner had manually unpublished before suspension remains unpublished.

The system does not automatically transfer funds. Venue QR payments go directly to the venue owner. Owners remit Courtly's fees separately to Courtly's configured receiving account.

## Files added / changed

- `supabase/migrations/006_weekly_owner_billing_invoices.sql` — billing tables, fee ledger triggers, weekly invoice functions, owner/admin RPCs, terms acceptance, suspension/re-activation rules, private remittance proof bucket and email queue.
- `supabase/migrations/007_weekly_billing_cron_schedule.sql` — Supabase Cron jobs (weekly statement generation + five-minute overdue enforcement).
- `supabase/migrations/008_live_owner_fee_balance.sql` — returns the live accrued balance and itemized fee activity to owner and admin dashboards.
- `owner-billing.js` — Owner Portal invoice/remittance screen.
- `owner-portal.html` — Adds the **Courtly Fees & Invoices** navigation item and page mount.
- `admin-billing.html` / `admin-billing.js` — Courtly admin invoice, remittance review and payment settings console.
- `venue-owner-terms.html` — public owner-terms draft.
- `api/cron/send-billing-emails.js` — optional Resend email sender, called by Vercel Cron.
- `COURTLY_WEEKLY_BILLING_ADMIN_BOOTSTRAP.sql` — allowlist bootstrap for the Courtly admin account.

## Before you install

1. Back up your Supabase database or use a staging project first.
2. Confirm that the Courtly base backend (`001_complete_supabase_backend.sql`), player account migrations (002/003 if used), and hybrid fee migration `005_hybrid_courtly_fee_policy.sql` are already installed.
3. In particular, `open_play_registrations` must have `transaction_fee_payer` and generated `player_total` columns. Do not run migration 001 or 005 again if already installed.

## 1. Apply migration 006

Open Supabase Dashboard → SQL Editor → New Query. Copy the full contents of:

`supabase/migrations/006_weekly_owner_billing_invoices.sql`

Run it once. It is additive and does not back-bill older bookings or Open Play registrations. `billing_effective_at` is set when the migration is installed; only eligible fees from that point forward are added to the new Courtly fee ledger.

The migration introduces a current Terms version. After deployment, each current venue owner must accept the terms in **Owner Portal → Courtly Fees & Invoices** before new public court bookings or Open Play registrations can be created. Existing bookings and registrations are not modified.

## 2. Create and allowlist the Courtly admin account

Use a dedicated Courtly admin identity, separate from everyday venue-owner/player accounts.

Recommended low-friction setup:

1. Register a new dedicated email through Courtly's Player Registration page. This creates an Auth user with `account_type=player`, so the venue-creation trigger does not create a venue for it.
2. Confirm that email using its confirmation link.
3. Open Supabase SQL Editor and run `COURTLY_WEEKLY_BILLING_ADMIN_BOOTSTRAP.sql` after replacing `YOUR_ADMIN_EMAIL@example.com` with the exact email.
4. The bootstrap script updates that Auth user's `raw_user_meta_data.account_type` to `courtly_admin` and adds the user to `courtly_admin_users`.
5. Sign in at `https://courtly-ecru.vercel.app/admin-billing`.

The account will no longer be treated as a player account after the metadata change. Use it only for the Courtly admin console. Only allowlisted `courtly_admin_users` can read platform billing data, configure Courtly's remittance account or approve remittances. Do not use a venue owner's everyday login as the Courtly administrator account.

## 3. Configure Courtly's own remittance details

In `/admin-billing`, configure the account venue owners will use to remit fees to Courtly:

- Payment method (GCash, Maya, Bank transfer or QR Ph)
- Account name
- Account / wallet number
- Public URL for Courtly's official QR image (optional)
- Remittance instructions
- Terms version

The QR URL must be a public image URL if you want to display the QR inside the Owner Portal. Do not put private credentials or service-role keys in these fields.

Owners will see these instructions on each invoice and submit the payment reference plus optional proof. A payment reference alone is not proof of cleared funds. The admin must verify that funds actually arrived before approving the remittance. Duplicate payment references are rejected across invoices for the same payment method.

## 4. Install the live-balance update (migration 008)

After migrations 006 and 007 are installed, run `supabase/migrations/008_live_owner_fee_balance.sql`. This updates the owner billing RPC so the outstanding amount includes both unpaid invoices and accrued ledger fees that have not yet been grouped into a Friday statement. It also returns the latest 100 fee/credit entries. It does not modify existing invoices, create charges, or change fee rates.

The owner portal displays: total owed (live), accrued not yet invoiced, and invoiced unpaid balance. The fee activity refreshes every 60 seconds while the portal is open. When Friday's statement is generated, the amount moves from “accrued” to “invoiced”; the total does not increase merely because a statement was issued.

## 5. Enable Supabase Cron and install migration 007

In Supabase Dashboard → Database → Extensions, enable `pg_cron` (if it is not already enabled). Then run:

`supabase/migrations/007_weekly_billing_cron_schedule.sql`

The jobs are:

- Friday 01:00 UTC = Friday 09:00 Philippine time: generate weekly invoices.
- Every five minutes: enforce 72-hour overdue invoices and suspend eligible venue listings, limiting scheduling delay after the deadline to about five minutes.

Verify jobs:

```sql
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN (
  'courtly-weekly-invoice-generation',
  'courtly-overdue-enforcement'
)
ORDER BY jobname;
```

Review recent runs:

```sql
SELECT jobid, status, return_message, start_time
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;
```

## 6. Configure Vercel

Vercel keeps the existing public variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

For the optional server-side email sender, add these server-only variables in Vercel:

- `SUPABASE_URL` = `https://pklrvpnnkmdwgqoyvhsb.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = the Supabase service-role secret (server-side only; never prefix with `VITE_`, never expose in browser code)
- `CRON_SECRET` = a long random secret (at least 32 characters)
- `RESEND_API_KEY` = Resend API key
- `COURTLY_FROM_EMAIL` = a sender address verified with Resend

Email sending is optional. Without Resend configuration, invoices, deadlines and listing enforcement still work in Supabase and the Owner Portal, but emails are skipped. The Vercel daily email job is scheduled for 10:00 Philippine time. It queues invoice-issued, 48-hour reminder, 24-hour reminder and overdue emails through the email outbox.

## 7. Deploy the website

Add / replace all project files from this package in the existing `courly` GitHub repository and push to `main`. Vercel should build the new multi-page entries and deploy these routes:

- `/owner-portal` — owner billing navigation and invoices
- `/admin-billing` — Courtly admin console
- `/venue-owner-terms` — terms page

No new `VITE_` environment variables are required by this update. Existing Supabase environment variables remain the same.

## 8. Acceptance and operating workflow

1. Owner signs in and opens **Courtly Fees & Invoices**.
2. Owner reads and accepts the current Venue Owner Terms.
3. Owner's new public court bookings and Open Play registrations can proceed.
4. Fee-ledger triggers record one fee entry per successfully paid source. Unique source/fee constraints prevent duplicate ledger entries, and fee-trigger writes serialize with invoice generation so a Friday invoice cannot mark a fee invoiced without its invoice line.
5. Each fee appears in the owner's live fee activity as soon as the source transaction is confirmed. On Friday, the statement generator only groups still-unbilled ledger entries into an itemized invoice with a 72-hour due time; it does not create new fees.
6. Owner pays Courtly's configured remittance account, then submits the amount, payment method and unique transaction reference. Proof upload is optional.
7. Admin checks the actual receiving account and approves/rejects the remittance in `/admin-billing`.
8. If a due invoice has no sufficient remittance submitted for verification, five-minute enforcement marks it overdue and unpublishes the venue from new player traffic. Owner account and existing bookings remain available.
9. Once all overdue balances are approved and cleared, the prior publication state is restored.

## Important test plan

Do these tests in staging first:

- A new paid court booking is confirmed: the fee ledger records PHP 10 per booked court-hour once.
- Repeating the booking payment review does not add a second fee ledger entry.
- A new paid Open Play registration is confirmed: the ledger records the player-paid PHP 10 Transaction Fee once.
- A free Open Play registration creates no fee ledger entry.
- A historical registration created before `billing_effective_at` is not billed retroactively.
- The Friday generator creates one invoice per venue with unbilled fee entries; running again creates no duplicate invoice lines.
- Owner can see only their own invoices and submit remittance against their invoice.
- Non-admin users cannot access `/admin-billing` data or approve remittances.
- A sufficient submitted remittance pauses suspension while awaiting verification; a rejected submission does not.
- A venue is unpublished only for new customers after the 72-hour deadline; owner portal and existing confirmed reservations remain accessible.
- A paid invoice reactivates only a venue that had been published before billing suspension. An owner-unpublished venue remains unpublished.

Do not manually change production invoice statuses or force production due dates to test suspension. Use staging for timing/suspension simulations.

## Business / legal note

The terms page is a draft of the commercial rules described above. Before requiring owners to accept it in production, have Philippine legal and tax advisers review the merchant-of-record arrangement, collection/agency language for the player-paid Open Play Transaction Fee, taxes, invoice records, disputes/refunds, and suspension process.
