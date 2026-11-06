# Courtly Coach Marketplace & Coach Portal

This release adds a separate coach account type and a coach marketplace to the existing Courtly website.

## What is included

- Public **Browse Coaches** directory at `/coaches`.
- Public coach profiles at `/coach/<slug>` with profile photo, cover photo, hourly rate, sport, location, biography, weekly availability, admin-controlled verified badge, Follow, Message and Book Coaching Session actions.
- Separate coach registration at `/coach/register` and coach login at `/coach/login`.
- Coach profile and cover uploads (JPG/PNG/WEBP, max 100 MB each, using resumable uploads).
- Coach Portal at `/coach/dashboard` with Overview, Booking Calendar, Coaching Sessions, Clients, Availability & Rates, Earnings & Transactions, Coach Profile, Payment Settings, Courtly Fees & Invoices, Messages and Notifications.
- Player booking flow at `/coach/booking?coach=<slug>` with date, duration and live available-time selection.
- Player payment to the coach's own configured QR/account. Player checkout is the coach's hourly rate multiplied by selected hours. The Courtly ₱50 fee is not added to the player's checkout.
- Coach-paid ₱50 fee recorded once when a paid coaching booking is confirmed; weekly coach invoices and 72-hour remittance deadline.
- Player/coach messaging, player follow/unfollow and player coaching-session history.
- Courtly admin coach verification and coach-remittance review at `/admin-coaches`.
- Coaches can publish to the existing Community feed.

## Fee rule implemented

The ₱50 Courtly coaching fee is charged to the coach for each successful paid coaching booking/session (one fee per confirmed paid booking, **not** per coaching hour). The player pays only the coach's hourly rate multiplied by the booked duration. The coach receives the player's payment directly through the coach's configured payment account and remits the ₱50 Courtly fee through the weekly invoicing process.

Payments are manual in this release: the player enters a payment reference and the coach verifies the payment in the Coach Portal. This is not an automatic payment-gateway integration.

## Before installing

1. Back up the production Supabase database.
2. Confirm the existing Courtly base schema and these prerequisite migrations are already installed:
   - `002_player_accounts_and_dashboard.sql` (creates `player_profiles`)
   - `005_hybrid_courtly_fee_policy.sql`
   - `006_weekly_owner_billing_invoices.sql` (provides Courtly admin/payment settings helpers)
   - `011_player_network_and_community.sql` (creates the Community tables)
   - `013_require_player_auth_for_booking.sql`
3. Do not rerun the original base schema or old migrations just to install coaches.

## Step 1 — Apply the coach migration

In Supabase Dashboard → SQL Editor → New Query, run the complete file:

`supabase/migrations/014_coach_marketplace_and_portal.sql`

Run it once. It is additive to the existing Courtly database and creates coach profiles, availability, coaching bookings, follow/chat tables, coach fee ledger, invoices, remittances, terms acceptance, storage buckets, RLS policies and RPCs. It also updates the auth signup trigger so coach accounts do not get a venue auto-created for them.

The SQL migration has static structural checks, but it has **not** been executed against your live Supabase project in this environment. Review the SQL and execute it first in a staging project if available.

## Step 2 — Supabase Storage limit

The migration creates the `courtly-coach-media` bucket with a 100 MB per-object limit. Profile photos and cover photos accept JPG, PNG or WEBP, max 100 MB each.

You must also set the **project-wide Supabase Storage file-size limit** to at least 100 MB in Supabase Dashboard → Storage → Settings. A bucket-level 100 MB limit cannot override a lower project-wide/plan limit. If your current Supabase plan does not allow 100 MB uploads, the upload will be rejected until the project-wide limit is raised or the plan is changed.

The `courtly-coach-payment-receipts` bucket is private and limited to 10 MB per receipt.

## Step 3 — Supabase Auth redirect allowlist

In Supabase → Authentication → URL Configuration, ensure the production callback is allowed:

`https://courtly-ecru.vercel.app/coach-login.html`

Keep the project Site URL set to the production Courtly origin. The coach registration page uses `VITE_APP_URL` when available and falls back to `https://courtly-ecru.vercel.app`.

## Step 4 — Courtly admin access

The `/admin-coaches` console uses the existing `public.is_courtly_admin()` authorization helper from the Courtly weekly billing/admin setup. Sign in with a Courtly administrator account that is already allowlisted. Do not grant admin access to ordinary coach or player accounts.

Use the admin console to review coach details and grant/remove the Verified badge. Coaches cannot set their own verification fields.

## Step 4A — Update the admin coach marketplace cards

After migration 014 is installed, run this additive migration in Supabase SQL Editor:

`019_admin_coach_marketplace_cards.sql`

It updates the admin coach-data RPC to return each coach's profile photo, cover photo, biography, experience and public profile slug. The updated `admin-coaches.html` uses those fields to render marketplace-style coach cards while retaining the admin verification and remittance controls.

## Step 5 — Deploy website files

Copy the files from the targeted patch into the existing GitHub `courly` repository, preserving the folder structure. The updated files include:

- New pages/scripts: `coaches.html`, `coaches.js`, `coach.html`, `coach-profile.js`, `coach-register.html`, `coach-login.html`, `coach-login.js`, `coach-booking.html`, `coach-booking.js`, `coach-chat.html`, `coach-chat.js`, `coach-portal.html`, `coach-portal.js`, `coach-owner-terms.html`, `admin-coaches.html`, `admin-coaches.js`, `my-coaching-sessions.html`, `my-coaching-sessions.js`, `coach-app.css`, `coach-media.js`.
- Updated integration files: `courtly-global-nav.js`, `community.js`, `player-dashboard.html`, `player-login.html`, `player-register.html`, `vite.config.js`, `vercel.json`.
- Migration: `supabase/migrations/014_coach_marketplace_and_portal.sql`.

Commit to `main` and allow Vercel to deploy. Existing Supabase environment variables are reused:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- Optional `VITE_APP_URL=https://courtly-ecru.vercel.app`

No service-role key is required in browser variables.

## Step 6 — Enable scheduled coach billing

Migration 014 attempts to register its Friday 09:00 Asia/Manila weekly-invoice job and five-minute overdue enforcement job when `pg_cron` is available. Confirm that `pg_cron` is enabled and verify the scheduled jobs after the migration. If the migration reports that `pg_cron` is not enabled, enable the extension and run the scheduling block from the migration again.

## Coach onboarding

1. Open `/coach/register`.
2. Create a separate coach account and accept the Coach Terms.
3. Confirm the email and sign in at `/coach/login` if the confirmation flow does not create a session automatically.
4. In Coach Portal → Profile, upload or finish the profile and cover photo if email confirmation prevented immediate upload.
5. In Availability & Rates, set the hourly rate and weekly time blocks; add blocked periods when unavailable.
6. In Payment Settings, enter the coach's payment account and upload the coach's merchant QR.
7. Publish the profile.
8. Courtly admin reviews the account and grants the Verified badge when appropriate.

## Player journey

1. Browse `/coaches` without signing in.
2. Open a coach profile to review rate, location, availability and verified status.
3. Follow or message the coach after signing in with a player account.
4. Choose Book Coaching Session, date, duration and one available slot.
5. The player pays the displayed session subtotal directly to the coach and submits the payment reference (receipt is optional).
6. The coach reviews the payment in Coach Portal → Coaching Sessions. Once confirmed, the booking is confirmed and the ₱50 coach fee is recorded once in the coach fee ledger.
7. The player can see the session at `/my-coaching-sessions`.

## Post-deployment test checklist

- [ ] Coach signup creates a `coach_profiles` record and does not create a `venues` record.
- [ ] Coach email confirmation/login returns to the production Courtly domain.
- [ ] Profile and cover photo uploads work at the configured limit; project-wide Storage limit permits 100 MB.
- [ ] Coach can set rate, weekly availability and blocked times.
- [ ] Coach cannot set their own verified badge or billing status.
- [ ] Only published, active coaches appear in Browse Coaches.
- [ ] Public profile shows admin-controlled Verified badge, rate, location and schedule.
- [ ] Player can follow/unfollow and start a coach conversation.
- [ ] Guest can browse but must sign in as a player to create a coaching booking.
- [ ] Overlapping booking attempts for the same coach/time cannot both succeed.
- [ ] Player checkout excludes the ₱50 coach fee.
- [ ] Coach confirmation creates exactly one ₱50 fee ledger entry.
- [ ] Repeated confirmation does not create a duplicate fee.
- [ ] Weekly coach invoices and 72-hour overdue rules work in staging before production activation.
- [ ] Coach can access their own sessions, clients, earnings, payment settings and invoices, but not another coach's data.
- [ ] Admin-only coach verification and remittance review are enforced by Supabase.

## Known launch notes

- The Coach Portal contains the equivalent operational areas needed by a coach, but it is a new coach-specific workspace, not a copy of venue-owner functions such as managing physical courts.
- Chat messages are text-only in this initial release; image/video posts are handled by the separate Community feature.
- Booking payment verification is manual through each coach's own payment account; there is no payment gateway/webhook integration in this release.
- Coach media uses a public bucket for profile/cover/QR media. Do not upload sensitive identity documents or private records to that public bucket.
- Coach Terms are a draft product agreement and should receive legal review before public enforcement.
- Static JavaScript/HTML/config checks passed. A full Vite production build and live Supabase integration test remain pending because dependency installation timed out in the preparation environment.
