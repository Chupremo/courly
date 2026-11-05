# Courtly transparent venue logo update

## What changes
- Venue logo upload now accepts PNG only and requires detectable alpha transparency.
- PNG compression preserves transparency instead of converting logos to JPEG.
- Venue logos are limited to 10 MB.
- The public venue hero renders the logo directly on the navy background without a white card, padding, border, or box shadow.
- The owner bridge keeps the owner-ownership pre-check and gives a clear error if a non-PNG logo reaches storage.

## Files to replace in the root of the existing GitHub repository
1. `owner-portal.html`
2. `owner-portal-bridge.js`
3. `venue.html`

Commit to `main` and wait for Vercel to deploy. No SQL migration is required.

## Important for existing logos
The website cannot reliably remove the background from an already-uploaded JPG or opaque PNG. After deploying, open Owner Portal → Venue Profile and upload a PNG whose background has already been removed (transparent checkerboard shown in an image editor before export). The upload form checks the PNG alpha channel and rejects an opaque file.

Recommended logo file: transparent PNG, landscape orientation, 10 MB or less, with modest clear space around the artwork.

## Verification
1. Upload a transparent PNG in Venue Profile.
2. Confirm the owner portal reports it saved successfully.
3. Open the public venue URL. The logo should sit directly on the navy hero with no white tile behind it.
4. In Supabase, confirm `venues.logo_url` points to a `.png` asset in `courtly-venue-media`.

No existing booking, payment, pricing, or database logic is intentionally changed by this patch.
