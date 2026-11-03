# Courtly update notes — 3 November 2026

Included in this package:
- Raised venue logo, cover, court image and QR image client-side file checks from 10 MB to 100 MB.
- Renamed the fee in owner-facing transaction labels and checkout to **Transaction Fee**.
- Updated the checkout payment breakdown labels to **Court Hourly Rental**, **Transaction Fee**, and **Total**.

## Important limitations before production

This package does NOT complete cross-device booking synchronization. The current public booking flow stores booking records in browser localStorage, while the owner portal also uses its own localStorage state. The current owner portal's Confirm paid action only changes that local browser record. Those two stores are not a shared database, so a player on another device will continue to see Pending.

The owner portal's QR/logo/cover/court images are also currently stored as data URLs in localStorage. Raising the client-side limit to 100 MB does not make localStorage capable of storing 100 MB files; browser quota limits may reject these uploads. A real 100 MB image upload requires Supabase Storage buckets and saving the returned object paths/URLs in the venues table.

To complete the requested cross-device synchronization safely, the app needs to use the existing Supabase bookings table for booking creation and player lookup, plus authenticated venue-owner sessions and an owner-only update policy/RPC for payment confirmation. The current owner portal is still demo/localStorage-based, so enabling an anonymous public update policy would expose booking records and is not a safe substitute.

Do not treat booking confirmation as live-synced until that database/auth integration is implemented and tested.
