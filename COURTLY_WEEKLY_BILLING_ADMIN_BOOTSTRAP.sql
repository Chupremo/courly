-- Create a dedicated Courtly admin identity without creating a venue.
-- Recommended flow:
-- 1) Register a NEW dedicated admin email through the Courtly Player Registration page.
--    This marks the Auth user as account_type='player', so the owner trigger does not create a venue.
-- 2) Confirm that email in the inbox.
-- 3) Replace the placeholder below with that exact email, then run this script once.
-- 4) The script changes the account type to courtly_admin and adds it to the admin allowlist.
-- 5) Use that account only at /admin-billing. It will no longer be accepted by player login.
-- Do not use a venue owner's everyday login as the Courtly administrator account.

BEGIN;

WITH admin_user AS (
  UPDATE auth.users
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object('account_type', 'courtly_admin')
  WHERE lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
  RETURNING id, lower(email) AS email
)
INSERT INTO public.courtly_admin_users (user_id, email)
SELECT id, email
FROM admin_user
ON CONFLICT (user_id)
DO UPDATE SET email = EXCLUDED.email
RETURNING user_id, email;

COMMIT;

-- Expected result: exactly one row returned.
-- If no row returns, confirm the admin email exists and its address is exact.
-- Keep the admin account separate from player/venue-owner accounts.
