-- COURTLY OWNER REGISTRATION
-- Run this in Supabase SQL Editor AFTER the existing supabase/schema.sql.
-- A new Auth user automatically receives one venue and starter court records.

create or replace function public.courtly_make_slug(input_name text)
returns text
language sql
immutable
as $$
  select coalesce(nullif(trim(both '-' from regexp_replace(lower(coalesce(input_name,'')), '[^a-z0-9]+', '-', 'g')), ''), 'my-venue');
$$;

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
  business_name := coalesce(nullif(trim(new.raw_user_meta_data->>'business_name'), ''), 'My Courtly Venue');
  business_address := nullif(trim(new.raw_user_meta_data->>'business_address'), '');
  venue_sport := coalesce(nullif(trim(new.raw_user_meta_data->>'sport'), ''), 'Multi-sport');
  requested_count := coalesce(new.raw_user_meta_data->>'court_count', '1');
  court_total := case
    when requested_count = '4–5' or requested_count = '4-5' then 4
    when requested_count = '6–10' or requested_count = '6-10' then 6
    when requested_count = '11+' then 11
    else greatest(1, least(50, coalesce(nullif(regexp_replace(requested_count, '[^0-9]', '', 'g'), '')::integer, 1)))
  end;

  -- Avoid duplicate public URLs while keeping the business-name slug readable.
  base_slug := public.courtly_make_slug(business_name);
  candidate_slug := base_slug;
  while exists (select 1 from public.venues where slug = candidate_slug) loop
    candidate_slug := base_slug || '-' || suffix::text;
    suffix := suffix + 1;
  end loop;

  insert into public.venues(owner_id, slug, name, address, admin_email)
  values (new.id, candidate_slug, business_name, business_address, new.email)
  returning id into new_venue_id;

  for i in 1..court_total loop
    insert into public.courts(venue_id, name, sport, hourly_rate, is_active)
    values (new_venue_id, 'Court ' || i, venue_sport, 350, true)
    on conflict (venue_id, name) do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists courtly_create_venue_after_signup on auth.users;
create trigger courtly_create_venue_after_signup
after insert on auth.users
for each row execute function public.courtly_create_owner_venue();

-- Explicit owner read/update policies. Trigger creates the venue securely;
-- owners cannot create arbitrary venues for other users from the browser.
drop policy if exists "Owners can view own venues" on public.venues;
create policy "Owners can view own venues" on public.venues
for select to authenticated using (owner_id = auth.uid());

drop policy if exists "Owners can update own venues" on public.venues;
create policy "Owners can update own venues" on public.venues
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
