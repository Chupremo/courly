# Courtly — Vercel + Supabase starter

This package prepares the existing Courtly prototype as a multi-page Vite site for Vercel and includes a Supabase database schema starter.

## Included
- Home / booking demo (`/`)
- Features (`/features`)
- Pricing (`/pricing`)
- For Clubs (`/clubs`)
- Find a Court (`/courts`)
- Vercel configuration and Vite multi-page build
- Supabase SQL schema for venues, courts, and bookings

## Important status
The current HTML app still uses browser `localStorage` for booking/configuration state and its QR payment is a simulation. This starter does **not** yet switch those operations to Supabase. The SQL schema is a safe foundation, not proof that live bookings, owner logins, email, or payments are already integrated. Do not accept real bookings until the app's data layer, owner authentication, RLS policies, and payment verification are connected and tested.

## 1. Run locally
Install Node.js LTS, unzip the project, open a terminal in this folder, then run:

```bash
npm install
npm run dev
```

Open the local URL Vite prints.

## 2. Create the Supabase project
1. Create a project at https://supabase.com/dashboard.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql`.
4. Keep the database password safe. It is not needed in the browser.
5. Under Project Settings → API, copy the Project URL and publishable/anon key.

## 3. Deploy to Vercel
1. Upload this folder to a new GitHub repository.
2. In https://vercel.com/new, import that repository.
3. Framework preset: **Vite**.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Deploy.

## 4. Configure Vercel environment variables
In Vercel → Project → Settings → Environment Variables, add:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Redeploy after adding variables.

The variables are included as placeholders for the next integration step; the current prototype does not yet read them.

## 5. Production work still required
- Replace `localStorage` persistence with Supabase queries/RPCs.
- Add Supabase Auth for owners and enforce venue ownership in RLS.
- Add a public-safe availability query and server-side booking conflict checks.
- Connect a real payment provider; only verified provider webhooks should mark bookings paid/confirmed.
- Send booking emails from a trusted server/Edge Function (never expose email service secrets in browser code).
- Test multiple venues/owners, time-zone rules, concurrent bookings, and cancellation/refund paths.

## Deploy tip
Keep the `public` folder and `supabase` folder in the repository. Never put a Supabase `service_role` key in frontend code or Vercel client-side variables.


## Owner portal demo and multi-hour bookings

Open `/owner-portal` to explore the standalone Courtly Owner Portal. Public booking supports selecting 1–8 consecutive hours. Availability checks the entire requested range, and the owner calendar marks each occupied hour of a multi-hour reservation. This remains demo/local-browser behavior until shared Supabase persistence and server-side booking validation are connected.
