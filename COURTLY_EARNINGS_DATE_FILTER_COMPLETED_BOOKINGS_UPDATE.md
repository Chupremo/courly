# Courtly Owner Portal — Earnings Filters and Completed Bookings

## Included
- Earnings filters on Overview and Earnings: 7 Days (default), 30 Days, 1 Year.
- The 7 Days option is always visible and is selected on each fresh page load.
- Court rental booking count, gross, Courtly transaction fees, and owner net update with the selected period.
- Confirmed bookings whose scheduled end time has passed are displayed as **Completed** and remain included in earnings.
- Already-completed bookings are also included. Pending and cancelled bookings are excluded.
- Open Play transaction payment statuses use green for Confirmed, yellow for Awaiting verification, and red for Rejected.

## Date calculation
The period is based on the booking date in the venue's browser-local timezone:
- 7 Days: today and the previous 6 calendar days.
- 30 Days: today and the previous 29 calendar days.
- 1 Year: from the same calendar date one year ago through today.

## Important current-project limitation
The supplied project version still contains the local-browser demo reservation model in `owner-portal.html`. These changes filter and display the booking records currently present in that model. They do not migrate demo reservations into Supabase or connect the Court Rental ledger to a production bookings table. The separate Open Play registration sync continues to use the Supabase RPCs already present in this project.

Before treating Court Rental Earnings as production accounting, connect the owner dashboard's booking source to the authenticated owner's Supabase bookings and verify the booking status, start/end timestamps, amount, and venue ownership server-side.
