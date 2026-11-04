# Courtly court image synchronization fix

## What was corrected

- Court image uploads now wait for the image compression, Supabase Storage upload, and `courts.image_url` database write to finish before showing a success message.
- Failed image uploads restore the previous image in the owner portal and show the actual Supabase error.
- The bridge verifies that Supabase returns the expected court image URL after the court upsert.
- The public venue booking page now builds its gallery from the venue cover and uploaded court photos instead of fixed stock-photo thumbnails.
- The booking page refreshes venue/court media when the tab regains focus, when it becomes visible, and every 60 seconds.
- The public venue directory now uses the venue cover or first available court image in each listing card.

## Database changes

No new SQL migration is required for this UI/source fix. The existing `courtly-venue-media` bucket and owner/public access policies from `supabase/001_complete_supabase_backend.sql` are used.

## Deployment

1. Deploy the updated source files from this package to the same Vercel project.
2. Keep the existing Vercel environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. After deployment, sign in to the owner portal and upload one court image again. Wait for the success message.
4. Open the public venue link and hard-refresh it (`Ctrl+Shift+R` on Windows). Returning to an already-open booking tab also triggers a media refresh; it additionally checks for changes every 60 seconds.

## Optional database diagnostic

Run this in Supabase SQL Editor to check whether each court image URL is saved:

```sql
select
  v.name as venue_name,
  v.slug,
  c.name as court_name,
  c.image_url,
  c.image_fit,
  c.is_active,
  c.updated_at
from public.venues v
join public.courts c on c.venue_id = v.id
order by v.name, c.display_order, c.name;
```

If `image_url` is null, the owner upload did not complete its database write. If `image_url` contains a Supabase public storage URL, the database link is saved and the issue is on the deployed/public page or browser cache.
