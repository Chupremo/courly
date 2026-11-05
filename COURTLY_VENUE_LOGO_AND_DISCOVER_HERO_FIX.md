# Courtly venue logo and Discover hero contrast fix

## Changes

- On the public venue booking page, the venue owner logo (`venues.logo_url`) now appears in the venue hero in place of the venue name when a logo is available.
- The logo is displayed on a contained white surface so light and dark venue logos remain visible against the navy hero.
- If no logo is configured or the image fails to load, the venue name remains as a safe fallback.
- The logo re-renders when the public page refreshes venue media.
- The `players.html` Discover hero now has a page-specific `discover-hero` class and explicit white heading/body text with a lime eyebrow, overriding the generic global hero text color.

## Files changed

- `venue.html`
- `players.html`
- `courtly-brand.css`

## Deploy

Replace these three files in the existing repository and deploy. No database migration is required. The venue owner must have a valid `logo_url` saved on their venue record for the logo to appear.
