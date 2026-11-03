# Booking confirmation and My Bookings update

## What changed
- Successful GCash receipt upload now redirects to `/booking-confirmation.html?ref=BOOKING_REFERENCE`.
- Confirmation page shows booking reference, venue, court, date, time, player, amount, and pending-verification status.
- Confirmation page links to `/my-bookings.html`.
- My Bookings lists locally stored bookings and can filter by the email used at checkout.
- Added both pages to Vite multi-page build and Vercel clean routes.

## Current prototype limitation
The existing checkout flow stores booking records in browser localStorage and uploads the receipt to Supabase Storage. This update intentionally preserves that flow. As a result, My Bookings is device/browser-specific, and the owner portal will not receive cross-device live updates. A production implementation needs a secure Supabase booking-creation RPC/table insert, a private receipt association, and authenticated/customer-safe booking retrieval. Do not treat receipt upload alone as payment confirmation.

## Deploy
Replace the project files in GitHub with this ZIP's contents and let Vercel redeploy. Test a booking using a venue with configured payment QR and storage bucket.
