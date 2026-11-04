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

The consolidated migration provides:

- Owner venue creation/linking through Supabase Auth.
- Shared venue profiles, court catalog, operating hours, payment settings and image storage.
- Database-backed availability, atomic reservation conflict checks, temporary unpaid holds and receipt submission.
- Owner-scoped reservation review and cancellation.
- Open Play events, registrations, capacity checks, receipt review and earnings.
- Private customer receipts, public venue media, and RLS / least-privilege access.
- Customer booking lookups through random access tokens rather than public email-only lookup.
- A consistent platform fee rule: PHP 10 per reserved court-hour or Open Play registration is deducted from the venue owner's payout and is not added to the player's checkout total.

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
