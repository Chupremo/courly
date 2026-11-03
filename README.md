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


### Booking date and time behavior
The public venue booking calendar initializes from the visitor browser current date/time, disables past calendar dates, disables hourly slots that have already started on the current day, allows remaining same-day slots, and refreshes the time availability display every 30 seconds. For production-grade live availability and double-booking prevention across devices, connect the booking flow to Supabase/server-side checks.
