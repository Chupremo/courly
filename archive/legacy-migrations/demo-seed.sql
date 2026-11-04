-- COURTLY DEMO DATA
-- Adds clearly labelled prototype venues and courts in Lipa City, Batangas.
-- Safe to run more than once: venue slugs and court names are upserted.
-- These are fictional demo listings, not real registered businesses.

begin;

insert into public.venues (slug, name, address, city, timezone, currency)
values
  ('demo-lipa-pickleball-hub', 'DEMO · Lipa Pickleball Hub', 'Demo listing · near Lipa City proper', 'Lipa City, Batangas', 'Asia/Manila', 'PHP'),
  ('demo-batangas-racquet-club', 'DEMO · Batangas Racquet Club', 'Demo listing · Marawoy area', 'Lipa City, Batangas', 'Asia/Manila', 'PHP'),
  ('demo-southside-sports-center', 'DEMO · Southside Sports Center', 'Demo listing · Sabang area', 'Lipa City, Batangas', 'Asia/Manila', 'PHP')
on conflict (slug) do update set
  name = excluded.name,
  address = excluded.address,
  city = excluded.city,
  timezone = excluded.timezone,
  currency = excluded.currency;

insert into public.courts (venue_id, name, sport, hourly_rate, is_active)
select v.id, c.name, c.sport, c.hourly_rate, true
from (values
  ('demo-lipa-pickleball-hub', 'Pickleball Court 1', 'Pickleball', 350::numeric),
  ('demo-lipa-pickleball-hub', 'Pickleball Court 2', 'Pickleball', 350::numeric),
  ('demo-batangas-racquet-club', 'Badminton Court 1', 'Badminton', 250::numeric),
  ('demo-batangas-racquet-club', 'Badminton Court 2', 'Badminton', 250::numeric),
  ('demo-southside-sports-center', 'Covered Basketball Court', 'Basketball', 800::numeric),
  ('demo-southside-sports-center', 'Multi-purpose Court', 'Volleyball', 500::numeric)
) as c(slug, name, sport, hourly_rate)
join public.venues v on v.slug = c.slug
on conflict (venue_id, name) do update set
  sport = excluded.sport,
  hourly_rate = excluded.hourly_rate,
  is_active = true;

commit;

-- To remove only these demo records later, run:
-- delete from public.venues
-- where slug in (
--   'demo-lipa-pickleball-hub',
--   'demo-batangas-racquet-club',
--   'demo-southside-sports-center'
-- );
