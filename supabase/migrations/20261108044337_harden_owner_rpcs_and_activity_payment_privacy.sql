BEGIN;

REVOKE EXECUTE ON FUNCTION public.cancel_owner_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_owner_booking(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.review_court_booking_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_court_booking_payment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_community_activities(
  p_event_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 36
)
RETURNS TABLE(
  event_id uuid,
  title text,
  sport text,
  event_type text,
  starts_at timestamptz,
  duration_minutes integer,
  location_name text,
  address text,
  city text,
  fee_per_player numeric,
  capacity integer,
  description text,
  event_status text,
  created_at timestamptz,
  host_id uuid,
  host_name text,
  host_avatar_path text,
  confirmed_count bigint,
  waitlist_count bigint,
  viewer_registration_status text,
  viewer_payment_status text,
  viewer_is_host boolean,
  venue_id uuid,
  venue_slug text,
  venue_name text,
  court_id uuid,
  court_name text,
  banner_url text,
  map_place_id text,
  map_label text,
  map_lat double precision,
  map_lng double precision,
  payment_qr_url text,
  payment_method text,
  payment_account text,
  payment_instructions text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $$
  SELECT
    e.id,e.title,e.sport,e.event_type,e.starts_at,e.duration_minutes,
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
    CASE WHEN auth.uid() IS NULL THEN NULL ELSE v.payment_qr_url END,
    CASE WHEN auth.uid() IS NULL THEN NULL ELSE v.payment_method END,
    CASE WHEN auth.uid() IS NULL THEN NULL ELSE v.payment_account END,
    CASE WHEN auth.uid() IS NULL THEN NULL ELSE v.payment_instructions END
  FROM public.community_events e
  JOIN public.venues v ON v.id=e.venue_id
  LEFT JOIN public.courts c ON c.id=e.court_id
  WHERE (p_event_id IS NULL OR e.id=p_event_id)
    AND e.status='published'
    AND e.starts_at>=now()-interval '12 hours'
  ORDER BY e.starts_at ASC
  LIMIT CASE WHEN p_event_id IS NOT NULL THEN 1 ELSE greatest(1,least(coalesce(p_limit,36),60)) END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_community_activities(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_community_activities(uuid, integer) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
