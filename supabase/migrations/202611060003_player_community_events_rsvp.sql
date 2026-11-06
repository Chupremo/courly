-- Courtly player-created activities with confirmed RSVPs and waitlists.
-- Additive: preserves existing venue-owned Open Play and booking/payment flows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.community_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 5 AND 120),
  sport text NOT NULL CHECK (char_length(trim(sport)) BETWEEN 2 AND 40),
  event_type text NOT NULL DEFAULT 'Open Play'
    CHECK (event_type IN ('Open Play','Social game','Training session','Tournament','Other')),
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 120
    CHECK (duration_minutes BETWEEN 30 AND 720),
  location_name text NOT NULL CHECK (char_length(trim(location_name)) BETWEEN 2 AND 160),
  address text NOT NULL DEFAULT '' CHECK (char_length(address) <= 240),
  city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
  fee_per_player numeric(10,2) NOT NULL DEFAULT 0
    CHECK (fee_per_player BETWEEN 0 AND 100000),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 2 AND 500),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published','cancelled','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_events_upcoming_idx
  ON public.community_events (status, starts_at);
CREATE INDEX IF NOT EXISTS community_events_host_idx
  ON public.community_events (host_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.community_event_rsvps (
  event_id uuid NOT NULL REFERENCES public.community_events(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','waitlist','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, player_id)
);
CREATE INDEX IF NOT EXISTS community_event_rsvps_event_idx
  ON public.community_event_rsvps (event_id, status, created_at);
CREATE INDEX IF NOT EXISTS community_event_rsvps_player_idx
  ON public.community_event_rsvps (player_id, created_at DESC);

ALTER TABLE public.community_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_event_rsvps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_events, public.community_event_rsvps FROM PUBLIC, anon, authenticated;
-- Client access is through the scoped SECURITY DEFINER functions below.

CREATE OR REPLACE FUNCTION public.create_community_event(
  p_title text,
  p_sport text,
  p_event_type text,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_location_name text,
  p_address text DEFAULT '',
  p_city text DEFAULT '',
  p_fee_per_player numeric DEFAULT 0,
  p_capacity integer DEFAULT NULL,
  p_description text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_private boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Only signed-in Courtly players can host community activities';
  END IF;
  SELECT pp.is_private INTO v_private
  FROM public.player_profiles pp WHERE pp.id = auth.uid();
  IF COALESCE(v_private, true) THEN
    RAISE EXCEPTION 'Make your player profile public before hosting an activity so other players can discover it';
  END IF;
  IF char_length(trim(COALESCE(p_title,''))) NOT BETWEEN 5 AND 120 THEN
    RAISE EXCEPTION 'Activity title must be between 5 and 120 characters';
  END IF;
  IF char_length(trim(COALESCE(p_sport,''))) NOT BETWEEN 2 AND 40 THEN
    RAISE EXCEPTION 'Choose a sport for this activity';
  END IF;
  IF p_event_type NOT IN ('Open Play','Social game','Training session','Tournament','Other') THEN
    RAISE EXCEPTION 'Choose a valid activity type';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at < now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'Choose a start time at least 10 minutes in the future';
  END IF;
  IF p_duration_minutes NOT BETWEEN 30 AND 720 THEN
    RAISE EXCEPTION 'Activity duration must be between 30 minutes and 12 hours';
  END IF;
  IF char_length(trim(COALESCE(p_location_name,''))) NOT BETWEEN 2 AND 160 THEN
    RAISE EXCEPTION 'Enter the venue or meeting place';
  END IF;
  IF COALESCE(p_fee_per_player,0) < 0 OR COALESCE(p_fee_per_player,0) > 100000 THEN
    RAISE EXCEPTION 'Enter a valid per-player fee';
  END IF;
  IF p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'Participant limit must be between 2 and 500';
  END IF;
  IF char_length(COALESCE(p_description,'')) > 5000 THEN
    RAISE EXCEPTION 'Activity description is too long';
  END IF;

  INSERT INTO public.community_events (
    host_id,title,sport,event_type,starts_at,duration_minutes,
    location_name,address,city,fee_per_player,capacity,description
  ) VALUES (
    auth.uid(),trim(p_title),trim(p_sport),p_event_type,p_starts_at,p_duration_minutes,
    trim(p_location_name),trim(COALESCE(p_address,'')),trim(COALESCE(p_city,'')),
    COALESCE(p_fee_per_player,0),p_capacity,trim(COALESCE(p_description,''))
  ) RETURNING id INTO v_event_id;

  -- The host is automatically confirmed and appears in the attendee list.
  INSERT INTO public.community_event_rsvps(event_id,player_id,status)
  VALUES (v_event_id,auth.uid(),'confirmed');

  RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_community_events(
  p_event_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 36
)
RETURNS TABLE (
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
  viewer_rsvp text,
  viewer_is_host boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    e.id,e.title,e.sport,e.event_type,e.starts_at,e.duration_minutes,
    e.location_name,e.address,e.city,e.fee_per_player,e.capacity,e.description,
    e.status,e.created_at,e.host_id,
    COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player'),
    CASE WHEN pp.is_private = false OR e.host_id = auth.uid() THEN pp.avatar_url ELSE NULL END,
    (SELECT count(*)::bigint FROM public.community_event_rsvps r
      WHERE r.event_id=e.id AND r.status='confirmed'),
    (SELECT count(*)::bigint FROM public.community_event_rsvps r
      WHERE r.event_id=e.id AND r.status='waitlist'),
    (SELECT r.status FROM public.community_event_rsvps r
      WHERE r.event_id=e.id AND r.player_id=auth.uid()),
    e.host_id=auth.uid()
  FROM public.community_events e
  JOIN public.player_profiles pp ON pp.id=e.host_id
  WHERE (auth.uid() IS NOT NULL OR p_event_id IS NOT NULL)
    AND (p_event_id IS NULL OR e.id=p_event_id)
    AND (e.starts_at >= now() - interval '12 hours' OR e.host_id=auth.uid())
    AND (e.status='published' OR e.host_id=auth.uid())
    AND (pp.is_private=false OR e.host_id=auth.uid())
  ORDER BY e.starts_at ASC
  LIMIT CASE WHEN p_event_id IS NOT NULL THEN 1 ELSE GREATEST(1,LEAST(COALESCE(p_limit,36),60)) END;
$$;

CREATE OR REPLACE FUNCTION public.get_community_event_attendees(p_event_id uuid)
RETURNS TABLE (
  player_id uuid,
  player_name text,
  avatar_path text,
  rsvp_status text,
  joined_at timestamptz,
  is_host boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    r.player_id,
    CASE WHEN pp.is_private=false OR r.player_id=auth.uid()
      THEN COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player')
      ELSE 'Private player' END,
    CASE WHEN pp.is_private=false OR r.player_id=auth.uid() THEN pp.avatar_url ELSE NULL END,
    r.status,r.created_at,(r.player_id=e.host_id)
  FROM public.community_event_rsvps r
  JOIN public.community_events e ON e.id=r.event_id
  JOIN public.player_profiles pp ON pp.id=r.player_id
  WHERE r.event_id=p_event_id
    AND r.status IN ('confirmed','waitlist')
    AND (e.status='published' OR e.host_id=auth.uid())
    AND (e.host_id=auth.uid() OR EXISTS (
      SELECT 1 FROM public.player_profiles hp
      WHERE hp.id=e.host_id AND hp.is_private=false
    ))
  ORDER BY CASE WHEN r.status='confirmed' THEN 0 ELSE 1 END,r.created_at ASC
  LIMIT 500;
$$;

CREATE OR REPLACE FUNCTION public.rsvp_community_event(p_event_id uuid)
RETURNS TABLE (rsvp_status text, confirmed_count bigint, waitlist_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_event public.community_events%ROWTYPE;
  v_existing text;
  v_confirmed bigint;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a Courtly player account to RSVP';
  END IF;
  SELECT * INTO v_event FROM public.community_events
  WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.status <> 'published' THEN
    RAISE EXCEPTION 'This activity is no longer available';
  END IF;
  IF v_event.starts_at <= now() THEN
    RAISE EXCEPTION 'RSVPs are closed because this activity has already started';
  END IF;

  SELECT r.status INTO v_existing FROM public.community_event_rsvps r
    WHERE r.event_id=p_event_id AND r.player_id=auth.uid();
  IF v_existing IN ('confirmed','waitlist') THEN
    SELECT count(*)::bigint INTO v_confirmed FROM public.community_event_rsvps r
      WHERE r.event_id=p_event_id AND r.status='confirmed';
    RETURN QUERY SELECT v_existing,v_confirmed,
      (SELECT count(*)::bigint FROM public.community_event_rsvps r
       WHERE r.event_id=p_event_id AND r.status='waitlist');
    RETURN;
  END IF;

  SELECT count(*)::bigint INTO v_confirmed FROM public.community_event_rsvps r
    WHERE r.event_id=p_event_id AND r.status='confirmed';
  v_status := CASE WHEN v_event.capacity IS NULL OR v_confirmed < v_event.capacity
    THEN 'confirmed' ELSE 'waitlist' END;

  INSERT INTO public.community_event_rsvps(event_id,player_id,status)
    VALUES(p_event_id,auth.uid(),v_status)
  ON CONFLICT(event_id,player_id) DO UPDATE
    SET status=EXCLUDED.status,updated_at=now();

  SELECT count(*)::bigint INTO v_confirmed FROM public.community_event_rsvps r
    WHERE r.event_id=p_event_id AND r.status='confirmed';
  RETURN QUERY SELECT v_status,v_confirmed,
    (SELECT count(*)::bigint FROM public.community_event_rsvps r
     WHERE r.event_id=p_event_id AND r.status='waitlist');
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_community_event_rsvp(p_event_id uuid)
RETURNS TABLE (confirmed_count bigint, waitlist_count bigint, promoted_player_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_old_status text;
  v_promote uuid;
  v_capacity integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a Courtly player account to manage your RSVP';
  END IF;
  SELECT e.capacity INTO v_capacity FROM public.community_events e
    WHERE e.id=p_event_id AND e.status='published' AND e.starts_at>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This activity is no longer accepting RSVP changes'; END IF;

  SELECT r.status INTO v_old_status FROM public.community_event_rsvps r
    WHERE r.event_id=p_event_id AND r.player_id=auth.uid() FOR UPDATE;
  IF v_old_status IS NULL OR v_old_status='cancelled' THEN
    RAISE EXCEPTION 'You do not have an active RSVP for this activity';
  END IF;
  IF EXISTS (SELECT 1 FROM public.community_events e WHERE e.id=p_event_id AND e.host_id=auth.uid()) THEN
    RAISE EXCEPTION 'The host RSVP is part of the activity. Cancel the activity instead if it should not go ahead.';
  END IF;
  UPDATE public.community_event_rsvps
    SET status='cancelled',updated_at=now()
    WHERE event_id=p_event_id AND player_id=auth.uid();

  IF v_old_status='confirmed' AND v_capacity IS NOT NULL THEN
    SELECT r.player_id INTO v_promote FROM public.community_event_rsvps r
      WHERE r.event_id=p_event_id AND r.status='waitlist'
      ORDER BY r.created_at ASC LIMIT 1 FOR UPDATE;
    IF v_promote IS NOT NULL THEN
      UPDATE public.community_event_rsvps
        SET status='confirmed',updated_at=now()
        WHERE event_id=p_event_id AND player_id=v_promote;
    END IF;
  END IF;

  RETURN QUERY
    SELECT
      (SELECT count(*)::bigint FROM public.community_event_rsvps r WHERE r.event_id=p_event_id AND r.status='confirmed'),
      (SELECT count(*)::bigint FROM public.community_event_rsvps r WHERE r.event_id=p_event_id AND r.status='waitlist'),
      v_promote;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_community_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a Courtly player account to cancel this activity';
  END IF;
  UPDATE public.community_events
    SET status='cancelled',updated_at=now()
    WHERE id=p_event_id AND host_id=auth.uid() AND status='published' AND starts_at>now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the host can cancel an upcoming activity';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.create_community_event(text,text,text,timestamptz,integer,text,text,text,numeric,integer,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_community_events(uuid,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_community_event_attendees(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rsvp_community_event(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_community_event_rsvp(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_community_event(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_community_event(text,text,text,timestamptz,integer,text,text,text,numeric,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_community_events(uuid,integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_community_event_attendees(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rsvp_community_event(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_community_event_rsvp(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_community_event(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
