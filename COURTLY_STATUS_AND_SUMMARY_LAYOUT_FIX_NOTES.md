# Courtly status and booking summary layout update

## Included
- Booking summary rows now reserve enough width for labels and values, preventing the transaction fee label/value overlap seen on narrow layouts.
- When an owner clicks **Confirm paid**, the owner booking is marked `Confirmed` / `Paid` and the matching player-side `courtlyPublicBookingsV1` record is updated in the same browser's local storage.
- My Bookings refreshes its list when the page regains focus or another same-origin tab updates the public booking list.

## Important limitation
This is a same-browser synchronization improvement only. The current owner portal and player booking pages still use browser local storage for booking records. Local storage is not shared between different devices, browsers, or users. True cross-device synchronization requires storing bookings in Supabase and changing both player and owner pages to read/write the same database records with appropriate owner authorization and row-level security.

## Build verification
The production build was not run in this environment because dependencies are not installed (`vite: not found`). Run `npm install` and `npm run build` before deployment, then check the Vercel build log.
