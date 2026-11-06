-- Courtly payment receipts: run this migration in Supabase SQL Editor.
create sequence if not exists public.courtly_receipt_number_seq start 1;

create table if not exists public.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  source_type text not null check (source_type in ('court_booking','coaching_booking')),
  source_id uuid not null,
  player_id uuid not null references auth.users(id) on delete restrict,
  player_email text not null,
  player_name text not null default '',
  description text not null,
  reference text not null,
  amount numeric(12,2) not null check (amount >= 0),
  payment_method text,
  paid_at timestamptz not null default now(),
  email_status text not null default 'pending' check (email_status in ('pending','processing','sent','failed')),
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now(),
  unique(source_type, source_id)
);

create or replace function public.courtly_next_receipt_number()
returns text language sql volatile security definer set search_path=public as $$
  select 'CR-' || to_char(now() at time zone 'Asia/Manila','YYYYMMDD') || '-' || lpad(nextval('public.courtly_receipt_number_seq')::text,6,'0');
$$;

alter table public.payment_receipts enable row level security;
drop policy if exists "Players can view their own payment receipts" on public.payment_receipts;
create policy "Players can view their own payment receipts"
  on public.payment_receipts for select to authenticated
  using (player_id = auth.uid());

revoke all on public.payment_receipts from anon, authenticated;
grant select on public.payment_receipts to authenticated;
grant usage, select on sequence public.courtly_receipt_number_seq to service_role;

comment on table public.payment_receipts is 'Immutable player-facing receipts created only after court owner or coach confirms payment.';
