# Courtly public browsing, role-aware navigation and Community upload update

## What changed

### Public venue browsing
- Visitors can open `/players.html` without creating an account.
- The public directory continues to query only published venues and active courts.
- A guest notice explains that venue details, court rates and availability can be viewed without an account.
- The public `/v/:slug` / `venue.html?slug=...` page continues to show the venue calendar, court availability and published Open Play sessions to guests.
- The player-account gate appears only when a visitor attempts to pay for a court or register for Open Play.
- The booking intent (venue, selected date/time/court or Open Play event) is saved for the browser session. After player login or registration, Courtly returns the player to the selected venue and attempts to restore the pending selection.

### Role-aware navigation
- Guest navigation: Home, Login dropdown (Player / Business owner), Register dropdown (Player / Business owner).
- Signed-in players see Player Dashboard, Community and account actions instead of Login/Register.
- Signed-in venue owners see Owner Portal, Community and account actions instead of Login/Register.
- Existing player profiles are recognized even if older Auth metadata is incomplete; owner accounts are recognized from owner metadata or their venue ownership record.
- A venue owner who attempts to book is told to switch to a player account. The switch links explicitly sign out the owner session before the player account login/registration flow.
- The older public headers are replaced by the shared global navigation on the public pages.

### Booking security
- Migration `013_require_player_auth_for_booking.sql` adds `bookings.customer_user_id` and changes the booking/Open Play RPCs to require an authenticated Courtly player profile.
- Anonymous users can still read public venue listings and public availability, but cannot create a court booking, attach a booking receipt, cancel a booking request, or create an Open Play registration through the RPCs.
- Existing player bookings continue to be associated with `player_id` by the existing player-account trigger. Existing booking rows are not deleted or repriced.

### Community media
- The Community page accepts images and videos up to 100 MB in the browser.
- Uploads use Supabase TUS resumable uploads with progress and retry support; 6 MB chunks are used for the resumable transfer.
- Migration `012_community_media_100mb.sql` raises the existing `courtly-community-media` bucket limit to 100 MB. Migration `011_player_network_and_community.sql` also creates/updates the bucket at 100 MB for a fresh install.
- **Important Supabase project setting:** the project's Global file size limit must also be at least 100 MB. Supabase Free projects are capped at 50 MB globally; a 100 MB global cap requires Pro or higher. See https://supabase.com/docs/guides/storage/uploads/file-limits.

### Owner dashboard transaction placement
- The Recent Open Play transactions panel is positioned near the top of the Overview, immediately after the KPI cards and before Recent reservations.
- The transaction RPC already orders records newest first (`created_at DESC`), so the most recent Open Play transactions appear at the top of the panel.

## Supabase migration order

Back up the project before running migrations.

1. `011_player_network_and_community.sql` — run only if the player network/community tables, profile directory RPC, follow features and media bucket have not already been installed.
2. `012_community_media_100mb.sql` — run to raise an existing community-media bucket to 100 MB.
3. `013_require_player_auth_for_booking.sql` — run once to enforce the player-account booking gate on the server-side RPCs.

Do not rerun earlier billing or Open Play fee migrations. If migration 011 is already installed, do not rerun it just for this update; run 012 and 013 if they have not yet been applied.

After migration 013, run this verification query:

```sql
SELECT
  has_function_privilege('anon', 'public.create_booking_request(text,uuid,timestamp with time zone,integer,text,text,text,text)', 'EXECUTE') AS anon_can_create_court_booking,
  has_function_privilege('authenticated', 'public.create_booking_request(text,uuid,timestamp with time zone,integer,text,text,text,text)', 'EXECUTE') AS player_can_create_court_booking,
  has_function_privilege('anon', 'public.register_open_play_player(uuid,text,text,text,text)', 'EXECUTE') AS anon_can_register_open_play,
  has_function_privilege('authenticated', 'public.register_open_play_player(uuid,text,text,text,text)', 'EXECUTE') AS player_can_register_open_play;
```

Expected: `anon_can_create_court_booking = false`, `player_can_create_court_booking = true`, `anon_can_register_open_play = false`, `player_can_register_open_play = true`.

## Supabase Storage setting for 100 MB

In Supabase Dashboard:
1. Open Storage → Settings.
2. Set **Global file size limit** to at least `100 MB` (102,400 KB / 104,857,600 bytes).
3. Confirm the `courtly-community-media` bucket limit is also 100 MB.

On the Free plan, Supabase's global limit cannot exceed 50 MB. Do not promise 100 MB community uploads to users until the project plan and global limit support it.

## Website deployment

1. Back up the current GitHub `main` branch.
2. Merge/replace the project files from this release package, preserving your existing Supabase environment values.
3. Commit and push to `main`; Vercel builds from that branch.
4. No new Vercel environment variables are introduced by this update.
5. The Vercel rewrite `/players` → `/players.html` is included; `/community` → `/community.html` remains in place.

## Acceptance test checklist

### Guest browsing
- Open `/players.html` in a private/incognito window.
- Confirm published venues, active courts, rates and filters load without login.
- Open a venue page and browse the calendar and Open Play details without login.
- Select a court/time and click PAY NOW; confirm the player account prompt appears.
- Click REGISTER NOW for an Open Play event; confirm the same player account prompt appears.

### Account return flow
- From the prompt, choose player login or registration.
- Confirm the return URL preserves the selected venue.
- After login/registration, confirm Courtly returns to the venue and restores the booking/Open Play intent if it is still available.
- With an owner account signed in, confirm public navigation shows Owner Portal/Community/account actions and not guest Login/Register links.
- From a booking prompt while signed in as an owner, use the player switch link and confirm the owner session is signed out before the player flow continues.

### Owner and player navigation
- Signed-in player: Player Dashboard, Community, My Account; no separate Login/Register links.
- Signed-in owner: Owner Portal, Community, My Account; no Owner Login button.
- Guest: Home, Login dropdown, Register dropdown.

### Community uploads
- Upload a small image and a small video.
- Upload a media file larger than 6 MB to verify resumable TUS progress/retry.
- Test an image/video near the 100 MB maximum only after the Supabase global limit and plan support it.
- Confirm files above 100 MB are rejected in the UI.

### Owner Overview
- Confirm Recent Open Play transactions appears above Recent reservations.
- Confirm newest registrations are listed first.

## Validation performed

- HTML parsing across project pages.
- Inline JavaScript syntax checks.
- JavaScript file syntax checks.
- JSON parsing for `package.json` and `vercel.json`.
- Migration dollar-quote balance checks.
- Static checks for role navigation, public browse notice, checkout gate, 100 MB TUS uploader, and transaction panel order.

A complete Vite production build could not be completed in this environment because `npm install` timed out. Vercel must confirm the production build after the GitHub commit.
