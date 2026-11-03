-- Courtly Open Play owner transaction review.
-- Run ONCE in Supabase SQL Editor. Safe to re-run (CREATE OR REPLACE).
-- Requires public.open_play_registrations and public.venues.owner_id.

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
    where v.slug = p_venue_slug and v.owner_id = auth.uid()
  ) then
    raise exception 'Not authorized to view these Open Play transactions';
  end if;

  return query
  select r.id, r.registration_reference, r.event_title, r.event_date,
         r.event_time, r.player_name, r.player_email, r.player_phone,
         r.fee, r.payment_status, r.registration_status,
         r.receipt_path, r.created_at
  from public.open_play_registrations r
  where r.venue_slug = p_venue_slug
  order by r.created_at desc;
end;
$$;

create or replace function public.review_open_play_payment(
  p_registration_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Please sign in with the venue owner account';
  end if;
  if p_decision not in ('confirmed', 'rejected') then
    raise exception 'Invalid payment decision';
  end if;

  select r.venue_slug into v_slug
  from public.open_play_registrations r
  where r.id = p_registration_id;

  if v_slug is null or not exists (
    select 1 from public.venues v
    where v.slug = v_slug and v.owner_id = auth.uid()
  ) then
    raise exception 'Not authorized to review this registration';
  end if;

  update public.open_play_registrations r
  set payment_status = p_decision,
      registration_status = case
        when p_decision = 'confirmed' then 'confirmed'
        else 'reserved'
      end
  where r.id = p_registration_id
    and r.payment_status = 'awaiting_verification';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'This registration is no longer awaiting verification';
  end if;

  return jsonb_build_object(
    'success', true,
    'payment_status', p_decision,
    'registration_id', p_registration_id
  );
end;
$$;

revoke all on function public.get_owner_open_play_transactions(text) from public;
revoke all on function public.review_open_play_payment(uuid, text) from public;
grant execute on function public.get_owner_open_play_transactions(text) to authenticated;
grant execute on function public.review_open_play_payment(uuid, text) to authenticated;
