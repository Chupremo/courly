# Courtly Unified Brand Pass — November 2026

This update applies the supplied navy/lime COURTLY wordmark throughout the desktop pages and aligns the visual system with the homepage.

## Brand system
- Primary navy: `#001A47`
- Lime accent: `#8ED502`
- Soft lime: `#F2FBDD`
- Background: `#F5F7FB`
- Body font: Inter, regular 400
- Heading font: Poppins, bold 700
- Non-heading UI/body labels are normalized to regular 400

## Files changed
- Added `public/assets/courtly-logo.png` (cropped transparent supplied logo)
- Added `courtly-brand.css` (shared brand, color and typography overrides)
- Linked the shared stylesheet across all HTML entry points
- Replaced platform wordmarks with the supplied logo in the homepage, owner portal, player portal, registration/login, venue directory, booking pages and product-page mockups
- Locked the owner portal sidebar and demo booking preview to the platform logo; venue-owned logos remain available in venue-specific settings/content

## Deploy
Replace the files in your existing `courly` GitHub repository with this package, commit to `main`, and let Vercel deploy. No Supabase migration or environment variable changes are required.

## Validation
Static checks confirmed that every HTML entry page links to `courtly-brand.css`, the shared logo asset exists, and the supplied brand references have been replaced. A remote Vercel deployment has not been performed from this workspace.
