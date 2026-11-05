# Courtly – Court Payment Confirmation and Open Play Overview Fix

## What this update fixes

1. **Confirmed future court reservations now count immediately.** Earnings periods are based on the booking payment-confirmation timestamp (`confirmedAt`), with safe fallbacks to payment/update/creation timestamps for older records. The scheduled playing date no longer excludes a reservation that has already been paid.
2. **All dashboard KPIs use one calculation.** Court rental gross, confirmed Open Play revenue, court-hour transaction fees, and owner net earnings are refreshed from the same canonical values.
3. **Open Play transactions remain visible on Overview.** The panel is now part of the Overview markup instead of being temporarily injected next to Recent reservations. It is reloaded after Overview re-renders, including after confirming a court rental.
4. **No stray transaction panel on unrelated screens.** The Open Play loader does not inject an Overview panel into Calendar, Venue Profile, or other unrelated views.
5. **Open Play review actions continue to refresh the KPIs.** Demo actions remain browser-local; real owner review continues to use the venue-scoped Supabase RPC.

## KPI definitions

- Court Rental Bookings: confirmed/completed court bookings in the selected earnings period.
- Open Play Bookings: confirmed Open Play player payments.
- Court & Open Play Gross: court rental gross + confirmed Open Play fees.
- Transaction Fee: ₱10 per confirmed court-rental hour.
- Owner Net Earnings: court rental net (after venue-owner court-hour fees) plus Open Play registration revenue (less historical owner-paid fees only). Player-paid Open Play transaction fees are tracked separately as remittance due.

Example: ₱800 (2 hours) + ₱400 (1 hour) court bookings + ₱200 confirmed Open Play = ₱1,400 gross. The ₱30 court-hour fee leaves ₱1,370 owner net.

## Validation

- `node --check open-play-owner-sync.js` passed.
- The inline owner-portal JavaScript passed `node --check`.
- A calculation test for the screenshot scenario returned 2 court bookings, ₱1,200 court gross, ₱200 Open Play gross, ₱1,400 combined gross, ₱30 transaction fees, and ₱1,370 owner net.
- A full Vite production build was not run because Vite dependencies were not installed in this environment; an install attempt timed out.

## Important existing limitation

This update corrects the current owner portal's confirmation and dashboard behavior. The current court-rental owner portal still reads and writes its court booking collection through browser `localStorage`, while Open Play registrations use Supabase for real owners. This is suitable for the isolated demo flow, but it is **not yet a complete multi-device production ledger**. Before launch, real court bookings and payment confirmation must also be persisted and retrieved from Supabase so owners can see the same authoritative records across browsers and devices.

No Supabase schema or data was changed by this update. No SQL migration is required for these UI/logic corrections.
