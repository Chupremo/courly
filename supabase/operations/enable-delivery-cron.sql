-- OPERATOR STEP, not an automatically applied application migration.
-- Run only after the new API, notification migration and verified sender are
-- ready. No secret value belongs in this file or in a cron.job command.
--
-- Prerequisite: create a NEW Vault secret named courtly_delivery_cron_secret
-- containing the SAME randomly generated value as Vercel's CRON_SECRET.
-- Use the Dashboard secret input; do not commit/paste that value into this file.
-- Keep net and vault out of the exposed Data API schemas. Database LOGIN roles
-- must remain trusted: pg_net's queue is platform-readable to those roles.
-- Only a five-minute, path-bound HMAC enters pg_net; the actual secret does not.

begin;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron') then
    raise exception 'Enable Supabase pg_cron before scheduling delivery';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault must be available before scheduling delivery';
  end if;
  if to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null then
    raise exception 'This pg_net version does not support the expected HTTP GET contract';
  end if;
  if (public.courtly_notification_readiness()->>'ready')::boolean is not true then
    raise exception 'Apply and verify the notification delivery migration first';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name='courtly_delivery_cron_secret' and length(decrypted_secret)>=32) then
    raise exception 'Store the generated CRON_SECRET in Vault as courtly_delivery_cron_secret first';
  end if;
end $$;

create table if not exists public.courtly_delivery_cron_runs(
  request_id bigint primary key,
  kind text not null,
  health_check boolean not null,
  queued_at timestamptz not null default now()
);
alter table public.courtly_delivery_cron_runs enable row level security;
revoke all on public.courtly_delivery_cron_runs from public,anon,authenticated;
grant select on public.courtly_delivery_cron_runs to service_role;

create or replace function public.courtly_dispatch_delivery_cron(p_kind text,p_check boolean default true)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_secret text;
  v_path text;
  v_timestamp text := floor(extract(epoch from clock_timestamp()))::bigint::text;
  v_signature text;
  v_crypto_schema text;
  v_request_id bigint;
begin
  v_path := case p_kind when 'booking' then '/api/notifications/process'
    when 'billing' then '/api/cron/send-billing-emails' end;
  if v_path is null or p_check is null then raise exception 'Choose booking or billing and an explicit check mode'; end if;
  if p_check then v_path:=v_path||'?check=1'; end if;
  select decrypted_secret into strict v_secret from vault.decrypted_secrets where name='courtly_delivery_cron_secret';
  if length(v_secret)<32 or v_secret ~ E'[\\r\\n]' then raise exception 'Invalid delivery cron secret configuration'; end if;
  select n.nspname into strict v_crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select encode(%I.hmac($1::text,$2::text,''sha256''),''hex'')',v_crypto_schema)
    into v_signature using 'courtly-cron:'||v_timestamp||':'||v_path,v_secret;
  select net.http_get(
    url:='https://www.courtlyph.com'||v_path,
    headers:=jsonb_build_object('X-Courtly-Cron-Timestamp',v_timestamp,'X-Courtly-Cron-Signature',v_signature),
    timeout_milliseconds:=55000
  ) into v_request_id;
  insert into public.courtly_delivery_cron_runs(request_id,kind,health_check) values(v_request_id,p_kind,p_check);
  delete from public.courtly_delivery_cron_runs where queued_at<now()-interval '7 days';
  return v_request_id;
end $$;
revoke all on function public.courtly_dispatch_delivery_cron(text,boolean) from public,anon,authenticated,service_role;

-- Named upserts change only these two jobs. Existing invoice generation and
-- overdue-enforcement schedules are left in place.
select cron.schedule('courtly-notification-delivery','*/10 * * * *',
  $$select public.courtly_dispatch_delivery_cron('booking',false);$$);
select cron.schedule('courtly-billing-email-delivery','*/15 * * * *',
  $$select public.courtly_dispatch_delivery_cron('billing',false);$$);
commit;

-- Read-only monitoring. HTTP 200/202 is successful handling; inspect queue
-- counts too, because a handled run may still have retry/needs_review jobs.
select r.kind,r.health_check,r.queued_at,h.status_code,h.timed_out,h.error_msg,h.content
from public.courtly_delivery_cron_runs r left join net._http_response h on h.id=r.request_id
order by r.queued_at desc limit 20;

-- Safe manual health checks (queued only after their transaction commits):
-- select public.courtly_dispatch_delivery_cron('booking');
-- select public.courtly_dispatch_delivery_cron('billing');
--
-- Pause just these jobs if needed (the API activation flag is the mail kill switch):
-- select cron.unschedule('courtly-notification-delivery');
-- select cron.unschedule('courtly-billing-email-delivery');
