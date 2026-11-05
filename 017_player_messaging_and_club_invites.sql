-- ============================================================================
-- COURTLY PLAYER MESSAGING + PLAYER-TO-PLAYER CLUB INVITATIONS
-- Apply after 011_player_network_and_community.sql,
-- 015_club_directory_and_registration.sql and
-- 016_club_dashboard_members_and_announcements.sql.
-- Additive and re-runnable. Private conversations and invitations are exposed
-- only through narrowly-scoped authenticated RPC functions.
-- ============================================================================
BEGIN;

-- Direct player conversations. The two participant UUIDs are stored in
-- canonical order so each pair has one conversation.
CREATE TABLE IF NOT EXISTS public.player_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_one_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  player_two_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_conversations_distinct_players CHECK (player_one_id < player_two_id),
  CONSTRAINT player_conversations_unique_pair UNIQUE (player_one_id, player_two_id)
);
CREATE INDEX IF NOT EXISTS player_conversations_player_one_idx
  ON public.player_conversations(player_one_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS player_conversations_player_two_idx
  ON public.player_conversations(player_two_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.player_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.player_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_messages_conversation_idx
  ON public.player_messages(conversation_id, created_at ASC);

ALTER TABLE public.player_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_conversations, public.player_messages FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.start_player_conversation(p_other_player_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
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
  IF NOT public.courtly_player_profile_is_public(p_other_player_id) THEN
    RAISE EXCEPTION 'This player profile is private or unavailable';
  END IF;

  v_one := LEAST(auth.uid(), p_other_player_id);
  v_two := GREATEST(auth.uid(), p_other_player_id);

  SELECT id INTO v_conversation_id
  FROM public.player_conversations
  WHERE player_one_id = v_one AND player_two_id = v_two;

  IF v_conversation_id IS NULL THEN
    BEGIN
      INSERT INTO public.player_conversations(player_one_id, player_two_id)
      VALUES (v_one, v_two)
      RETURNING id INTO v_conversation_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_conversation_id
      FROM public.player_conversations
      WHERE player_one_id = v_one AND player_two_id = v_two;
    END;
  END IF;

  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_conversations()
RETURNS TABLE (
  conversation_id uuid,
  other_player_id uuid,
  other_player_name text,
  other_avatar_path text,
  other_sport text,
  last_message text,
  last_message_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to view messages';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    peer.id,
    COALESCE(NULLIF(trim(peer.player_name), ''), NULLIF(trim(peer.full_name), ''), 'Courtly Player')::text,
    peer.avatar_url::text,
    peer.preferred_sport::text,
    latest.body::text,
    COALESCE(latest.created_at, c.created_at)
  FROM public.player_conversations c
  JOIN public.player_profiles peer
    ON peer.id = CASE WHEN c.player_one_id = auth.uid() THEN c.player_two_id ELSE c.player_one_id END
  LEFT JOIN LATERAL (
    SELECT m.body, m.created_at
    FROM public.player_messages m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC
    LIMIT 1
  ) latest ON true
  WHERE c.player_one_id = auth.uid() OR c.player_two_id = auth.uid()
  ORDER BY COALESCE(latest.created_at, c.created_at) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_chat_messages(p_conversation_id uuid)
RETURNS TABLE (
  message_id uuid,
  sender_id uuid,
  sender_name text,
  body text,
  created_at timestamptz,
  is_mine boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.player_conversations c
    WHERE c.id = p_conversation_id
      AND auth.uid() IN (c.player_one_id, c.player_two_id)
  ) THEN
    RAISE EXCEPTION 'You are not a participant in this conversation';
  END IF;

  RETURN QUERY
  SELECT m.id, m.sender_id,
    COALESCE(NULLIF(trim(pp.player_name), ''), NULLIF(trim(pp.full_name), ''), 'Courtly Player')::text,
    m.body, m.created_at, (m.sender_id = auth.uid())
  FROM public.player_messages m
  JOIN public.player_profiles pp ON pp.id = m.sender_id
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_player_message(p_conversation_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_message_id uuid;
  v_body text := trim(COALESCE(p_body, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to send a message';
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Messages must contain between 1 and 2000 characters';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.player_conversations c
    WHERE c.id = p_conversation_id
      AND auth.uid() IN (c.player_one_id, c.player_two_id)
  ) THEN
    RAISE EXCEPTION 'You are not a participant in this conversation';
  END IF;

  INSERT INTO public.player_messages(conversation_id, sender_id, body)
  VALUES (p_conversation_id, auth.uid(), v_body)
  RETURNING id INTO v_message_id;

  UPDATE public.player_conversations
  SET updated_at = now()
  WHERE id = p_conversation_id;

  RETURN v_message_id;
END;
$$;

-- A player can invite another public player to a published Courtly club.
-- The invitee must accept before a pending club_members request is created;
-- the club manager still decides whether to approve that membership request.
CREATE TABLE IF NOT EXISTS public.player_club_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  invitee_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT player_club_invites_not_self CHECK (inviter_id <> invitee_id),
  CONSTRAINT player_club_invites_unique UNIQUE (club_id, inviter_id, invitee_id)
);
CREATE INDEX IF NOT EXISTS player_club_invites_invitee_idx
  ON public.player_club_invites(invitee_id, status, created_at DESC);
ALTER TABLE public.player_club_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_club_invites FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.invite_player_to_club(p_club_id uuid, p_invitee_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_invite_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to invite someone to a club';
  END IF;
  IF p_invitee_id IS NULL OR p_invitee_id = auth.uid() THEN
    RAISE EXCEPTION 'Choose another player to invite';
  END IF;
  IF NOT public.courtly_player_profile_is_public(p_invitee_id) THEN
    RAISE EXCEPTION 'This player profile is private or unavailable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_profiles cp WHERE cp.id = p_club_id AND cp.is_published = true) THEN
    RAISE EXCEPTION 'This club is not currently accepting invitations';
  END IF;

  INSERT INTO public.player_club_invites(club_id, inviter_id, invitee_id, status, created_at, responded_at)
  VALUES (p_club_id, auth.uid(), p_invitee_id, 'pending', now(), NULL)
  ON CONFLICT (club_id, inviter_id, invitee_id) DO UPDATE
    SET status = 'pending', created_at = now(), responded_at = NULL
    WHERE public.player_club_invites.status <> 'pending'
  RETURNING id INTO v_invite_id;

  IF v_invite_id IS NULL THEN
    SELECT id INTO v_invite_id FROM public.player_club_invites
    WHERE club_id = p_club_id AND inviter_id = auth.uid() AND invitee_id = p_invitee_id;
  END IF;
  RETURN v_invite_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_player_club_invites()
RETURNS TABLE (
  invite_id uuid,
  club_id uuid,
  club_name text,
  club_sport text,
  inviter_id uuid,
  inviter_name text,
  invite_status text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to view club invitations';
  END IF;

  RETURN QUERY
  SELECT i.id, i.club_id, cp.club_name::text, cp.sport::text,
    i.inviter_id,
    COALESCE(NULLIF(trim(inviter.player_name), ''), NULLIF(trim(inviter.full_name), ''), 'Courtly Player')::text,
    i.status::text, i.created_at
  FROM public.player_club_invites i
  JOIN public.club_profiles cp ON cp.id = i.club_id
  JOIN public.player_profiles inviter ON inviter.id = i.inviter_id
  WHERE i.invitee_id = auth.uid()
  ORDER BY i.created_at DESC
  LIMIT 50;
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_player_club_invite(p_invite_id uuid, p_accept boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_invite public.player_club_invites%rowtype;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_is_player(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to respond to club invitations';
  END IF;

  SELECT * INTO v_invite
  FROM public.player_club_invites
  WHERE id = p_invite_id AND invitee_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;
  IF v_invite.status <> 'pending' THEN
    RETURN v_invite.status;
  END IF;

  UPDATE public.player_club_invites
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
      responded_at = now()
  WHERE id = p_invite_id;

  IF p_accept THEN
    INSERT INTO public.club_members(club_id, player_id, status)
    VALUES (v_invite.club_id, auth.uid(), 'pending')
    ON CONFLICT (club_id, player_id) DO UPDATE
      SET status = CASE WHEN public.club_members.status = 'active' THEN 'active' ELSE 'pending' END,
          updated_at = now();
  END IF;

  RETURN CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END;
END;
$$;

REVOKE ALL ON FUNCTION public.start_player_conversation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_player_conversations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_player_chat_messages(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_player_message(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invite_player_to_club(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_player_club_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_player_club_invite(uuid, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.start_player_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_conversations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_chat_messages(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_player_message(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invite_player_to_club(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_player_club_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_player_club_invite(uuid, boolean) TO authenticated;

COMMIT;
