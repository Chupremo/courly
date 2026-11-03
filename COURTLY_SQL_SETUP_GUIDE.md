# Courtly Supabase SQL setup (clean package)

This ZIP contains one canonical copy of each SQL script. All SQL files are inside `supabase/`. Do not run duplicate copies from the project root; there are no root-level SQL copies in this package.

## Required setup order

Run each required file once in Supabase Dashboard → SQL Editor, in this order:

1. `supabase/schema.sql`
2. `supabase/owner-registration.sql`
3. `supabase/open-play-events.sql`
4. `supabase/open-play-registrations.sql`
5. `supabase/payment-receipts-storage.sql`
6. `supabase/open-play-earnings.sql`
7. `supabase/open-play-owner-transactions.sql`

`supabase/link-existing-owner-venue.sql` is conditional: run it only if the owner already has a Supabase Auth account and an existing venue whose `admin_email` matches that Auth email. Replace the email placeholder before running it.

Optional seed scripts (do not run unless you want demo data):
- `supabase/demo-seed.sql`
- `supabase/sample-owner-seed.sql`

`supabase/courtly-hourly-fee-migration.sql` is an optional migration for the per-court-hour transaction fee. Run it only if that fee migration has not already been applied.

## Before testing Open Play earnings

- The owner must sign in through Supabase Auth, not the legacy local-browser demo session.
- The venue row must have `owner_id` set to the signed-in Auth user's UUID.
- Open Play receipts must be uploaded to the `courtly-payment-receipts` bucket and their `receipt_path` stored with each registration.
- Pending receipts are excluded from confirmed Open Play revenue until the owner verifies them.

If the portal still reports that it cannot load Open Play earnings after these steps, share the exact browser console error and the Supabase SQL error/result. Do not rerun every SQL file blindly; most scripts use `create or replace`/`if not exists`, but setup state and ownership linkage still matter.
