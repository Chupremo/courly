-- Courtly: fix "This booking page is not linked to an active Courtly owner venue".
-- Run this whole file once in Supabase SQL Editor. It is safe to re-run.
--
-- WHY THE ERROR HAPPENS
-- register_open_play_player() only accepts a venue whose slug exists in public.venues
-- AND whose owner_id is set. The public page /v/<slug> takes its slug from the URL,
-- so the error means that slug has no owner-linked row in the database
-- (the venue was only ever saved in the browser, was renamed, or is a DEMO venue).

-- 1) Lightweight pre-check used by venue.html BEFORE a receipt is uploaded.
create or replace function public.venue_accepts_registrations(p_venue_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venues v
    where lower(trim(v.slug)) = lower(trim(coalesce(p_venue_slug, '')))
      and v.owner_id is not null
  );
$$;

revoke all on function public.venue_accepts_registrations(text) from public;
grant execute on function public.venue_accepts_registrations(text) to anon, authenticated;

-- 2) DIAGNOSE: every venue and whether it can accept registrations.
--    Look for the slug that appears in your booking page URL (/v/<slug>).
select v.slug,
       v.name,
       v.admin_email,
       v.owner_id,
       case when v.owner_id is null then 'NOT LINKED - registrations blocked'
            else 'linked' end as status
from public.venues v
order by v.created_at desc nulls last;

-- 3) REPAIR A: the venue row exists but owner_id is empty.
--    Replace BOTH placeholders, then run. Uses the email of the Supabase Auth account
--    you log in to the owner portal with.
update public.venues v
set owner_id = u.id,
    admin_email = coalesce(v.admin_email, u.email)
from auth.users u
where lower(u.email) = lower('REPLACE_WITH_OWNER_LOGIN_EMAIL')
  and lower(v.slug) = lower('REPLACE_WITH_VENUE_SLUG')
  and v.owner_id is null;

-- 4) REPAIR B: the owner is linked, but the slug in the URL is different from the
--    database slug. List what the owner account actually owns, then open
--    /v/<that slug> (the updated owner portal now does this automatically).
select v.slug, v.name
from public.venues v
join auth.users u on u.id = v.owner_id
where lower(u.email) = lower('REPLACE_WITH_OWNER_LOGIN_EMAIL');

-- 5) VERIFY: should return true for your slug.
select public.venue_accepts_registrations('REPLACE_WITH_VENUE_SLUG');
