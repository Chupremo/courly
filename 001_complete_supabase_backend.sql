-- ============================================================================
-- COURTLY: COMPLETE SHARED DATABASE BACKEND
-- Apply once in Supabase SQL Editor after backing up existing production data.
-- Safe to re-run for additive changes. This migration does not delete bookings.
-- Fee policy: Courtly deducts PHP 10 per court-hour / registration from OWNER
-- earnings. The player pays the venue's published court/event price only.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- 1. Venue and court profile data
-- --------------------------------------------------------------------------
alter table public.venues
  add column if not exists owner_name text,
  add column if not exists phone text,
  add column if not exists description text,
  add column if not exists sport text,
  add column if not exists logo_url text,
  add column if not exists cover_url text,
  add column if not exists payment_method text default 'GCash QR',
  add column if not exists payment_account text,
  add column if not exists payment_instructions text,
  add column if not exists hours_open time not null default '08:00',
  add column if not exists hours_close time not null default '22:00',
  add column if not exists peak_hours_start time,
  add column if not exists peak_hours_end time,
  add column if not exists is_published boolean not null default true,
  add column if not exists notify_email boolean not null default true,
  add column if not exists notify_pending boolean not null default true,
  add column if not exists notify_cancelled boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

alter table public.courts
  add column if not exists image_url text,
  add column if not exists image_fit text not null default 'cover' check (image_fit in ('cover','contain')),
  add column if not exists off_peak_rate numeric(10,2),
  add column if not exists peak_rate numeric(10,2),
  add column if not exists display_order integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

-- Preserve each existing court's current hourly rate as its initial off-peak and peak rate.
update public.courts set off_peak_rate=hourly_rate where off_peak_rate is null;
update public.courts set peak_rate=off_peak_rate where peak_rate is null;
alter table public.courts alter column off_peak_rate set default 350, alter column off_peak_rate set not null;
alter table public.courts alter column peak_rate set default 350, alter column peak_rate set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.courts'::regclass and conname='courts_off_peak_rate_check') then
    alter table public.courts add constraint courts_off_peak_rate_check check (off_peak_rate >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.courts'::regclass and conname='courts_peak_rate_check') then
    alter table public.courts add constraint courts_peak_rate_check check (peak_rate >= 0);
  end if;
end $$;

create index if not exists venues_owner_id_idx on public.venues(owner_id);
create index if not exists venues_public_idx on public.venues(is_published, created_at desc);
-- Peak pricing is either disabled (both fields null) or has a complete,
-- distinct, whole-hour window. Normalize partial legacy values before enforcing it.
update public.venues set peak_hours_start=null,peak_hours_end=null
where (peak_hours_start is null) <> (peak_hours_end is null)
   or (peak_hours_start is not null and peak_hours_start=peak_hours_end);
alter table public.venues drop constraint if exists venues_peak_window_hour_check;
alter table public.venues add constraint venues_peak_window_hour_check
  check (
    (peak_hours_start is null and peak_hours_end is null)
    or (peak_hours_start is not null and peak_hours_end is not null
      and peak_hours_start <> peak_hours_end
      and date_part('minute',peak_hours_start)=0
      and date_part('minute',peak_hours_end)=0)
  );
create index if not exists courts_venue_active_order_idx on public.courts(venue_id, is_active, display_order);

-- --------------------------------------------------------------------------
-- 2. Court bookings and calendar blocks
-- --------------------------------------------------------------------------
alter table public.bookings
  add column if not exists payment_receipt_path text,
  add column if not exists payment_method text default 'GCash',
  add column if not exists paid_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists receipt_submitted_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists customer_access_token uuid not null default gen_random_uuid(),
  add column if not exists updated_at timestamptz not null default now();

-- Normalize payment statuses from the older prototype schema.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.bookings'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%payment_status%'
  loop
    execute format('alter table public.bookings drop constraint %I', c.conname);
  end loop;
end $$;

update public.bookings
set payment_status = case
  when payment_status in ('paid','confirmed') then 'confirmed'
  when payment_status in ('pending','awaiting_verification') then 'awaiting_verification'
  when payment_status in ('failed','rejected') then 'rejected'
  when payment_status = 'refunded' then 'refunded'
  else 'unpaid'
end;

update public.bookings
set status = case
  when payment_status='confirmed' and status='pending' then 'confirmed'
  when payment_status='rejected' and status='pending' then 'rejected'
  else status
end
where status='pending' and payment_status in ('confirmed','rejected');

alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in ('unpaid','awaiting_verification','confirmed','rejected','refunded'));

-- Courtly's service fee is charged against the owner's payout, not added to
-- the player's checkout total. Existing historical rows are left untouched.
comment on column public.bookings.platform_fee is
  'Courtly fee deducted from owner payout: PHP 10 per booked court-hour. Not added to player total.';
comment on column public.bookings.total is
  'Amount paid by player. Equals subtotal; Courtly fee is deducted from owner payout.';
comment on column public.bookings.customer_access_token is
  'Unpredictable bearer token used to retrieve this customer booking without exposing email-based lookups.';

create unique index if not exists bookings_customer_access_token_uidx
  on public.bookings(customer_access_token);

create table if not exists public.court_blocks (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default 'Unavailable',
  created_at timestamptz not null default now(),
  constraint court_blocks_valid_range check (ends_at > starts_at)
);
create index if not exists court_blocks_court_range_idx on public.court_blocks(court_id, starts_at, ends_at);

-- --------------------------------------------------------------------------
-- 3. Open Play events and registrations
-- --------------------------------------------------------------------------
create table if not exists public.open_play_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  title text not null,
  details text not null default '',
  banner_url text,
  starts_at timestamptz not null,
  location_text text not null,
  fee numeric(10,2) not null default 0 check (fee >= 0),
  registration_limit integer check (registration_limit is null or registration_limit > 0),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.open_play_events
  add column if not exists updated_at timestamptz not null default now();

create index if not exists open_play_events_venue_starts_idx on public.open_play_events(venue_id, starts_at);

create table if not exists public.open_play_registrations (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete cascade,
  registration_reference text not null unique,
  event_id text not null,
  event_uuid uuid references public.open_play_events(id) on delete set null,
  event_title text not null,
  venue_slug text not null,
  venue_name text not null,
  event_date date not null,
  event_time text not null,
  location_text text not null,
  player_name text not null,
  player_email text not null,
  player_phone text,
  fee numeric(10,2) not null default 0 check (fee >= 0),
  transaction_fee numeric(10,2) not null default 10 check (transaction_fee >= 0),
  receipt_path text not null,
  payment_status text not null default 'awaiting_verification'
    check (payment_status in ('awaiting_verification','confirmed','rejected')),
  registration_status text not null default 'reserved'
    check (registration_status in ('reserved','confirmed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.open_play_registrations
  add column if not exists venue_id uuid,
  add column if not exists event_uuid uuid references public.open_play_events(id) on delete set null,
  add column if not exists transaction_fee numeric(10,2) not null default 10,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.open_play_registrations'::regclass
      and conname='open_play_registrations_venue_id_fkey'
  ) then
    alter table public.open_play_registrations
      add constraint open_play_registrations_venue_id_fkey
      foreign key (venue_id) references public.venues(id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.open_play_registrations'::regclass
      and conname='open_play_registrations_transaction_fee_check'
  ) then
    alter table public.open_play_registrations
      add constraint open_play_registrations_transaction_fee_check check (transaction_fee >= 0);
  end if;
end $$;

-- Backfill old registrations to the venue and event they were originally stored against.
update public.open_play_registrations r
set venue_id = v.id
from public.venues v
where r.venue_id is null and lower(trim(r.venue_slug))=lower(trim(v.slug));

update public.open_play_registrations r
set event_uuid = e.id, venue_id = coalesce(r.venue_id,e.venue_id)
from public.open_play_events e
where r.event_uuid is null and r.event_id = e.id::text;

-- Previously rejected registrations must not continue consuming event capacity.
update public.open_play_registrations
set registration_status='cancelled',updated_at=now()
where payment_status='rejected' and registration_status='reserved';

create index if not exists open_play_registrations_event_uuid_idx on public.open_play_registrations(event_uuid, created_at desc);
create index if not exists open_play_registrations_event_capacity_idx
  on public.open_play_registrations(event_uuid) where registration_status <> 'cancelled';
create index if not exists open_play_registrations_venue_id_idx
  on public.open_play_registrations(venue_id, created_at desc);
create index if not exists open_play_registrations_venue_date_idx on public.open_play_registrations(venue_slug, event_date);

-- --------------------------------------------------------------------------
-- 4. RLS and least-privilege table access
-- --------------------------------------------------------------------------
alter table public.venues enable row level security;
alter table public.courts enable row level security;
alter table public.bookings enable row level security;
alter table public.court_blocks enable row level security;
alter table public.open_play_events enable row level security;
alter table public.open_play_registrations enable row level security;

-- Public venue directory reads are limited to published venues and active courts.
drop policy if exists "Public can view venues" on public.venues;
drop policy if exists "Courtly public venue directory" on public.venues;
create policy "Courtly public venue directory" on public.venues
for select to anon, authenticated
using (is_published = true or owner_id = auth.uid());

drop policy if exists "Public can view active courts" on public.courts;
drop policy if exists "Courtly public active courts" on public.courts;
create policy "Courtly public active courts" on public.courts
for select to anon, authenticated
using (is_active = true or exists (
  select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()
));

drop policy if exists "Owners can view own venues" on public.venues;
create policy "Owners can view own venues" on public.venues
for select to authenticated using (owner_id = auth.uid());

drop policy if exists "Owners can update own venues" on public.venues;
create policy "Owners can update own venues" on public.venues
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "Owners can manage own courts" on public.courts;
create policy "Owners can manage own courts" on public.courts
for all to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()))
with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop policy if exists "Owners can update bookings for own venues" on public.bookings;
drop policy if exists "Owners can view bookings for own venues" on public.bookings;
create policy "Owners can view bookings for own venues" on public.bookings
for select to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop policy if exists "Owners can manage own court blocks" on public.court_blocks;
create policy "Owners can manage own court blocks" on public.court_blocks
for all to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()))
with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop policy if exists "Owners manage their open play" on public.open_play_events;
drop policy if exists "Courtly public open play events" on public.open_play_events;
create policy "Courtly public open play events" on public.open_play_events
for select to anon, authenticated using (
  is_published = true and starts_at >= now()
  and exists (select 1 from public.venues v where v.id = venue_id and v.is_published = true)
);
create policy "Owners manage their open play" on public.open_play_events
for all to authenticated
using (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()))
with check (exists (select 1 from public.venues v where v.id = venue_id and v.owner_id = auth.uid()));

-- Never allow direct browser access to customer registration PII or receipts.
revoke all on public.open_play_registrations from anon, authenticated;
revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;

-- Remove broad anonymous venue reads if they were previously granted, then grant
-- only the fields required by the public directory and booking page.
revoke all on public.venues from anon;
revoke all on public.courts from anon;
grant select (id, slug, name, address, city, timezone, currency, phone, description,
  sport, logo_url, cover_url, payment_qr_url, payment_method, payment_account,
  payment_instructions, hours_open, hours_close, peak_hours_start, peak_hours_end, is_published, created_at)
on public.venues to anon;
grant select (id, slug, name, address, city, timezone, currency, phone, description,
  sport, logo_url, cover_url, payment_qr_url, payment_method, payment_account,
  payment_instructions, hours_open, hours_close, peak_hours_start, peak_hours_end, is_published, created_at)
on public.venues to authenticated;

grant select (id, venue_id, name, sport, hourly_rate, off_peak_rate, peak_rate, is_active, image_url, image_fit, display_order, created_at)
on public.courts to anon, authenticated;
grant select on public.open_play_events to anon, authenticated;

-- --------------------------------------------------------------------------
-- 5. Private payment receipts and public venue media buckets
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('courtly-payment-receipts','courtly-payment-receipts',false,104857600,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('courtly-venue-media','courtly-venue-media',true,15728640,
  array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=true, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- Public can view venue media. Only an authenticated venue owner can upload/update/delete.
drop policy if exists "Courtly public venue media read" on storage.objects;
create policy "Courtly public venue media read" on storage.objects
for select to anon, authenticated using (bucket_id = 'courtly-venue-media');

drop policy if exists "Courtly owners upload venue media" on storage.objects;
create policy "Courtly owners upload venue media" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'courtly-venue-media'
  and exists (select 1 from public.venues v where v.owner_id = auth.uid() and v.id::text = (storage.foldername(name))[1])
);

drop policy if exists "Courtly owners update venue media" on storage.objects;
create policy "Courtly owners update venue media" on storage.objects
for update to authenticated
using (bucket_id = 'courtly-venue-media' and exists (
  select 1 from public.venues v where v.owner_id=auth.uid() and v.id::text=(storage.foldername(name))[1]
))
with check (bucket_id = 'courtly-venue-media' and exists (
  select 1 from public.venues v where v.owner_id=auth.uid() and v.id::text=(storage.foldername(name))[1]
));

drop policy if exists "Courtly owners delete venue media" on storage.objects;
create policy "Courtly owners delete venue media" on storage.objects
for delete to authenticated using (
  bucket_id = 'courtly-venue-media'
  and exists (select 1 from public.venues v where v.owner_id=auth.uid() and v.id::text=(storage.foldername(name))[1])
);

-- Receipt authorization is checked inside SECURITY DEFINER helpers so public
-- uploaders never receive direct SELECT permission on private booking records.
create or replace function public.courtly_receipt_upload_allowed(p_name text)
returns boolean language sql stable security definer set search_path=public,storage as $$
  select
    exists (
      select 1 from public.bookings b join public.venues v on v.id=b.venue_id
      where v.slug=(storage.foldername(p_name))[1]
        and b.id::text=(storage.foldername(p_name))[2]
        and b.status='pending' and b.payment_status='unpaid'
        and b.created_at > now()-interval '20 minutes'
    )
    or exists (
      select 1 from public.open_play_events e join public.venues v on v.id=e.venue_id
      where v.slug=(storage.foldername(p_name))[1]
        and (storage.foldername(p_name))[2]='open-play'
        and e.id::text=(storage.foldername(p_name))[3]
        and e.is_published=true and e.starts_at >= now() and v.is_published=true
    );
$$;
revoke all on function public.courtly_receipt_upload_allowed(text) from public;
grant execute on function public.courtly_receipt_upload_allowed(text) to anon,authenticated;

create or replace function public.courtly_owner_can_view_receipt(p_name text)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.bookings b join public.venues v on v.id=b.venue_id
      where v.owner_id=auth.uid() and b.payment_receipt_path=p_name)
    or exists (select 1 from public.open_play_registrations r join public.venues v on (v.id=r.venue_id or (r.venue_id is null and v.slug=r.venue_slug))
      where v.owner_id=auth.uid() and r.receipt_path=p_name)
  );
$$;
revoke all on function public.courtly_owner_can_view_receipt(text) from public;
grant execute on function public.courtly_owner_can_view_receipt(text) to authenticated;

-- Receipts use <venue-slug>/<booking-uuid>/<filename> for court rentals.
-- Open Play receipts use <venue-slug>/open-play/<event-uuid>/<filename>.
drop policy if exists "Customers can upload Courtly payment receipts" on storage.objects;
drop policy if exists "Courtly upload receipt for active booking or event" on storage.objects;
create policy "Courtly upload receipt for active booking or event" on storage.objects
for insert to anon, authenticated
with check (
  bucket_id = 'courtly-payment-receipts'
  and public.courtly_receipt_upload_allowed(name)
);

drop policy if exists "Venue owners can view their Courtly payment receipts" on storage.objects;
drop policy if exists "Courtly owners view venue receipts" on storage.objects;
create policy "Courtly owners view venue receipts" on storage.objects
for select to authenticated
using (
  bucket_id='courtly-payment-receipts'
  and public.courtly_owner_can_view_receipt(name)
);

-- --------------------------------------------------------------------------
-- 6. Owner signup: create a venue and starter courts after Supabase Auth signup
-- --------------------------------------------------------------------------
create or replace function public.courtly_make_slug(input_name text)
returns text language sql immutable as $$
  select coalesce(nullif(trim(both '-' from regexp_replace(lower(coalesce(input_name,'')), '[^a-z0-9]+', '-', 'g')), ''), 'my-venue');
$$;
revoke all on function public.courtly_make_slug(text) from public;

create or replace function public.courtly_create_owner_venue()
returns trigger language plpgsql security definer
set search_path = public, auth, extensions as $$
declare
  business_name text;
  business_address text;
  venue_sport text;
  requested_count text;
  court_total integer := 1;
  base_slug text;
  candidate_slug text;
  suffix integer := 2;
  new_venue_id uuid;
  i integer;
begin
  if exists (select 1 from public.venues where owner_id=new.id) then return new; end if;
  business_name := coalesce(nullif(trim(new.raw_user_meta_data->>'business_name'), ''), 'My Courtly Venue');
  business_address := nullif(trim(new.raw_user_meta_data->>'business_address'), '');
  venue_sport := coalesce(nullif(trim(new.raw_user_meta_data->>'sport'), ''), 'Multi-sport');
  requested_count := coalesce(new.raw_user_meta_data->>'court_count', '1');
  court_total := case
    when requested_count in ('4–5','4-5') then 4
    when requested_count in ('6–10','6-10') then 6
    when requested_count='11+' then 11
    else greatest(1, least(50, coalesce(nullif(regexp_replace(requested_count, '[^0-9]', '', 'g'), '')::integer, 1)))
  end;
  base_slug := public.courtly_make_slug(business_name);
  perform pg_advisory_xact_lock(hashtext(base_slug));
  candidate_slug := base_slug;
  while exists (select 1 from public.venues where slug=candidate_slug) loop
    candidate_slug := base_slug || '-' || suffix::text;
    suffix := suffix + 1;
  end loop;
  insert into public.venues(owner_id,slug,name,address,city,admin_email,owner_name,phone,sport)
  values (new.id,candidate_slug,business_name,business_address,
    nullif(trim(new.raw_user_meta_data->>'city'),''),new.email,
    nullif(trim(new.raw_user_meta_data->>'owner_name'),''),
    nullif(trim(new.raw_user_meta_data->>'owner_phone'),''),venue_sport)
  returning id into new_venue_id;
  for i in 1..court_total loop
    insert into public.courts(venue_id,name,sport,hourly_rate,is_active,display_order)
    values (new_venue_id,'Court '||i,venue_sport,350,true,i)
    on conflict (venue_id,name) do nothing;
  end loop;
  return new;
end; $$;
revoke all on function public.courtly_create_owner_venue() from public;

drop trigger if exists courtly_create_venue_after_signup on auth.users;
create trigger courtly_create_venue_after_signup
after insert on auth.users for each row execute function public.courtly_create_owner_venue();

-- Existing Auth users may have signed up before this trigger was installed.
-- This RPC links an unclaimed venue by matching its admin email, or safely
-- creates a venue/courts from the Auth user's signup metadata when none exists.
create or replace function public.courtly_ensure_owner_venue()
returns uuid language plpgsql security definer set search_path=public,auth,extensions as $$
declare
  v_user auth.users%rowtype;
  v_venue public.venues%rowtype;
  v_match_count integer;
  v_name text;
  v_address text;
  v_city text;
  v_sport text;
  v_phone text;
  v_count_text text;
  v_count integer := 1;
  v_base text;
  v_slug text;
  v_suffix integer := 2;
  v_id uuid;
  i integer;
begin
  if auth.uid() is null then raise exception 'Please sign in to access your venue'; end if;
  select * into v_user from auth.users where id=auth.uid();
  if not found then raise exception 'Authenticated user record was not found'; end if;
  select * into v_venue from public.venues where owner_id=auth.uid() order by created_at limit 1;
  if found then return v_venue.id; end if;

  select count(*) into v_match_count from public.venues
    where owner_id is null and admin_email is not null
      and lower(admin_email)=lower(v_user.email);
  if v_match_count=1 then
    select * into v_venue from public.venues where owner_id is null
      and lower(admin_email)=lower(v_user.email) for update;
    update public.venues set owner_id=auth.uid(), updated_at=now()
      where id=v_venue.id returning * into v_venue;
    if not exists(select 1 from public.courts where venue_id=v_venue.id) then
      insert into public.courts(venue_id,name,sport,hourly_rate,is_active,display_order)
      values(v_venue.id,'Court 1',coalesce(v_venue.sport,'Multi-sport'),350,true,1)
      on conflict (venue_id,name) do nothing;
    end if;
    return v_venue.id;
  elsif v_match_count>1 then
    raise exception 'More than one unclaimed venue uses this email. Contact Courtly support to link the correct venue.';
  end if;

  v_name := coalesce(nullif(trim(v_user.raw_user_meta_data->>'business_name'),''),'My Courtly Venue');
  v_address := nullif(trim(v_user.raw_user_meta_data->>'business_address'),'');
  v_city := nullif(trim(v_user.raw_user_meta_data->>'city'),'');
  v_sport := coalesce(nullif(trim(v_user.raw_user_meta_data->>'sport'),''),'Multi-sport');
  v_phone := nullif(trim(v_user.raw_user_meta_data->>'owner_phone'),'');
  v_count_text := coalesce(v_user.raw_user_meta_data->>'court_count','1');
  v_count := case
    when v_count_text in ('4–5','4-5') then 4
    when v_count_text in ('6–10','6-10') then 6
    when v_count_text='11+' then 11
    else greatest(1,least(50,coalesce(nullif(regexp_replace(v_count_text,'[^0-9]','','g'),'')::integer,1)))
  end;
  v_base := public.courtly_make_slug(v_name);
  perform pg_advisory_xact_lock(hashtext(v_base));
  v_slug := v_base;
  while exists(select 1 from public.venues where slug=v_slug) loop
    v_slug := v_base||'-'||v_suffix::text;
    v_suffix := v_suffix+1;
  end loop;
  insert into public.venues(owner_id,slug,name,address,city,admin_email,owner_name,phone,sport)
  values(auth.uid(),v_slug,v_name,v_address,v_city,v_user.email,
    nullif(trim(v_user.raw_user_meta_data->>'owner_name'),''),v_phone,v_sport)
  returning id into v_id;
  for i in 1..v_count loop
    insert into public.courts(venue_id,name,sport,hourly_rate,is_active,display_order)
    values(v_id,'Court '||i,v_sport,350,true,i)
    on conflict (venue_id,name) do nothing;
  end loop;
  return v_id;
end; $$;
revoke all on function public.courtly_ensure_owner_venue() from public;
grant execute on function public.courtly_ensure_owner_venue() to authenticated;

-- --------------------------------------------------------------------------
-- 7. Public availability and booking creation
-- --------------------------------------------------------------------------
create or replace function public.get_public_booked_slots(
  p_venue_slug text, p_from timestamptz, p_to timestamptz
) returns table(court_id uuid, starts_at timestamptz, ends_at timestamptz, slot_type text)
language sql stable security definer set search_path=public as $$
  select b.court_id,b.starts_at,b.ends_at,'booking'::text
  from public.bookings b join public.venues v on v.id=b.venue_id
  where v.slug=p_venue_slug and v.is_published=true
    and b.starts_at < p_to and b.ends_at > p_from
    and b.status in ('pending','confirmed')
    and not (b.status='pending' and b.payment_status='unpaid' and b.created_at < now()-interval '20 minutes')
  union all
  select cb.court_id,cb.starts_at,cb.ends_at,'blocked'::text
  from public.court_blocks cb join public.venues v on v.id=cb.venue_id
  where v.slug=p_venue_slug and v.is_published=true
    and cb.starts_at < p_to and cb.ends_at > p_from;
$$;
revoke all on function public.get_public_booked_slots(text,timestamptz,timestamptz) from public;
grant execute on function public.get_public_booked_slots(text,timestamptz,timestamptz) to anon,authenticated;

create or replace function public.create_booking_request(
  p_venue_slug text,
  p_court_id uuid,
  p_starts_at timestamptz,
  p_duration_hours integer,
  p_player_name text,
  p_player_email text,
  p_player_phone text default null,
  p_payment_method text default 'GCash'
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_venue public.venues%rowtype;
  v_court public.courts%rowtype;
  v_ends_at timestamptz;
  v_subtotal numeric(10,2) := 0;
  v_fee numeric(10,2);
  v_hour_start timestamptz;
  v_local_time time;
  v_is_peak boolean;
  i integer;
  v_booking public.bookings%rowtype;
begin
  if coalesce(trim(p_player_name),'')='' or coalesce(trim(p_player_email),'')='' then
    raise exception 'Please provide your name and email address';
  end if;
  if p_duration_hours is null or p_duration_hours < 1 or p_duration_hours > 8 then
    raise exception 'Booking duration must be between 1 and 8 hours';
  end if;
  if p_starts_at is null or p_starts_at <= now() then raise exception 'Choose a future start time'; end if;
  if extract(minute from p_starts_at) <> 0 or extract(second from p_starts_at) <> 0 then
    raise exception 'Court reservations must start on the hour';
  end if;
  select * into v_venue from public.venues where slug=p_venue_slug and is_published=true;
  if not found then raise exception 'This venue is not available for booking'; end if;
  select * into v_court from public.courts where id=p_court_id and venue_id=v_venue.id and is_active=true;
  if not found then raise exception 'This court is not available'; end if;
  v_ends_at := p_starts_at + make_interval(hours => p_duration_hours);
  if (p_starts_at at time zone v_venue.timezone)::time < v_venue.hours_open
     or (v_ends_at at time zone v_venue.timezone)::time > v_venue.hours_close then
    raise exception 'The requested time is outside this venue''s operating hours';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_court_id::text), hashtext((p_starts_at at time zone v_venue.timezone)::date::text));
  if exists (
    select 1 from public.bookings b
    where b.court_id=p_court_id and b.starts_at < v_ends_at and b.ends_at > p_starts_at
      and b.status in ('pending','confirmed')
      and not (b.status='pending' and b.payment_status='unpaid' and b.created_at < now()-interval '20 minutes')
  ) then raise exception 'That court and time have just been reserved. Please select another slot'; end if;
  if exists (select 1 from public.court_blocks cb where cb.court_id=p_court_id and cb.starts_at < v_ends_at and cb.ends_at > p_starts_at) then
    raise exception 'That court is unavailable for the selected time';
  end if;
  for i in 0..(p_duration_hours-1) loop
    v_hour_start := p_starts_at + make_interval(hours => i);
    v_local_time := (v_hour_start at time zone v_venue.timezone)::time;
    v_is_peak := false;
    if v_venue.peak_hours_start is not null and v_venue.peak_hours_end is not null then
      if v_venue.peak_hours_start < v_venue.peak_hours_end then
        v_is_peak := v_local_time >= v_venue.peak_hours_start and v_local_time < v_venue.peak_hours_end;
      elsif v_venue.peak_hours_start > v_venue.peak_hours_end then
        v_is_peak := v_local_time >= v_venue.peak_hours_start or v_local_time < v_venue.peak_hours_end;
      end if;
    end if;
    v_subtotal := v_subtotal + case when v_is_peak then v_court.peak_rate else v_court.off_peak_rate end;
  end loop;
  v_fee := 10 * p_duration_hours;
  insert into public.bookings(
    venue_id,court_id,customer_name,customer_email,customer_phone,starts_at,ends_at,
    duration_hours,subtotal,platform_fee,total,status,payment_status,payment_method,expires_at
  ) values (
    v_venue.id,v_court.id,trim(p_player_name),lower(trim(p_player_email)),nullif(trim(p_player_phone),''),
    p_starts_at,v_ends_at,p_duration_hours,v_subtotal,v_fee,v_subtotal,'pending','unpaid',
    coalesce(nullif(trim(p_payment_method),''),'GCash'),now()+interval '20 minutes'
  ) returning * into v_booking;
  return jsonb_build_object(
    'id',v_booking.id,'reference',v_booking.reference,'venue_slug',v_venue.slug,
    'venue_name',v_venue.name,'court_id',v_court.id,'court_name',v_court.name,
    'starts_at',v_booking.starts_at,'ends_at',v_booking.ends_at,
    'duration_hours',v_booking.duration_hours,'subtotal',v_booking.subtotal,
    'platform_fee',v_booking.platform_fee,'total',v_booking.total,
    'customer_access_token',v_booking.customer_access_token,
    'payment_status',v_booking.payment_status,'status',v_booking.status
  );
end; $$;
revoke all on function public.create_booking_request(text,uuid,timestamptz,integer,text,text,text,text) from public;
grant execute on function public.create_booking_request(text,uuid,timestamptz,integer,text,text,text,text) to anon,authenticated;

create or replace function public.attach_booking_receipt(p_booking_id uuid,p_receipt_path text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_booking public.bookings%rowtype; v_slug text;
begin
  select b.* into v_booking from public.bookings b where b.id=p_booking_id;
  select v.slug into v_slug from public.bookings b join public.venues v on v.id=b.venue_id where b.id=p_booking_id;
  if not found or v_booking.id is null or v_booking.status <> 'pending'
     or v_booking.payment_status <> 'unpaid' or v_booking.created_at < now()-interval '20 minutes'
     or v_booking.expires_at is null or v_booking.expires_at <= now() then
    raise exception 'This booking request has expired. Please start again';
  end if;
  if p_receipt_path not like v_slug||'/'||p_booking_id::text||'/%' then
    raise exception 'Invalid receipt path for this booking';
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id='courtly-payment-receipts' and o.name=p_receipt_path) then
    raise exception 'The uploaded payment receipt could not be found. Please upload it again';
  end if;
  if exists (select 1 from public.bookings other
    where other.id <> p_booking_id and other.court_id=v_booking.court_id
      and other.starts_at < v_booking.ends_at and other.ends_at > v_booking.starts_at
      and other.status in ('pending','confirmed')
      and not (other.status='pending' and other.payment_status='unpaid' and other.created_at < now()-interval '20 minutes')) then
    raise exception 'This timeslot has already been taken. Please contact the venue before paying again';
  end if;
  update public.bookings set payment_receipt_path=p_receipt_path,
    payment_status='awaiting_verification',receipt_submitted_at=now(),expires_at=null,updated_at=now()
  where id=p_booking_id;
  return jsonb_build_object('success',true,'reference',v_booking.reference,'booking_id',p_booking_id);
end; $$;
revoke all on function public.attach_booking_receipt(uuid,text) from public;
grant execute on function public.attach_booking_receipt(uuid,text) to anon,authenticated;

create or replace function public.cancel_unpaid_booking_request(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  update public.bookings set status='cancelled',cancelled_at=now(),updated_at=now()
  where id=p_booking_id and status='pending' and payment_status='unpaid'
    and created_at > now()-interval '20 minutes';
  get diagnostics n=row_count;
  return n=1;
end; $$;
revoke all on function public.cancel_unpaid_booking_request(uuid) from public;
grant execute on function public.cancel_unpaid_booking_request(uuid) to anon,authenticated;

drop function if exists public.get_public_booking_by_reference(text,text);
drop function if exists public.get_public_bookings_for_email(text);

create or replace function public.get_public_booking_by_reference(p_reference text,p_access_token uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'reference',b.reference,'venue_name',v.name,'venue_slug',v.slug,'court_name',c.name,
    'starts_at',b.starts_at,'ends_at',b.ends_at,'duration_hours',b.duration_hours,
    'subtotal',b.subtotal,'total',b.total,'status',b.status,'payment_status',b.payment_status,
    'player_name',b.customer_name,'payment_method',b.payment_method,'created_at',b.created_at
  )
  from public.bookings b join public.venues v on v.id=b.venue_id join public.courts c on c.id=b.court_id
  where upper(b.reference)=upper(p_reference) and b.customer_access_token=p_access_token
  limit 1;
$$;
revoke all on function public.get_public_booking_by_reference(text,uuid) from public;
grant execute on function public.get_public_booking_by_reference(text,uuid) to anon,authenticated;

create or replace function public.get_public_bookings_for_tokens(p_access_tokens uuid[])
returns table(
  reference text,venue_name text,court_name text,starts_at timestamptz,ends_at timestamptz,
  duration_hours integer,total numeric,status text,payment_status text,payment_method text,created_at timestamptz
) language sql stable security definer set search_path=public as $$
  select b.reference,v.name,c.name,b.starts_at,b.ends_at,b.duration_hours,b.total,
    b.status,b.payment_status,b.payment_method,b.created_at
  from public.bookings b join public.venues v on v.id=b.venue_id join public.courts c on c.id=b.court_id
  where b.customer_access_token=any(coalesce(p_access_tokens,array[]::uuid[]))
  order by b.created_at desc limit 100;
$$;
revoke all on function public.get_public_bookings_for_tokens(uuid[]) from public;
grant execute on function public.get_public_bookings_for_tokens(uuid[]) to anon,authenticated;

-- Expire unpaid 20-minute holds for the signed-in venue owner so abandoned
-- checkouts do not remain as misleading pending rows in the owner portal.
create or replace function public.expire_owner_courtly_booking_holds()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'Please sign in as the venue owner'; end if;
  update public.bookings b
  set status='cancelled',cancelled_at=coalesce(cancelled_at,now()),updated_at=now()
  where b.status='pending' and b.payment_status='unpaid'
    and b.created_at <= now()-interval '20 minutes'
    and exists(select 1 from public.venues v where v.id=b.venue_id and v.owner_id=auth.uid());
  get diagnostics v_count=row_count;
  return v_count;
end; $$;
revoke all on function public.expire_owner_courtly_booking_holds() from public;
grant execute on function public.expire_owner_courtly_booking_holds() to authenticated;

-- --------------------------------------------------------------------------
-- 8. Owner booking review and management
-- --------------------------------------------------------------------------
create or replace function public.review_court_booking_payment(p_booking_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_booking public.bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'Please sign in as the venue owner'; end if;
  if p_decision not in ('confirmed','rejected') then raise exception 'Invalid payment decision'; end if;
  select b.* into v_booking from public.bookings b join public.venues v on v.id=b.venue_id
  where b.id=p_booking_id and v.owner_id=auth.uid() for update;
  if not found then raise exception 'Booking not found or not authorized'; end if;
  if v_booking.payment_status <> 'awaiting_verification' then raise exception 'This receipt is no longer awaiting verification'; end if;
  update public.bookings set
    payment_status=p_decision,
    status=case when p_decision='confirmed' then 'confirmed' else 'rejected' end,
    paid_at=case when p_decision='confirmed' then now() else null end,
    confirmed_at=case when p_decision='confirmed' then now() else null end,
    updated_at=now()
  where id=p_booking_id;
  return jsonb_build_object('success',true,'reference',v_booking.reference,'payment_status',p_decision);
end; $$;
revoke all on function public.review_court_booking_payment(uuid,text) from public;
grant execute on function public.review_court_booking_payment(uuid,text) to authenticated;

create or replace function public.cancel_owner_booking(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  update public.bookings b set status='cancelled',cancelled_at=now(),updated_at=now()
  where b.id=p_booking_id and b.status in ('pending','confirmed')
    and exists (select 1 from public.venues v where v.id=b.venue_id and v.owner_id=auth.uid());
  get diagnostics n=row_count;
  if n=0 then raise exception 'Booking not found or not authorized'; end if;
  return true;
end; $$;
revoke all on function public.cancel_owner_booking(uuid) from public;
grant execute on function public.cancel_owner_booking(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- 9. Open Play: event counts, registration, owner review and earnings
-- --------------------------------------------------------------------------
-- Retire the older RPC that accepted event price/title/capacity from the public browser.
-- The UUID-based replacement below reads all event details from Supabase.
drop function if exists public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text);
-- The owner portal now requests a venue-scoped report explicitly.
drop function if exists public.get_owner_open_play_transactions();
create or replace function public.get_open_play_registration_counts(p_event_ids text[])
returns table(event_id text,registered_count bigint)
language sql stable security definer set search_path=public as $$
  select r.event_uuid::text,count(*)::bigint
  from public.open_play_registrations r
  where r.event_uuid::text=any(coalesce(p_event_ids,array[]::text[]))
    and r.registration_status<>'cancelled'
  group by r.event_uuid;
$$;
revoke all on function public.get_open_play_registration_counts(text[]) from public;
grant execute on function public.get_open_play_registration_counts(text[]) to anon,authenticated;

create or replace function public.register_open_play_player(
  p_event_id uuid,p_player_name text,p_player_email text,p_player_phone text,p_receipt_path text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_event public.open_play_events%rowtype;
  v_venue public.venues%rowtype;
  v_count integer;
  v_ref text;
  v_registration public.open_play_registrations%rowtype;
begin
  if coalesce(trim(p_player_name),'')='' or coalesce(trim(p_player_email),'')='' or coalesce(trim(p_receipt_path),'')='' then
    raise exception 'Name, email and receipt are required';
  end if;
  select * into v_event from public.open_play_events where id=p_event_id and is_published=true and starts_at>=now();
  if not found then raise exception 'This Open Play event is no longer available'; end if;
  select * into v_venue from public.venues where id=v_event.venue_id and is_published=true;
  if not found then raise exception 'This venue is not currently accepting registrations'; end if;
  if p_receipt_path not like v_venue.slug||'/open-play/'||v_event.id::text||'/%' then
    raise exception 'Invalid receipt path for this Open Play event';
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id='courtly-payment-receipts' and o.name=p_receipt_path) then
    raise exception 'The uploaded payment receipt could not be found. Please upload it again';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_event.id::text));
  select count(*) into v_count from public.open_play_registrations
   where event_uuid=v_event.id and registration_status<>'cancelled';
  if v_event.registration_limit is not null and v_count>=v_event.registration_limit then
    raise exception 'This Open Play session is fully booked';
  end if;
  v_ref := 'OP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.open_play_registrations(
    venue_id,registration_reference,event_id,event_uuid,event_title,venue_slug,venue_name,event_date,event_time,
    location_text,player_name,player_email,player_phone,fee,transaction_fee,receipt_path
  ) values (
    v_venue.id,v_ref,v_event.id::text,v_event.id,v_event.title,v_venue.slug,v_venue.name,
    (v_event.starts_at at time zone v_venue.timezone)::date,
    to_char(v_event.starts_at at time zone v_venue.timezone,'HH12:MI AM'),
    v_event.location_text,trim(p_player_name),lower(trim(p_player_email)),nullif(trim(p_player_phone),''),
    v_event.fee,10,p_receipt_path
  ) returning * into v_registration;
  return jsonb_build_object('id',v_registration.id,'registration_reference',v_ref,
    'registered_count',v_count+1,'fee',v_event.fee,'transaction_fee',10,
    'payment_status',v_registration.payment_status,'registration_status',v_registration.registration_status);
end; $$;
revoke all on function public.register_open_play_player(uuid,text,text,text,text) from public;
grant execute on function public.register_open_play_player(uuid,text,text,text,text) to anon,authenticated;

drop function if exists public.get_owner_open_play_transactions(text);
create function public.get_owner_open_play_transactions(p_venue_slug text default null)
returns table(
  id uuid,registration_reference text,event_title text,event_date date,event_time text,
  player_name text,player_email text,player_phone text,fee numeric,transaction_fee numeric,
  payment_status text,registration_status text,receipt_path text,created_at timestamptz,venue_slug text
) language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in as the venue owner'; end if;
  return query
  select r.id,r.registration_reference,r.event_title,r.event_date,r.event_time,
    r.player_name,r.player_email,r.player_phone,r.fee,r.transaction_fee,
    r.payment_status,r.registration_status,r.receipt_path,r.created_at,r.venue_slug
  from public.open_play_registrations r join public.venues v
    on v.id=r.venue_id or (r.venue_id is null and lower(trim(v.slug))=lower(trim(r.venue_slug)))
  where v.owner_id=auth.uid() and (p_venue_slug is null or v.slug=p_venue_slug)
  order by r.created_at desc;
end; $$;
revoke all on function public.get_owner_open_play_transactions(text) from public;
grant execute on function public.get_owner_open_play_transactions(text) to authenticated;

create or replace function public.review_open_play_payment(p_registration_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_updated integer;
begin
  if auth.uid() is null then raise exception 'Please sign in with the venue owner account'; end if;
  if p_decision not in ('confirmed','rejected') then raise exception 'Invalid payment decision'; end if;
  update public.open_play_registrations r set payment_status=p_decision,
    registration_status=case when p_decision='confirmed' then 'confirmed' else 'cancelled' end,
    updated_at=now()
  where r.id=p_registration_id and r.payment_status='awaiting_verification'
    and exists(select 1 from public.venues v
      where (v.id=r.venue_id or (r.venue_id is null and lower(trim(v.slug))=lower(trim(r.venue_slug))) )
        and v.owner_id=auth.uid());
  get diagnostics v_updated=row_count;
  if v_updated=0 then raise exception 'This registration is no longer awaiting verification or does not belong to your venue'; end if;
  return jsonb_build_object('success',true,'payment_status',p_decision,'registration_id',p_registration_id);
end; $$;
revoke all on function public.review_open_play_payment(uuid,text) from public;
grant execute on function public.review_open_play_payment(uuid,text) to authenticated;

drop function if exists public.get_owner_open_play_earnings(text);
create function public.get_owner_open_play_earnings(p_venue_slug text)
returns table(registration_count bigint,paid_count bigint,awaiting_count bigint,confirmed_revenue numeric,transaction_fees numeric)
language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or not exists(select 1 from public.venues v where v.slug=p_venue_slug and v.owner_id=auth.uid()) then
    raise exception 'Not authorized to view Open Play earnings';
  end if;
  return query select
    count(*) filter(where r.registration_status<>'cancelled')::bigint,
    count(*) filter(where r.registration_status<>'cancelled' and r.payment_status='confirmed')::bigint,
    count(*) filter(where r.registration_status<>'cancelled' and r.payment_status='awaiting_verification')::bigint,
    coalesce(sum(r.fee) filter(where r.registration_status<>'cancelled' and r.payment_status='confirmed'),0)::numeric,
    coalesce(sum(r.transaction_fee) filter(where r.registration_status<>'cancelled' and r.payment_status='confirmed'),0)::numeric
  from public.open_play_registrations r where r.venue_slug=p_venue_slug;
end; $$;
revoke all on function public.get_owner_open_play_earnings(text) from public;
grant execute on function public.get_owner_open_play_earnings(text) to authenticated;

-- --------------------------------------------------------------------------
-- 10. Grants for owner CRUD and RLS-protected data
-- --------------------------------------------------------------------------
grant select,update on public.venues to authenticated;
grant select,insert,update,delete on public.courts to authenticated;
grant select,insert,update,delete on public.court_blocks to authenticated;
grant select,insert,update,delete on public.open_play_events to authenticated;

-- Do not expose owner/customer private fields to anonymous REST table access.
revoke all on public.open_play_registrations from anon,authenticated;
revoke all on public.bookings from anon;

commit;

-- ============================================================================
-- AFTER APPLYING:
-- 1) Enable email confirmation in Supabase Auth (recommended).
-- 2) Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel.
-- 3) Register a test owner account, then verify venues/courts were auto-created.
-- 4) Test bookings with test details before accepting real money.
-- ============================================================================
