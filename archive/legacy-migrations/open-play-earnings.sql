-- Open Play earnings summary for the authenticated venue owner.
-- Run after open-play-registrations.sql and owner-registration.sql.
-- Only aggregate totals are returned; player personal details are never exposed.
create or replace function public.get_owner_open_play_earnings(p_venue_slug text)
returns table(
  registration_count bigint,
  paid_count bigint,
  awaiting_count bigint,
  confirmed_revenue numeric
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
    raise exception 'Not authorized to view Open Play earnings';
  end if;

  return query
  select
    count(*) filter (where r.registration_status <> 'cancelled')::bigint,
    count(*) filter (where r.registration_status <> 'cancelled' and r.payment_status = 'confirmed')::bigint,
    count(*) filter (where r.registration_status <> 'cancelled' and r.payment_status = 'awaiting_verification')::bigint,
    coalesce(sum(r.fee) filter (where r.registration_status <> 'cancelled' and r.payment_status = 'confirmed'), 0)::numeric
  from public.open_play_registrations r
  where r.venue_slug = p_venue_slug;
end;
$$;
revoke all on function public.get_owner_open_play_earnings(text) from public;
grant execute on function public.get_owner_open_play_earnings(text) to authenticated;
