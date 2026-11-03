# Courtly Open Play Registration Update

## Player flow
- `REGISTER NOW` opens the payment dialog directly; it does not ask the player to choose a court, date, or time slot.
- The payment summary shows the Open Play registration fee only.
- Player submits name, email, phone (optional), and payment receipt.
- The receipt is uploaded to the existing `courtly-payment-receipts` Supabase Storage bucket.
- The registration is inserted into `public.open_play_registrations` through the `register_open_play_player` RPC. The RPC checks capacity atomically and returns the updated count.
- The player sees an Open Play registration reference and a pending owner-verification message.

## Required Supabase setup
1. Open Supabase Dashboard → SQL Editor.
2. Run `supabase/open-play-registrations.sql`.
3. Confirm the `courtly-payment-receipts` Storage bucket exists and allows the existing receipt upload flow.
4. Confirm Vercel has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set.

The migration creates a separate registration table. Direct table access is denied; players register through the capacity-checked RPC. The owner portal uses a second RPC that returns aggregate counts only, not player contact details.

## Important current-project limitation
Open Play event announcements are still created/stored in the existing browser-local owner portal prototype (`courtlyOwnerPortalV1`). The registration records and aggregate counts are stored in Supabase, but publishing and loading the event announcements themselves across different devices is not yet migrated to a shared Supabase events table. Therefore, an event created in one browser may not appear on a player's separate device until event publishing/loading is also migrated. This update does not claim that event publishing is cross-device ready.

Owner portal Open Play count refresh reads Supabase counts for event IDs available in that browser. The owner portal's event-management records remain local until the event table migration is completed.

## Build verification
A full Vite production build was not completed in the patch environment because dependency installation timed out. JavaScript syntax checks for the new Open Play module and the updated venue page passed. Check the Vercel build log after deployment.

## Open Play earnings visibility (new)
- The owner Earnings page now has a separate **Open Play earnings** panel.
- It displays total active registrations, confirmed payments, payments awaiting verification, and confirmed Open Play revenue.
- Only registrations with `payment_status = 'confirmed'` contribute to revenue. Awaiting-verification receipts are shown separately and are not counted as collected revenue.
- Open Play revenue is kept separate from court-booking gross, transaction fees, and owner net earnings. The existing ₱10 fee is per court-hour and is not automatically deducted from a standalone Open Play player fee.

### Additional SQL migration
Run `supabase/open-play-earnings.sql` after `supabase/open-play-registrations.sql`. It creates a protected aggregate RPC that only returns totals to the authenticated owner of the venue. It does not expose player names, email addresses, phone numbers, or receipt paths.

### Owner authentication requirement
The current Owner Portal still uses a browser-local demo session, not a Supabase Auth session. The protected earnings RPC therefore cannot return live totals until the owner portal is connected to Supabase Auth and each venue's `venues.owner_id` is linked to that authenticated user. Do not remove the authorization check or expose the registration table publicly to work around this limitation.
