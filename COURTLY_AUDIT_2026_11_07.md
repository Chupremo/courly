# Courtly application audit and fixes

Date: 7 November 2026 (Asia/Manila)  
Website: https://www.courtlyph.com  
Repository: https://github.com/Chupremo/courly  
Baseline: `37f62cce08e6915059ecb8868850c2d09f02500c`

## Scope and release status

This change audits the Vite application entries, fixes shared presentation and
navigation problems, and addresses verified booking, billing-display and owner
management defects. It preserves the existing Supabase schema, authentication
boundaries, payment providers, fee rates and booking policies.

The code is prepared for review on a separate branch. It has not been merged or
published to `courtlyph.com`. No live reservations, payment approvals,
cancellations, remittances, accounts or database migrations were created or
changed during this work.

The repository's existing Vercel checks on the baseline commit report
**“Deployment rate limited — retry in 24 hours.”** All three linked Vercel
contexts reported that status before this work was submitted. The time limit
is Vercel's reported message, not a verified reset time.

## Application inventory

All 35 production HTML entries declared in `vite.config.js` were included in
the source checks. The routing rewrites in `vercel.json` were also inspected.
Historical duplicate HTML and SQL files that are not build entries were not
treated as active product pages or applied as migrations.

| Area | Built pages |
| --- | --- |
| Public and venue discovery | `index.html`, `players.html`, `business.html`, `features.html`, `pricing.html`, `clubs.html`, `courts.html`, `venue.html` |
| Player accounts and bookings | `player-register.html`, `player-login.html`, `player-dashboard.html`, `booking-confirmation.html`, `my-bookings.html`, `player-messages.html` |
| Community | `community.html`, `community-event.html` |
| Venue owners | `login.html`, `owner-portal.html`, `venue-owner-terms.html` |
| Coaches | `coaches.html`, `coach.html`, `coach-register.html`, `coach-login.html`, `coach-booking.html`, `coach-chat.html`, `coach-portal.html`, `coach-owner-terms.html`, `my-coaching-sessions.html` |
| Clubs | `browse-clubs.html`, `club-register.html`, `club-login.html`, `club-dashboard.html` |
| Administration and demo | `admin-billing.html`, `admin-coaches.html`, `demo.html` |

## Main fixes

### Booking reliability

- Clearing a time selector clears the booking range; it cannot silently become
  midnight or keep an old selection. Court bookings respect the backend's
  existing 1–8 hour limit.
- Availability requests are associated with the selected date. An older
  response cannot replace the latest selection. Failed availability requests
  disable checkout and provide a retry instead of advertising free courts.
- Checkout captures the reviewed selection, validates receipts before creating
  a court reservation, and acquires submission guards before the first await.
  Payment controls and modal closing are protected while a submission is active.
- Successful backend mutations remain successful when a subsequent display
  refresh, browser-storage write or receipt-email attempt fails.
- Cancelled, rejected and expired reservations take precedence over an earlier
  confirmed payment when rendering booking status. Unpaid requests no longer
  claim that a receipt was submitted.
- Coaching reservations ignore repeated taps and stale slot responses. Once a
  reservation exists, its date/time/duration and backend price remain the
  authoritative payment summary. Expired holds cannot submit payment.
- Removing locally saved booking references invalidates outstanding refreshes,
  preventing late responses from showing the removed records again.
- The venue page starts with loading placeholders instead of an unrelated
  sample venue, sample date and price. Missing or failed images have fallbacks.
  Courts with missing rates are unavailable for selection, while a legitimate
  numeric zero price is preserved.

### Billing wording and preserved amounts

Relevant booking, checkout, confirmation and management charge labels use
**Convenience Fee**. The shared booking label is defined in `booking-utils.mjs`.
Database column names, RPC parameters and accounting identifiers are unchanged.

| Existing charge | Amount and payer retained |
| --- | --- |
| Court rental | ₱10 per booked hour, paid by the venue owner; excluded from the player's checkout total |
| Paid Open Play | ₱10 per registration, paid by the player in addition to the event price |
| Free Open Play | ₱0 fee; no payment receipt required |
| Coaching | ₱50 per successful booking, paid by the coach; excluded from the player's session price |

The shared visibility fix also ensures that an intentionally hidden owner-paid
fee row is not exposed by a conflicting `display: grid !important` rule.

### Owner management

- Settings saves update only the requested section. Payment or profile changes
  no longer reconstruct courts, rewrite unrelated settings, or remove events
  and blocks created elsewhere.
- Court settings preserve court IDs, names, sports and photos. Inactive courts
  are not silently reactivated, and courts created in another tab are not
  removed by a stale full-list comparison.
- Publish, block, image and other save actions report success only after the
  corresponding backend operation succeeds. Repeated payment-review taps are
  guarded.
- The calendar distinguishes pending, booked, blocked and available periods,
  supports day/week views, and accounts for partial-hour bookings and blocks
  spanning multiple hours. Rejected/cancelled reservations do not occupy slots.
- Demo payment approvals, cancellations and Open Play review stay in demo
  state and do not call live mutation RPCs.
- Receipt-delivery failures do not misreport an already-confirmed payment as a
  failed approval. Open Play filters remain selected when the review list refreshes.
- Background billing refresh preserves unfinished remittance forms. A saved
  remittance stays successful when the subsequent balance refresh fails and
  cannot be submitted again through the old form.

### Shared navigation, layout and accessibility

- Home consistently opens `/`; role workspaces have their own navigation links.
  Navigation remains available while account information loads and ignores
  stale authentication responses.
- Shared navigation loads its stylesheet on coach and other pages that omitted
  it, and reuses the header placeholder without duplicate IDs.
- Mobile menus have accurate open/close labels and icons, outside/Escape
  dismissal, and scrolling within short screens. Header controls do not inherit
  unsuitable form-button spacing.
- Removed the global text-rewriting script that stripped arrows, calendar
  symbols, checkmarks and characters from user content and accessible names.
- Restored emphasis on prices, totals and buttons by removing the blanket font
  weight override. Added visible keyboard focus, touch-friendly controls,
  readable mobile form sizing, reduced-motion handling and scrollable dialogs.
- Added a skip link, associations for existing unambiguous form labels,
  keyboard-accessible table scrolling, and focus management for custom dialogs.
  Dialog Escape handling respects each page's existing close/submission guard.

### Discovery and account recovery

- Venue search and labelled filters appear before the owner promotion. Active
  filters are visible and reflected in the URL, and network failures retain
  those filters with a retry action.
- Mixed-sport venues show the selected sport's courts and prices. Missing rates
  are not presented as zero-price rentals, and listing images load lazily.
- Registration validates email/password confirmation near the relevant field,
  ignores repeated submissions, and preserves the booking destination when
  switching to login.
- A profile/photo error after successful account creation offers a way to
  continue with that account instead of inviting duplicate registration.
- Owner login uses a keyboard-accessible mode button, prevents mode changes
  during submission and recognises club/admin destinations. Existing valid
  login passwords are not rejected by the sign-up-only minimum-length rule.

## Verification

The repository now includes repeatable checks:

```sh
npm ci
npm run check
npm test
npm run build
```

- `npm run check` passed for all 35 built pages and 50 scripts, inspecting
  JavaScript syntax, page titles, viewport metadata, duplicate static IDs,
  internal link targets and same-page section links.
- All 35 regression tests passed. The suite exercises actual application handlers with controlled
  backend responses. It covers availability races, pricing/fee invariants,
  invalid ranges, duplicate submissions, committed-success handling, owner
  save scoping, demo isolation, registration recovery and directory failures.
- The Vite production build completed successfully. A dependency lockfile makes
  the reviewed dependency resolution reproducible.
- The shared stylesheets were parsed with PostCSS, and the patch passed
  `git diff --check`.
- The live public homepage, venue directory and a venue booking page were
  inspected in the browser, including a measured 390 CSS-pixel mobile view.
  These observations were of the existing deployment, not the changed branch.

## Checks still required before release

Updated-page visual verification is blocked in this session: the connected and
cloud browsers could not reach the workspace development server, and the
existing Vercel deployment checks were rate-limited. The source and regression
checks are not a substitute for rendering the changed pages.

Before merging/publishing, use a preview with staging accounts and data to:

1. Inspect the updated layouts at 320, 375, 390, 430, 768, 1024 and 1440 CSS
   pixels, including landscape, keyboard focus, navigation and payment dialogs.
2. Complete a player court booking, paid/free Open Play registration, coaching
   reservation and receipt submission with test data. Verify totals against the
   deployed RPCs and exercise a conflicting slot and an expired session.
3. Exercise owner calendar blocking, settings/photo saves, payment review and
   cancellation, including concurrent changes from two sessions.
4. Verify player/owner/coach/club/admin permissions with separate test accounts,
   plus receipt delivery and remittance refresh/recovery against staging.

No authenticated live end-to-end payment or reservation test is claimed as
passed. Password recovery, rescheduling and other features are not claimed as
implemented where they were not already part of the inspected application.
