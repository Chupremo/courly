# Vercel build hotfix — November 5, 2026

## Cause

Vite failed to parse `player-login.html` because its `<title>` element was malformed:

```html
<title>Player Login | Courtly">
```

The element was not closed. HTML parsing therefore continued in the title's text-only (RCDATA) context until end-of-file, producing `eof-in-element-that-can-contain-only-text`.

## Fix applied

The title now reads:

```html
<title>Player Login | Courtly</title>
```

No database migration or Supabase setting changes are required for this HTML parsing fix.

## Deploy

Replace the repository's `player-login.html` with the corrected file from this package, or make the one-line edit above directly in GitHub. Commit to the deployed branch and let Vercel rebuild.

The `npm warn Unknown env config "cache-dir"` and `esbuild install-scripts` messages in the supplied log are warnings, not the cause of this failed build. The fatal error is the malformed title tag.

## Verification note

The corrected HTML file was inspected and its title element is now closed correctly. A fresh Vite production build could not be run in this environment because dependency installation from the npm registry timed out; Vercel must confirm the new deployment build.
