-- Courtly Open Play registrations: separate records from court bookings.
-- Run this file in Supabase SQL Editor before deploying the Open Play checkout update.
create table if not exists public.open_play_registrations (
  id uuid primary key default gen_random_uuid(),
  registration_reference text not null unique,
  event_id text not null,
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
  receipt_path text not null,
  payment_status text not null default 'awaiting_verification' check (payment_status in ('awaiting_verification','confirmed','rejected')),
  registration_status text not null default 'reserved' check (registration_status in ('reserved','confirmed','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists open_play_registrations_event_idx on public.open_play_registrations(event_id, created_at);
create index if not exists open_play_registrations_venue_idx on public.open_play_registrations(venue_slug, event_date);
alter table public.open_play_registrations enable row level security;
revoke all on public.open_play_registrations from anon, authenticated;

-- Public checkout can register a player, but cannot directly read or modify registration records.
create or replace function public.register_open_play_player(
  p_event_id text, p_event_title text, p_venue_slug text, p_venue_name text,
  p_event_date date, p_event_time text, p_location_text text,
  p_registration_limit integer, p_fee numeric, p_player_name text,
  p_player_email text, p_player_phone text, p_receipt_path text,
  p_registration_reference text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_count integer; v_id uuid;
begin
  if coalesce(trim(p_player_name),'') = '' or coalesce(trim(p_player_email),'') = '' or coalesce(trim(p_receipt_path),'') = '' then
    raise exception 'Name, email and payment receipt are required';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_event_id));
  select count(*) into v_count from public.open_play_registrations
   where event_id = p_event_id and registration_status <> 'cancelled';
  if p_registration_limit is not null and v_count >= p_registration_limit then
    raise exception 'This Open Play session is fully booked';
  end if;
  insert into public.open_play_registrations(
    registration_reference,event_id,event_title,venue_slug,venue_name,event_date,event_time,location_text,
    player_name,player_email,player_phone,fee,receipt_path
  ) values (
    p_registration_reference,p_event_id,p_event_title,p_venue_slug,p_venue_name,p_event_date,p_event_time,p_location_text,
    p_player_name,p_player_email,p_player_phone,coalesce(p_fee,0),p_receipt_path
  ) returning id into v_id;
  v_count := v_count + 1;
  return jsonb_build_object('id',v_id,'registration_reference',p_registration_reference,'registered_count',v_count,'remaining',greatest(coalesce(p_registration_limit,v_count)-v_count,0),'status','reserved','payment_status','awaiting_verification');
end;
$$;
revoke all on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) from public;
grant execute on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) to anon, authenticated;

-- Returns counts only (never player names, emails, phones or receipt paths).
create or replace function public.get_open_play_registration_counts(p_event_ids text[])
returns table(event_id text, registered_count bigint)
language sql security definer set search_path = public
as $$
  select r.event_id, count(*)::bigint
  from public.open_play_registrations r
  where r.event_id = any(coalesce(p_event_ids, array[]::text[]))
    and r.registration_status <> 'cancelled'
  group by r.event_id;
$$;
revoke all on function public.get_open_play_registration_counts(text[]) from public;
grant execute on function public.get_open_play_registration_counts(text[]) to anon, authenticated;
