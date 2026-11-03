# Courtly hourly fee and mobile UI update

## Fee policy
Courtly charges PHP 10 per booked court-hour on every court booking.
- 1 hour = PHP 10
- 2 hours = PHP 20
- 3 hours = PHP 30

The player checkout displays court rental, Courtly fee, and total separately. The venue booking prototype stores subtotal, platformFee, and total separately. Owner portal fee reporting calculates the fee from the booking duration.

## Supabase migration
After deploying the files, run `supabase/courtly-hourly-fee-migration.sql` in Supabase SQL Editor. It updates existing booking fee totals to PHP 10 x duration_hours and changes the column default to zero so application code must calculate the fee.

## Prototype limitation
This repository's public booking flow still uses browser localStorage for booking records. The SQL migration updates the Supabase bookings table but does not move localStorage bookings into Supabase. Reliable cross-device booking and fee enforcement requires a server-side booking RPC that calculates duration and fee itself; client-side totals are not tamper-proof. No live Supabase database was modified by this package.
