-- COURTLY SAMPLE OWNER + LISTED COURTS
-- Adds one fictional owner's venue with three listed courts so it appears on /players.html.
-- Safe to run more than once (upserts by venue slug and court name).
-- Fictional demo listing, not a real business.
--
-- The venue slug matches what the owner portal generates from the business name
-- ("DEMO · Santos Pickleball Club" -> demo-santos-pickleball-club).
-- owner_id is linked automatically if a Supabase Auth user with the sample email exists;
-- otherwise it stays null and the listing still shows publicly.

begin;

insert into public.venues (slug, name, address, city, timezone, currency, admin_email, owner_id)
values (
  'demo-santos-pickleball-club',
  'DEMO · Santos Pickleball Club',
  'Demo listing · 12 Sample Street, Brgy. Marawoy',
  'Lipa City, Batangas',
  'Asia/Manila',
  'PHP',
  'sample.owner@courtly.demo',
  (select id from auth.users where lower(email) = 'sample.owner@courtly.demo' limit 1)
)
on conflict (slug) do update set
  name = excluded.name,
  address = excluded.address,
  city = excluded.city,
  timezone = excluded.timezone,
  currency = excluded.currency,
  admin_email = excluded.admin_email,
  owner_id = coalesce(public.venues.owner_id, excluded.owner_id);

insert into public.courts (venue_id, name, sport, hourly_rate, is_active)
select v.id, c.name, c.sport, c.hourly_rate, true
from (values
  ('demo-santos-pickleball-club', 'Court 1 (Indoor)', 'Pickleball', 400::numeric),
  ('demo-santos-pickleball-club', 'Court 2 (Indoor)', 'Pickleball', 400::numeric),
  ('demo-santos-pickleball-club', 'Court 3 (Outdoor)', 'Pickleball', 300::numeric)
) as c(slug, name, sport, hourly_rate)
join public.venues v on v.slug = c.slug
on conflict (venue_id, name) do update set
  sport = excluded.sport,
  hourly_rate = excluded.hourly_rate,
  is_active = true;

commit;

-- To remove the sample owner's listing later (courts are deleted with it):
-- delete from public.venues where slug = 'demo-santos-pickleball-club';
