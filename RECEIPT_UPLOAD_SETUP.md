# Courtly customer booking page update

## Included changes
- Public venue page has a customer-only header with no navigation links or menu.
- Payment receipt picker accepts image files up to 100 MiB.
- Receipt files upload directly to the private Supabase Storage bucket `courtly-payment-receipts`.
- A confirmation dialog shows the venue, court, date, time, duration, amount, and booking reference.
- The dialog clearly states that the receipt was received and payment is pending venue-owner verification.

## Required Supabase setup
1. Open Supabase SQL Editor.
2. Run `supabase/payment-receipts-storage.sql`.
3. Confirm the bucket `courtly-payment-receipts` exists under Storage.
4. Confirm Vercel Production has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configured.
5. Redeploy after uploading the updated project.

## Important current limitation
This update uploads receipt files to Supabase Storage, but the existing booking creation logic in this starter still stores booking metadata in browser localStorage. It does not yet create a shared row in `public.bookings` or make the reservation visible to an owner on another device. The success dialog therefore means the receipt upload and local booking request were saved, not that GCash payment was independently verified or that a permanent database booking has been confirmed. A production booking RPC/database integration is still required for shared availability, cross-device owner visibility, and race-safe reservation locking.
