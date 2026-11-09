BEGIN;

-- A public Open Play listing must belong to a published Courtly venue.
DROP POLICY IF EXISTS "Public can view published upcoming open play" ON public.open_play_events;

CREATE OR REPLACE FUNCTION public.update_community_event_banner(
  p_event_id uuid,p_banner_path text,p_banner_url text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,storage,pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in as the venue owner to update this activity banner';
  END IF;
  IF p_banner_path NOT LIKE auth.uid()::text||'/'||p_event_id::text||'/%' THEN
    RAISE EXCEPTION 'Invalid activity banner path';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id='courtly-community-banners' AND o.name=p_banner_path
  ) THEN
    RAISE EXCEPTION 'The banner image upload could not be found';
  END IF;

  UPDATE public.community_events e
  SET banner_path=p_banner_path,banner_url=p_banner_url,updated_at=now()
  WHERE e.id=p_event_id
    AND e.host_id=auth.uid()
    AND e.status='published'
    AND EXISTS(
      SELECT 1 FROM public.venues v
      WHERE v.id=e.venue_id AND v.owner_id=auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Activity not found or not owned by this venue owner';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.update_community_event_banner(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_community_event_banner(uuid,text,text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;