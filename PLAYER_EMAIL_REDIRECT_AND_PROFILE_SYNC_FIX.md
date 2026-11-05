# Courtly Player Confirmation Redirect + Profile Sync Fix

## What changed
- Registration email links use `VITE_APP_URL` when set.
- If the app is opened on `localhost`, confirmation emails still go to `https://courtly-ecru.vercel.app/player-dashboard.html?welcome=1`.
- Player login now offers a resend-confirmation action when Supabase reports `Email not confirmed`; the resend link also targets the production Courtly domain.
- Player login and dashboard use a shared `syncPlayerProfile()` helper. Existing profile values are kept; blank values are filled from the Auth signup metadata.
- After login, the login page greets the player by their saved Player Name (fallback: Full Name). The dashboard header/sidebar use the same display name.
- If the confirmation callback lands on the dashboard without a session, Courtly routes to the player login page with a confirmation notice.

## Deploy files
Commit the updated `player-register.html`, `player-login.html`, `player-dashboard.js`, new `player-profile-sync.js`, `.env.example`, and the new `supabase/migrations/003_sync_existing_player_profiles.sql`.

## Vercel environment variable
Add this variable for Production, Preview, and Development:

`VITE_APP_URL=https://courtly-ecru.vercel.app`

Then redeploy. This is a public site URL, not a secret.

## Supabase Auth URL Configuration
In Supabase Dashboard → Authentication → URL Configuration:
- Site URL: `https://courtly-ecru.vercel.app`
- Add Redirect URL: `https://courtly-ecru.vercel.app/**`
- If you customized the signup confirmation email template, make sure its confirmation link uses `{{ .RedirectTo }}` rather than hard-coding `{{ .SiteURL }}` for the redirect destination.
- Optional local development allowlist only: `http://localhost:3000/**` and/or `http://localhost:5173/**`. Do not set localhost as the Site URL for production.

## Database migration
Run `supabase/migrations/003_sync_existing_player_profiles.sql` once in Supabase SQL Editor. It only backfills blank profile fields from Auth metadata and preserves non-empty values. The original player-account migration (002) must already be installed.

## Test
1. Open `https://courtly-ecru.vercel.app/player-register.html` (not localhost).
2. Register with a test email and a distinct Full Name / Player Name.
3. Inspect the confirmation email link: its `redirect_to` should start with `https://courtly-ecru.vercel.app/`.
4. Confirm the email. The browser should land on the deployed player dashboard.
5. If the existing account is still unconfirmed, enter its email on the player login page and use **Resend confirmation email**; the new link will target production. If confirmation already succeeded, simply log in.
6. Verify the dashboard sidebar, top bar, and home heading show the saved Player Name.
7. In Supabase, check `public.player_profiles` for matching `id`, `full_name`, `player_name`, and `email`.

Never expose the Supabase service-role key in Vercel browser environment variables.
