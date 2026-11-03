-- Courtly initial Supabase schema.
-- Apply in Supabase SQL Editor. Review RLS policies before using live customer data.
create extension if not exists pgcrypto;

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  slug text not null unique,
  name text not null,
  address text,
  city text,
  timezone text not null default 'Asia/Manila',
  currency text not null default 'PHP',
  payment_qr_url text,
  admin_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  sport text,
  hourly_rate numeric(10,2) not null default 350 check (hourly_rate >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (venue_id, name)
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('CT-' || upper(substr(encode(gen_random_bytes(5),'hex'),1,8))),
  venue_id uuid not null references public.venues(id) on delete restrict,
  court_id uuid not null references public.courts(id) on delete restrict,
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_hours integer not null default 1 check (duration_hours between 1 and 8),
  subtotal numeric(10,2) not null check (subtotal >= 0),
  platform_fee numeric(10,2) not null default 0 check (platform_fee >= 0),
  total numeric(10,2) not null check (total >= 0),
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','rejected')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','pending','paid','failed','refunded')),
  payment_reference text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists bookings_venue_starts_idx on public.bookings(venue_id, starts_at);
create index if not exists bookings_court_starts_idx on public.bookings(court_id, starts_at);
create index if not exists bookings_status_idx on public.bookings(status);

alter table public.venues enable row level security;
alter table public.courts enable row level security;
alter table public.bookings enable row level security;

-- Public users can discover published venue/court information only.
drop policy if exists "Public can view venues" on public.venues;
create policy "Public can view venues" on public.venues
for select to anon, authenticated using (true);

drop policy if exists "Public can view active courts" on public.courts;
create policy "Public can view active courts" on public.courts
for select to anon, authenticated using (is_active = true);

-- Owners can view/update only venues they own.
drop policy if exists "Owners can update own venues" on public.venues;
create policy "Owners can update own venues" on public.venues
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "Owners can manage own courts" on public.courts;
create policy "Owners can manage own courts" on public.courts
for all to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()))
with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop policy if exists "Owners can view bookings for own venues" on public.bookings;
create policy "Owners can view bookings for own venues" on public.bookings
for select to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop policy if exists "Owners can update bookings for own venues" on public.bookings;
create policy "Owners can update bookings for own venues" on public.bookings
for update to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()))
with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

-- Intentionally no direct anonymous INSERT/SELECT policy on bookings.
-- Add SECURITY DEFINER RPCs for safe public availability + booking creation before launch.
-- This avoids exposing customers' names/emails through a public table policy.

comment on table public.bookings is 'Private reservation and payment records. Public booking flow should use vetted RPC functions.';
