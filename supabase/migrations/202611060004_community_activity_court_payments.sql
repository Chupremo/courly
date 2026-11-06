-- Courtly activity payments, registered-court reservation, banners and notifications.
-- Apply after 202611060003_player_community_events_rsvp.sql.

begin;

alter table public.community_events
  add column if not exists venue_id uuid references public.venues(id) on delete cascade,
  add column if not exists court_id uuid references public.courts(id) on delete restrict,
  add column if not exists banner_path text,
  add column if not exists banner_url text,
  add column if not exists map_place_id text,
  add column if not exists map_label text,
  add column if not exists map_lat double precision,
  add column if not exists map_lng double precision;

alter table public.court_blocks
  add column if not exists community_event_id uuid references public.community_events(id) on delete cascade;

create unique index if not exists court_blocks_community_event_uidx
  on public.court_blocks(community_event_id) where community_event_id is not null;
create index if not exists community_events_venue_court_starts_idx
  on public.community_events(venue_id,court_id,starts_at) where status='published';

create table if not exists public.community_event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.community_events(id) on delete cascade,
  player_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10,2) not null default 0 check (amount >= 0),
  payment_method text,
  payment_reference text,
  receipt_path text,
  payment_status text not null default 'awaiting_verification'
    check (payment_status in ('awaiting_verification','confirmed','rejected')),
  registration_status text not null default 'waitlisted'
    check (registration_status in ('waitlisted','confirmed','rejected','cancelled')),
  payment_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(event_id,player_id)
);
create index if not exists community_event_registrations_event_status_idx
  on public.community_event_registrations(event_id,registration_status,created_at);
create index if not exists community_event_registrations_player_idx
  on public.community_event_registrations(player_id,created_at desc);

create table if not exists public.community_activity_notifications (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.community_events(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique(player_id,event_id)
);
create index if not exists community_activity_notifications_unread_idx
  on public.community_activity_notifications(player_id,created_at desc) where read_at is null;

alter table public.community_event_registrations enable row level security;
alter table public.community_activity_notifications enable row level security;
revoke all on public.community_event_registrations from public,anon,authenticated;
revoke all on public.community_activity_notifications from public,anon,authenticated;

-- Public banner images are separate from the private payment receipt bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('courtly-community-banners','courtly-community-banners',true,5242880,
  array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=5242880,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Courtly community banners public read" on storage.objects;
create policy "Courtly community banners public read"
on storage.objects for select to anon,authenticated
using(bucket_id='courtly-community-banners');

drop policy if exists "Courtly players upload own activity banners" on storage.objects;
create policy "Courtly players upload own activity banners"
on storage.objects for insert to authenticated
with check(
  bucket_id='courtly-community-banners'
  and (storage.foldername(name))[1]=auth.uid()::text
  and exists(
    select 1 from public.community_events e
    where e.id::text=(storage.foldername(name))[2]
      and e.host_id=auth.uid() and e.status='published'
  )
);

create or replace function public.courtly_activity_receipt_upload_allowed(p_name text)
returns boolean
language sql stable security definer
set search_path=public,storage,auth,pg_temp
as $$
  select auth.uid() is not null
    and (storage.foldername(p_name))[2]='community-activity'
    and (storage.foldername(p_name))[4]=auth.uid()::text
    and exists(
      select 1
      from public.community_events e
      join public.venues v on v.id=e.venue_id
      where e.id::text=(storage.foldername(p_name))[3]
        and v.slug=(storage.foldername(p_name))[1]
        and e.status='published' and e.starts_at>now()
        and e.host_id<>auth.uid()
    );
$$;
revoke all on function public.courtly_activity_receipt_upload_allowed(text) from public;
grant execute on function public.courtly_activity_receipt_upload_allowed(text) to authenticated;

create or replace function public.courtly_owner_can_view_activity_receipt(p_name text)
returns boolean
language sql stable security definer
set search_path=public,storage,auth,pg_temp
as $$
  select auth.uid() is not null and exists(
    select 1
    from public.community_event_registrations r
    join public.community_events e on e.id=r.event_id
    join public.venues v on v.id=e.venue_id
    where v.owner_id=auth.uid() and r.receipt_path=p_name
  );
$$;
revoke all on function public.courtly_owner_can_view_activity_receipt(text) from public;
grant execute on function public.courtly_owner_can_view_activity_receipt(text) to authenticated;

drop policy if exists "Courtly players upload activity payment receipts" on storage.objects;
create policy "Courtly players upload activity payment receipts"
on storage.objects for insert to authenticated
with check(
  bucket_id='courtly-payment-receipts'
  and public.courtly_activity_receipt_upload_allowed(name)
);

drop policy if exists "Courtly owners view activity payment receipts" on storage.objects;
create policy "Courtly owners view activity payment receipts"
on storage.objects for select to authenticated
using(
  bucket_id='courtly-payment-receipts'
  and public.courtly_owner_can_view_activity_receipt(name)
);

-- Every new activity appears as an unread notification for other public player profiles.
create or replace function public.courtly_notify_players_of_new_activity()
returns trigger
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
begin
  insert into public.community_activity_notifications(player_id,event_id)
  select pp.id,new.id
  from public.player_profiles pp
  where pp.id<>new.host_id and pp.is_private=false
  on conflict(player_id,event_id) do nothing;
  return new;
end;
$$;
revoke all on function public.courtly_notify_players_of_new_activity() from public,anon,authenticated;
drop trigger if exists courtly_notify_players_of_new_activity on public.community_events;
create trigger courtly_notify_players_of_new_activity
after insert on public.community_events
for each row execute function public.courtly_notify_players_of_new_activity();

-- Reserve one real, active Courtly court/time slot when an activity is published.
drop function if exists public.create_community_event(text,text,text,timestamptz,integer,text,text,text,numeric,integer,text);
create or replace function public.create_community_event(
  p_venue_id uuid,
  p_court_id uuid,
  p_title text,
  p_sport text,
  p_event_type text,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_fee_per_player numeric default 0,
  p_capacity integer default 8,
  p_description text default '',
  p_map_place_id text default null,
  p_map_label text default null,
  p_map_lat double precision default null,
  p_map_lng double precision default null
)
returns uuid
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_venue public.venues%rowtype;
  v_court public.courts%rowtype;
  v_event_id uuid;
  v_end timestamptz;
  v_local_start time;
  v_local_end time;
  v_hours integer;
begin
  if auth.uid() is null or not public.courtly_is_player_account() then
    raise exception 'Sign in with a Courtly player account to host an activity';
  end if;
  if not exists(select 1 from public.player_profiles pp where pp.id=auth.uid() and pp.is_private=false) then
    raise exception 'Make your player profile public before hosting a community activity';
  end if;
  if char_length(trim(coalesce(p_title,''))) not between 5 and 120 then
    raise exception 'Activity title must be between 5 and 120 characters';
  end if;
  if char_length(trim(coalesce(p_sport,''))) not between 2 and 40 then
    raise exception 'Choose a sport for this activity';
  end if;
  if p_event_type not in ('Open Play','Social game','Training session','Tournament','Other') then
    raise exception 'Choose a valid activity type';
  end if;
  if p_duration_minutes not between 60 and 480 or p_duration_minutes%60<>0 then
    raise exception 'Court activities must be booked in whole hours, from 1 to 8 hours';
  end if;
  if p_starts_at is null or p_starts_at<=now() then
    raise exception 'Choose a future activity date and time';
  end if;
  if extract(minute from p_starts_at)<>0 or extract(second from p_starts_at)<>0 then
    raise exception 'Court activities must start on the hour';
  end if;
  if coalesce(p_fee_per_player,0)<0 or coalesce(p_fee_per_player,0)>100000 then
    raise exception 'Enter a valid amount per player';
  end if;
  if p_capacity is null or p_capacity not between 2 and 500 then
    raise exception 'Choose a participant limit between 2 and 500, including the host';
  end if;
  if char_length(coalesce(p_description,''))>5000 then
    raise exception 'Activity description is too long';
  end if;

  select * into v_venue from public.venues
  where id=p_venue_id and is_published=true;
  if not found then raise exception 'Select a registered, published Courtly venue'; end if;

  select * into v_court from public.courts
  where id=p_court_id and venue_id=v_venue.id and is_active=true;
  if not found then raise exception 'Select an active court registered under this venue'; end if;
  if lower(trim(coalesce(v_court.sport,''))) not in ('multi-sport','multi sport','')
     and lower(trim(v_court.sport))<>lower(trim(p_sport)) then
    raise exception 'The selected court is not registered for this sport';
  end if;

  v_end:=p_starts_at+make_interval(mins=>p_duration_minutes);
  v_local_start:=(p_starts_at at time zone coalesce(v_venue.timezone,'Asia/Manila'))::time;
  v_local_end:=(v_end at time zone coalesce(v_venue.timezone,'Asia/Manila'))::time;
  if v_local_start<v_venue.hours_open or v_local_end>v_venue.hours_close then
    raise exception 'The activity falls outside this venue operating hours';
  end if;

  v_hours:=p_duration_minutes/60;
  perform pg_advisory_xact_lock(hashtext(p_court_id::text),
    hashtext((p_starts_at at time zone coalesce(v_venue.timezone,'Asia/Manila'))::date::text));

  if exists(
    select 1 from public.bookings b
    where b.court_id=p_court_id and b.starts_at<v_end and b.ends_at>p_starts_at
      and b.status in ('pending','confirmed')
      and not(b.status='pending' and b.payment_status='unpaid'
        and b.created_at<now()-interval '20 minutes')
  ) then raise exception 'This court slot already has a reservation'; end if;

  if exists(
    select 1 from public.court_blocks cb
    where cb.court_id=p_court_id and cb.starts_at<v_end and cb.ends_at>p_starts_at
  ) then raise exception 'This court slot is unavailable or already reserved'; end if;

  if exists(
    select 1 from public.community_events e
    where e.court_id=p_court_id and e.status='published'
      and e.starts_at<v_end
      and e.starts_at+make_interval(mins=>e.duration_minutes)>p_starts_at
  ) then raise exception 'Another community activity already reserved this court slot'; end if;

  insert into public.community_events(
    host_id,venue_id,court_id,title,sport,event_type,starts_at,duration_minutes,
    location_name,address,city,fee_per_player,capacity,description,
    map_place_id,map_label,map_lat,map_lng
  ) values(
    auth.uid(),v_venue.id,v_court.id,trim(p_title),trim(p_sport),p_event_type,
    p_starts_at,p_duration_minutes,
    v_venue.name||' · '||v_court.name,
    coalesce(nullif(trim(p_map_label),''),nullif(trim(v_venue.address),''),''),
    coalesce(v_venue.city,''),
    coalesce(p_fee_per_player,0),p_capacity,trim(coalesce(p_description,'')),
    nullif(trim(p_map_place_id),''),nullif(trim(p_map_label),''),p_map_lat,p_map_lng
  ) returning id into v_event_id;

  insert into public.court_blocks(venue_id,court_id,starts_at,ends_at,reason,community_event_id)
  values(v_venue.id,v_court.id,p_starts_at,v_end,'Courtly activity: '||trim(p_title),v_event_id);

  return v_event_id;
end;
$$;

create or replace function public.update_community_event_banner(
  p_event_id uuid,p_banner_path text,p_banner_url text
)
returns void
language plpgsql security definer
set search_path=public,auth,storage,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Please sign in to update this activity banner'; end if;
  if p_banner_path not like auth.uid()::text||'/'||p_event_id::text||'/%' then
    raise exception 'Invalid activity banner path';
  end if;
  if not exists(select 1 from storage.objects o
    where o.bucket_id='courtly-community-banners' and o.name=p_banner_path) then
    raise exception 'The banner image upload could not be found';
  end if;
  update public.community_events
  set banner_path=p_banner_path,banner_url=p_banner_url,updated_at=now()
  where id=p_event_id and host_id=auth.uid() and status='published';
  if not found then raise exception 'Activity not found or not owned by this player'; end if;
end;
$$;

create or replace function public.get_community_activities(
  p_event_id uuid default null,
  p_limit integer default 36
)
returns table(
  event_id uuid,title text,sport text,event_type text,starts_at timestamptz,
  duration_minutes integer,location_name text,address text,city text,
  fee_per_player numeric,capacity integer,description text,event_status text,
  created_at timestamptz,host_id uuid,host_name text,host_avatar_path text,
  confirmed_count bigint,waitlist_count bigint,viewer_registration_status text,
  viewer_payment_status text,viewer_is_host boolean,venue_id uuid,venue_slug text,
  venue_name text,court_id uuid,court_name text,banner_url text,
  map_place_id text,map_label text,map_lat double precision,map_lng double precision,
  payment_qr_url text,payment_method text,payment_account text,payment_instructions text
)
language sql stable security definer
set search_path=public,auth,pg_temp
as $$
  select e.id,e.title,e.sport,e.event_type,e.starts_at,e.duration_minutes,
    e.location_name,e.address,e.city,e.fee_per_player,e.capacity,e.description,
    e.status,e.created_at,e.host_id,
    coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    case when pp.is_private=false or e.host_id=auth.uid() then pp.avatar_url else null end,
    (1 + (select count(*)::bigint from public.community_event_registrations r
      where r.event_id=e.id and r.registration_status='confirmed')),
    (select count(*)::bigint from public.community_event_registrations r
      where r.event_id=e.id and r.registration_status='waitlisted'),
    (select r.registration_status from public.community_event_registrations r
      where r.event_id=e.id and r.player_id=auth.uid()),
    (select r.payment_status from public.community_event_registrations r
      where r.event_id=e.id and r.player_id=auth.uid()),
    e.host_id=auth.uid(),v.id,v.slug,v.name,c.id,c.name,e.banner_url,
    e.map_place_id,e.map_label,e.map_lat,e.map_lng,
    v.payment_qr_url,v.payment_method,v.payment_account,v.payment_instructions
  from public.community_events e
  join public.player_profiles pp on pp.id=e.host_id
  left join public.venues v on v.id=e.venue_id
  left join public.courts c on c.id=e.court_id
  where (auth.uid() is not null or p_event_id is not null)
    and (p_event_id is null or e.id=p_event_id)
    and (e.starts_at>=now()-interval '12 hours' or e.host_id=auth.uid())
    and (e.status='published' or e.host_id=auth.uid())
    and (pp.is_private=false or e.host_id=auth.uid())
  order by e.starts_at asc
  limit case when p_event_id is not null then 1 else greatest(1,least(coalesce(p_limit,36),60)) end;
$$;

create or replace function public.get_community_activity_attendees(p_event_id uuid)
returns table(player_id uuid,player_name text,avatar_path text,is_host boolean)
language sql stable security definer
set search_path=public,auth,pg_temp
as $$
  select pp.id,
    coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    pp.avatar_url,true
  from public.community_events e
  join public.player_profiles pp on pp.id=e.host_id
  where e.id=p_event_id and e.status='published' and pp.is_private=false
  union all
  select pp.id,
    coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    pp.avatar_url,false
  from public.community_event_registrations r
  join public.player_profiles pp on pp.id=r.player_id
  join public.community_events e on e.id=r.event_id
  where r.event_id=p_event_id and r.registration_status='confirmed'
    and e.status='published' and pp.is_private=false
  order by 2;
$$;

create or replace function public.courtly_promote_community_activity_waitlist(p_event_id uuid)
returns integer
language plpgsql security definer
set search_path=public,pg_temp
as $$
declare
  v_capacity integer;
  v_confirmed integer;
  v_next uuid;
  v_promoted integer:=0;
begin
  select capacity into v_capacity from public.community_events where id=p_event_id;
  if not found or v_capacity is null then return 0; end if;
  loop
    select 1+count(*) into v_confirmed
    from public.community_event_registrations
    where event_id=p_event_id and registration_status='confirmed';
    exit when v_confirmed>=v_capacity;
    select id into v_next
    from public.community_event_registrations
    where event_id=p_event_id and payment_status='confirmed' and registration_status='waitlisted'
    order by payment_verified_at asc,created_at asc
    limit 1 for update skip locked;
    exit when v_next is null;
    update public.community_event_registrations
      set registration_status='confirmed',updated_at=now()
      where id=v_next;
    v_promoted:=v_promoted+1;
  end loop;
  return v_promoted;
end;
$$;

create or replace function public.register_community_activity(
  p_event_id uuid,
  p_receipt_path text default null,
  p_payment_method text default null,
  p_payment_reference text default null
)
returns jsonb
language plpgsql security definer
set search_path=public,auth,storage,pg_temp
as $$
declare
  v_event public.community_events%rowtype;
  v_venue public.venues%rowtype;
  v_registration public.community_event_registrations%rowtype;
  v_rows integer;
begin
  if auth.uid() is null or not public.courtly_is_player_account() then
    raise exception 'Sign in with a Courtly player account to join this activity';
  end if;
  select * into v_event from public.community_events where id=p_event_id and status='published' for update;
  if not found or v_event.starts_at<=now() then raise exception 'This activity is no longer accepting registrations'; end if;
  if v_event.host_id=auth.uid() then raise exception 'You are already listed as the activity host'; end if;
  select * into v_venue from public.venues where id=v_event.venue_id and is_published=true;
  if not found then raise exception 'The venue is no longer accepting activity registrations'; end if;

  if coalesce(v_event.fee_per_player,0)>0 then
    if coalesce(trim(p_receipt_path),'')='' then raise exception 'Upload your payment receipt before registering'; end if;
    if p_receipt_path not like v_venue.slug||'/community-activity/'||p_event_id::text||'/'||auth.uid()::text||'/%' then
      raise exception 'Invalid receipt path for this activity';
    end if;
    if not exists(select 1 from storage.objects o
      where o.bucket_id='courtly-payment-receipts' and o.name=p_receipt_path) then
      raise exception 'The payment receipt could not be found. Upload it again';
    end if;
  end if;

  insert into public.community_event_registrations(
    event_id,player_id,amount,payment_method,payment_reference,receipt_path,
    payment_status,registration_status
  ) values(
    p_event_id,auth.uid(),v_event.fee_per_player,
    nullif(trim(p_payment_method),''),nullif(trim(p_payment_reference),''),nullif(trim(p_receipt_path),''),
    'awaiting_verification','waitlisted'
  )
  on conflict(event_id,player_id) do update set
    amount=excluded.amount,payment_method=excluded.payment_method,
    payment_reference=excluded.payment_reference,receipt_path=excluded.receipt_path,
    payment_status='awaiting_verification',registration_status='waitlisted',
    payment_verified_at=null,updated_at=now()
  where public.community_event_registrations.registration_status in ('rejected','cancelled')
  returning * into v_registration;

  if v_registration.id is null then raise exception 'You already have an active registration for this activity'; end if;
  return jsonb_build_object('registration_id',v_registration.id,
    'payment_status',v_registration.payment_status,
    'registration_status',v_registration.registration_status,
    'message','Your registration is waitlisted while the venue owner verifies your payment.');
end;
$$;

create or replace function public.review_community_activity_payment(
  p_registration_id uuid,p_decision text
)
returns jsonb
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_registration public.community_event_registrations%rowtype;
  v_event public.community_events%rowtype;
  v_status text;
  v_payment text;
begin
  if auth.uid() is null then raise exception 'Sign in with the venue owner account to verify this payment'; end if;
  if p_decision not in ('confirmed','rejected') then raise exception 'Invalid payment decision'; end if;

  select r.* into v_registration
  from public.community_event_registrations r
  join public.community_events e on e.id=r.event_id
  join public.venues v on v.id=e.venue_id
  where r.id=p_registration_id and v.owner_id=auth.uid()
  for update of r;
  if not found then raise exception 'Payment registration not found or not owned by your venue'; end if;
  if v_registration.payment_status<>'awaiting_verification' then
    raise exception 'This activity payment has already been reviewed';
  end if;
  select * into v_event from public.community_events where id=v_registration.event_id for update;

  if p_decision='rejected' then
    update public.community_event_registrations
    set payment_status='rejected',registration_status='rejected',updated_at=now()
    where id=p_registration_id;
  else
    update public.community_event_registrations
    set payment_status='confirmed',payment_verified_at=now(),updated_at=now()
    where id=p_registration_id;
    perform public.courtly_promote_community_activity_waitlist(v_event.id);
    select registration_status into v_status
      from public.community_event_registrations where id=p_registration_id;
  end if;

  select payment_status,registration_status into v_payment,v_status
    from public.community_event_registrations where id=p_registration_id;
  return jsonb_build_object('registration_id',p_registration_id,
    'payment_status',v_payment,'registration_status',v_status);
end;
$$;

create or replace function public.cancel_community_activity_registration(p_event_id uuid)
returns void
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
declare v_status text;
begin
  if auth.uid() is null or not public.courtly_is_player_account() then
    raise exception 'Sign in with a Courtly player account to manage this registration';
  end if;
  select registration_status into v_status
  from public.community_event_registrations
  where event_id=p_event_id and player_id=auth.uid()
  for update;
  if v_status is null or v_status in ('rejected','cancelled') then raise exception 'No active registration was found'; end if;
  update public.community_event_registrations
    set registration_status='cancelled',updated_at=now()
    where event_id=p_event_id and player_id=auth.uid();
  perform public.courtly_promote_community_activity_waitlist(p_event_id);
end;
$$;

create or replace function public.get_owner_community_activity_registrations()
returns table(
  registration_id uuid,event_id uuid,event_title text,sport text,starts_at timestamptz,
  duration_minutes integer,court_name text,player_id uuid,player_name text,player_email text,
  amount numeric,payment_method text,payment_reference text,payment_status text,
  registration_status text,receipt_path text,created_at timestamptz
)
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Sign in as the venue owner'; end if;
  return query
  select r.id,e.id,e.title,e.sport,e.starts_at,e.duration_minutes,c.name,
    r.player_id,coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    pp.email,r.amount,r.payment_method,r.payment_reference,r.payment_status,
    r.registration_status,r.receipt_path,r.created_at
  from public.community_event_registrations r
  join public.community_events e on e.id=r.event_id
  join public.venues v on v.id=e.venue_id
  join public.courts c on c.id=e.court_id
  join public.player_profiles pp on pp.id=r.player_id
  where v.owner_id=auth.uid()
  order by r.created_at desc;
end;
$$;

create or replace function public.get_community_activity_unread_count()
returns integer
language sql stable security definer
set search_path=public,auth,pg_temp
as $$
  select count(*)::integer
  from public.community_activity_notifications
  where player_id=auth.uid() and read_at is null;
$$;

create or replace function public.mark_community_activity_notifications_read()
returns integer
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
declare v_rows integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.community_activity_notifications
    set read_at=now()
    where player_id=auth.uid() and read_at is null;
  get diagnostics v_rows=row_count;
  return v_rows;
end;
$$;

create or replace function public.cancel_community_event(p_event_id uuid)
returns void
language plpgsql security definer
set search_path=public,auth,pg_temp
as $$
begin
  if auth.uid() is null or not public.courtly_is_player_account() then
    raise exception 'Sign in with a Courtly player account to cancel this activity';
  end if;
  update public.community_events
    set status='cancelled',updated_at=now()
    where id=p_event_id and host_id=auth.uid() and status='published' and starts_at>now();
  if not found then raise exception 'Only the host can cancel an upcoming activity'; end if;
  delete from public.court_blocks where community_event_id=p_event_id;
end;
$$;

revoke all on function public.create_community_event(uuid,uuid,text,text,text,timestamptz,integer,numeric,integer,text,text,text,double precision,double precision) from public,anon;
revoke all on function public.update_community_event_banner(uuid,text,text) from public,anon;
revoke all on function public.get_community_activities(uuid,integer) from public;
revoke all on function public.get_community_activity_attendees(uuid) from public;
revoke all on function public.register_community_activity(uuid,text,text,text) from public,anon;
revoke all on function public.review_community_activity_payment(uuid,text) from public,anon;
revoke all on function public.cancel_community_activity_registration(uuid) from public,anon;
revoke all on function public.get_owner_community_activity_registrations() from public,anon;
revoke all on function public.get_community_activity_unread_count() from public,anon;
revoke all on function public.mark_community_activity_notifications_read() from public,anon;
revoke all on function public.cancel_community_event(uuid) from public,anon;
revoke all on function public.courtly_promote_community_activity_waitlist(uuid) from public,anon,authenticated;

grant execute on function public.create_community_event(uuid,uuid,text,text,text,timestamptz,integer,numeric,integer,text,text,text,double precision,double precision) to authenticated;
grant execute on function public.update_community_event_banner(uuid,text,text) to authenticated;
grant execute on function public.get_community_activities(uuid,integer) to anon,authenticated;
grant execute on function public.get_community_activity_attendees(uuid) to anon,authenticated;
grant execute on function public.register_community_activity(uuid,text,text,text) to authenticated;
grant execute on function public.review_community_activity_payment(uuid,text) to authenticated;
grant execute on function public.cancel_community_activity_registration(uuid) to authenticated;
grant execute on function public.get_owner_community_activity_registrations() to authenticated;
grant execute on function public.get_community_activity_unread_count() to authenticated;
grant execute on function public.mark_community_activity_notifications_read() to authenticated;
grant execute on function public.cancel_community_event(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
