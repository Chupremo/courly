-- Courtly Open Play announcements
-- Apply in Supabase SQL Editor when moving Open Play from browser prototype to shared production data.
create table if not exists public.open_play_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  title text not null,
  details text not null,
  banner_url text,
  starts_at timestamptz not null,
  location_text text not null,
  fee numeric(10,2) not null default 0 check (fee >= 0),
  registration_limit integer check (registration_limit is null or registration_limit > 0),
  is_published boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists open_play_events_venue_starts_idx on public.open_play_events(venue_id, starts_at);
alter table public.open_play_events enable row level security;
drop policy if exists "Public can view published upcoming open play" on public.open_play_events;
create policy "Public can view published upcoming open play" on public.open_play_events for select to anon, authenticated using (is_published = true and starts_at >= now());
drop policy if exists "Owners manage their open play" on public.open_play_events;
create policy "Owners manage their open play" on public.open_play_events for all to authenticated using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid())) with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));
