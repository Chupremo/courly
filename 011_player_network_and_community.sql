-- ============================================================================
-- COURTLY PLAYER NETWORK + COMMUNITY
-- Adds: public verified-player count, player directory/follows, community posts,
-- image/video storage, likes, comments, unique shares, and post reports.
-- Additive migration. Does not modify bookings, Open Play fees, invoices or venues.
-- Run once after the existing player profile migration (002) and fee migrations.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Role and privacy helpers. SECURITY DEFINER is used only for narrowly
--    scoped checks so RLS can inspect profiles without exposing private fields.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.courtly_community_is_player(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.player_profiles pp
    WHERE pp.id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.courtly_community_can_post(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.player_profiles pp WHERE pp.id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.venues v WHERE v.owner_id = p_user_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.courtly_player_profile_is_public(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.player_profiles pp
    WHERE pp.id = p_player_id AND pp.is_private = false
  );
$$;

CREATE OR REPLACE FUNCTION public.courtly_can_read_player_avatar(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.player_profiles pp
    WHERE pp.avatar_url = p_object_name
      AND public.courtly_community_can_post(auth.uid())
      AND (pp.is_private = false OR pp.id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.courtly_community_is_player(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.courtly_community_can_post(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.courtly_player_profile_is_public(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.courtly_can_read_player_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_community_is_player(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_community_can_post(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_player_profile_is_public(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_can_read_player_avatar(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) Public aggregate count. Returns only a number, never personal information.
--    Counts player accounts with confirmed email addresses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_player_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT count(*)::bigint
  FROM public.player_profiles pp
  JOIN auth.users u ON u.id = pp.id
  WHERE u.email_confirmed_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.get_public_player_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_player_count() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Player follows. Only player accounts can follow public player profiles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.player_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CONSTRAINT player_follows_no_self CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS player_follows_following_idx
  ON public.player_follows (following_id, created_at DESC);

ALTER TABLE public.player_follows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_follows FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.player_follows TO authenticated;

DROP POLICY IF EXISTS "Players read their own follow relationships" ON public.player_follows;
CREATE POLICY "Players read their own follow relationships"
ON public.player_follows FOR SELECT TO authenticated
USING (follower_id = auth.uid());

DROP POLICY IF EXISTS "Players follow public player profiles" ON public.player_follows;
CREATE POLICY "Players follow public player profiles"
ON public.player_follows FOR INSERT TO authenticated
WITH CHECK (
  follower_id = auth.uid()
  AND public.courtly_community_is_player(auth.uid())
  AND public.courtly_player_profile_is_public(following_id)
  AND follower_id <> following_id
);

DROP POLICY IF EXISTS "Players unfollow their own relationships" ON public.player_follows;
CREATE POLICY "Players unfollow their own relationships"
ON public.player_follows FOR DELETE TO authenticated
USING (follower_id = auth.uid());

CREATE OR REPLACE FUNCTION public.get_player_directory(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  player_id uuid,
  player_name text,
  skill_level text,
  preferred_sport text,
  avatar_path text,
  follower_count bigint,
  is_following boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    pp.id,
    COALESCE(NULLIF(trim(pp.player_name), ''), NULLIF(trim(pp.full_name), ''), 'Courtly Player'),
    pp.skill_level,
    pp.preferred_sport,
    pp.avatar_url,
    (SELECT count(*)::bigint FROM public.player_follows f WHERE f.following_id = pp.id),
    EXISTS (
      SELECT 1 FROM public.player_follows f
      WHERE f.follower_id = auth.uid() AND f.following_id = pp.id
    )
  FROM public.player_profiles pp
  WHERE public.courtly_community_can_post(auth.uid())
    AND pp.is_private = false
    AND pp.id <> auth.uid()
    AND (
      NULLIF(trim(p_search), '') IS NULL
      OR COALESCE(pp.player_name, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.preferred_sport, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.skill_level, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY (SELECT count(*) FROM public.player_follows f WHERE f.following_id = pp.id) DESC,
           pp.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 60))
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;
REVOKE ALL ON FUNCTION public.get_player_directory(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_directory(text, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4) Community tables. Media stays in a private Storage bucket; the feed issues
--    short-lived signed URLs only for published posts visible to the viewer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('player', 'venue_owner')),
  venue_id uuid REFERENCES public.venues(id) ON DELETE SET NULL,
  body text NOT NULL DEFAULT '',
  media_path text,
  media_type text CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_posts_content_required CHECK (
    char_length(trim(body)) <= 2000
    AND (char_length(trim(body)) > 0 OR media_path IS NOT NULL)
  ),
  CONSTRAINT community_posts_media_consistency CHECK (
    (media_path IS NULL AND media_type IS NULL)
    OR (media_path IS NOT NULL AND media_type IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS community_posts_feed_idx
  ON public.community_posts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS community_posts_author_idx
  ON public.community_posts (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.community_post_likes (
  post_id uuid NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.community_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_comments_post_idx
  ON public.community_comments (post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.community_post_shares (
  post_id uuid NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.community_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misleading', 'other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);

-- Community visibility helpers are created after the referenced community tables.
CREATE OR REPLACE FUNCTION public.courtly_can_view_community_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_posts p
    WHERE p.id = p_post_id
      AND public.courtly_community_can_post(auth.uid())
      AND p.status = 'published'
      AND (p.author_type = 'venue_owner' OR p.author_id = auth.uid()
           OR public.courtly_player_profile_is_public(p.author_id))
  );
$$;

CREATE OR REPLACE FUNCTION public.courtly_can_read_community_media(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_posts p
    WHERE p.media_path = p_object_name
      AND public.courtly_community_can_post(auth.uid())
      AND p.status = 'published'
      AND (p.author_type = 'venue_owner' OR p.author_id = auth.uid()
           OR public.courtly_player_profile_is_public(p.author_id))
  );
$$;

REVOKE ALL ON FUNCTION public.courtly_can_view_community_post(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.courtly_can_read_community_media(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_can_view_community_post(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_can_read_community_media(text) TO authenticated;

ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_post_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.community_posts, public.community_post_likes,
  public.community_comments, public.community_post_shares, public.community_reports
FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.community_posts TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.community_post_likes TO authenticated;
GRANT INSERT, DELETE ON public.community_comments TO authenticated;
GRANT INSERT, SELECT ON public.community_reports TO authenticated;
-- Share rows are deliberately accessed only through the share RPC.

DROP POLICY IF EXISTS "View published community posts" ON public.community_posts;
CREATE POLICY "View published community posts"
ON public.community_posts FOR SELECT TO authenticated
USING (public.courtly_can_view_community_post(id));

DROP POLICY IF EXISTS "Players and venue owners create community posts" ON public.community_posts;
CREATE POLICY "Players and venue owners create community posts"
ON public.community_posts FOR INSERT TO authenticated
WITH CHECK (author_id = auth.uid() AND public.courtly_community_can_post(auth.uid()));

DROP POLICY IF EXISTS "Authors delete their own community posts" ON public.community_posts;
CREATE POLICY "Authors delete their own community posts"
ON public.community_posts FOR DELETE TO authenticated
USING (author_id = auth.uid());

DROP POLICY IF EXISTS "View likes on visible community posts" ON public.community_post_likes;
CREATE POLICY "View likes on visible community posts"
ON public.community_post_likes FOR SELECT TO authenticated
USING (user_id = auth.uid() AND public.courtly_can_view_community_post(post_id));

DROP POLICY IF EXISTS "Community members like visible posts" ON public.community_post_likes;
CREATE POLICY "Community members like visible posts"
ON public.community_post_likes FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.courtly_community_can_post(auth.uid()) AND public.courtly_can_view_community_post(post_id));

DROP POLICY IF EXISTS "Members remove their own likes" ON public.community_post_likes;
CREATE POLICY "Members remove their own likes"
ON public.community_post_likes FOR DELETE TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "View comments on visible community posts" ON public.community_comments;
CREATE POLICY "View comments on visible community posts"
ON public.community_comments FOR SELECT TO authenticated
USING (public.courtly_can_view_community_post(post_id));

DROP POLICY IF EXISTS "Community members comment on visible posts" ON public.community_comments;
CREATE POLICY "Community members comment on visible posts"
ON public.community_comments FOR INSERT TO authenticated
WITH CHECK (author_id = auth.uid() AND public.courtly_community_can_post(auth.uid()) AND public.courtly_can_view_community_post(post_id));

DROP POLICY IF EXISTS "Authors delete their own comments" ON public.community_comments;
CREATE POLICY "Authors delete their own comments"
ON public.community_comments FOR DELETE TO authenticated
USING (author_id = auth.uid());

DROP POLICY IF EXISTS "Members submit community reports" ON public.community_reports;
CREATE POLICY "Members submit community reports"
ON public.community_reports FOR INSERT TO authenticated
WITH CHECK (reporter_id = auth.uid() AND public.courtly_community_can_post(auth.uid()) AND public.courtly_can_view_community_post(post_id));

DROP POLICY IF EXISTS "Members view their own community reports" ON public.community_reports;
CREATE POLICY "Members view their own community reports"
ON public.community_reports FOR SELECT TO authenticated
USING (reporter_id = auth.uid());

-- Derive author identity from the signed-in account. A player cannot post as a
-- venue, and an owner cannot attach a post to somebody else's venue.
CREATE OR REPLACE FUNCTION public.courtly_prepare_community_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_venue_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_can_post(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a Courtly player or venue-owner account to post';
  END IF;

  NEW.author_id := auth.uid();

  IF EXISTS (SELECT 1 FROM public.player_profiles pp WHERE pp.id = auth.uid()) THEN
    NEW.author_type := 'player';
    NEW.venue_id := NULL;
  ELSE
    IF NEW.venue_id IS NOT NULL THEN
      SELECT v.id INTO v_venue_id
      FROM public.venues v
      WHERE v.id = NEW.venue_id AND v.owner_id = auth.uid();
    ELSE
      SELECT v.id INTO v_venue_id
      FROM public.venues v
      WHERE v.owner_id = auth.uid()
      ORDER BY v.created_at ASC
      LIMIT 1;
    END IF;

    IF v_venue_id IS NULL THEN
      RAISE EXCEPTION 'Your owner account must have a linked venue before posting';
    END IF;

    NEW.author_type := 'venue_owner';
    NEW.venue_id := v_venue_id;
  END IF;

  IF NEW.media_path IS NOT NULL AND split_part(NEW.media_path, '/', 1) <> auth.uid()::text THEN
    RAISE EXCEPTION 'Community media must belong to your signed-in account';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_prepare_community_post() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS courtly_prepare_community_post_before_insert ON public.community_posts;
CREATE TRIGGER courtly_prepare_community_post_before_insert
BEFORE INSERT ON public.community_posts
FOR EACH ROW EXECUTE FUNCTION public.courtly_prepare_community_post();

-- ---------------------------------------------------------------------------
-- 5) Private media bucket and object policies.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'courtly-community-media',
  'courtly-community-media',
  false,
  104857600,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 104857600,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Community members upload their own media" ON storage.objects;
CREATE POLICY "Community members upload their own media"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'courtly-community-media'
  AND split_part(name, '/', 1) = auth.uid()::text
  AND public.courtly_community_can_post(auth.uid())
);

DROP POLICY IF EXISTS "Members view media attached to visible community posts" ON storage.objects;
CREATE POLICY "Members view media attached to visible community posts"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'courtly-community-media'
  AND public.courtly_can_read_community_media(name)
);

DROP POLICY IF EXISTS "Community members delete their own media" ON storage.objects;
CREATE POLICY "Community members delete their own media"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'courtly-community-media'
  AND split_part(name, '/', 1) = auth.uid()::text
);

-- Public directory cards may request signed URLs for avatars only when the
-- player has chosen a public profile. Private avatars remain owner-only.
DROP POLICY IF EXISTS "Courtly members view public player avatars" ON storage.objects;
CREATE POLICY "Courtly members view public player avatars"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'courtly-player-avatars'
  AND public.courtly_can_read_player_avatar(name)
);

-- ---------------------------------------------------------------------------
-- 6) Community feed and comments RPCs. These return nickname/avatar only;
--    email, phone and full name are never returned for public player cards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_community_feed(
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0,
  p_post_id uuid DEFAULT NULL
)
RETURNS TABLE (
  post_id uuid,
  author_id uuid,
  author_type text,
  author_name text,
  author_avatar_path text,
  venue_name text,
  body text,
  media_path text,
  media_type text,
  created_at timestamptz,
  likes_count bigint,
  comments_count bigint,
  shares_count bigint,
  viewer_liked boolean,
  viewer_can_delete boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    p.id,
    p.author_id,
    p.author_type,
    CASE WHEN p.author_type = 'player'
      THEN COALESCE(NULLIF(trim(pp.player_name), ''), 'Courtly Player')
      ELSE COALESCE(NULLIF(trim(v.owner_name), ''), NULLIF(trim(v.name), ''), 'Courtly Venue')
    END,
    CASE WHEN p.author_type = 'player' THEN pp.avatar_url ELSE v.logo_url END,
    CASE WHEN p.author_type = 'venue_owner' THEN v.name ELSE NULL END,
    p.body,
    p.media_path,
    p.media_type,
    p.created_at,
    (SELECT count(*)::bigint FROM public.community_post_likes l WHERE l.post_id = p.id),
    (SELECT count(*)::bigint FROM public.community_comments c WHERE c.post_id = p.id),
    (SELECT count(*)::bigint FROM public.community_post_shares s WHERE s.post_id = p.id),
    EXISTS (SELECT 1 FROM public.community_post_likes l WHERE l.post_id = p.id AND l.user_id = auth.uid()),
    p.author_id = auth.uid()
  FROM public.community_posts p
  LEFT JOIN public.player_profiles pp ON pp.id = p.author_id AND p.author_type = 'player'
  LEFT JOIN public.venues v ON v.id = p.venue_id AND p.author_type = 'venue_owner'
  WHERE public.courtly_community_can_post(auth.uid())
    AND (p_post_id IS NULL OR p.id = p_post_id)
    AND p.status = 'published'
    AND (
      p.author_type = 'venue_owner'
      OR p.author_id = auth.uid()
      OR public.courtly_player_profile_is_public(p.author_id)
    )
  ORDER BY p.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 50))
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.get_community_comments(p_post_id uuid)
RETURNS TABLE (
  comment_id uuid,
  author_type text,
  author_name text,
  author_avatar_path text,
  body text,
  created_at timestamptz,
  viewer_can_delete boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    c.id,
    CASE WHEN pp.id IS NOT NULL THEN 'player' ELSE 'venue_owner' END,
    CASE WHEN pp.id IS NOT NULL THEN
      CASE WHEN pp.is_private = false OR pp.id = auth.uid()
        THEN COALESCE(NULLIF(trim(pp.player_name), ''), 'Courtly Player')
        ELSE 'Private Player' END
      ELSE COALESCE(NULLIF(trim(v.owner_name), ''), NULLIF(trim(v.name), ''), 'Courtly Venue')
    END,
    CASE WHEN pp.id IS NOT NULL THEN
      CASE WHEN pp.is_private = false OR pp.id = auth.uid() THEN pp.avatar_url ELSE NULL END
      ELSE v.logo_url
    END,
    c.body,
    c.created_at,
    c.author_id = auth.uid()
  FROM public.community_comments c
  JOIN public.community_posts p ON p.id = c.post_id
  LEFT JOIN public.player_profiles pp ON pp.id = c.author_id
  LEFT JOIN LATERAL (
    SELECT v1.owner_name, v1.name, v1.logo_url
    FROM public.venues v1
    WHERE v1.owner_id = c.author_id
    ORDER BY v1.created_at ASC
    LIMIT 1
  ) v ON pp.id IS NULL
  WHERE c.post_id = p_post_id
    AND public.courtly_community_can_post(auth.uid())
    AND public.courtly_can_view_community_post(p_post_id)
  ORDER BY c.created_at ASC
  LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.record_community_post_share(p_post_id uuid)
RETURNS TABLE (shares_count bigint, already_shared boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_rows integer;
  v_count bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_can_post(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in to share a Courtly community post';
  END IF;
  IF NOT public.courtly_can_view_community_post(p_post_id) THEN
    RAISE EXCEPTION 'This community post is not available';
  END IF;

  INSERT INTO public.community_post_shares (post_id, user_id)
  VALUES (p_post_id, auth.uid())
  ON CONFLICT (post_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*)::bigint INTO v_count
  FROM public.community_post_shares s
  WHERE s.post_id = p_post_id;

  RETURN QUERY SELECT v_count, (v_rows = 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_community_feed(integer, integer, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_community_comments(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_community_post_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_community_feed(integer, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_community_comments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_community_post_share(uuid) TO authenticated;

-- Let the signed-in author see their own pending/private post media while the
-- media is attached to a published post; private player posts remain hidden
-- from all other users through the helper above.

NOTIFY pgrst, 'reload schema';

COMMIT;
