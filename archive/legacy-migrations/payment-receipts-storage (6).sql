-- Courtly payment receipt storage (private bucket, maximum 100 MiB per receipt).
-- Run this in Supabase SQL Editor after confirming your public.venues table exists.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'courtly-payment-receipts',
  'courtly-payment-receipts',
  false,
  104857600,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 104857600,
  allowed_mime_types = excluded.allowed_mime_types;

-- Customers may upload a receipt into a folder named with the venue slug.
drop policy if exists "Customers can upload Courtly payment receipts" on storage.objects;
create policy "Customers can upload Courtly payment receipts"
on storage.objects for insert to anon, authenticated
with check (bucket_id = 'courtly-payment-receipts');

-- Only the authenticated owner of the matching venue may read its receipts.
drop policy if exists "Venue owners can view their Courtly payment receipts" on storage.objects;
create policy "Venue owners can view their Courtly payment receipts"
on storage.objects for select to authenticated
using (
  bucket_id = 'courtly-payment-receipts'
  and exists (
    select 1 from public.venues v
    where v.slug = (storage.foldername(name))[1]
      and v.owner_id = auth.uid()
  )
);
