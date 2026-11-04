-- ============================================================================
-- COURTLY PLAYER ACCOUNTS + PLAYER DASHBOARD DATA ACCESS
-- Run once in Supabase SQL Editor after 001_complete_supabase_backend.sql.
-- Safe/additive: does not delete existing venues, courts, bookings or registrations.
-- ============================================================================

begin;

-- 1) Player profile data. A profile exists only for Auth users who sign up
--    with raw_user_meta_data.account_type = 'player'.
create table if not exists public.player_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  player_name text not null default '',
  email text not null default '',
  phone text,
  skill_level text not null default 'Beginner'
    check (skill_level in ('Beginner','Intermediate','Advanced','Professional')),
  avatar_url text,
  is_private boolean not null default false,
  preferred_sport text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.courtly_is_player_account()
returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.raw_user_meta_data->>'account_type' = 'player'
  );
$$;
revoke all on function public.courtly_is_player_account() from public, anon;
grant execute on function public.courtly_is_player_account() to authenticated;

alter table public.player_profiles enable row level security;
revoke all on public.player_profiles from anon;
revoke all on public.player_profiles from authenticated;
grant select, insert, update on public.player_profiles to authenticated;

drop policy if exists "Players can read their own profile" on public.player_profiles;
create policy "Players can read their own profile"
on public.player_profiles for select to authenticated
using (id = auth.uid());

drop policy if exists "Players can create their own profile" on public.player_profiles;
create policy "Players can create their own profile"
on public.player_profiles for insert to authenticated
with check (id = auth.uid() and public.courtly_is_player_account());

drop policy if exists "Players can update their own profile" on public.player_profiles;
create policy "Players can update their own profile"
on public.player_profiles for update to authenticated
using (id = auth.uid() and public.courtly_is_player_account())
with check (id = auth.uid() and public.courtly_is_player_account());

create or replace function public.courtly_create_player_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if coalesce(new.raw_user_meta_data->>'account_type','') <> 'player' then
    return new;
  end if;

  insert into public.player_profiles (
    id, full_name, player_name, email, phone, skill_level, is_private, preferred_sport
  ) values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''), ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'player_name'),''), ''),
    coalesce(lower(new.email), ''),
    nullif(trim(new.raw_user_meta_data->>'phone'),''),
    case when new.raw_user_meta_data->>'skill_level' in ('Beginner','Intermediate','Advanced','Professional')
      then new.raw_user_meta_data->>'skill_level' else 'Beginner' end,
    (coalesce(new.raw_user_meta_data->>'is_private','false') = 'true'),
    nullif(trim(new.raw_user_meta_data->>'preferred_sport'),'')
  ) on conflict (id) do nothing;

  return new;
end;
$$;
revoke all on function public.courtly_create_player_profile() from public;

drop trigger if exists courtly_create_player_profile_after_signup on auth.users;
create trigger courtly_create_player_profile_after_signup
after insert on auth.users
for each row execute function public.courtly_create_player_profile();

-- 2) Make sure player signups never create a venue through the existing
--    owner signup trigger. Existing owner signups (without account_type=player)
--    retain the same behavior.
create or replace function public.courtly_create_owner_venue()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
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
  if coalesce(new.raw_user_meta_data->>'account_type','') = 'player' then
    return new;
  end if;
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
end;
$$;

-- 3) Prevent player accounts from calling the owner venue-bootstrap RPC.
create or replace function public.courtly_ensure_owner_venue()
returns uuid
language plpgsql
security definer
set search_path=public,auth,extensions
as $$
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
  if coalesce(v_user.raw_user_meta_data->>'account_type','') = 'player'
     or exists (select 1 from public.player_profiles pp where pp.id=auth.uid()) then
    raise exception 'Player accounts cannot access the owner portal';
  end if;

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
end;
$$;

-- 4) Attach any new court booking or Open Play registration made while signed
--    in as a player to that player's Auth ID. Guest checkout remains supported.
alter table public.bookings
  add column if not exists player_id uuid references auth.users(id) on delete set null;
alter table public.open_play_registrations
  add column if not exists player_id uuid references auth.users(id) on delete set null;

create index if not exists bookings_player_created_idx
  on public.bookings(player_id, created_at desc) where player_id is not null;
create index if not exists open_play_registrations_player_created_idx
  on public.open_play_registrations(player_id, created_at desc) where player_id is not null;

create or replace function public.courtly_attach_player_to_booking()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and exists (
    select 1 from public.player_profiles pp where pp.id=auth.uid()
  ) then
    new.player_id := auth.uid();
  end if;
  return new;
end;
$$;
revoke all on function public.courtly_attach_player_to_booking() from public;
drop trigger if exists courtly_attach_player_to_booking_before_insert on public.bookings;
create trigger courtly_attach_player_to_booking_before_insert
before insert on public.bookings
for each row execute function public.courtly_attach_player_to_booking();

create or replace function public.courtly_attach_player_to_open_play_registration()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and exists (
    select 1 from public.player_profiles pp where pp.id=auth.uid()
  ) then
    new.player_id := auth.uid();
  end if;
  return new;
end;
$$;
revoke all on function public.courtly_attach_player_to_open_play_registration() from public;
drop trigger if exists courtly_attach_player_to_open_play_registration_before_insert on public.open_play_registrations;
create trigger courtly_attach_player_to_open_play_registration_before_insert
before insert on public.open_play_registrations
for each row execute function public.courtly_attach_player_to_open_play_registration();

-- Player can read only their own court bookings.
drop policy if exists "Players can view own bookings" on public.bookings;
create policy "Players can view own bookings"
on public.bookings for select to authenticated
using (player_id = auth.uid());
grant select on public.bookings to authenticated;

-- Player can read only their own Open Play registrations. Owner transaction
-- screens continue to use the existing owner-scoped SECURITY DEFINER RPC.
drop policy if exists "Players can view own Open Play registrations" on public.open_play_registrations;
create policy "Players can view own Open Play registrations"
on public.open_play_registrations for select to authenticated
using (player_id = auth.uid());
revoke all on public.open_play_registrations from anon;
grant select on public.open_play_registrations to authenticated;

-- 5) Optional player avatars. The bucket is private; a player can read/write
--    only objects in the folder matching their authenticated user ID. The
--    browser requests short-lived signed URLs for display.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('courtly-player-avatars','courtly-player-avatars',false,8388608,
  array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false, file_size_limit=8388608,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Courtly player avatars are public" on storage.objects;
drop policy if exists "Players read their own avatar" on storage.objects;
create policy "Players read their own avatar"
on storage.objects for select to authenticated
using (
  bucket_id='courtly-player-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Players upload their own avatar" on storage.objects;
create policy "Players upload their own avatar"
on storage.objects for insert to authenticated
with check (
  bucket_id='courtly-player-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Players update their own avatar" on storage.objects;
create policy "Players update their own avatar"
on storage.objects for update to authenticated
using (
  bucket_id='courtly-player-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id='courtly-player-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Players delete their own avatar" on storage.objects;
create policy "Players delete their own avatar"
on storage.objects for delete to authenticated
using (
  bucket_id='courtly-player-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

commit;

-- AFTER APPLYING:
-- 1) Test with a NEW player account (existing Auth users are not auto-classified).
-- 2) Confirm player_profiles contains the new account.
-- 3) Confirm no venues row is created for the player account.
-- 4) Book a court while logged in and confirm bookings.player_id is set.

comment on column public.player_profiles.avatar_url is 'Private Storage object path in courtly-player-avatars; resolve to a short-lived signed URL for display.';
