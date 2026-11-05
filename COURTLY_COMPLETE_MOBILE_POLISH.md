# Courtly — Complete Mobile Responsive Polish

## What changed

- Added `courtly-responsive.css` and loaded it after page-specific styles on all 15 root HTML pages.
- Added `courtly-responsive.js` to all 15 pages. It gives the public venue directory and standalone booking lookup an accessible hamburger menu, and consolidates the Features/Pricing/Clubs/Courts/Business two-row marketing navigation into one mobile drawer.
- Preserved the existing player and owner dashboard menu implementations.
- Added mobile-safe sizing, readable text colors, 44–48px controls, safe-area spacing, and reduced horizontal overflow.
- Reworked the player Discover filter panel into a contained mobile grid.
- Reworked My Bookings filters, tabs and date controls into a 2-column mobile layout that collapses to one column on very narrow screens.
- Reworked the Profile summary card so the avatar, player name, email, skill badge, upload button and My Sports block no longer force horizontal overflow or excessive height.
- Reworked owner portal cards, forms, stats, tables, calendar scrollers, court cards and earnings tabs for mobile.
- Reworked public venue booking, photo gallery, date/calendar selection, timeslots, court cards and payment/confirmation dialogs for mobile.
- Reworked marketing, pricing, clubs, courts and business pages for narrow screens, including compact mobile navigation.
- Added `viewport-fit=cover` to page viewport metadata.

## Files

New:
- `courtly-responsive.css`
- `courtly-responsive.js`

Updated:
- All 15 root-level HTML pages. No database schema, Supabase environment variables, or booking/payment logic changed.

## Deploy

1. Back up your current GitHub `main` branch.
2. Extract this ZIP into the existing repository root.
3. Keep the existing `.env` / Vercel environment variables unchanged.
4. Commit and push to `main`.
5. Confirm Vercel completes the Vite multi-page build.
6. On mobile Safari/Chrome, hard refresh or clear the site cache to load the new CSS.

## Mobile test checklist

Test at 320px, 360px, 390px and 430px viewport widths:
- Home page navigation and hero buttons.
- Player dashboard drawer, Home, Discover, Tournaments, My Bookings, Memberships and Profile.
- Discover search, sport/location selects, mode tabs and venue cards.
- My Bookings statistic cards, type filters, date range, clear and refresh actions.
- Profile header, avatar upload, personal details, privacy toggle and save button.
- Owner portal drawer, overview stats, calendar, tables, forms, photo upload, earnings and settings.
- Public venue booking calendar, timeslots, court selection, payment dialog and confirmation dialog.
- Player/owner registration and login forms.
- Pricing, Features, Clubs, Courts and Business marketing pages.

## Validation notes

- All updated HTML documents were checked for parseability.
- JavaScript files were checked with Node syntax validation.
- CSS was parsed for syntax errors.
- A full Vite production build is not claimed unless Vercel's deployment log confirms it.
