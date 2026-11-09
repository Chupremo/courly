BEGIN;

CREATE TABLE IF NOT EXISTS public.player_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT player_blocks_no_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS player_blocks_blocked_idx ON public.player_blocks(blocked_id, created_at DESC);
ALTER TABLE public.player_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.player_blocks TO authenticated;

DROP POLICY IF EXISTS "Players view their blocks" ON public.player_blocks;
CREATE POLICY "Players view their blocks" ON public.player_blocks FOR SELECT TO authenticated
USING (blocker_id = (select auth.uid()));
DROP POLICY IF EXISTS "Players create their blocks" ON public.player_blocks;
CREATE POLICY "Players create their blocks" ON public.player_blocks FOR INSERT TO authenticated
WITH CHECK (
  blocker_id = (select auth.uid())
  AND blocked_id <> (select auth.uid())
  AND public.courtly_community_is_player((select auth.uid()))
);
DROP POLICY IF EXISTS "Players remove their blocks" ON public.player_blocks;
CREATE POLICY "Players remove their blocks" ON public.player_blocks FOR DELETE TO authenticated
USING (blocker_id = (select auth.uid()));

CREATE OR REPLACE FUNCTION public.courtly_players_blocked(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT CASE
    WHEN p_a IS NULL OR p_b IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM public.player_blocks b
      WHERE (b.blocker_id = p_a AND b.blocked_id = p_b)
         OR (b.blocker_id = p_b AND b.blocked_id = p_a)
    )
  END;
$$;
REVOKE ALL ON FUNCTION public.courtly_players_blocked(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_players_blocked(uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.block_player(p_blocked_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to block a player';
  END IF;
  IF p_blocked_id IS NULL OR p_blocked_id = auth.uid() THEN
    RAISE EXCEPTION 'Choose another player to block';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.player_profiles WHERE id = p_blocked_id) THEN
    RAISE EXCEPTION 'This player is unavailable';
  END IF;

  INSERT INTO public.player_blocks(blocker_id, blocked_id)
  VALUES (auth.uid(), p_blocked_id)
  ON CONFLICT DO NOTHING;

  DELETE FROM public.player_follows
  WHERE (follower_id = auth.uid() AND following_id = p_blocked_id)
     OR (follower_id = p_blocked_id AND following_id = auth.uid());

  DELETE FROM public.player_friend_requests
  WHERE (sender_id = auth.uid() AND receiver_id = p_blocked_id)
     OR (sender_id = p_blocked_id AND receiver_id = auth.uid());

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.block_player(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.block_player(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unblock_player(p_blocked_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  DELETE FROM public.player_blocks
  WHERE blocker_id = auth.uid() AND blocked_id = p_blocked_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.unblock_player(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unblock_player(uuid) TO authenticated;

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
  is_following boolean,
  public_location text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT pp.id,
    COALESCE(NULLIF(trim(pp.player_name), ''), NULLIF(trim(pp.full_name), ''), 'Courtly Player'),
    pp.skill_level, pp.preferred_sport, pp.avatar_url,
    (SELECT count(*)::bigint FROM public.player_follows f WHERE f.following_id = pp.id),
    EXISTS (SELECT 1 FROM public.player_follows f WHERE f.follower_id = auth.uid() AND f.following_id = pp.id),
    NULLIF(trim(pp.public_location), '')
  FROM public.player_profiles pp
  WHERE public.courtly_community_can_post(auth.uid())
    AND pp.is_private = false
    AND pp.id <> auth.uid()
    AND NOT public.courtly_players_blocked(auth.uid(), pp.id)
    AND (
      NULLIF(trim(p_search), '') IS NULL
      OR COALESCE(pp.player_name, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.preferred_sport, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.skill_level, '') ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(pp.public_location, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY (SELECT count(*) FROM public.player_follows f WHERE f.following_id = pp.id) DESC, pp.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 60))
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;
REVOKE ALL ON FUNCTION public.get_player_directory(text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_directory(text,integer,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_player_conversation(p_other_player_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_one uuid;
  v_two uuid;
  v_conversation_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to start a conversation';
  END IF;
  IF p_other_player_id IS NULL OR p_other_player_id = auth.uid() THEN
    RAISE EXCEPTION 'Choose another player to message';
  END IF;
  IF public.courtly_players_blocked(auth.uid(), p_other_player_id) THEN
    RAISE EXCEPTION 'Messaging is unavailable between these player accounts';
  END IF;
  IF NOT public.courtly_player_profile_is_public(p_other_player_id) THEN
    RAISE EXCEPTION 'This player profile is private or unavailable';
  END IF;

  v_one := LEAST(auth.uid(), p_other_player_id);
  v_two := GREATEST(auth.uid(), p_other_player_id);

  SELECT id INTO v_conversation_id
  FROM public.player_conversations
  WHERE player_one_id = v_one AND player_two_id = v_two;

  IF v_conversation_id IS NULL THEN
    INSERT INTO public.player_conversations(player_one_id, player_two_id)
    VALUES (v_one, v_two)
    ON CONFLICT (player_one_id, player_two_id) DO UPDATE SET updated_at = public.player_conversations.updated_at
    RETURNING id INTO v_conversation_id;
  END IF;
  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_conversations()
RETURNS TABLE (
  conversation_id uuid, other_player_id uuid, other_player_name text,
  other_avatar_path text, other_sport text, last_message text, last_message_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to view messages';
  END IF;
  RETURN QUERY
  SELECT c.id, peer.id,
    COALESCE(NULLIF(trim(peer.player_name), ''), NULLIF(trim(peer.full_name), ''), 'Courtly Player')::text,
    peer.avatar_url::text, peer.preferred_sport::text, latest.body::text,
    COALESCE(latest.created_at, c.created_at)
  FROM public.player_conversations c
  JOIN public.player_profiles peer
    ON peer.id = CASE WHEN c.player_one_id = auth.uid() THEN c.player_two_id ELSE c.player_one_id END
  LEFT JOIN LATERAL (
    SELECT m.body,m.created_at FROM public.player_messages m
    WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1
  ) latest ON true
  WHERE (c.player_one_id=auth.uid() OR c.player_two_id=auth.uid())
    AND NOT public.courtly_players_blocked(auth.uid(), peer.id)
  ORDER BY COALESCE(latest.created_at,c.created_at) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_chat_messages(p_conversation_id uuid)
RETURNS TABLE (
  message_id uuid, sender_id uuid, sender_name text, body text,
  created_at timestamptz, is_mine boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE v_other uuid;
BEGIN
  SELECT CASE WHEN c.player_one_id=auth.uid() THEN c.player_two_id ELSE c.player_one_id END
    INTO v_other
  FROM public.player_conversations c
  WHERE c.id=p_conversation_id AND auth.uid() IN (c.player_one_id,c.player_two_id);

  IF v_other IS NULL THEN RAISE EXCEPTION 'You are not a participant in this conversation'; END IF;
  IF public.courtly_players_blocked(auth.uid(),v_other) THEN RAISE EXCEPTION 'This conversation is unavailable'; END IF;

  RETURN QUERY
  SELECT m.id,m.sender_id,
    COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player')::text,
    m.body,m.created_at,(m.sender_id=auth.uid())
  FROM public.player_messages m
  JOIN public.player_profiles pp ON pp.id=m.sender_id
  WHERE m.conversation_id=p_conversation_id
  ORDER BY m.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_player_message(p_conversation_id uuid,p_body text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_message_id uuid;
  v_body text := trim(COALESCE(p_body,''));
  v_other uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to send a message';
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Messages must contain between 1 and 2000 characters';
  END IF;

  SELECT CASE WHEN c.player_one_id=auth.uid() THEN c.player_two_id ELSE c.player_one_id END
    INTO v_other
  FROM public.player_conversations c
  WHERE c.id=p_conversation_id AND auth.uid() IN (c.player_one_id,c.player_two_id);

  IF v_other IS NULL THEN RAISE EXCEPTION 'You are not a participant in this conversation'; END IF;
  IF public.courtly_players_blocked(auth.uid(),v_other) THEN RAISE EXCEPTION 'Messaging is unavailable between these player accounts'; END IF;

  INSERT INTO public.player_messages(conversation_id,sender_id,body)
  VALUES (p_conversation_id,auth.uid(),v_body)
  RETURNING id INTO v_message_id;
  UPDATE public.player_conversations SET updated_at=now() WHERE id=p_conversation_id;
  RETURN v_message_id;
END;
$$;

ALTER TABLE public.payment_receipts ALTER COLUMN player_id DROP NOT NULL;
ALTER TABLE public.payment_receipts DROP CONSTRAINT IF EXISTS payment_receipts_player_id_fkey;
ALTER TABLE public.payment_receipts ADD CONSTRAINT payment_receipts_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES auth.users(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
