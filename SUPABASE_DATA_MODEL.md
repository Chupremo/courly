# Courtly Supabase data model

This describes the shared database used by the updated Courtly app.

## Core relationships

```text
Supabase Auth user
  └── venues (one owner can have a venue)
        ├── courts
        │     ├── bookings
        │     └── court_blocks
        ├── open_play_events
        │     └── open_play_registrations
        └── venue/court media in Supabase Storage

Court payment receipts and Open Play receipts
  └── private courtly-payment-receipts Storage bucket
```

## Tables and responsibility

| Table | Purpose | Who can access it |
|---|---|---|
| `venues` | Venue profile, owner, business hours, payment details and peak window | Public can read permitted fields for published venues; owner can manage their own venue |
| `courts` | Court names, sport, hourly prices, images and active status | Public can read active court fields; owner can manage own courts |
| `bookings` | Court reservations, customer data, calculated totals, payment and review status | Owner can read their venue's records; public uses guarded RPCs and random access tokens |
| `court_blocks` | Maintenance or unavailable times | Only the matching venue owner |
| `open_play_events` | Venue-owned open-play announcements | Public can read future published events at published venues; owner can manage own events |
| `open_play_registrations` | Player details, event snapshot, receipt path and payment status | No direct browser table access; owner-facing RPCs return only their venue's records |

## Pricing and payment rules

Court rate is stored on each court as `off_peak_rate` and `peak_rate`. The venue stores an optional `peak_hours_start` / `peak_hours_end` window. When both are blank, off-peak pricing applies all day. The booking RPC calculates each booked hour from these database values; the amount sent by the browser is not trusted.

Courtly's fee is PHP 10 per booked court-hour and PHP 10 per confirmed Open Play registration. It is recorded separately and deducted from the owner's payout calculation. It is not added to the player's payment total. This is a reporting/deduction rule in the app; actual money settlement is not automated by this database.

## Security model

- Supabase Auth identifies the owner.
- Row Level Security ties venue, court, booking, calendar block and event management to `auth.uid()`.
- Anonymous users do not get direct access to booking or Open Play registration customer data.
- Public booking and event registration use narrowly scoped RPC functions that validate current database values.
- Booking confirmation and history lookups require a random per-booking access token, not just an email address.
- Payment receipts are stored privately and signed URLs are generated only after the owner is authorized for that record.
- The browser only receives the Supabase publishable/anon key. The service-role key must remain server-side and is not needed by this frontend.
