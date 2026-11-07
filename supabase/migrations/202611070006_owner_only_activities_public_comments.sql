BEGIN;

-- Venue records are created by the trusted auth trigger. Players and other
-- authenticated users cannot create extra venue rows directly.
DROP POLICY IF EXISTS "Owners can create own venues" ON public.venues;

-- Only the owner of the selected published venue can create an activity.
CREATE OR REPLACE FUNCTION public.create_community_event(
  p_venue_id uuid, p_court_id uuid, p_title text, p_sport text, p_event_type text,
  p_starts_at timestamptz, p_duration_minutes integer, p_fee_per_player numeric DEFAULT 0,
  p_capacity integer DEFAULT 8, p_description text DEFAULT '',
  p_map_place_id text DEFAULT NULL, p_map_label text DEFAULT NULL,
  p_map_lat double precision DEFAULT NULL, p_map_lng double precision DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
DECLARE
  v_venue public.venues%ROWTYPE;
  v_court public.courts%ROWTYPE;
  v_event_id uuid;
  v_end timestamptz;
  v_local_start time;
  v_local_end time;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in with a venue owner account to publish an activity';
  END IF;

  SELECT * INTO v_venue
  FROM public.venues
  WHERE id=p_venue_id
    AND owner_id=auth.uid()
    AND is_published=true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the owner of a published Courtly venue can publish this activity';
  END IF;

  IF char_length(trim(coalesce(p_title,''))) NOT BETWEEN 5 AND 120 THEN
    RAISE EXCEPTION 'Activity title must be between 5 and 120 characters';
  END IF;
  IF char_length(trim(coalesce(p_sport,''))) NOT BETWEEN 2 AND 40 THEN
    RAISE EXCEPTION 'Choose a sport for this activity';
  END IF;
  IF p_event_type NOT IN ('Open Play','Social game','Training session','Tournament','Other') THEN
    RAISE EXCEPTION 'Choose a valid activity type';
  END IF;
  IF p_duration_minutes NOT BETWEEN 60 AND 480 OR p_duration_minutes%60<>0 THEN
    RAISE EXCEPTION 'Court activities must be booked in whole hours, from 1 to 8 hours';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at<=now() THEN
    RAISE EXCEPTION 'Choose a future activity date and time';
  END IF;
  IF extract(minute FROM p_starts_at)<>0 OR extract(second FROM p_starts_at)<>0 THEN
    RAISE EXCEPTION 'Court activities must start on the hour';
  END IF;
  IF coalesce(p_fee_per_player,0)<0 OR coalesce(p_fee_per_player,0)>100000 THEN
    RAISE EXCEPTION 'Enter a valid amount per player';
  END IF;
  IF p_capacity IS NULL OR p_capacity NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'Choose a participant limit between 2 and 500';
  END IF;
  IF char_length(coalesce(p_description,''))>5000 THEN
    RAISE EXCEPTION 'Activity description is too long';
  END IF;

  SELECT * INTO v_court
  FROM public.courts
  WHERE id=p_court_id
    AND venue_id=v_venue.id
    AND is_active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active court registered under your venue'; END IF;

  v_end:=p_starts_at+make_interval(mins=>p_duration_minutes);
  v_local_start:=(p_starts_at AT TIME ZONE coalesce(v_venue.timezone,'Asia/Manila'))::time;
  v_local_end:=(v_end AT TIME ZONE coalesce(v_venue.timezone,'Asia/Manila'))::time;
  IF v_local_start<v_venue.hours_open OR v_local_end>v_venue.hours_close THEN
    RAISE EXCEPTION 'The activity falls outside this venue operating hours';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_court_id::text),
    hashtext((p_starts_at AT TIME ZONE coalesce(v_venue.timezone,'Asia/Manila'))::date::text));

  IF EXISTS(
    SELECT 1 FROM public.bookings b
    WHERE b.court_id=p_court_id AND b.starts_at<v_end AND b.ends_at>p_starts_at
      AND b.status IN ('pending','confirmed')
  ) THEN RAISE EXCEPTION 'This court slot already has a reservation'; END IF;

  IF EXISTS(
    SELECT 1 FROM public.court_blocks cb
    WHERE cb.court_id=p_court_id AND cb.starts_at<v_end AND cb.ends_at>p_starts_at
  ) THEN RAISE EXCEPTION 'This court slot is unavailable or already reserved'; END IF;

  INSERT INTO public.community_events(
    host_id,venue_id,court_id,title,sport,event_type,starts_at,duration_minutes,
    location_name,address,city,fee_per_player,capacity,description,
    map_place_id,map_label,map_lat,map_lng
  ) VALUES(
    auth.uid(),v_venue.id,v_court.id,trim(p_title),trim(p_sport),p_event_type,
    p_starts_at,p_duration_minutes,
    v_venue.name||' · '||v_court.name,
    coalesce(nullif(trim(p_map_label),''),nullif(trim(v_venue.address),''),''),
    coalesce(v_venue.city,''),
    coalesce(p_fee_per_player,0),p_capacity,trim(coalesce(p_description,'')),
    nullif(trim(p_map_place_id),''),nullif(trim(p_map_label),''),
    p_map_lat,p_map_lng
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.court_blocks(venue_id,court_id,starts_at,ends_at,reason,community_event_id)
  VALUES(v_venue.id,v_court.id,p_starts_at,v_end,'Courtly activity: '||trim(p_title),v_event_id);

  RETURN v_event_id;
END
$function$;

REVOKE ALL ON FUNCTION public.create_community_event(uuid,uuid,text,text,text,timestamptz,integer,numeric,integer,text,text,text,double precision,double precision) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_community_event(uuid,uuid,text,text,text,timestamptz,integer,numeric,integer,text,text,text,double precision,double precision) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_community_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in with a venue owner account'; END IF;

  UPDATE public.community_events e
  SET status='cancelled',updated_at=now()
  WHERE e.id=p_event_id
    AND e.status='published'
    AND e.starts_at>now()
    AND EXISTS(
      SELECT 1 FROM public.venues v
      WHERE v.id=e.venue_id AND v.owner_id=auth.uid()
    );

  IF NOT FOUND THEN RAISE EXCEPTION 'Only the venue owner can cancel this upcoming activity'; END IF;
  DELETE FROM public.court_blocks WHERE community_event_id=p_event_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_community_activities(p_event_id uuid DEFAULT NULL,p_limit integer DEFAULT 36)
RETURNS TABLE(
  event_id uuid,title text,sport text,event_type text,starts_at timestamptz,duration_minutes integer,
  location_name text,address text,city text,fee_per_player numeric,capacity integer,description text,
  event_status text,created_at timestamptz,host_id uuid,host_name text,host_avatar_path text,
  confirmed_count bigint,waitlist_count bigint,viewer_registration_status text,viewer_payment_status text,
  viewer_is_host boolean,venue_id uuid,venue_slug text,venue_name text,court_id uuid,court_name text,
  banner_url text,map_place_id text,map_label text,map_lat double precision,map_lng double precision,
  payment_qr_url text,payment_method text,payment_account text,payment_instructions text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
  SELECT e.id,e.title,e.sport,e.event_type,e.starts_at,e.duration_minutes,
    e.location_name,e.address,e.city,e.fee_per_player,e.capacity,e.description,
    e.status,e.created_at,e.host_id,
    coalesce(nullif(trim(v.owner_name),''),v.name,'Courtly Venue'),
    v.logo_url,
    (SELECT count(*)::bigint FROM public.community_event_registrations r
      WHERE r.event_id=e.id AND r.registration_status='confirmed'),
    (SELECT count(*)::bigint FROM public.community_event_registrations r
      WHERE r.event_id=e.id AND r.registration_status='waitlisted'),
    (SELECT r.registration_status FROM public.community_event_registrations r
      WHERE r.event_id=e.id AND r.player_id=auth.uid()),
    (SELECT r.payment_status FROM public.community_event_registrations r
      WHERE r.event_id=e.id AND r.player_id=auth.uid()),
    (v.owner_id=auth.uid()),
    v.id,v.slug,v.name,c.id,c.name,e.banner_url,
    e.map_place_id,e.map_label,e.map_lat,e.map_lng,
    v.payment_qr_url,v.payment_method,v.payment_account,v.payment_instructions
  FROM public.community_events e
  JOIN public.venues v ON v.id=e.venue_id
  LEFT JOIN public.courts c ON c.id=e.court_id
  WHERE (p_event_id IS NULL OR e.id=p_event_id)
    AND e.status='published'
    AND e.starts_at>=now()-interval '12 hours'
  ORDER BY e.starts_at ASC
  LIMIT CASE WHEN p_event_id IS NOT NULL THEN 1 ELSE greatest(1,least(coalesce(p_limit,36),60)) END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_community_activities(uuid,integer) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_community_activity_attendees(p_event_id uuid)
RETURNS TABLE(player_id uuid,player_name text,avatar_path text,is_host boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
  SELECT pp.id,
    coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    CASE WHEN pp.is_private=false THEN pp.avatar_url ELSE NULL END,
    false
  FROM public.community_event_registrations r
  JOIN public.player_profiles pp ON pp.id=r.player_id
  JOIN public.community_events e ON e.id=r.event_id
  WHERE r.event_id=p_event_id
    AND r.registration_status='confirmed'
    AND e.status='published'
  ORDER BY 2;
$function$;

GRANT EXECUTE ON FUNCTION public.get_community_activity_attendees(uuid) TO anon,authenticated;

CREATE TABLE IF NOT EXISTS public.community_event_comments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.community_events(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(char_length(trim(body)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS community_event_comments_event_created_idx
ON public.community_event_comments(event_id,created_at);

ALTER TABLE public.community_event_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read activity comments" ON public.community_event_comments;
CREATE POLICY "Anyone can read activity comments"
ON public.community_event_comments FOR SELECT
TO anon,authenticated USING(true);

DROP POLICY IF EXISTS "Players can comment on activities" ON public.community_event_comments;
CREATE POLICY "Players can comment on activities"
ON public.community_event_comments FOR INSERT
TO authenticated
WITH CHECK(author_id=(SELECT auth.uid()));

DROP POLICY IF EXISTS "Players can delete own activity comments" ON public.community_event_comments;
CREATE POLICY "Players can delete own activity comments"
ON public.community_event_comments FOR DELETE
TO authenticated
USING(author_id=(SELECT auth.uid()));

GRANT SELECT ON public.community_event_comments TO anon,authenticated;
GRANT INSERT,DELETE ON public.community_event_comments TO authenticated;

CREATE OR REPLACE FUNCTION public.get_community_event_comments(p_event_id uuid)
RETURNS TABLE(comment_id uuid,author_id uuid,author_name text,avatar_path text,body text,created_at timestamptz,viewer_can_delete boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
  SELECT c.id,c.author_id,
    coalesce(nullif(trim(pp.player_name),''),nullif(trim(pp.full_name),''),'Courtly Player'),
    CASE WHEN pp.is_private=false OR pp.id=auth.uid() THEN pp.avatar_url ELSE NULL END,
    c.body,c.created_at,(c.author_id=auth.uid())
  FROM public.community_event_comments c
  JOIN public.player_profiles pp ON pp.id=c.author_id
  JOIN public.community_events e ON e.id=c.event_id
  WHERE c.event_id=p_event_id AND e.status='published'
  ORDER BY c.created_at ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_community_event_comments(uuid) TO anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;