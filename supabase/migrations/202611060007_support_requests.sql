-- Private account/privacy support, using the existing Courtly administrator allowlist.
-- No public access, automated email, new administrator, or historical data changes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.courtly_support_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('account','booking','privacy','technical')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 120),
  message text NOT NULL CHECK (length(message) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  admin_reply text NOT NULL DEFAULT '' CHECK (length(admin_reply)<=4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS courtly_support_user_created_idx ON public.courtly_support_requests(user_id,created_at DESC);
ALTER TABLE public.courtly_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.courtly_support_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.courtly_support_requests TO authenticated;
DROP POLICY IF EXISTS courtly_support_read ON public.courtly_support_requests;
CREATE POLICY courtly_support_read ON public.courtly_support_requests FOR SELECT TO authenticated
  USING (user_id=auth.uid() OR public.is_courtly_admin());

CREATE OR REPLACE FUNCTION public.submit_courtly_support_request(p_id uuid,p_category text,p_subject text,p_message text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing public.courtly_support_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in before sending an account support request'; END IF;
  IF p_id IS NULL OR p_category IS NULL OR p_category NOT IN ('account','booking','privacy','technical')
    OR p_subject IS NULL OR length(btrim(p_subject)) NOT BETWEEN 3 AND 120
    OR p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 10 AND 4000 THEN
    RAISE EXCEPTION 'Choose a topic, a subject of 3–120 characters and a message of 10–4000 characters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('courtly-support'),hashtext(auth.uid()::text));
  SELECT * INTO existing FROM public.courtly_support_requests WHERE id=p_id;
  IF FOUND THEN
    IF existing.user_id<>auth.uid() OR existing.category<>p_category OR existing.subject<>btrim(p_subject) OR existing.message<>btrim(p_message) THEN
      RAISE EXCEPTION 'This request reference is already in use. Refresh and try again';
    END IF;
    RETURN existing.id;
  END IF;
  IF (SELECT count(*) FROM public.courtly_support_requests WHERE user_id=auth.uid() AND created_at>now()-interval '1 hour')>=3 THEN
    RAISE EXCEPTION 'You have sent three requests in the last hour. Please wait before sending another';
  END IF;
  INSERT INTO public.courtly_support_requests(id,user_id,category,subject,message)
  VALUES(p_id,auth.uid(),p_category,btrim(p_subject),btrim(p_message));
  RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION public.submit_courtly_support_request(uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_courtly_support_request(uuid,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_courtly_support_request(p_id uuid,p_status text,p_reply text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT coalesce(public.is_courtly_admin(),false) THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('open','in_progress','resolved') OR p_reply IS NULL OR length(p_reply)>4000 THEN
    RAISE EXCEPTION 'Choose a valid status and a reply of up to 4000 characters';
  END IF;
  UPDATE public.courtly_support_requests SET status=p_status,admin_reply=btrim(p_reply),updated_at=now() WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Support request not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.review_courtly_support_request(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_courtly_support_request(uuid,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
