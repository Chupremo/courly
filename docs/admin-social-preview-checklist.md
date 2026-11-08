# Courtly Admin + Social Preview — Implementation Checklist

Branch: feature/admin-social-preview

## Release gate
This branch is a development preview. Do not merge or deploy without explicit owner approval and passing automated tests.

## Private admin
- Platform admin identified by an explicitly allowlisted auth UUID in a protected backend secret/config, never by UI role alone.
- All analytics use protected server endpoints and server-side role checks; no privileged credentials in frontend.
- Non-admin requests return 403; court owner and player navigation never expose admin features.
- Metrics: total auth accounts, verified accounts, player profiles, venue owners, published venues, bookings, Open Play. Show separate unclassified count and avoid role double counts.

## Player discovery
- Only opted-in discoverable profiles appear in search; existing private profiles remain hidden.
- Search by name, sport, skill and coarse location; never reveal email, phone or exact address.
- Profile actions: follow/unfollow, friend request lifecycle, private messages, club invitations.
- Friend requests: send, accept, decline, cancel, deduplicate, block/report.
- Messages: participants only, row-level security and spam safeguards.
- Club invitations: club-admin permission, pending/accepted/declined, duplicate prevention.
- My Clubs: accepted memberships only, logo grid at profile bottom, link to club profile, initials fallback, privacy-aware.
- Reuse existing Supabase tables where appropriate; inspect migrations and RLS before changes.

## QA
- Verify with admin, court owner, player and logged-out test identities.
- Confirm direct admin route and API calls are forbidden for non-admins.
- Confirm private profiles and messages cannot be read by other users.
- Check mobile navigation, spacing, icons, accessibility, empty/loading/error states.
- Run npm run check, npm test, npm run build.
- Obtain explicit approval of preview before production release.
