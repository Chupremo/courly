# Courtly owner portal — court image upload RLS fix

This update addresses both protected writes involved in a court image change:

1. Uploading the compressed image to `storage.objects` in the public `courtly-venue-media` bucket.
2. Upserting the matching row in `public.courts` with `image_url` and `image_fit`.

The existing uploader stores files at `courtly-venue-media/<venue UUID>/<file name>`. The migration uses a narrowly scoped `SECURITY DEFINER` ownership helper and keeps RLS enabled. It does not grant anonymous write access or service-role access to the browser.

## Apply the SQL

1. Back up the Supabase database.
2. Open Supabase → SQL Editor → New query.
3. Open `supabase/migrations/004_owner_court_image_rls_fix.sql` from this project and run the complete script.
4. Confirm it completes and inspect the returned policy rows. `venues` and `courts` should both show `rls_enabled = true`.

## Deploy the owner portal changes

Commit the updated `owner-portal-bridge.js` and migration to GitHub `main`. Vercel should deploy automatically. No environment variables or bucket changes are required.

## Test one court image

1. Sign out of the owner portal and sign back in using the actual venue-owner account.
2. Open Owner Portal → Courts & Rates → Court photos.
3. Upload one small JPG or PNG first.
4. Wait for the success message.
5. Run this SQL:

```sql
select v.name as venue, v.id as venue_id, v.owner_id,
       c.id as court_id, c.name as court, c.image_url, c.image_fit
from public.venues v
join public.courts c on c.venue_id = v.id
where v.slug = 'bonn-test'
order by c.display_order, c.name;
```

Replace `bonn-test` if your venue slug differs. A successful upload should have a non-null `image_url` for the selected court.

## How to read a remaining error

The revised bridge now labels the failing stage:

- `Storage upload denied...`: check the `storage.objects` insert policy and whether the folder segment is exactly the venue UUID.
- `Venue profile update was rejected...`: check the owner update policy on `public.venues`.
- `Court records could not be saved...`: Storage succeeded; check the INSERT/UPDATE policy on `public.courts`.
- `does not own venue...`: the signed-in user's `auth.uid()` does not match `venues.owner_id` for this venue. Do not bypass this check; link the correct owner account.

Do not disable RLS, make the bucket writable to `anon`, or put a service-role key in Vercel browser environment variables.
