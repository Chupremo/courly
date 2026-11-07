BEGIN;

-- Remove the remaining demo/test venue records.
DELETE FROM public.venues
WHERE slug IN (
  'demo-lipa-pickleball-hub',
  'demo-batangas-racquet-club',
  'demo-southside-sports-center',
  'demo-santos-pickleball-club',
  'bonn-test'
);

-- Remove obvious Bonn/demo test identities, but preserve the Courtly admin account.
DELETE FROM auth.users
WHERE id IN (
  '2f8b7ad0-2c76-43da-9387-8eb895484d3c',
  'dae96fcd-825e-4118-b183-6938415bdc42',
  '1ca56b2c-bb0c-4411-8136-33e3ab29268c',
  'c14bdf80-34f2-40e7-8fc6-cdc8773e0b16',
  '0f6311bd-2338-48fc-aa00-434a18af26ed'
);

-- Player-only home feed visible to signed-in Courtly players.
CREATE TABLE IF NOT EXISTS public.player_home_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  author_name text NOT NULL,
  avatar_path text,
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS player_home_posts_created_at_idx
  ON public.player_home_posts(created_at DESC);

ALTER TABLE public.player_home_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Registered players can read home posts" ON public.player_home_posts;
CREATE POLICY "Registered players can read home posts"
ON public.player_home_posts
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.player_profiles p
    WHERE p.id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "Players can create own home posts" ON public.player_home_posts;
CREATE POLICY "Players can create own home posts"
ON public.player_home_posts
FOR INSERT
TO authenticated
WITH CHECK (
  player_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.player_profiles p
    WHERE p.id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS "Players can delete own home posts" ON public.player_home_posts;
CREATE POLICY "Players can delete own home posts"
ON public.player_home_posts
FOR DELETE
TO authenticated
USING (player_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, DELETE ON TABLE public.player_home_posts TO authenticated;
REVOKE ALL ON TABLE public.player_home_posts FROM anon;

CREATE OR REPLACE FUNCTION public.courtly_prepare_player_home_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $function$
DECLARE
  p public.player_profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in with a player account to post';
  END IF;

  SELECT * INTO p
  FROM public.player_profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A Courtly player profile is required to post';
  END IF;

  NEW.player_id := auth.uid();
  NEW.author_name := COALESCE(NULLIF(trim(p.player_name),''), NULLIF(trim(p.full_name),''), 'Courtly Player');
  NEW.avatar_path := NULLIF(trim(p.avatar_url),'');
  NEW.body := trim(NEW.body);
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.courtly_prepare_player_home_post() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS prepare_player_home_post ON public.player_home_posts;
CREATE TRIGGER prepare_player_home_post
BEFORE INSERT ON public.player_home_posts
FOR EACH ROW EXECUTE FUNCTION public.courtly_prepare_player_home_post();

NOTIFY pgrst,'reload schema';
COMMIT;