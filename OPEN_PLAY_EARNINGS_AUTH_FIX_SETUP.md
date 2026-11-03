# Courtly Open Play Earnings Auth Fix

## What changed
- The root `login.html` now uses the project's bundled Supabase client instead of the old browser-only demo login.
- Owners can sign in with Supabase Auth or create an owner account.
- New owner signups include venue metadata. The existing `courtly_create_venue` Auth trigger creates the venue and starter courts.
- Open Play earnings now resolves the venue by the authenticated Supabase user ID. It no longer trusts a locally stored venue slug.
- Earnings errors now show the actual reason (not a generic instruction).

## Supabase prerequisites
Run these SQL files in order if they have not already been applied:
1. `supabase/schema.sql`
2. `owner-registration.sql`
3. `open-play-registrations.sql`
4. `open-play-earnings.sql`

If the owner already has a Supabase Auth account and an existing unclaimed venue row, edit `supabase/link-existing-owner-venue.sql`, replace `REPLACE_WITH_OWNER_EMAIL` with the exact Auth email in both places, and run it in SQL Editor. It only links a venue with a matching `admin_email` where `owner_id` is currently NULL.

If the existing owner has only used the old demo/localStorage login, that is not a Supabase Auth account. Use the new Create an owner account flow on `/login.html` and confirm the email if Supabase requires it. The Auth trigger must be installed so the new account gets a venue row.

## Deploy
Replace the repository files with this ZIP and push to `main`. Keep the existing Vercel `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment variables. The login page uses `supabase-client.js`; do not put a service-role key in the browser.

## Important
This fixes the Auth-to-venue lookup used by Open Play Earnings. It does not migrate old demo/localStorage bookings or old locally stored Open Play event announcements into Supabase. The complete Vite production build has not been verified in this environment.
