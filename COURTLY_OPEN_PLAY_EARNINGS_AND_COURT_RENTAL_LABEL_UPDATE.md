# Courtly earnings and Open Play transaction review update

## What changed
- Renamed the first earnings summary card to **Court Rental Earnings** and clarified the gross, transaction-fee, and net figures as court-rental amounts.
- Added the owner-authenticated Open Play transaction review module to the owner portal. It lists submitted registrations, receipt links, payment status, and Verify/Reject actions.
- Added Supabase RPC definitions for owner-only transaction listing and payment review.
- Kept Open Play registration revenue separate from court-rental revenue. Only confirmed Open Play payments contribute to Open Play revenue.
- Added a 30-second refresh for registration counts, transaction status, and earnings.

## Supabase SQL required
Run these in Supabase SQL Editor if they have not already been applied, in this order:
1. `supabase/schema.sql`
2. `owner-registration.sql`
3. `supabase/open-play-registrations.sql`
4. `supabase/payment-receipts-storage.sql`
5. `open-play-earnings.sql`
6. `supabase/open-play-owner-transactions.sql`

If an existing venue is not linked to the signed-in owner account, follow `supabase/link-existing-owner-venue.sql` and replace the email placeholder with the exact Auth email before running it.

## Important
- The owner must sign in through Supabase Auth. A legacy localStorage/demo login is not an authenticated Supabase owner session.
- The venue row must have `owner_id` equal to the signed-in Auth user's UUID.
- Open Play receipts must be stored in the `courtly-payment-receipts` bucket, with the `receipt_path` saved in `open_play_registrations`.
- Pending receipts do not count as Open Play revenue until the owner verifies them.
- Complete Vite build was not verified in this environment because dependency installation timed out. Do not treat this ZIP as a verified successful production build.
