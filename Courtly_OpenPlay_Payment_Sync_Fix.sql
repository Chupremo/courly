-- Courtly Open Play payment/owner synchronization hardening.
-- Run this file once in Supabase SQL Editor before deploying the matching frontend.
-- It preserves valid registration history, links records to the canonical venue ID,
-- and prevents checkout from reporting success for an unowned/orphaned venue slug.

-- 1) Add a durable venue relationship. Existing rows are backfilled only when
--    their stored slug matches an actual venue; unmatched rows remain unlinked.
alter table public.open_play_registrations
  add column if not exists venue_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'open_play_registrations_venue_id_fkey'
      and conrelid = 'public.open_play_registrations'::regclass
  ) then
    alter table public.open_play_registrations
      add constraint open_play_registrations_venue_id_fkey
      foreign key (venue_id) references public.venues(id) on delete cascade;
  end if;
end $$;

update public.open_play_registrations r
set venue_id = v.id
from public.venues v
where r.venue_id is null
  and lower(trim(r.venue_slug)) = lower(trim(v.slug));

create index if not exists open_play_registrations_venue_id_created_idx
  on public.open_play_registrations(venue_id, created_at desc);

-- 2) Public Open Play checkout: validate venue ownership/linkage before insert.
--    This makes the player see an error rather than a false successful checkout
--    when their page is using a slug that does not belong to an active owner.
create or replace function public.register_open_play_player(
  p_event_id text,
  p_event_title text,
  p_venue_slug text,
  p_venue_name text,
  p_event_date date,
  p_event_time text,
  p_location_text text,
  p_registration_limit integer,
  p_fee numeric,
  p_player_name text,
  p_player_email text,
  p_player_phone text,
  p_receipt_path text,
  p_registration_reference text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_id uuid;
  v_venue_id uuid;
  v_venue_slug text;
  v_venue_name text;
begin
  if coalesce(trim(p_player_name), '') = ''
     or coalesce(trim(p_player_email), '') = ''
     or coalesce(trim(p_receipt_path), '') = '' then
    raise exception 'Player name, email, and payment receipt are required';
  end if;

  select v.id, v.slug, v.name
    into v_venue_id, v_venue_slug, v_venue_name
  from public.venues v
  where lower(trim(v.slug)) = lower(trim(coalesce(p_venue_slug, '')))
    and v.owner_id is not null
  limit 1;

  if v_venue_id is null then
    raise exception 'This booking page is not linked to an active Courtly owner venue. The registration was not saved. Please contact the venue owner.';
  end if;

  if lower(p_receipt_path) not like lower(v_venue_slug) || '/%' then
    raise exception 'The uploaded receipt does not match this venue. Please refresh the booking page and upload the receipt again.';
  end if;

  if coalesce(trim(p_registration_reference), '') = '' then
    raise exception 'A booking reference is required';
  end if;

  -- Lock capacity per venue + event, preventing different venues with the same
  -- event ID from blocking one another.
  perform pg_advisory_xact_lock(hashtext(v_venue_id::text || ':' || coalesce(p_event_id, '')));

  select count(*)::integer
    into v_count
  from public.open_play_registrations r
  where r.venue_id = v_venue_id
    and r.event_id = p_event_id
    and r.registration_status <> 'cancelled';

  if p_registration_limit is not null and v_count >= p_registration_limit then
    raise exception 'This Open Play session is fully booked';
  end if;

  insert into public.open_play_registrations(
    venue_id,
    registration_reference,
    event_id,
    event_title,
    venue_slug,
    venue_name,
    event_date,
    event_time,
    location_text,
    player_name,
    player_email,
    player_phone,
    fee,
    receipt_path
  ) values (
    v_venue_id,
    p_registration_reference,
    p_event_id,
    coalesce(nullif(trim(p_event_title), ''), 'Open Play session'),
    v_venue_slug,
    v_venue_name,
    p_event_date,
    coalesce(p_event_time, ''),
    coalesce(p_location_text, ''),
    trim(p_player_name),
    trim(p_player_email),
    nullif(trim(coalesce(p_player_phone, '')), ''),
    greatest(coalesce(p_fee, 0), 0),
    p_receipt_path
  ) returning id into v_id;

  v_count := v_count + 1;
  return jsonb_build_object(
    'success', true,
    'id', v_id,
    'registration_reference', p_registration_reference,
    'venue_id', v_venue_id,
    'venue_slug', v_venue_slug,
    'registered_count', v_count,
    'remaining', greatest(coalesce(p_registration_limit, v_count) - v_count, 0),
    'status', 'reserved',
    'payment_status', 'awaiting_verification'
  );
end;
$$;

revoke all on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) from public;
grant execute on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) to anon, authenticated;

-- 3) Owner transaction list: derive venues from the authenticated owner ID.
--    No browser-supplied slug is needed. This also supports owners with multiple venues.
create or replace function public.get_owner_open_play_transactions()
returns table(
  id uuid,
  registration_reference text,
  event_title text,
  event_date date,
  event_time text,
  player_name text,
  player_email text,
  player_phone text,
  fee numeric,
  payment_status text,
  registration_status text,
  receipt_path text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Your owner session is missing. Please sign in again.';
  end if;

  return query
  select r.id, r.registration_reference, r.event_title, r.event_date,
         r.event_time, r.player_name, r.player_email, r.player_phone,
         r.fee, r.payment_status, r.registration_status,
         r.receipt_path, r.created_at
  from public.open_play_registrations r
  join public.venues v
    on v.id = r.venue_id
    or (r.venue_id is null and lower(trim(v.slug)) = lower(trim(r.venue_slug)))
  where v.owner_id = auth.uid()
  order by r.created_at desc;
end;
$$;

revoke all on function public.get_owner_open_play_transactions() from public;
grant execute on function public.get_owner_open_play_transactions() to authenticated;

-- 4) Preserve the old parameterized RPC for compatibility with older deployed
--    clients, but apply the same owner + venue-ID matching rule.
create or replace function public.get_owner_open_play_transactions(p_venue_slug text)
returns table(
  id uuid,
  registration_reference text,
  event_title text,
  event_date date,
  event_time text,
  player_name text,
  player_email text,
  player_phone text,
  fee numeric,
  payment_status text,
  registration_status text,
  receipt_path text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.venues v
    where lower(trim(v.slug)) = lower(trim(p_venue_slug))
      and v.owner_id = auth.uid()
  ) then
    raise exception 'Not authorized to view these Open Play transactions';
  end if;

  return query
  select r.id, r.registration_reference, r.event_title, r.event_date,
         r.event_time, r.player_name, r.player_email, r.player_phone,
         r.fee, r.payment_status, r.registration_status,
         r.receipt_path, r.created_at
  from public.open_play_registrations r
  join public.venues v
    on v.id = r.venue_id
    or (r.venue_id is null and lower(trim(v.slug)) = lower(trim(r.venue_slug)))
  where v.owner_id = auth.uid()
    and lower(trim(v.slug)) = lower(trim(p_venue_slug))
  order by r.created_at desc;
end;
$$;

revoke all on function public.get_owner_open_play_transactions(text) from public;
grant execute on function public.get_owner_open_play_transactions(text) to authenticated;

-- 5) Payment review: authorize through venue_id (with safe slug fallback for
--    legacy rows), and only transition awaiting_verification records.
create or replace function public.review_open_play_payment(
  p_registration_id uuid,
  p_decision text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Please sign in with the venue owner account';
  end if;
  if p_decision not in ('confirmed', 'rejected') then
    raise exception 'Invalid payment decision';
  end if;

  update public.open_play_registrations r
  set payment_status = p_decision,
      registration_status = case
        when p_decision = 'confirmed' then 'confirmed'
        else 'reserved'
      end
  where r.id = p_registration_id
    and r.payment_status = 'awaiting_verification'
    and exists (
      select 1 from public.venues v
      where v.owner_id = auth.uid()
        and (v.id = r.venue_id or (r.venue_id is null and lower(trim(v.slug)) = lower(trim(r.venue_slug))))
    );

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'This registration is not awaiting verification or does not belong to your venue';
  end if;

  return jsonb_build_object(
    'success', true,
    'payment_status', p_decision,
    'registration_id', p_registration_id
  );
end;
$$;

revoke all on function public.review_open_play_payment(uuid, text) from public;
grant execute on function public.review_open_play_payment(uuid, text) to authenticated;

-- 6) Diagnostic result: unmatched historical records are intentionally not
--    exposed in the owner portal. Use this query as an admin to identify them:
-- select r.registration_reference, r.venue_slug, r.created_at
-- from public.open_play_registrations r
-- left join public.venues v on lower(trim(v.slug)) = lower(trim(r.venue_slug))
-- where v.id is null
-- order by r.created_at desc;
