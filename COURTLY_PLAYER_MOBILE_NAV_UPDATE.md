# Courtly Player Mobile Navigation Update

## What changed

- Replaced the always-visible 75px mobile icon rail with an off-canvas player navigation drawer.
- Added a three-line hamburger button to the player dashboard top bar. It animates into a close icon when the drawer is open.
- Added a dimmed backdrop; tapping outside the drawer, pressing Escape, or selecting a navigation item closes the drawer.
- Kept full player labels, profile/skill details, Courtly logo, and logout visible inside the opened drawer.
- Added `aria-expanded`, `aria-controls`, `aria-hidden`, keyboard Escape support, and focus return to the menu toggle.
- Removed the 75px left offset on mobile so the dashboard uses the full screen width.
- Improved touch target sizes, mobile spacing, responsive filters, booking cards, forms, modal presentation, and safe-area spacing.
- Made sports chips horizontally swipeable on small screens.
- Preserved existing page routes, Supabase queries, registration/login logic, and desktop sidebar behavior.

## Files changed

- `player-dashboard.html` — hamburger and backdrop markup; loads the mobile stylesheet.
- `player-dashboard.js` — drawer open/close behavior and accessibility state.
- `player-mobile.css` — responsive drawer and mobile layout refinements.

## Deploy

1. Extract the ZIP.
2. Replace these three files in the existing Courtly repository.
3. Keep the rest of the project and Supabase environment variables unchanged.
4. Commit and push to `main`; Vercel will deploy from GitHub.
5. Open the player dashboard on a phone and reload without cache.

No Supabase SQL migration is required.

## Validation

- `node --check player-dashboard.js` passed.
- HTML parse completed with Python HTMLParser; no duplicate IDs.
- Mobile CSS brace balance and media query checks passed.
- A complete Vite production build could not be run because `npm install` timed out in this environment. Verify the deployed Vercel build.
