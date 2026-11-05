# Courtly — Complete Supabase setup

This guide is for the updated Courtly source package. It consolidates the database setup into one base schema and one complete backend migration.

## 1. Back up the database

Before running SQL on a project that contains real or test records, create a Supabase backup or use a separate staging project. Do not run this on production without a recoverable backup.

## 2. Apply the base schema only when needed

- **Brand-new Supabase project:** Open Supabase Dashboard → SQL Editor, run the root `schema.sql` (or the identical `supabase/schema.sql`) once.
- **Existing Courtly Supabase project that already has `venues`, `courts`, and `bookings`:** Skip this step. Do not recreate tables or run a second copy of the base schema.

Run only one copy of the base schema, not both.

## 3. Apply the consolidated backend migration

Open `supabase/001_complete_supabase_backend.sql`, copy the full contents, and run it in Supabase Dashboard → SQL Editor.

This migration adds the shared database fields, court blocks, Open Play tables, RLS policies, storage buckets and policies, owner signup/linking functions, secure booking/availability RPCs, private customer access tokens, owner payment review, and earnings functions. It also retires the older Open Play registration RPC that accepted event price and capacity from the browser.

The migration is designed to be rerunnable for its additive setup, but it is not a substitute for a backup. Review any SQL error and resolve it before deploying the app.

**Do not then run the older individual patches** such as `owner-registration.sql`, `open-play-events.sql`, `open-play-registrations.sql`, `payment-receipts-storage.sql`, `open-play-earnings.sql`, `open-play-owner-transactions.sql`, `courtly-hourly-fee-migration.sql`, or the duplicate root-level versions. They are retained under `archive/legacy-migrations/` as historical reference files; the consolidated migration supersedes them.

## 4. Configure Supabase Auth

In Supabase Dashboard → Authentication → Providers → Email:

- Enable Email provider.
- Keep email confirmation enabled for production.
- Configure the site URL and redirect URLs for your deployed Courtly domain and local development domain.

The signup trigger creates a venue and the selected number of starter courts. Existing Auth users can be linked or initialized when they first load the owner portal.

## 5. Configure environment variables

Copy `.env.example` to `.env.local` for local development and set:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

Then add the same two values in Vercel → Project → Settings → Environment Variables. Apply them to the required environments and redeploy.

Only use the public publishable/anon key. **Never expose the Supabase `service_role` key in frontend code, `.env.local` variables prefixed with `VITE_`, GitHub, or Vercel client bundles.**

## 6. Build and deploy

```bash
npm install
npm run build
```

Deploy the updated project to Vercel. The deployed app will read and write records in the Supabase project configured by those environment variables.

## 7. Run the post-migration test checklist

Use test accounts and non-production payments first.

### Owner signup and isolation

1. Create a test owner account.
2. Confirm the email if confirmation is enabled.
3. Log in and verify one venue plus the requested starter courts were created.
4. Update the venue name, address, city, contact number, sports, hours, off-peak and peak rates, peak-window start/end, payment instructions, logo, cover image and QR image. Verify both peak-window fields are either set together or left blank.
5. Sign out and sign in from another browser/device. Confirm the same data appears.
6. Create a second owner account and verify neither account can see or edit the other's private data.

### Player directory and venue page

1. Verify the published venue appears in `/players.html`.
2. Open its `/v/<slug>` page in a private/incognito browser.
3. Confirm the venue profile, active courts, published Open Play events and payment information are loaded from Supabase.
4. Confirm an unpublished venue does not appear in the public directory.

### Court booking and payment receipt

1. Create a test booking for a future timeslot.
2. Configure a peak window (for example 17:00–21:00) and verify that a booking spanning peak and off-peak hours is priced hour by hour; leave the peak window blank and verify only the off-peak rate is used.
3. Open the same venue in another browser and verify the held timeslot is unavailable.
4. Try to submit a second overlapping booking; the database must reject it.
5. Upload a supported receipt image and verify the booking changes to “Awaiting owner verification”.
6. Sign in as the owner and verify the matching reservation and private receipt link appear.
7. Confirm or reject the payment. Verify that the customer sees the updated status on the browser that holds the booking access token.
8. Test an abandoned checkout and confirm the unpaid hold expires after 20 minutes.

### Open Play

1. Create and publish an upcoming event as the owner.
2. Register as a player and submit a test receipt.
3. Confirm the registration appears in the correct owner's Open Play transactions.
4. Verify that capacity counts update and a full event rejects additional registrations.
5. Confirm/reject a payment and check that only confirmed registrations count toward confirmed revenue.
6. Verify an event price or capacity changed in the browser payload cannot override values stored in the database.

### Storage and privacy

1. Confirm venue media is publicly viewable.
2. Confirm payment receipts are stored in the private `courtly-payment-receipts` bucket.
3. Confirm a different owner cannot open another venue's receipt.
4. Confirm public booking lookup requires the per-booking access token; email address alone must not return a reservation.
5. Confirm no service-role key is present in deployed JavaScript or HTML.

## Database model

- `auth.users` is the identity source for venue owners.
- `venues` stores each business profile and owner link.
- `courts` belongs to a venue and stores active status, images, off-peak rate and peak rate.
- `bookings` stores each court reservation, payment review state, authoritative price, owner fee and private customer access token.
- `court_blocks` stores owner-created unavailable periods that prevent a court from being booked.
- `open_play_events` stores the published sessions owned by a venue.
- `open_play_registrations` stores each player's registration and receipt reference, linked to both the venue and event where available.
- `courtly-payment-receipts` is a private Storage bucket; `courtly-venue-media` is public and holds venue/court imagery.

Venue owners are isolated by Row Level Security. Anonymous players use restricted public venue/event reads and database RPCs for booking, availability, counts, and registration rather than direct access to customer records.

## Fee rule

Court rentals: the venue owner pays PHP 10 per booked court-hour. Paid Open Play: the player pays a PHP 10 transaction fee added to the published event registration amount; free Open Play has no transaction fee. Because current checkout uses the venue's GCash QR, the venue receives the full player payment and must remit the player-paid transaction fee to Courtly. The dashboard tracks this amount separately. This repository does not itself move or settle money between bank/payment accounts.

## Known items outside this database migration

- GCash/QR receipt verification is manual, not an integrated gateway or webhook.
- Email notification preferences are saved but notification delivery still requires an email provider and server-side function.
- The “My Bookings” list uses access tokens stored on the same browser/device used to book. Clearing browser storage removes the local shortcut; do not treat it as an account-wide booking history.
- Test the migration against your actual Supabase version/schema. SQL has been reviewed statically in this environment, but no live Supabase project was connected to execute it.


## Player accounts and player dashboard (new)

After the complete backend migration has already been applied, run the additive migration below once in Supabase SQL Editor:

`supabase/migrations/002_player_accounts_and_dashboard.sql`

This creates private player profiles, player avatar storage, and account-scoped read access for court bookings and Open Play registrations. It also updates the owner signup trigger so new player accounts do not accidentally create a venue, and prevents player accounts from calling the owner venue bootstrap RPC.

Do not rerun the full base migration for this update. Test with a newly registered player account. Existing guest bookings are not automatically attached to a player account; only new bookings made while signed in can be linked by the new database trigger.

## Hybrid fee policy migration (existing Courtly project)

After the main backend migration is already installed, back up the database and run `supabase/migrations/005_hybrid_courtly_fee_policy.sql` once. This changes new paid Open Play registrations to add a PHP 10 player transaction fee, gives free Open Play a zero fee and no receipt requirement, and preserves older registrations as venue-owner-paid for historical reporting. It also updates the owner transaction and earnings reports.

Court rental bookings remain PHP 10 per booked court-hour paid by the venue owner. The player is not charged this court-rental fee.

**GCash QR settlement note:** Paid Open Play players send the full registration amount plus PHP 10 to the venue's QR. The venue collects that PHP 10 on Courtly's behalf. Supabase tracks it as an amount to remit, but does not automatically transfer or split the money.

## Weekly owner billing (new)

After the hybrid fee policy migration `supabase/migrations/005_hybrid_courtly_fee_policy.sql`, apply `supabase/migrations/006_weekly_owner_billing_invoices.sql`. Then follow `COURTLY_WEEKLY_BILLING_IMPLEMENTATION.md` to create/allowlist a Courtly admin account, configure Courtly's remittance account in `/admin-billing`, enable Supabase `pg_cron`, and install `supabase/migrations/007_weekly_billing_cron_schedule.sql`. This feature creates unique fee ledger entries, invoices venue owners each Friday with a 72-hour deadline, accepts manual remittance references, supports admin approval/rejection and suspends a listing only from new customer traffic if an overdue amount remains unpaid. Owner access and existing confirmed bookings remain intact. Email notifications are optional and require server-only Vercel environment variables for Resend.
