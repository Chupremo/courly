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


## Owner registration and login prototype

The homepage owner registration now collects a password, creates a browser-local demo account, and redirects to `owner-portal.html`. Returning owners can use `login.html` to return to their portal. This is only a front-end prototype: credentials and account details are stored in localStorage and are not secure or shared across devices. Before public production use, replace this demo flow with Supabase Auth, server-side profile creation, and row-level security. Never use real/reused passwords in the prototype.

## Real owner registration (Supabase)

1. In Supabase SQL Editor, run `supabase/owner-registration.sql` after the existing `supabase/schema.sql`.
2. In Supabase Authentication settings, configure your site URL as `https://courtly-ecru.vercel.app` and add the same domain plus your Vercel preview domains to Redirect URLs.
3. Add Vercel environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (use the publishable/anon key only; never expose the service-role key).
4. Redeploy on Vercel so Vite can bundle the environment variables.
5. Owners register from the homepage. Supabase Auth creates the account; a database trigger automatically creates the venue and starter courts. The booking URL is `/v/<business-name-slug>`. If the slug is taken, a numeric suffix is added.
6. If Supabase email confirmation is enabled, the owner must confirm their email before signing in. Venue creation and slug reservation still happen automatically at signup. If you want immediate login without email confirmation, disable Confirm email in Supabase Auth settings (not recommended for public production signups).

The registration captures extra contact/social details in Supabase Auth user metadata. Venue and court records are stored in the existing database schema. Starter court rates default to ₱350/hour and can be edited in the owner portal.
