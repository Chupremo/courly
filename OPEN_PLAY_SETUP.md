# Courtly Open Play

## Prototype behaviour
- Owners open **Open play** in the owner portal, upload a banner and enter title, details, date/time, location, fee and optional player limit.
- Published events appear above the date/time calendar on the public venue page. **Register now** scrolls the player to the date selector.
- The current owner portal is a localStorage prototype. The owner portal and public booking page must be opened in the same browser profile/origin for the banner to appear. It does not yet sync to other players/devices.

## Shared production database migration
`supabase/open-play-events.sql` creates the Supabase table and RLS policies for published public reads and venue-owner management. The current UI does not yet call this table; before launch, connect owner create/update/delete and public fetch to Supabase, and store banner files in a Supabase Storage bucket rather than localStorage.


## Registration counter prototype
- Owners set a registration capacity (default 20) when publishing an Open Play event.
- Player booking banners show `registered / capacity` plus remaining spots.
- Register now selects the event date and scrolls to the booking calendar.
- After the player successfully uploads a payment receipt for the calendar booking, the selected Open Play event's registered count increases by one, up to its capacity.
- The prototype stores event registrations in browser local storage. Counts are therefore not shared across devices or different browsers. For production, implement a Supabase `open_play_registrations` table and atomic registration RPC to prevent overbooking and synchronize counts globally.
