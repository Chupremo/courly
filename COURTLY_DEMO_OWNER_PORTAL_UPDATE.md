# Courtly Demo Owner Portal Update

## What changed
- The owner login page now offers four clearly labelled demo portals.
- Each demo portal opens without Supabase authentication and is isolated by venue slug in browser local storage.
- Each demo venue receives fictional court reservations and Open Play payment-review examples.
- Demo payment approval/rejection changes only that demo venue's local sample data. It never calls the production payment-review RPC.
- Real owner sessions continue to load venue-scoped Open Play registrations through the authenticated Supabase RPC.
- Unauthenticated access to a non-demo venue shows a sign-in prompt instead of exposing sample or real transaction data.
- Demo receipt labels are explicitly marked as samples; no fake receipt file or payment proof is generated.

## Demo venues
- `demo-batangas-racquet-club`
- `demo-lipa-pickleball-hub`
- `demo-santos-pickleball-club`
- `demo-southside-sports-center`

## Important behavior
Demo records are fictional and stored in the visitor's browser. They do not create Supabase rows, send notifications, collect payments, or represent real players. Clearing browser storage resets the demo workspace. Real owners must sign in and have their Auth user ID linked to their venue's `owner_id`.

## Deployment
Deploy the updated source to Vercel. No Supabase SQL migration is required for this demo-only UI update. Existing real-owner RPC permissions and venue ownership checks remain in place.
