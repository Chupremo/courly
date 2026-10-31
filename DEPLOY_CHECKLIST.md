# Courtly deployment checklist

## Upload the project
1. Extract this ZIP.
2. Upload the **contents** of this folder to the root of the `Chupremo/courly` GitHub repository.
3. Preserve the `supabase/` folder and all project files.
4. Commit and push the changes.

## Vercel build settings
- Framework: Vite
- Root directory: `./`
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

## Routes
- `/`
- `/features`
- `/pricing`
- `/clubs`
- `/courts`
- `/owner-portal`
- `/v/picklepaul` (demo venue page)

## Important limitations
The `/v/:slug` page is a route/layout demo. It currently uses a local demo profile for `picklepaul`; it does not fetch shared Supabase venue records or create bookings. QR payment, verified payment webhooks, email notifications, authentication, and production-safe booking conflict checks still need to be implemented before taking real bookings or charging fees.
