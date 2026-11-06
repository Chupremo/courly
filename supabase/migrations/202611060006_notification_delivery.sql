-- Durable transactional mail for Courtly. Apply after payment receipts (001),
-- shared bookings/player accounts, hybrid fees and weekly billing (006).
-- No email is sent by this migration. Delivery requires the server activation
-- flag, a verified sender, and a worker invocation after deployment.
begin;

do $$
begin
  if to_regclass('public.payment_receipts') is null
     or to_regclass('public.bookings') is null
     or to_regclass('public.open_play_registrations') is null
     or to_regclass('public.courtly_billing_email_events') is null then
    raise exception 'Install Courtly bookings, payment receipts and weekly billing before notification delivery';
  end if;
end $$;

-- A paid Open Play registration can now have the same immutable payment
-- receipt as a court or coaching booking. Receipt IDs/numbers stay unchanged.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid='public.payment_receipts'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%source_type%'
  loop
    execute format('alter table public.payment_receipts drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.payment_receipts add constraint payment_receipts_source_type_check
  check (source_type in ('court_booking','coaching_booking','open_play_registration'));
alter table public.payment_receipts add column if not exists email_provider_id text;

create table if not exists public.courtly_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  category text not null check (category in ('booking','billing')),
  kind text not null check (kind in ('notification','receipt','billing')),
  source_type text not null,
  source_id uuid not null,
  event_type text not null,
  recipient_user_id uuid references auth.users(id) on delete set null,
  recipient_email text not null,
  payload jsonb not null,
  receipt_id uuid references public.payment_receipts(id) on delete restrict,
  billing_event_id uuid references public.courtly_billing_email_events(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','processing','retry','sent','needs_review','superseded')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  first_attempt_at timestamptz,
  provider_payload jsonb,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists courtly_delivery_due_idx
  on public.courtly_delivery_jobs(category,next_attempt_at,created_at)
  where status in ('pending','retry','processing');
create index if not exists courtly_delivery_source_idx
  on public.courtly_delivery_jobs(source_type,source_id,created_at);
create unique index if not exists courtly_delivery_receipt_idx
  on public.courtly_delivery_jobs(receipt_id) where receipt_id is not null;
create unique index if not exists courtly_delivery_billing_idx
  on public.courtly_delivery_jobs(billing_event_id) where billing_event_id is not null;
alter table public.courtly_delivery_jobs enable row level security;
revoke all on public.courtly_delivery_jobs from public,anon,authenticated;
grant select,insert,update on public.courtly_delivery_jobs to service_role;

create or replace function public.courtly_delivery_enqueue(
  p_key text,p_category text,p_kind text,p_source_type text,p_source_id uuid,
  p_event_type text,p_email text,p_user_id uuid,p_payload jsonb,
  p_receipt_id uuid default null,p_billing_id uuid default null,p_send_after timestamptz default now()
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
  insert into public.courtly_delivery_jobs(
    dedupe_key,category,kind,source_type,source_id,event_type,recipient_email,recipient_user_id,
    payload,receipt_id,billing_event_id,next_attempt_at,status,last_error
  ) values (
    p_key,p_category,p_kind,p_source_type,p_source_id,p_event_type,coalesce(nullif(trim(p_email),''),''),p_user_id,
    p_payload,p_receipt_id,p_billing_id,coalesce(p_send_after,now()),
    case when nullif(trim(p_email),'') is null then 'needs_review' else 'pending' end,
    case when nullif(trim(p_email),'') is null then 'Recipient email is missing; repair the account before delivery.' end
  ) on conflict (dedupe_key) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.courtly_delivery_jobs where dedupe_key=p_key; end if;
  return v_id;
end $$;

create or replace function public.courtly_delivery_receipt_event()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.email_status <> 'sent' then
    perform public.courtly_delivery_enqueue(
      'receipt:'||new.id,'booking','receipt',new.source_type,new.source_id,'payment_confirmed',
      new.player_email,new.player_id,to_jsonb(new),new.id
    );
  end if;
  return new;
end $$;
drop trigger if exists courtly_notify_payment_receipt on public.payment_receipts;
create trigger courtly_notify_payment_receipt after insert on public.payment_receipts
  for each row execute function public.courtly_delivery_receipt_event();

create or replace function public.courtly_delivery_capture_source(
  p_type text,p_row jsonb,p_previous jsonb default null
) returns void language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare
  v_id uuid := (p_row->>'id')::uuid;
  v_player_id uuid := coalesce(nullif(p_row->>'player_id',''),nullif(p_row->>'customer_user_id',''))::uuid;
  v_venue_id uuid := nullif(p_row->>'venue_id','')::uuid;
  v_owner_id uuid;
  v_venue jsonb := '{}'::jsonb;
  v_player_email text;
  v_owner_email text;
  v_player_name text;
  v_name text;
  v_reference text;
  v_description text;
  v_payment text := p_row->>'payment_status';
  v_state text := coalesce(p_row->>'status',p_row->>'registration_status',p_row->>'booking_status','');
  v_previous_payment text := p_previous->>'payment_status';
  v_previous_state text := coalesce(p_previous->>'status',p_previous->>'registration_status',p_previous->>'booking_status','');
  v_event text;
  v_amount numeric;
  v_payload jsonb;
  v_revision text := '';
  v_receipt_id uuid;
  v_notify_owner boolean := true;
begin
  if p_type not in ('court_booking','coaching_booking','open_play_registration') then
    raise exception 'Unsupported Courtly notification source';
  end if;
  -- Repeated updates and a confirmed -> completed change do not send again.
  if p_previous is not null and v_payment is not distinct from v_previous_payment
    and (v_state is not distinct from v_previous_state
      or (v_state in ('confirmed','completed') and v_previous_state in ('confirmed','completed'))) then
    return;
  end if;
  -- Unpaid holds and their automatic expiry/cancellation are not reservations.
  if v_payment in ('unpaid','pending') then return; end if;

  select email,coalesce(nullif(raw_user_meta_data->>'player_name',''),nullif(raw_user_meta_data->>'full_name',''))
    into v_player_email,v_player_name from auth.users where id=v_player_id;
  v_player_email := coalesce(nullif(v_player_email,''),nullif(p_row->>'customer_email',''),nullif(p_row->>'player_email',''));
  v_player_name := coalesce(nullif(p_row->>'customer_name',''),nullif(p_row->>'player_name',''),v_player_name,'Courtly player');
  v_reference := coalesce(p_row->>'reference',p_row->>'booking_reference',p_row->>'registration_reference',v_id::text);

  if p_type='coaching_booking' then
    v_owner_id := (p_row->>'coach_id')::uuid;
    select email into v_owner_email from auth.users where id=v_owner_id;
    v_name := coalesce(nullif(p_row->>'coach_name_snapshot',''),'Courtly coach');
    v_description := 'Coaching session with '||v_name;
    v_amount := coalesce((p_row->>'subtotal')::numeric,0);
  else
    select to_jsonb(v) into v_venue from public.venues v where v.id=v_venue_id;
    v_owner_id := (v_venue->>'owner_id')::uuid;
    select email into v_owner_email from auth.users where id=v_owner_id;
    v_owner_email := coalesce(nullif(v_venue->>'admin_email',''),v_owner_email);
    v_notify_owner := coalesce((v_venue->>'notify_email')::boolean,true);
    v_name := coalesce(nullif(v_venue->>'name',''),nullif(p_row->>'venue_name',''),'Courtly venue');
    if p_type='court_booking' then
      v_description := 'Court reservation at '||v_name;
      v_amount := coalesce((p_row->>'total')::numeric,(p_row->>'subtotal')::numeric,0);
    else
      v_description := coalesce(nullif(p_row->>'event_title',''),'Open Play')||' at '||v_name;
      v_amount := coalesce((p_row->>'player_total')::numeric,
        coalesce((p_row->>'fee')::numeric,0)+case when p_row->>'transaction_fee_payer'='player'
          then coalesce((p_row->>'transaction_fee')::numeric,0) else 0 end);
    end if;
  end if;

  if v_payment='refunded' then v_event := 'payment_refunded';
  elsif v_payment='rejected' then v_event := 'payment_rejected';
  elsif v_state in ('cancelled','expired') then v_event := 'booking_cancelled';
  elsif v_payment='confirmed' then
    v_event := case when v_amount>0 then 'payment_confirmed' else 'booking_confirmed' end;
  elsif v_payment='awaiting_verification' then v_event := 'payment_submitted';
  else return;
  end if;

  if v_event in ('payment_submitted','payment_rejected') then
    -- A replacement proof can produce a new review event; replaying the same
    -- proof or the client dispatch call cannot duplicate the original event.
    v_revision := ':'||md5(coalesce(nullif(p_row->>'payment_receipt_path',''),nullif(p_row->>'receipt_path',''),v_reference));
  end if;
  v_payload := jsonb_build_object(
    'reference',v_reference,'player_name',v_player_name,'venue_name',v_name,'description',v_description,
    'amount',v_amount,'payment_status',v_payment,'booking_status',v_state,
    'starts_at',p_row->>'starts_at','ends_at',p_row->>'ends_at',
    'event_date',p_row->>'event_date','event_time',p_row->>'event_time',
    'timezone',coalesce(v_venue->>'timezone','Asia/Manila'),'event_type',v_event
  );

  -- A later state replaces queued acknowledgements, but never alters an
  -- immutable receipt or a notification already handed to the provider.
  if v_event <> 'payment_submitted' then
    update public.courtly_delivery_jobs set status='superseded',updated_at=now()
      where source_type=p_type and source_id=v_id and kind='notification'
        and event_type='payment_submitted' and status in ('pending','retry');
  end if;

  if v_event='payment_confirmed' and v_player_id is not null then
    insert into public.payment_receipts(
      source_type,source_id,player_id,player_email,player_name,description,reference,
      amount,payment_method,paid_at
    ) values (
      p_type,v_id,v_player_id,coalesce(v_player_email,''),v_player_name,v_description,v_reference,
      v_amount,coalesce(nullif(p_row->>'payment_method',''),'Venue payment'),
      coalesce((p_row->>'paid_at')::timestamptz,(p_row->>'confirmed_at')::timestamptz,
        (p_row->>'updated_at')::timestamptz,now())
    ) on conflict (source_type,source_id) do nothing returning id into v_receipt_id;
    -- AFTER INSERT creates its delivery job in the same database transaction.
  else
    perform public.courtly_delivery_enqueue(
      p_type||':'||v_id||':'||v_event||v_revision||':player','booking','notification',p_type,v_id,
      v_event,v_player_email,v_player_id,v_payload||jsonb_build_object('audience','player')
    );
  end if;

  if v_event='payment_submitted' then
    v_notify_owner := v_notify_owner and coalesce((v_venue->>'notify_pending')::boolean,true);
  elsif v_event in ('booking_cancelled','payment_refunded') then
    v_notify_owner := v_notify_owner and coalesce((v_venue->>'notify_cancelled')::boolean,true);
  end if;
  if v_notify_owner then
    perform public.courtly_delivery_enqueue(
      p_type||':'||v_id||':'||v_event||v_revision||':owner','booking','notification',p_type,v_id,
      v_event,v_owner_email,v_owner_id,v_payload||jsonb_build_object('audience','owner')
    );
  end if;
end $$;

create or replace function public.courtly_delivery_source_event()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.courtly_delivery_capture_source(tg_argv[0],to_jsonb(new),case when tg_op='UPDATE' then to_jsonb(old) else null end);
  return new;
end $$;
drop trigger if exists courtly_notify_court_booking on public.bookings;
create trigger courtly_notify_court_booking after insert or update of status,payment_status on public.bookings
  for each row execute function public.courtly_delivery_source_event('court_booking');
drop trigger if exists courtly_notify_open_play on public.open_play_registrations;
create trigger courtly_notify_open_play after insert or update of registration_status,payment_status on public.open_play_registrations
  for each row execute function public.courtly_delivery_source_event('open_play_registration');
do $$
begin
  if to_regclass('public.coaching_bookings') is not null then
    execute 'drop trigger if exists courtly_notify_coaching_booking on public.coaching_bookings';
    execute 'create trigger courtly_notify_coaching_booking after insert or update of booking_status,payment_status on public.coaching_bookings for each row execute function public.courtly_delivery_source_event(''coaching_booking'')';
  end if;
end $$;

create or replace function public.courtly_delivery_billing_event()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status <> 'sent' then
    perform public.courtly_delivery_enqueue(
      'billing:'||new.id,'billing','billing','billing_invoice',new.id,new.event_type,
      new.recipient_email,null,jsonb_build_object('subject',new.subject,'html',new.html_body),
      null,new.id,new.send_after
    );
  end if;
  return new;
end $$;
drop trigger if exists courtly_notify_billing_email on public.courtly_billing_email_events;
create trigger courtly_notify_billing_email after insert on public.courtly_billing_email_events
  for each row execute function public.courtly_delivery_billing_event();

-- Import unsent work without sending historical confirmations or recreating
-- old receipts. Legacy failed/processing sends had no provider idempotency key;
-- their outcome must be reconciled before a human deliberately retries them.
insert into public.courtly_delivery_jobs(
  dedupe_key,category,kind,source_type,source_id,event_type,recipient_user_id,recipient_email,payload,receipt_id,status,last_error
)
select 'receipt:'||r.id,'booking','receipt',r.source_type,r.source_id,'payment_confirmed',r.player_id,r.player_email,to_jsonb(r),r.id,
  case when r.email_status in ('processing','failed') or nullif(trim(r.player_email),'') is null then 'needs_review' else 'pending' end,
  case when r.email_status in ('processing','failed') then 'Legacy delivery outcome is unknown; check the provider before retrying.'
    when nullif(trim(r.player_email),'') is null then 'Recipient email is missing.' end
from public.payment_receipts r where r.email_status<>'sent'
on conflict (dedupe_key) do nothing;

update public.payment_receipts r set email_status='failed',email_error=j.last_error
from public.courtly_delivery_jobs j
where j.receipt_id=r.id and j.status='needs_review' and r.email_status='processing';

insert into public.courtly_delivery_jobs(
  dedupe_key,category,kind,source_type,source_id,event_type,recipient_email,payload,billing_event_id,status,next_attempt_at,last_error
)
select 'billing:'||e.id,'billing','billing','billing_invoice',e.id,e.event_type,e.recipient_email,
  jsonb_build_object('subject',e.subject,'html',e.html_body),e.id,
  case when e.status='failed' or nullif(trim(e.recipient_email),'') is null then 'needs_review' else 'pending' end,e.send_after,
  case when e.status='failed' then 'Legacy delivery outcome is unknown; check the provider before retrying.'
    when nullif(trim(e.recipient_email),'') is null then 'Recipient email is missing.' end
from public.courtly_billing_email_events e where e.status<>'sent'
on conflict (dedupe_key) do nothing;

create or replace function public.courtly_delivery_reconcile_source(p_source_type text,p_source_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row jsonb;
begin
  if p_source_type='court_booking' then select to_jsonb(b) into v_row from public.bookings b where id=p_source_id;
  elsif p_source_type='open_play_registration' then select to_jsonb(r) into v_row from public.open_play_registrations r where id=p_source_id;
  elsif p_source_type='coaching_booking' and to_regclass('public.coaching_bookings') is not null then
    execute 'select to_jsonb(b) from public.coaching_bookings b where id=$1' into v_row using p_source_id;
  else raise exception 'Unsupported notification source';
  end if;
  if v_row is null then raise exception 'Notification source not found'; end if;
  perform public.courtly_delivery_capture_source(p_source_type,v_row);
end $$;

create or replace function public.courtly_delivery_claim(
  p_limit integer default 4,p_category text default 'booking',p_source_type text default null,p_source_id uuid default null
) returns setof public.courtly_delivery_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_category not in ('booking','billing') or (p_source_type is null)<>(p_source_id is null) then
    raise exception 'Invalid delivery claim filter';
  end if;
  if p_category='billing' then
    -- An old queued reminder must not demand payment for a settled invoice,
    -- or describe a future deadline after that deadline has already passed.
    update public.courtly_delivery_jobs j set status='superseded',lease_token=null,lease_until=null,
      last_error='The invoice changed before this notice was delivered.',updated_at=now()
    from public.courtly_billing_email_events e join public.courtly_invoices i on i.id=e.invoice_id
    where j.billing_event_id=e.id and e.status<>'sent' and j.status in ('pending','retry','processing')
      and (j.lease_until is null or j.lease_until<=now())
      and (i.status in ('paid','void') or i.amount_paid>=i.amount_due
        or (e.event_type<>'overdue' and i.due_at<=now())
        or (e.event_type='reminder_48h' and i.due_at<=now()+interval '24 hours'));
  end if;
  -- An old sender may have acknowledged a pre-existing receipt/notice. Respect
  -- that persisted success before considering any new provider request.
  update public.courtly_delivery_jobs j set status='sent',sent_at=coalesce(r.email_sent_at,now()),
    provider_message_id=r.email_provider_id,lease_token=null,lease_until=null,updated_at=now()
  from public.payment_receipts r where j.receipt_id=r.id and r.email_status='sent'
    and j.status not in ('sent','superseded') and j.category=p_category
    and (p_source_id is null or (j.source_type=p_source_type and j.source_id=p_source_id));
  update public.courtly_delivery_jobs j set status='sent',sent_at=coalesce(e.sent_at,now()),
    lease_token=null,lease_until=null,updated_at=now()
  from public.courtly_billing_email_events e where j.billing_event_id=e.id and e.status='sent'
    and j.status not in ('sent','superseded') and j.category=p_category;

  -- Resend retains a key for 24h. Leave a one-hour margin and stop automatic
  -- sends once an ambiguous result can no longer be safely deduplicated.
  update public.courtly_delivery_jobs j set status='needs_review',lease_token=null,lease_until=null,
    last_error=case when attempts>=8 then 'Delivery retry limit reached; review the provider outcome.'
      else 'Provider deduplication window elapsed; verify delivery before retrying.' end,updated_at=now()
  where j.category=p_category and j.status in ('pending','retry','processing')
    and (j.lease_until is null or j.lease_until<=now())
    and (j.attempts>=8 or j.first_attempt_at<now()-interval '23 hours')
    and (p_source_id is null or (j.source_type=p_source_type and j.source_id=p_source_id));

  return query
  with candidates as (
    select j.id from public.courtly_delivery_jobs j
    where j.category=p_category
      and (p_source_id is null or (j.source_type=p_source_type and j.source_id=p_source_id))
      and ((j.status in ('pending','retry') and j.next_attempt_at<=now())
        or (j.status='processing' and j.lease_until<=now()))
      and j.attempts<8 and (j.first_attempt_at is null or j.first_attempt_at>=now()-interval '23 hours')
    order by case when j.kind='receipt' then 0 else 1 end,j.next_attempt_at,j.created_at
    for update skip locked limit greatest(1,least(coalesce(p_limit,4),20))
  )
  update public.courtly_delivery_jobs j set status='processing',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
  from candidates c where j.id=c.id returning j.*;
end $$;

create or replace function public.courtly_delivery_prepare(p_job_id uuid,p_lease_token uuid,p_provider_payload jsonb)
returns setof public.courtly_delivery_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(p_provider_payload) is distinct from 'object' then raise exception 'Invalid provider payload'; end if;
  return query update public.courtly_delivery_jobs j
    set provider_payload=coalesce(j.provider_payload,p_provider_payload),first_attempt_at=coalesce(j.first_attempt_at,now()),updated_at=now()
    where j.id=p_job_id and j.status='processing' and j.lease_token=p_lease_token and j.lease_until>now()
      and (j.first_attempt_at is null or j.first_attempt_at>=now()-interval '23 hours')
    returning j.*;
end $$;

create or replace function public.courtly_delivery_finish(
  p_job_id uuid,p_lease_token uuid,p_outcome text,p_provider_id text default null,p_error text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.courtly_delivery_jobs%rowtype;
begin
  if p_outcome not in ('sent','retry','needs_review') then raise exception 'Invalid delivery outcome'; end if;
  if p_outcome='sent' and nullif(trim(p_provider_id),'') is null then raise exception 'Provider message ID is required'; end if;
  update public.courtly_delivery_jobs j set
    status=case when p_outcome='retry' and attempts>=8 then 'needs_review' else p_outcome end,
    provider_message_id=case when p_outcome='sent' then p_provider_id else provider_message_id end,
    sent_at=case when p_outcome='sent' then now() else sent_at end,
    next_attempt_at=case when p_outcome='retry' then now()+make_interval(secs=>least(3600,60*power(2,least(attempts-1,6)))::integer) else next_attempt_at end,
    last_error=case when p_outcome='sent' then null else left(coalesce(p_error,'Delivery needs attention.'),500) end,
    lease_token=null,lease_until=null,updated_at=now()
  where j.id=p_job_id and j.status='processing' and j.lease_token=p_lease_token
  returning j.* into v_job;
  if v_job.id is null then return false; end if;
  if v_job.receipt_id is not null then
    update public.payment_receipts set email_status=case when v_job.status='sent' then 'sent' else 'failed' end,
      email_sent_at=v_job.sent_at,email_error=v_job.last_error,email_provider_id=v_job.provider_message_id
      where id=v_job.receipt_id;
  end if;
  if v_job.billing_event_id is not null then
    update public.courtly_billing_email_events set status=case when v_job.status='sent' then 'sent' else 'failed' end,
      sent_at=v_job.sent_at,last_error=v_job.last_error where id=v_job.billing_event_id;
  end if;
  return true;
end $$;

create or replace function public.courtly_delivery_source_status(p_source_type text,p_source_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',j.id,'kind',j.kind,'event',j.event_type,'status',j.status,'sent_at',j.sent_at,
    'next_attempt_at',case when j.status='retry' then j.next_attempt_at else null end
  ) order by j.created_at),'[]'::jsonb)
  from public.courtly_delivery_jobs j where j.source_type=p_source_type and j.source_id=p_source_id;
$$;

create or replace function public.courtly_notification_readiness()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',1,'ready',
    exists(select 1 from pg_trigger where tgname='courtly_notify_court_booking' and not tgisinternal and tgenabled<>'D')
    and exists(select 1 from pg_trigger where tgname='courtly_notify_open_play' and not tgisinternal and tgenabled<>'D')
    and exists(select 1 from pg_trigger where tgname='courtly_notify_payment_receipt' and not tgisinternal and tgenabled<>'D'),
    'durable_queue',true,'open_play_receipts',true,'provider_idempotency',true,
    'coaching',exists(select 1 from pg_trigger where tgname='courtly_notify_coaching_booking' and not tgisinternal and tgenabled<>'D'));
$$;

-- Browser roles can only inspect readiness. All queue access, claims and
-- reconciliation are server-only, after the API independently authorizes the
-- player/venue owner/coach or verifies the cron secret.
revoke all on function public.courtly_delivery_enqueue(text,text,text,text,uuid,text,text,uuid,jsonb,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.courtly_delivery_receipt_event() from public,anon,authenticated;
revoke all on function public.courtly_delivery_capture_source(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.courtly_delivery_source_event() from public,anon,authenticated;
revoke all on function public.courtly_delivery_billing_event() from public,anon,authenticated;
revoke all on function public.courtly_delivery_reconcile_source(text,uuid) from public,anon,authenticated;
revoke all on function public.courtly_delivery_claim(integer,text,text,uuid) from public,anon,authenticated;
revoke all on function public.courtly_delivery_prepare(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.courtly_delivery_finish(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.courtly_delivery_source_status(text,uuid) from public,anon,authenticated;
revoke all on function public.courtly_notification_readiness() from public;
grant execute on function public.courtly_notification_readiness() to anon,authenticated,service_role;
grant execute on function public.courtly_delivery_reconcile_source(text,uuid) to service_role;
grant execute on function public.courtly_delivery_claim(integer,text,text,uuid) to service_role;
grant execute on function public.courtly_delivery_prepare(uuid,uuid,jsonb) to service_role;
grant execute on function public.courtly_delivery_finish(uuid,uuid,text,text,text) to service_role;
grant execute on function public.courtly_delivery_source_status(text,uuid) to service_role;
comment on table public.courtly_delivery_jobs is 'Private transactional email outbox. Claims expire after 2 minutes; uncertain sends stop before the provider 24-hour idempotency window expires.';
notify pgrst,'reload schema';
commit;
