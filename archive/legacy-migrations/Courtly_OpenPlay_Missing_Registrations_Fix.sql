-- Courtly: Open Play sign-ups not appearing in the owner portal.
-- Run this whole file once in Supabase SQL Editor (safe to re-run).
--
-- CAUSES THIS FILE FIXES
-- 1) Booking references (CT-001, CT-002...) were counted per browser, but the database requires
--    every reference to be unique. A second player on another device generating the same number
--    was rejected (or their receipt could not be uploaded), so no registration reached the owner.
--    -> The website now adds a random token (CT-003-K7Q2) and the database also de-duplicates.
-- 2) Registrations saved under a slug that is not the owner's real venue slug are invisible to
--    the owner. -> Diagnose/recover them in sections 4 and 5 below.
-- 3) The owner list only looked at one venue. -> It now lists every venue the owner has.

-- 0) Make sure registrations are tied to a venue ID.
alter table public.open_play_registrations add column if not exists venue_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'open_play_registrations_venue_id_fkey'
                   and conrelid = 'public.open_play_registrations'::regclass) then
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

-- 1) Registration function: same checks as before, but a reference that already exists gets a
--    short suffix instead of failing the whole sign-up. The final reference is returned.
create or replace function public.register_open_play_player(
  p_event_id text, p_event_title text, p_venue_slug text, p_venue_name text,
  p_event_date date, p_event_time text, p_location_text text,
  p_registration_limit integer, p_fee numeric, p_player_name text,
  p_player_email text, p_player_phone text, p_receipt_path text,
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
  v_ref text;
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

  v_ref := nullif(trim(coalesce(p_registration_reference, '')), '');
  if v_ref is null then
    raise exception 'A booking reference is required';
  end if;
  while exists (select 1 from public.open_play_registrations x where x.registration_reference = v_ref) loop
    v_ref := trim(p_registration_reference) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4));
  end loop;

  perform pg_advisory_xact_lock(hashtext(v_venue_id::text || ':' || coalesce(p_event_id, '')));

  select count(*)::integer into v_count
  from public.open_play_registrations r
  where r.venue_id = v_venue_id
    and r.event_id = p_event_id
    and r.registration_status <> 'cancelled';

  if p_registration_limit is not null and v_count >= p_registration_limit then
    raise exception 'This Open Play session is fully booked';
  end if;

  insert into public.open_play_registrations(
    venue_id, registration_reference, event_id, event_title, venue_slug, venue_name,
    event_date, event_time, location_text, player_name, player_email, player_phone, fee, receipt_path
  ) values (
    v_venue_id, v_ref, p_event_id,
    coalesce(nullif(trim(p_event_title), ''), 'Open Play session'),
    v_venue_slug, v_venue_name, p_event_date, coalesce(p_event_time, ''),
    coalesce(p_location_text, ''), trim(p_player_name), trim(p_player_email),
    nullif(trim(coalesce(p_player_phone, '')), ''), greatest(coalesce(p_fee, 0), 0), p_receipt_path
  ) returning id into v_id;

  v_count := v_count + 1;
  return jsonb_build_object(
    'success', true, 'id', v_id, 'registration_reference', v_ref,
    'venue_id', v_venue_id, 'venue_slug', v_venue_slug,
    'registered_count', v_count,
    'remaining', greatest(coalesce(p_registration_limit, v_count) - v_count, 0),
    'status', 'reserved', 'payment_status', 'awaiting_verification'
  );
end;
$$;

revoke all on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) from public;
grant execute on function public.register_open_play_player(text,text,text,text,date,text,text,integer,numeric,text,text,text,text,text) to anon, authenticated;

-- 2) Owner list for ALL venues owned by the signed-in owner (no slug needed).
create or replace function public.get_owner_open_play_transactions()
returns table(
  id uuid, registration_reference text, event_title text, event_date date, event_time text,
  player_name text, player_email text, player_phone text, fee numeric,
  payment_status text, registration_status text, receipt_path text, created_at timestamptz
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
  select r.id, r.registration_reference, r.event_title, r.event_date, r.event_time,
         r.player_name, r.player_email, r.player_phone, r.fee,
         r.payment_status, r.registration_status, r.receipt_path, r.created_at
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

-- 3) Payment review (Verify payment / Reject) authorised through the venue link.
create or replace function public.review_open_play_payment(p_registration_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_updated integer;
begin
  if auth.uid() is null then raise exception 'Please sign in with the venue owner account'; end if;
  if p_decision not in ('confirmed', 'rejected') then raise exception 'Invalid payment decision'; end if;

  update public.open_play_registrations r
  set payment_status = p_decision,
      registration_status = case when p_decision = 'confirmed' then 'confirmed' else 'reserved' end
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
  return jsonb_build_object('success', true, 'payment_status', p_decision, 'registration_id', p_registration_id);
end;
$$;

revoke all on function public.review_open_play_payment(uuid, text) from public;
grant execute on function public.review_open_play_payment(uuid, text) to authenticated;

-- 4) DIAGNOSE: the 15 newest sign-ups and whether the owner portal can see them.
--    "HIDDEN" rows were saved under a slug that is not any owner's venue slug.
select r.created_at, r.registration_reference, r.player_name, r.player_email,
       r.venue_slug as saved_under_slug, r.venue_id, v.owner_id,
       case when v.id is null then 'HIDDEN - slug matches no venue'
            when v.owner_id is null then 'HIDDEN - venue has no owner'
            else 'visible to owner' end as owner_portal_status
from public.open_play_registrations r
left join public.venues v on v.id = r.venue_id
     or (r.venue_id is null and lower(trim(v.slug)) = lower(trim(r.venue_slug)))
order by r.created_at desc
limit 15;

-- 5) RECOVER a hidden sign-up: move it to your real venue.
--    Replace the two placeholders (the reference from section 4, and your real venue slug).
--    NOTE: the receipt image stays in its original storage folder and may not open from the
--    portal; if the owner cannot open it, ask the player to resend the receipt.
-- update public.open_play_registrations r
-- set venue_id = v.id, venue_slug = v.slug, venue_name = v.name
-- from public.venues v
-- where r.registration_reference = 'REPLACE_WITH_REFERENCE'
--   and lower(v.slug) = lower('REPLACE_WITH_YOUR_VENUE_SLUG')
--   and v.owner_id is not null;
