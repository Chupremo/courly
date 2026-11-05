-- Courtly Club Dashboard: member management and community announcements
-- Apply after 015_club_directory_and_registration.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS public.club_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 club_id uuid NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
 player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(club_id,player_id)
);
CREATE INDEX IF NOT EXISTS club_members_club_status_idx ON public.club_members(club_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS club_members_player_idx ON public.club_members(player_id,status);
CREATE TABLE IF NOT EXISTS public.club_announcements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 club_id uuid NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 post_type text NOT NULL DEFAULT 'Open Play',
 description text NOT NULL DEFAULT '',
 starts_at timestamptz,
 location_text text NOT NULL DEFAULT '',
 is_published boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_announcements_public_idx ON public.club_announcements(is_published,starts_at);
CREATE INDEX IF NOT EXISTS club_announcements_owner_idx ON public.club_announcements(club_id,created_at DESC);
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_announcements ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.club_members TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.club_announcements TO authenticated;
DROP POLICY IF EXISTS club_members_read_owner_or_self ON public.club_members;
CREATE POLICY club_members_read_owner_or_self ON public.club_members FOR SELECT TO authenticated USING(club_id=auth.uid() OR player_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_members_player_request ON public.club_members;
CREATE POLICY club_members_player_request ON public.club_members FOR INSERT TO authenticated WITH CHECK(player_id=auth.uid() AND public.courtly_is_player_account() AND EXISTS(SELECT 1 FROM public.club_profiles cp WHERE cp.id=club_id));
DROP POLICY IF EXISTS club_members_owner_update ON public.club_members;
CREATE POLICY club_members_owner_update ON public.club_members FOR UPDATE TO authenticated USING(club_id=auth.uid() OR public.is_courtly_admin()) WITH CHECK(club_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_members_owner_delete ON public.club_members;
CREATE POLICY club_members_owner_delete ON public.club_members FOR DELETE TO authenticated USING(club_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_announcements_read_public_or_owner ON public.club_announcements;
CREATE POLICY club_announcements_read_public_or_owner ON public.club_announcements FOR SELECT TO anon,authenticated USING(is_published=true OR club_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_announcements_owner_insert ON public.club_announcements;
CREATE POLICY club_announcements_owner_insert ON public.club_announcements FOR INSERT TO authenticated WITH CHECK(club_id=auth.uid() AND EXISTS(SELECT 1 FROM public.club_profiles cp WHERE cp.id=auth.uid()));
DROP POLICY IF EXISTS club_announcements_owner_update ON public.club_announcements;
CREATE POLICY club_announcements_owner_update ON public.club_announcements FOR UPDATE TO authenticated USING(club_id=auth.uid() OR public.is_courtly_admin()) WITH CHECK(club_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_announcements_owner_delete ON public.club_announcements;
CREATE POLICY club_announcements_owner_delete ON public.club_announcements FOR DELETE TO authenticated USING(club_id=auth.uid() OR public.is_courtly_admin());
CREATE OR REPLACE FUNCTION public.courtly_club_dashboard_members(p_club_id uuid)
RETURNS TABLE(id uuid,player_id uuid,player_name text,avatar_url text,status text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR (auth.uid()<>p_club_id AND NOT public.is_courtly_admin()) THEN
   RAISE EXCEPTION 'Not authorized to view this club member list';
 END IF;
 RETURN QUERY
 SELECT cm.id,cm.player_id,COALESCE(NULLIF(pp.player_name,''),NULLIF(pp.full_name,''),'Courtly player')::text,
        pp.avatar_url,cm.status,cm.created_at
 FROM public.club_members cm
 LEFT JOIN public.player_profiles pp ON pp.id=cm.player_id
 WHERE cm.club_id=p_club_id
 ORDER BY cm.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION public.courtly_club_dashboard_members(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_club_dashboard_members(uuid) TO authenticated;
COMMIT;
