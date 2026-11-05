# Courtly Player Network & Community — Installation Guide

This update adds three player/community capabilities:

1. A live verified-player count on the player registration page.
2. A player directory showing public player nicknames, avatar photos, skill level, preferred sport, follower count and Follow/Following actions.
3. A Community page for authenticated players and venue owners to publish text, image and video posts, like posts, comment, share links, delete their own posts and report content.

## Before deployment

- Back up Supabase.
- Confirm the player account migration `002_player_accounts_and_dashboard.sql` has been installed, because this feature uses `public.player_profiles` and the `courtly-player-avatars` bucket.
- This feature uses a new migration: `supabase/migrations/011_player_network_and_community.sql`.
- It does not change court bookings, Open Play fee calculations, owner invoices or fee balances.
- The registration counter counts **email-confirmed player profiles** only. It returns a single aggregate number and does not expose profile data.

## 1. Apply the Supabase migration

1. Open Supabase → SQL Editor → New Query.
2. Open `supabase/migrations/011_player_network_and_community.sql`.
3. Copy the complete file, from the first comment to the final `COMMIT;`.
4. Execute it once.
5. If it fails, do not run partial fragments. Send the complete error and line number so the full migration can be corrected.

The migration creates:

- `player_follows`
- `community_posts`
- `community_post_likes`
- `community_comments`
- `community_post_shares`
- `community_reports`
- The private `courtly-community-media` Storage bucket
- Public aggregate and authenticated directory/feed RPCs
- RLS policies for player/owner posting, follows, likes, comments, media and reports

Player profiles marked private are excluded from the public player directory. Their posts and avatar remain visible only to themselves. Emails, phone numbers and full names are not returned by the public player directory or community feed.

## 2. Update GitHub

Copy these files into the root of the existing `courly` repository, preserving the folders:

- `player-register.html` — adds the live player-count strip.
- `player-dashboard.html` — adds Players and Community navigation and loads the social styles.
- `player-dashboard.js` — adds the public player directory, follow actions and home recommendations.
- `player-social.css` — new responsive styles for player cards and follow buttons.
- `community.html` — new Community page.
- `community.js` — new community feed and interactions.
- `community.css` — new responsive community styles.
- `owner-portal.html` — adds a Community link to the owner navigation.
- `vite.config.js` — adds the Community page to the Vite build.
- `vercel.json` — adds the `/community` route.
- `supabase/migrations/011_player_network_and_community.sql` — database migration.

Do not replace the rest of your repository with an older archive. This is a targeted update so existing billing, booking, image-upload and mobile fixes remain intact.

Commit and push to `main`; Vercel will deploy automatically.

## 3. How it works

### Player count

The registration page calls `get_public_player_count()`. It counts player profiles whose Auth email is confirmed. It does not return user IDs, emails, phone numbers or other personal data.

### Player directory

The dashboard calls `get_player_directory()`. Only public profiles appear. It returns nickname, skill level, preferred sport, avatar object path, follower count and whether the current player follows that profile. Avatar paths are resolved to short-lived signed URLs only for authenticated Courtly players/venue owners and only when the profile is public (or belongs to the viewer).

### Community posts

- Players and authenticated venue owners can post.
- Owners' posts are attributed to their linked venue.
- Supported images: JPEG, PNG, WEBP and GIF, up to 10 MB.
- Supported videos: MP4, WEBM and MOV/QuickTime, up to 25 MB.
- The community media bucket is private. Only authenticated Courtly players and venue owners can obtain signed media URLs, and only for posts they are allowed to see.
- Like and comment actions require a signed-in Courtly player or venue owner.
- Share links point to `/community.html?post=<post-id>`; the share counter records one unique share per signed-in member per post.
- Members can report a post. Reports are stored in `community_reports` for Courtly review.
- Authors can delete their own posts. Comment deletion and comment-specific reporting are not included in this first release.

### Privacy

A private player is not discoverable and their posts are not shown to other members. Public directory/community responses do not include player email, phone or full name. Player avatars remain in the private player-avatar bucket; storage policies allow signed reads only for public profiles or the signed-in profile owner.

## 4. Test after deployment

1. Open `player-register.html`: confirm the number of verified players appears above the registration form.
2. Sign in as a player with a public profile and open Player Dashboard → Players.
3. Confirm nicknames, profile photos and Follow buttons appear.
4. Follow a player, refresh the page and confirm the button remains Following.
5. Open `/community.html` as a player; create a text-only post.
6. Create an image post and a short video post.
7. Like, comment, share and delete your own test post.
8. Sign in as a venue owner; open Owner Portal → Community and publish a venue update.
9. Confirm player and owner posts appear in the same feed.
10. Switch a test player's profile to Private; confirm it disappears from the player directory and their posts are no longer visible to other accounts.
11. Try to access community pages while logged out; the page should show player/owner sign-in options.

## 5. Important launch note

The player registration Privacy Notice has been updated to explain that public profiles may display nickname, skill level, preferred sport and optional avatar to signed-in members; private profiles are excluded from discovery and their posts are visible only to the owner. Email, phone and full name are not shown on public player cards.

This is the first social/community release. It includes content reporting and private-profile handling, but it is not a full moderation console. Courtly should review `community_reports` regularly and establish moderation, blocking, retention and takedown procedures before promoting the feed broadly. Large video uploads above 25 MB are rejected in this version; larger media should use resumable uploads in a later release.

The SQL migration has not been executed against the live Supabase project. Complete the migration and the test checklist before enabling the Community link for all users.

## 6. Player-to-player messages and club invitations

The launch-readiness update adds private one-to-one player messages and player-to-player invitations to published clubs. It requires the additive root migration:

`017_player_messaging_and_club_invites.sql`

Apply it only after these dependencies are installed:

1. `002_player_accounts_and_dashboard.sql` — player profiles.
2. `011_player_network_and_community.sql` — public player directory and follow/privacy helpers.
3. `015_club_directory_and_registration.sql` — published club profiles.
4. `016_club_dashboard_members_and_announcements.sql` — club membership table.

Run the full `017_player_messaging_and_club_invites.sql` file in Supabase SQL Editor in one transaction. Back up the database or use a staging project first. Do not paste partial function fragments. The new tables are private and are accessed through authenticated RPC functions.

### Player-to-player chat

- From Player Dashboard → Players, use **Chat** to open a private conversation or **Message** to open the same conversation with the composer focused.
- Conversations are one-to-one and can only be read or written by their two participants.
- A player can start a conversation only with another public player profile. Private player profiles are not discoverable or messageable through this directory.

### Invite a player to a club

- From Player Dashboard → Players, choose **Invite to club**, select a published club and send the invitation.
- The invitee sees the request under **Club invitations** and can accept or decline.
- Accepting does not silently add a member. It creates a `pending` row in `club_members`; the club manager must still approve the membership in the Club Dashboard.
- Invitations and chat are authenticated player-only actions. The migration does not send external email or push notifications; the invite is surfaced inside the recipient's dashboard.

### Required verification before launch

1. Sign in as Player A and start a chat with a second public player. Send a message, sign in as Player B in a separate browser and confirm the conversation and reply are visible.
2. Try to read the same conversation as a third player. The database function must reject access.
3. Sign in as Player A, invite Player B to a published club and check that the invite appears in Player B → Club invitations.
4. Accept the invitation as Player B. Confirm a pending membership request appears for the correct club and that the club manager must approve it.
5. Decline a separate invitation and confirm no membership row is created.
6. Try using the invite and messaging actions as a coach or venue-owner account. The database functions must reject the action.
7. Confirm a private player profile is excluded from the player directory, and is rejected by the conversation/invitation functions.

The Vercel deploy does not apply database migrations. Complete this SQL step and the real-account checks above in a staging project before announcing the new social actions.
