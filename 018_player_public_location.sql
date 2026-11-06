-- ============================================================================
-- COURTLY PLAYER PUBLIC LOCATION
-- Adds an optional, player-controlled public location to public profile cards.
-- Apply after 002_player_accounts_and_dashboard.sql and
-- 011_player_network_and_community.sql.
-- Do not use this field for a home or street address. Store a general area only.
-- ============================================================================
BEGIN;

ALTER TABLE public.player_profiles
  ADD COLUMN IF NOT EXISTS public_location text
  CHECK (public_location IS NULL OR char_length(public_location) <= 160);

-- The directory RPC needs a new return column. PostgreSQL requires dropping
-- this function before changing its RETURNS TABLE definition.
DROP FUNCTION IF EXISTS public.get_player_directory(text, integer, integer);

CREATE FUNCTION public.get_player_directory(
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
  is_following boolean,
  public_location text
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
    ),
    NULLIF(trim(pp.public_location), '')
  FROM public.player_profiles pp
  WHERE public.courtly_community_can_post(auth.uid())
    AND pp.is_private = false
    AND pp.id <> auth.uid()
    AND (
      NULLIF(trim(p_search), '') IS NULL
      OR COALESCE(pp.player_name, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.preferred_sport, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.skill_level, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.public_location, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY (SELECT count(*) FROM public.player_follows f WHERE f.following_id = pp.id) DESC,
           pp.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 60))
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.get_player_directory(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_directory(text, integer, integer) TO authenticated;

COMMIT;
