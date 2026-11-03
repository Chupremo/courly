# Courtly Open Play payment review

The owner portal already renders **Recent Open Play transactions** and calls these Supabase RPCs:

- `get_owner_open_play_transactions(p_venue_slug)` to list registrations and receipt paths.
- `review_open_play_payment(p_registration_id, p_decision)` to verify or reject a registration.

## Required one-time Supabase setup

1. Open Supabase → SQL Editor → New query.
2. Open `supabase/open-play-owner-transactions.sql` from this project.
3. Copy the entire file into the SQL Editor and click **Run** once.
4. Confirm the query completes successfully.
5. Sign out of the Courtly owner portal and sign back in with the Supabase Auth owner account.
6. Open Owner Portal → Overview or Earnings & transactions. Pending registrations should appear with **View receipt**, **Verify payment**, and **Reject** actions.

Do not manually mark registrations confirmed in SQL as a normal workflow. Review the receipt and use **Verify payment** in the owner portal. That action updates `payment_status` and `registration_status`; the earnings RPC then includes the fee in confirmed Open Play revenue.

## If the list still shows an error

- Confirm the signed-in Supabase Auth user has `venues.owner_id` matching their Auth user ID for the venue slug.
- Confirm receipt files are stored in the `courtly-payment-receipts` bucket and the owner receipt-read policy is installed.
- Check browser DevTools Console for the exact RPC error.
- The browser must use the Supabase publishable/anon key, never a service-role key.

This SQL is safe to re-run because it uses `CREATE OR REPLACE FUNCTION` and replaces the two RPC definitions. It does not create duplicate tables or duplicate registrations.
