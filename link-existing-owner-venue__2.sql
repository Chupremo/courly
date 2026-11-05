-- Courtly owner-to-venue link repair.
-- Run only if the owner already has a Supabase Auth account AND the venue row exists.
-- Replace the email below with the exact email used for Supabase Auth.
-- This links only an unclaimed venue whose admin_email matches that Auth account.
update public.venues v
set owner_id = u.id
from auth.users u
where lower(u.email) = lower('REPLACE_WITH_OWNER_EMAIL')
  and lower(v.admin_email) = lower(u.email)
  and v.owner_id is null;

-- Verify the link. The result should show your venue slug and the matching owner_id.
select v.name, v.slug, v.owner_id, u.email
from public.venues v
join auth.users u on u.id = v.owner_id
where lower(u.email) = lower('REPLACE_WITH_OWNER_EMAIL');
