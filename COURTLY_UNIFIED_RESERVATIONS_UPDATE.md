# Courtly Unified Reservations Update

- The owner portal keeps a single **Reservations** navigation page for both court rentals and Open Play registrations.
- Each row has a clear **Court Rental** or **Open Play** type label.
- Open Play registrations are loaded into the same reservation table as court bookings.
- Pending Open Play payments can be confirmed or rejected from the unified table; demo actions remain local to the demo venue, while real owner actions call the venue-scoped Supabase review RPC.
- The Open Play events navigation remains separate because it manages event announcements, not reservations.
- Reservation filters include Pending, Confirmed, Cancelled, Awaiting verification, and Rejected.
