BEGIN;

CREATE OR REPLACE FUNCTION public.courtly_can_view_community_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_posts p
    WHERE p.id=p_post_id
      AND public.courtly_community_can_post(auth.uid())
      AND p.status='published'
      AND (p.author_type<>'player' OR NOT public.courtly_players_blocked(auth.uid(), p.author_id))
      AND (
        p.author_type='venue_owner'
        OR p.author_id=auth.uid()
        OR (p.author_type='player' AND public.courtly_player_profile_is_public(p.author_id))
        OR (p.author_type='coach' AND public.courtly_coach_profile_is_public(p.author_id))
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_community_feed(
  p_limit integer DEFAULT 30,p_offset integer DEFAULT 0,p_post_id uuid DEFAULT NULL
)
RETURNS TABLE (
  post_id uuid,author_id uuid,author_type text,author_name text,author_avatar_path text,
  venue_name text,body text,media_path text,media_type text,created_at timestamptz,
  likes_count bigint,comments_count bigint,shares_count bigint,viewer_liked boolean,viewer_can_delete boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT p.id,p.author_id,p.author_type,
    CASE WHEN p.author_type='player' THEN COALESCE(NULLIF(trim(pp.player_name),''),'Courtly Player')
         WHEN p.author_type='coach' THEN COALESCE(NULLIF(trim(cp.coach_name),''),'Courtly Coach')
         ELSE COALESCE(NULLIF(trim(v.owner_name),''),NULLIF(trim(v.name),''),'Courtly Venue') END,
    CASE WHEN p.author_type='player' THEN pp.avatar_url WHEN p.author_type='coach' THEN cp.profile_image_path ELSE v.logo_url END,
    CASE WHEN p.author_type='venue_owner' THEN v.name ELSE NULL END,
    p.body,p.media_path,p.media_type,p.created_at,
    (SELECT count(*)::bigint FROM public.community_post_likes l WHERE l.post_id=p.id),
    (SELECT count(*)::bigint FROM public.community_comments c WHERE c.post_id=p.id),
    (SELECT count(*)::bigint FROM public.community_post_shares s WHERE s.post_id=p.id),
    EXISTS(SELECT 1 FROM public.community_post_likes l WHERE l.post_id=p.id AND l.user_id=auth.uid()),
    p.author_id=auth.uid()
  FROM public.community_posts p
  LEFT JOIN public.player_profiles pp ON pp.id=p.author_id AND p.author_type='player'
  LEFT JOIN public.coach_profiles cp ON cp.id=p.author_id AND p.author_type='coach'
  LEFT JOIN public.venues v ON v.id=p.venue_id AND p.author_type='venue_owner'
  WHERE public.courtly_community_can_post(auth.uid())
    AND (p_post_id IS NULL OR p.id=p_post_id)
    AND p.status='published'
    AND (p.author_type<>'player' OR NOT public.courtly_players_blocked(auth.uid(),p.author_id))
    AND (
      p.author_type='venue_owner' OR p.author_id=auth.uid()
      OR (p.author_type='player' AND public.courtly_player_profile_is_public(p.author_id))
      OR (p.author_type='coach' AND public.courtly_coach_profile_is_public(p.author_id))
    )
  ORDER BY p.created_at DESC
  LIMIT GREATEST(1,LEAST(COALESCE(p_limit,30),50))
  OFFSET GREATEST(COALESCE(p_offset,0),0);
$$;

CREATE OR REPLACE FUNCTION public.get_community_comments(p_post_id uuid)
RETURNS TABLE (
  comment_id uuid,author_type text,author_name text,author_avatar_path text,
  body text,created_at timestamptz,viewer_can_delete boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT c.id,
    CASE WHEN pp.id IS NOT NULL THEN 'player' WHEN cp.id IS NOT NULL THEN 'coach' ELSE 'venue_owner' END,
    CASE WHEN pp.id IS NOT NULL THEN CASE WHEN pp.is_private=false OR pp.id=auth.uid() THEN COALESCE(NULLIF(trim(pp.player_name),''),'Courtly Player') ELSE 'Private Player' END
      WHEN cp.id IS NOT NULL THEN COALESCE(NULLIF(trim(cp.coach_name),''),'Courtly Coach')
      ELSE COALESCE(NULLIF(trim(v.owner_name),''),NULLIF(trim(v.name),''),'Courtly Venue') END,
    CASE WHEN pp.id IS NOT NULL THEN CASE WHEN pp.is_private=false OR pp.id=auth.uid() THEN pp.avatar_url ELSE NULL END
      WHEN cp.id IS NOT NULL THEN cp.profile_image_path ELSE v.logo_url END,
    c.body,c.created_at,c.author_id=auth.uid()
  FROM public.community_comments c
  JOIN public.community_posts p ON p.id=c.post_id
  LEFT JOIN public.player_profiles pp ON pp.id=c.author_id
  LEFT JOIN public.coach_profiles cp ON cp.id=c.author_id
  LEFT JOIN LATERAL (
    SELECT v1.owner_name,v1.name,v1.logo_url FROM public.venues v1
    WHERE v1.owner_id=c.author_id ORDER BY v1.created_at LIMIT 1
  ) v ON pp.id IS NULL AND cp.id IS NULL
  WHERE c.post_id=p_post_id
    AND public.courtly_community_can_post(auth.uid())
    AND public.courtly_can_view_community_post(p_post_id)
    AND (pp.id IS NULL OR NOT public.courtly_players_blocked(auth.uid(),pp.id))
  ORDER BY c.created_at ASC LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.courtly_prepare_player_account_deletion(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_alias text := 'deleted+' || replace(p_user_id::text,'-','') || '@courtly.invalid';
BEGIN
  UPDATE public.bookings
    SET customer_name='Deleted Player',customer_email=v_alias,customer_phone=NULL,
        player_id=NULL,customer_user_id=NULL
    WHERE player_id=p_user_id OR customer_user_id=p_user_id;

  UPDATE public.open_play_registrations
    SET player_name='Deleted Player',player_email=v_alias,player_phone=NULL,player_id=NULL
    WHERE player_id=p_user_id;

  UPDATE public.payment_receipts
    SET player_id=NULL,player_name='Deleted Player',player_email=v_alias
    WHERE player_id=p_user_id;

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_prepare_player_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_prepare_player_account_deletion(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
