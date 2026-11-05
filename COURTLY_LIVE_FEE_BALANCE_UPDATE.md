# Courtly live owner fee balance update

## What changes

- The owner dashboard shows **Total owed to Courtly** as a live balance.
- The live total includes outstanding issued invoices plus net positive fee-ledger charges accrued since the last statement.
- Every qualifying confirmed court booking or paid Open Play registration is recorded by the existing ledger triggers; its fee appears in the activity list on the next refresh.
- The dashboard refreshes automatically every 60 seconds while visible and has a manual Refresh Balance button.
- Friday at 9:00 AM Manila time remains the weekly statement cutoff. The statement groups fee-ledger entries already displayed in the dashboard; it does not create a new fee or increase the running total.
- The owner sees separate totals for accrued/not-yet-invoiced fees and issued invoice balances.
- The admin console also shows total owed and accrued/not-yet-invoiced fees across venues.

## Why this prevents surprises

The fee ledger is the source of truth. The owner can open Courtly Fees & Invoices at any time and see the amount accumulated so far, the individual fee entries, which entries are already on an invoice, and which entries will be included in the next Friday statement. When the Friday statement is generated, ledger entries are linked to the invoice; the same amount moves from the accrued bucket to the invoiced bucket, while **Total owed** stays the same.

## Install order

1. Confirm migration 006 (weekly billing tables, ledger triggers, invoices, remittances) has been installed.
2. Confirm migration 007 (pg_cron schedule) has been installed if automatic Friday statements and overdue enforcement are being used.
3. Back up Supabase.
4. Run `supabase/migrations/008_live_owner_fee_balance.sql` in Supabase SQL Editor.
5. Deploy the updated project files: `owner-billing.js`, `admin-billing.js`, and `owner-portal.html`.
6. Refresh the owner portal and open **Courtly Fees & Invoices**.

No new tables or columns are created by migration 008. It replaces the owner/admin billing read functions and refreshes the PostgREST schema cache. It does not change historical fees, create invoices, change fee rates, or modify existing bookings.

## Expected owner dashboard

- **Total owed to Courtly** — unpaid invoices plus net positive accrued fees.
- **Accrued · not yet invoiced** — fees already recorded in the ledger and waiting for the next Friday statement.
- **Invoiced · unpaid balance** — amount on issued statements that remains unpaid.
- **Live Courtly fee activity** — latest 100 charges and credits, with date, description, amount and whether they are accrued or invoiced.

A submitted remittance remains pending until the Courtly administrator verifies and approves receipt of funds. Pending remittances are not subtracted from the confirmed balance until approval. Refund/cancellation credits are displayed separately and netted against the next statement's accrued fees.

## Test checklist

1. Confirm a qualifying paid court booking; verify a court-rental fee entry appears in the ledger and live owner balance.
2. Confirm a paid Open Play registration with player-paid transaction fee; verify the ₱10 fee appears once.
3. Open another browser/device and load the owner billing page; verify it shows the same running balance.
4. Wait for or manually run the Friday statement in staging; verify the entry moves from accrued to invoiced and **Total owed does not increase**.
5. Submit a remittance; verify the amount remains outstanding while submitted and decreases only after admin approval.

## Important distinction

The owner can see the total amount accumulating at all times. The remittance form is attached to an issued invoice, so accrued fees that have not yet reached the Friday statement are shown for transparency and become payable through the issued statement once it is generated.
