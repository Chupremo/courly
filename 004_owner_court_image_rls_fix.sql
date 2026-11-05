-- Courtly owner court-image RLS fix
-- Run once in Supabase SQL Editor after confirming the owner account is signed in.
-- This keeps RLS enabled and restricts writes to the venue owned by auth.uid().

begin;

-- Evaluate ownership in a narrowly scoped SECURITY DEFINER function. This avoids
-- a storage.objects policy having to query public.venues under the caller's
-- column grants / RLS context.
create or replace function public.courtly_owns_venue(p_venue_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
  select auth.uid() is not null
     and exists (
       select 1
       from public.venues v
       where v.id::text = p_venue_id
         and v.owner_id = auth.uid()
     );
$$;

revoke all on function public.courtly_owns_venue(text) from public;
revoke all on function public.courtly_owns_venue(text) from anon;
grant execute on function public.courtly_owns_venue(text) to authenticated;

-- Owner profile read/update policies use the same ownership check.
drop policy if exists "Owners can view own venues" on public.venues;
create policy "Owners can view own venues"
on public.venues
for select to authenticated
using (public.courtly_owns_venue(id::text));

drop policy if exists "Owners can update own venues" on public.venues;
create policy "Owners can update own venues"
on public.venues
for update to authenticated
using (public.courtly_owns_venue(id::text))
with check (public.courtly_owns_venue(id::text));

-- Court upserts use onConflict (venue_id,name), so owners need both INSERT
-- and UPDATE policies, not only permission to upload the Storage object.
drop policy if exists "Owners can manage own courts" on public.courts;
drop policy if exists "Courtly owners manage their courts" on public.courts;
create policy "Courtly owners manage their courts"
on public.courts
for all to authenticated
using (public.courtly_owns_venue(venue_id::text))
with check (public.courtly_owns_venue(venue_id::text));

-- The owner portal writes images to:
--   courtly-venue-media/<venue UUID>/<file name>
-- This policy authorizes only the first path segment if it belongs to auth.uid().
drop policy if exists "Courtly owners upload venue media" on storage.objects;
drop policy if exists "Courtly owner upload venue media by venue id" on storage.objects;
create policy "Courtly owner upload venue media by venue id"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'courtly-venue-media'
  and public.courtly_owns_venue((storage.foldername(name))[1])
);

drop policy if exists "Courtly owners update venue media" on storage.objects;
drop policy if exists "Courtly owner update venue media by venue id" on storage.objects;
create policy "Courtly owner update venue media by venue id"
on storage.objects
for update to authenticated
using (
  bucket_id = 'courtly-venue-media'
  and public.courtly_owns_venue((storage.foldername(name))[1])
)
with check (
  bucket_id = 'courtly-venue-media'
  and public.courtly_owns_venue((storage.foldername(name))[1])
);

drop policy if exists "Courtly owners delete venue media" on storage.objects;
drop policy if exists "Courtly owner delete venue media by venue id" on storage.objects;
create policy "Courtly owner delete venue media by venue id"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'courtly-venue-media'
  and public.courtly_owns_venue((storage.foldername(name))[1])
);

commit;

-- Post-migration check: inspect the policy definitions and ensure RLS remains on.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  p.policyname,
  p.cmd,
  p.roles,
  p.qual,
  p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname in ('venues', 'courts')
order by c.relname, p.policyname;

select
  policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname ilike 'Courtly owner%venue media%'
order by policyname;
