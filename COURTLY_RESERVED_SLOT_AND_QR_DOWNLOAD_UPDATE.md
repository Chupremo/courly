# Courtly reserved-slot and payment QR download update

## Included in this update
- After a player uploads a payment receipt successfully, the selected court/time is immediately saved as `Reserved` in the player's browser booking list. The availability check treats that record as occupied, preventing another booking for the same court/time in that browser.
- The player sees `Reserved · Awaiting verification` and is told that the venue owner only needs to verify the receipt.
- The owner portal continues to show the booking as `Pending` so the owner can use the existing **Confirm paid** action after checking the receipt. This keeps the owner verification step explicit.
- Added a **Download QR code** link in the payment window. It downloads the venue QR image for use in the player's GCash/QR scanner workflow.

## Important deployment limitation
This project version still uses browser `localStorage` for booking records and venue settings. The reservation lock and owner/player update therefore work only where both flows share the same browser storage. They do **not** provide reliable synchronization between a player's phone and the venue owner's different phone.

For the requested production workflow (player submits on their phone, owner sees it on their phone), bookings must be written to and read from Supabase with a secure public booking-creation RPC and owner-authenticated verification RPC. Do not treat this prototype update as cross-device-ready. The uploaded receipt remains in Supabase Storage; the booking record itself is not yet a shared Supabase row.

## Test
1. Open the venue booking page and select a court, date, and time.
2. In payment, click **Download QR code** and verify the image downloads.
3. Submit a receipt. The player booking should show `Reserved · Awaiting verification`.
4. Return to the same venue page in the same browser and confirm the reserved time is unavailable.
5. In the same browser storage, open the owner portal and verify the booking appears as pending for owner review.
