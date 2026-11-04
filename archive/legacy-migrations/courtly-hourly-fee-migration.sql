-- Courtly platform fee policy: ₱10 per booked court-hour for every booking.
-- Run once in Supabase SQL Editor after deploying the matching application files.
begin;

alter table public.bookings
  alter column platform_fee set default 0;

update public.bookings
set platform_fee = duration_hours * 10,
    total = subtotal + (duration_hours * 10)
where platform_fee is distinct from (duration_hours * 10)
   or total is distinct from (subtotal + (duration_hours * 10));

comment on column public.bookings.platform_fee is
  'Courtly transaction fee: PHP 10 per booked court-hour, across all booking types.';

commit;
