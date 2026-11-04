# Courtly Player Registration & Desktop Dashboard

This update adds a dedicated player account experience inspired by the supplied Sports360 player screenshots while preserving Courtly's navy/blue/red brand and existing venue booking flow.

## Included player pages

- `player-register.html` — player registration with optional profile photo, full name, player name, email confirmation, contact number, skill level, password confirmation, profile privacy setting and Terms/Privacy acknowledgements.
- `player-login.html` — player-only sign-in. Owner accounts continue to use `login.html`.
- `player-dashboard.html` + `player-dashboard.js` — player dashboard with Home, Discover, My Tournaments, My Bookings, Memberships and Profile views.
- `venue.html` — auto-fills the checkout name, email and phone from a signed-in player profile.

## Database behavior

The migration `supabase/migrations/002_player_accounts_and_dashboard.sql` is additive. Run it **after** `supabase/001_complete_supabase_backend.sql` and after the base Courtly database setup already applied to the current Supabase project.

It:

1. Creates `public.player_profiles` with self-only row-level security.
2. Creates a private `courtly-player-avatars` Storage bucket with user-folder-only access.
3. Adds `player_id` to `bookings` and `open_play_registrations`.
4. Adds insert triggers to associate new bookings/Open Play registrations with the signed-in player, when a player profile exists.
5. Adds self-only read policies for a player's bookings and Open Play registrations.
6. Updates the existing owner signup trigger so a player signup does not create a venue.
7. Blocks player accounts from using `courtly_ensure_owner_venue()`.

The migration does not delete or rewrite existing bookings. Existing guest bookings remain accessible through the existing private booking-token flow. New bookings are attached to the player's account only when the player is signed in at the time of booking.

## Deployment steps

### 1. Back up and apply the player migration

1. Open Supabase Dashboard → SQL Editor.
2. Back up the current database or use a staging project first.
3. Open `supabase/migrations/002_player_accounts_and_dashboard.sql` from this project.
4. Paste the entire SQL file into a new Supabase query and run it once.
5. Confirm Supabase reports `Success. No rows returned`.

Do not rerun the complete base migration just for this feature.

### 2. Deploy the updated project to Vercel

1. Extract this ZIP file.
2. Copy the updated project files into the Git repository connected to the existing Courtly Vercel project. Keep the existing Vercel environment variables; do not paste any service-role key into source files.
3. Commit and push the changes, or deploy using the workflow already connected to the project.
4. Vercel should run `npm run build` and publish the updated static pages.

The current frontend continues to use the existing environment variables:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_publishable_key
```

Never put a Supabase `sb_secret_...` or service-role key in a browser app.

### 3. Check Supabase Auth redirect settings

In Supabase → Authentication → URL Configuration, confirm:

- Site URL: `https://courtly-ecru.vercel.app`
- Additional Redirect URL: `https://courtly-ecru.vercel.app/**`

Keep email confirmation enabled for production. Registration sends confirmation links back to the player dashboard URL.

### 4. Test a new player account

Use a new email address that is not already registered as a Courtly owner account.

1. Visit `https://courtly-ecru.vercel.app/player-register.html`.
2. Fill in the player registration form.
3. Confirm the email (if email confirmation is enabled).
4. Log in at `https://courtly-ecru.vercel.app/player-login.html`.
5. Confirm the player dashboard opens and the sport selector appears if no preferred sport is set.
6. Update the profile and privacy setting.
7. Open Discover and confirm published venues are listed.
8. Open a venue booking page while signed in. Name, email and phone should be prefilled.
9. Complete a test booking (do not use a real payment unless the venue owner has instructed you to).
10. Open My Bookings and confirm the new booking appears.

### 5. Verify the database

Check the player profile:

```sql
select id, full_name, player_name, email, skill_level, is_private, preferred_sport, avatar_url
from public.player_profiles
order by created_at desc
limit 10;
```

Confirm a player account did not create a venue:

```sql
select id, email, raw_user_meta_data->>'account_type' as account_type
from auth.users
where raw_user_meta_data->>'account_type' = 'player'
order by created_at desc;
```

Check account-linked bookings:

```sql
select id, reference, player_id, customer_name, customer_email, total, status, payment_status
from public.bookings
where player_id is not null
order by created_at desc
limit 25;
```

Check account-linked Open Play registrations:

```sql
select id, registration_reference, player_id, player_name, player_email, event_title, payment_status
from public.open_play_registrations
where player_id is not null
order by created_at desc
limit 25;
```

## What is live vs. planned in this release

- **Live in this release:** player registration/login, private player profile, avatar upload, skill level, preferred sport, profile privacy preference, venue discovery, Google Maps links for venue addresses, published Open Play discovery, court booking checkout prefill, account-linked new bookings and Open Play registrations, player booking history.
- **Coming later:** tournament registration/results/rankings and real venue membership plans/subscriptions. The player UI includes these views with honest empty states; no fake plans, fees, tournament entries or statistics are created.
- **Map view limitation:** the current venue schema does not store map coordinates. Map view therefore presents venue address cards with direct Google Maps links, not an embedded interactive map.
- **Profile privacy limitation:** profiles are not exposed in a public player directory in this release. The privacy preference is saved for future player discovery/social features. Required contact details are still shared with a venue when the player submits its booking or Open Play registration.

## Existing account notes

- The player role is saved in Supabase Auth user metadata as `account_type=player` at signup.
- This release expects new player registrations after the migration has been applied. Existing guest checkout bookings are not automatically imported into the player's booking list.
- Owner accounts and the owner portal continue to use their existing `login.html` and `owner-portal.html` routes.
