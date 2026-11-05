# Courtly — Supabase-backed Vercel app

Courtly is a Vite multi-page website for players and sports-venue owners. The production app uses Supabase Auth, Postgres, Row Level Security (RLS), RPC functions, and Supabase Storage.

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local` before using authenticated or database-backed pages. The publishable/anon key is intended for browser use when RLS and function permissions are correctly configured. **Never put a Supabase `service_role` secret in a Vite environment variable or browser code.**

## Supabase setup

Follow [`SUPABASE_COMPLETE_SETUP.md`](SUPABASE_COMPLETE_SETUP.md). For a new project, run the base `schema.sql` once and then run `supabase/001_complete_supabase_backend.sql`. For a project that already has the base Courtly tables, back up the database and run only the consolidated migration. Do not run the older individual Open Play, owner-registration, receipt-storage, or hourly-fee SQL patches after the consolidated migration. Those historical files are stored under `archive/legacy-migrations/`.

After the consolidated backend migration, also apply each incremental migration in order, including `supabase/migrations/005_hybrid_courtly_fee_policy.sql` for the hybrid fee policy. Back up the database before applying migrations.

The consolidated migration provides:

- Owner venue creation/linking through Supabase Auth.
- Shared venue profiles, court catalog, operating hours, payment settings and image storage.
- Database-backed availability, atomic reservation conflict checks, temporary unpaid holds and receipt submission.
- Owner-scoped reservation review and cancellation.
- Open Play events, registrations, capacity checks, receipt review and earnings.
- Private customer receipts, public venue media, and RLS / least-privilege access.
- Customer booking lookups through random access tokens rather than public email-only lookup.
- A hybrid fee policy: PHP 10 per booked court-hour for court rentals is paid by the venue owner; paid Open Play adds a PHP 10 transaction fee to the player’s registration checkout; free Open Play has no transaction fee. Venue QR payments collect the player-paid Open Play fee for later remittance to Courtly.

## Main routes

- `/` — Courtly homepage
- `/players.html` — public venue directory
- `/v/:slug` — venue booking page
- `/login.html` — owner signup and login
- `/owner-portal.html` — authenticated owner dashboard
- `/booking-confirmation.html` — customer booking confirmation
- `/my-bookings.html` — bookings stored in the customer's current browser

## Build and deployment

```bash
npm run build
```

Vercel uses `vercel.json` and expects `dist` as the output directory. Add the two public Supabase environment variables to the Vercel project for Production, Preview, and Development as appropriate, then redeploy.

## Important launch notes

- Applying SQL in this repository does not change a remote Supabase project by itself. The migration must be executed in the correct Supabase project.
- The migration has not been tested against your live database; back up existing data and test in a staging Supabase project first.
- Manual GCash/QR receipt review is not an automated payment gateway. Owners must verify each receipt before confirming a booking.
- Email notification preferences are stored, but delivery requires a separately configured email provider / server-side function.
- Run the post-migration test checklist in `SUPABASE_COMPLETE_SETUP.md` before accepting live bookings.

## Demo mode

The four owner demo portals and the business-page preview use fictional browser-local data for demonstration only. The real owner portal and player booking flow use Supabase. Demo records are not real reservations or payment records.

## Courtly Supabase project configuration

The supplied Courtly Supabase project uses this project root URL:

`https://pklrvpnnkmdwgqoyvhsb.supabase.co`

Use the root URL in `VITE_SUPABASE_URL`; do not append `/rest/v1/`. Copy `.env.example` to `.env.local` and add the Supabase publishable key locally. In Vercel, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Project Settings → Environment Variables, then redeploy. The publishable key is suitable for browser use only when the database's RLS policies and function permissions are configured correctly. Never expose a Supabase secret/service-role key in frontend code.

## Player-facing experience

Courtly now includes a separate player registration/login and dashboard flow. See `PLAYER_DASHBOARD_SETUP.md` and apply `supabase/migrations/002_player_accounts_and_dashboard.sql` after the existing complete backend migration before deploying the player pages. Player and owner authentication flows are separate; the owner portal remains on `login.html`.


## Player confirmation redirect and profile sync
See `PLAYER_EMAIL_REDIRECT_AND_PROFILE_SYNC_FIX.md`. Run the additive migration `supabase/migrations/003_sync_existing_player_profiles.sql` after the player account migration. Set `VITE_APP_URL=https://courtly-ecru.vercel.app` in Vercel and update Supabase Authentication URL Configuration as described in the guide.

The player login page includes a resend-confirmation action for accounts that are still unconfirmed; it uses the same canonical production redirect.

## Weekly owner billing and remittances

Courtly's owner billing implementation is documented in `COURTLY_WEEKLY_BILLING_IMPLEMENTATION.md`. After the hybrid fee policy migration 005, run `supabase/migrations/006_weekly_owner_billing_invoices.sql`, bootstrap the dedicated admin account, configure Courtly's receiving remittance details in `/admin-billing`, enable Supabase `pg_cron`, and run `supabase/migrations/007_weekly_billing_cron_schedule.sql`. New venue owners must accept the current Venue Owner Terms in the Owner Portal before new bookings/Open Play registrations are accepted. Weekly invoices are issued Friday 09:00 Asia/Manila and are due 72 hours after issue. Venue payments remain direct to venue merchant QR; fee remittance to Courtly is manual and verified by a Courtly admin.


For the Courtly billing administrator, use a separate email: register it through the player registration page, confirm it, then run `COURTLY_WEEKLY_BILLING_ADMIN_BOOTSTRAP.sql` after replacing the email placeholder. The script changes that account's metadata to `courtly_admin` and allowlists it, avoiding the owner-venue creation trigger. Use that identity only at `/admin-billing`.


## Courtly owner billing

The owner billing dashboard shows a live running balance: issued invoice balances plus accrued fee-ledger entries not yet included in a Friday statement. Friday's statement groups already-recorded fees; it does not create additional charges. Install migration 008 after 006 and 007 to enable the live owner/admin balance and itemized fee activity.
