BEGIN;

ALTER TABLE public.community_events ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE public.community_events ADD COLUMN IF NOT EXISTS public_author_name text;
ALTER TABLE public.community_events ADD COLUMN IF NOT EXISTS public_contact text;
ALTER TABLE public.community_events ADD COLUMN IF NOT EXISTS is_public_post boolean NOT NULL DEFAULT false;

ALTER TABLE public.community_events DROP CONSTRAINT IF EXISTS community_events_capacity_check;
ALTER TABLE public.community_events ADD CONSTRAINT community_events_capacity_check
CHECK (capacity IS NULL OR (capacity >= 2 AND capacity <= 500));

CREATE OR REPLACE FUNCTION public.create_public_community_event(
  p_author_name text,
  p_contact text,
  p_title text,
  p_sport text,
  p_event_type text,
  p_starts_at timestamptz,
  p_location_name text,
  p_description text DEFAULT '',
  p_capacity integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF char_length(trim(coalesce(p_author_name,''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Enter your name';
  END IF;
  IF char_length(trim(coalesce(p_title,''))) NOT BETWEEN 5 AND 120 THEN
    RAISE EXCEPTION 'Activity title must be between 5 and 120 characters';
  END IF;
  IF char_length(trim(coalesce(p_sport,''))) NOT BETWEEN 2 AND 40 THEN
    RAISE EXCEPTION 'Choose a sport';
  END IF;
  IF p_event_type NOT IN ('Open Play','Social game','Training session','Tournament','Other') THEN
    RAISE EXCEPTION 'Choose a valid activity type';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at <= now() THEN
    RAISE EXCEPTION 'Choose a future activity date and time';
  END IF;
  IF char_length(trim(coalesce(p_location_name,''))) NOT BETWEEN 2 AND 160 THEN
    RAISE EXCEPTION 'Enter the activity location';
  END IF;
  IF char_length(coalesce(p_description,'')) > 5000 THEN
    RAISE EXCEPTION 'Activity description is too long';
  END IF;
  IF p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'Capacity must be between 2 and 500';
  END IF;

  INSERT INTO public.community_events(
    host_id,title,sport,event_type,starts_at,duration_minutes,
    location_name,address,city,fee_per_player,capacity,description,status,
    public_author_name,public_contact,is_public_post
  ) VALUES(
    auth.uid(),trim(p_title),trim(p_sport),p_event_type,p_starts_at,120,
    trim(p_location_name),'','',0,p_capacity,trim(coalesce(p_description,'')),'published',
    trim(p_author_name),nullif(trim(coalesce(p_contact,'')),''),true
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.create_public_community_event(text,text,text,text,text,timestamptz,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_community_event(text,text,text,text,text,timestamptz,text,text,integer) TO anon,authenticated;

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
    CASE
      WHEN e.is_public_post THEN coalesce(nullif(trim(e.public_author_name),''),'Community Member')
      ELSE coalesce(nullif(trim(v.owner_name),''),v.name,'Courtly Venue')
    END,
    CASE WHEN e.is_public_post THEN NULL ELSE v.logo_url END,
    CASE WHEN e.is_public_post THEN 0::bigint ELSE
      (SELECT count(*)::bigint FROM public.community_event_registrations r
       WHERE r.event_id=e.id AND r.registration_status='confirmed') END,
    CASE WHEN e.is_public_post THEN 0::bigint ELSE
      (SELECT count(*)::bigint FROM public.community_event_registrations r
       WHERE r.event_id=e.id AND r.registration_status='waitlisted') END,
    CASE WHEN e.is_public_post THEN NULL ELSE
      (SELECT r.registration_status FROM public.community_event_registrations r
       WHERE r.event_id=e.id AND r.player_id=auth.uid()) END,
    CASE WHEN e.is_public_post THEN NULL ELSE
      (SELECT r.payment_status FROM public.community_event_registrations r
       WHERE r.event_id=e.id AND r.player_id=auth.uid()) END,
    CASE
      WHEN e.is_public_post THEN (e.host_id IS NOT NULL AND e.host_id=auth.uid())
      ELSE (v.owner_id=auth.uid())
    END,
    v.id,v.slug,v.name,c.id,c.name,e.banner_url,
    e.map_place_id,e.map_label,e.map_lat,e.map_lng,
    v.payment_qr_url,v.payment_method,v.payment_account,v.payment_instructions
  FROM public.community_events e
  LEFT JOIN public.venues v ON v.id=e.venue_id
  LEFT JOIN public.courts c ON c.id=e.court_id
  WHERE (p_event_id IS NULL OR e.id=p_event_id)
    AND e.status='published'
    AND e.starts_at>=now()-interval '12 hours'
  ORDER BY e.starts_at ASC
  LIMIT CASE WHEN p_event_id IS NOT NULL THEN 1 ELSE greatest(1,least(coalesce(p_limit,36),60)) END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_community_activities(uuid,integer) TO anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;