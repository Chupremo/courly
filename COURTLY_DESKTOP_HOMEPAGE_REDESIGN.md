# Courtly desktop homepage redesign

This update refreshes the public homepage (`index.html`) with a more complete sports-booking SaaS presentation inspired by the general product-storytelling approach on Sports360.

## What changed

- New responsive navigation with player, venue, platform and onboarding sections.
- New hero section with player and venue-owner calls to action.
- Illustrative desktop owner-dashboard preview with schedule and sample KPIs.
- Dedicated player and venue-owner paths.
- Venue-management feature cards covering bookings, schedules, player experience, Open Play, payment review and earnings.
- Player booking journey and illustrative venue-discovery preview.
- Sports-category strip and venue onboarding steps.
- Stronger final call-to-action and structured footer.
- Accessibility basics: semantic sections, labelled navigation, mobile menu states and reduced-motion support.
- Existing links to `/players.html`, `/business.html`, `/login.html`, `/owner-portal.html` remain relative and are preserved.

## Important content note

Dashboard figures and venue cards in the homepage are explicitly labelled illustrative/sample previews. They are not live customer metrics or guaranteed listings. The existing player directory remains the source for live venue listings.

## Scope

This update changes the desktop/public homepage only. It does not alter Supabase schema, RLS policies, authentication, booking RPCs, payment handling, owner-portal logic or image uploads. Existing application pages remain in place.
