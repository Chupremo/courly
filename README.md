# Courtly — Vercel + Supabase starter

This project is a Vite multi-page Courtly website prepared for Vercel. HTML pages are at the repository root so the file layout matches the GitHub upload workflow.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

Vercel configuration is in `vercel.json`. The route `/v/:slug` rewrites to `venue.html?slug=:slug`; `venue.html` currently demonstrates the public venue page with a sample `picklepaul` profile.

The included `supabase/schema.sql` is a database schema starter. The current frontend does not yet read/write shared Supabase data, and booking/payment flows are not production-ready. Do not accept real bookings or payments until authentication, shared database reads/writes, booking conflict checks, payment verification, and notification handling are implemented and tested.
