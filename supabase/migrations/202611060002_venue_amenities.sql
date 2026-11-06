-- Courtly venue amenities
-- Run this migration in Supabase SQL Editor before owners save amenities.
alter table public.venues
  add column if not exists amenities text[] not null default '{}'::text[];

comment on column public.venues.amenities is
  'Owner-selected facilities displayed in the public venue Amenities tab.';
