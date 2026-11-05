-- ============================================================================
-- COURTLY COACH MARKETPLACE + COACH PORTAL
-- Apply after migrations 001, 002/003, 005, 006, 011 and 013.
-- Coaches are a distinct Auth role and never receive an owner venue.
-- Players pay the coach's session price directly. Coaches owe Courtly PHP 50
-- per successful paid coaching session, billed through the weekly ledger.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Coach profile and signup trigger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coach_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  coach_name text NOT NULL DEFAULT '',
  slug text NOT NULL UNIQUE,
  email text NOT NULL DEFAULT '',
  phone text,
  sport text NOT NULL DEFAULT 'Pickleball',
  coaching_bio text NOT NULL DEFAULT '',
  experience_years integer NOT NULL DEFAULT 0 CHECK (experience_years BETWEEN 0 AND 60),
  hourly_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  location_text text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  profile_image_path text,
  cover_image_path text,
  payment_provider text,
  payment_account_name text,
  payment_account_number text,
  payment_qr_path text,
  payment_instructions text,
  is_published boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  billing_status text NOT NULL DEFAULT 'active' CHECK (billing_status IN ('active','suspended')),
  billing_was_published boolean NOT NULL DEFAULT false,
  billing_suspended_at timestamptz,
  billing_suspend_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_profiles_public_idx
  ON public.coach_profiles(is_published, billing_status, city, sport, created_at DESC);

CREATE OR REPLACE FUNCTION public.courtly_is_coach(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.coach_profiles cp WHERE cp.id = p_user_id
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_is_coach(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_is_coach(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.courtly_coach_profile_is_public(p_coach_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.coach_profiles cp WHERE cp.id=p_coach_id AND cp.is_published=true AND cp.billing_status='active');
$$;
REVOKE ALL ON FUNCTION public.courtly_coach_profile_is_public(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_coach_profile_is_public(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.courtly_create_coach_profile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_name text;
  v_base_slug text;
  v_slug text;
  v_suffix integer := 2;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'account_type','') <> 'coach' THEN
    RETURN NEW;
  END IF;

  v_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'coach_name'),''),
                     NULLIF(trim(NEW.raw_user_meta_data->>'full_name'),''), 'Courtly Coach');
  v_base_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_base_slug = '' THEN v_base_slug := 'coach'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('coach-slug:' || v_base_slug));
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.coach_profiles WHERE slug = v_slug) LOOP
    v_slug := v_base_slug || '-' || v_suffix::text;
    v_suffix := v_suffix + 1;
  END LOOP;

  INSERT INTO public.coach_profiles (
    id, full_name, coach_name, slug, email, phone, sport, coaching_bio,
    experience_years, hourly_rate, location_text, city
  ) VALUES (
    NEW.id,
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'full_name'),''), ''),
    v_name,
    v_slug,
    COALESCE(lower(NEW.email), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''),
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''), 'Pickleball'),
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'coaching_bio'),''), ''),
    GREATEST(0, LEAST(60, COALESCE(NULLIF(NEW.raw_user_meta_data->>'experience_years','')::integer,0))),
    GREATEST(0, COALESCE(NULLIF(NEW.raw_user_meta_data->>'hourly_rate','')::numeric,0)),
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'location_text'),''), ''),
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'city'),''), '')
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_create_coach_profile() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS courtly_create_coach_profile_after_signup ON auth.users;
CREATE TRIGGER courtly_create_coach_profile_after_signup
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.courtly_create_coach_profile();

-- Existing owner-creation trigger must explicitly skip coaches as well as players/admins.
CREATE OR REPLACE FUNCTION public.courtly_create_owner_venue()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  business_name text;
  business_address text;
  venue_sport text;
  requested_count text;
  court_total integer := 1;
  base_slug text;
  candidate_slug text;
  suffix integer := 2;
  new_venue_id uuid;
  i integer;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'account_type','') IN ('player','coach','courtly_admin') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.venues WHERE owner_id=NEW.id) THEN RETURN NEW; END IF;
  business_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'business_name'),''),'My Courtly Venue');
  business_address := NULLIF(trim(NEW.raw_user_meta_data->>'business_address'),'');
  venue_sport := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''),'Multi-sport');
  requested_count := COALESCE(NEW.raw_user_meta_data->>'court_count','1');
  court_total := CASE
    WHEN requested_count IN ('4–5','4-5') THEN 4
    WHEN requested_count IN ('6–10','6-10') THEN 6
    WHEN requested_count='11+' THEN 11
    ELSE GREATEST(1,LEAST(50,COALESCE(NULLIF(regexp_replace(requested_count,'[^0-9]','','g'),'')::integer,1)))
  END;
  base_slug := public.courtly_make_slug(business_name);
  PERFORM pg_advisory_xact_lock(hashtext(base_slug));
  candidate_slug := base_slug;
  WHILE EXISTS (SELECT 1 FROM public.venues WHERE slug=candidate_slug) LOOP
    candidate_slug := base_slug || '-' || suffix::text;
    suffix := suffix + 1;
  END LOOP;
  INSERT INTO public.venues(owner_id,slug,name,address,city,admin_email,owner_name,phone,sport)
  VALUES (NEW.id,candidate_slug,business_name,business_address,
    NULLIF(trim(NEW.raw_user_meta_data->>'city'),''),NEW.email,
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_name'),''),
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_phone'),''),venue_sport)
  RETURNING id INTO new_venue_id;
  FOR i IN 1..court_total LOOP
    INSERT INTO public.courts(venue_id,name,sport,hourly_rate,is_active,display_order)
    VALUES (new_venue_id,'Court '||i,venue_sport,350,true,i)
    ON CONFLICT (venue_id,name) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

ALTER TABLE public.coach_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_profiles FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.coach_profiles TO authenticated;
DROP POLICY IF EXISTS coach_profile_read_self ON public.coach_profiles;
CREATE POLICY coach_profile_read_self ON public.coach_profiles
FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS coach_profile_update_self ON public.coach_profiles;
CREATE POLICY coach_profile_update_self ON public.coach_profiles
FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE OR REPLACE FUNCTION public.courtly_guard_coach_profile_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_courtly_admin() THEN
    IF NEW.is_verified IS DISTINCT FROM OLD.is_verified
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
       OR NEW.billing_status IS DISTINCT FROM OLD.billing_status
       OR NEW.billing_was_published IS DISTINCT FROM OLD.billing_was_published
       OR NEW.billing_suspended_at IS DISTINCT FROM OLD.billing_suspended_at
       OR NEW.billing_suspend_reason IS DISTINCT FROM OLD.billing_suspend_reason THEN
      RAISE EXCEPTION 'Coach verification and billing status are managed by Courtly';
    END IF;
    IF OLD.billing_status = 'suspended' AND NEW.is_published IS DISTINCT FROM OLD.is_published THEN
      RAISE EXCEPTION 'Your coach listing is suspended. Settle your Courtly balance to reactivate it.';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS courtly_guard_coach_profile_fields ON public.coach_profiles;
CREATE TRIGGER courtly_guard_coach_profile_fields
BEFORE UPDATE ON public.coach_profiles
FOR EACH ROW EXECUTE FUNCTION public.courtly_guard_coach_profile_fields();

-- ---------------------------------------------------------------------------
-- 2) Coach media, recurring availability and blockouts
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('courtly-coach-media','courtly-coach-media',true,104857600,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public=true, file_size_limit=104857600,
  allowed_mime_types=EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS coach_media_public_read ON storage.objects;
CREATE POLICY coach_media_public_read ON storage.objects FOR SELECT TO public
USING (bucket_id='courtly-coach-media');
DROP POLICY IF EXISTS coach_media_owner_insert ON storage.objects;
CREATE POLICY coach_media_owner_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='courtly-coach-media' AND split_part(name,'/',1)=auth.uid()::text AND public.courtly_is_coach(auth.uid()));
DROP POLICY IF EXISTS coach_media_owner_update ON storage.objects;
CREATE POLICY coach_media_owner_update ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id='courtly-coach-media' AND split_part(name,'/',1)=auth.uid()::text AND public.courtly_is_coach(auth.uid()))
WITH CHECK (bucket_id='courtly-coach-media' AND split_part(name,'/',1)=auth.uid()::text AND public.courtly_is_coach(auth.uid()));
DROP POLICY IF EXISTS coach_media_owner_delete ON storage.objects;
CREATE POLICY coach_media_owner_delete ON storage.objects FOR DELETE TO authenticated
USING (bucket_id='courtly-coach-media' AND split_part(name,'/',1)=auth.uid()::text AND public.courtly_is_coach(auth.uid()));

CREATE TABLE IF NOT EXISTS public.coach_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_minutes integer NOT NULL DEFAULT 60 CHECK (slot_minutes IN (30,60,90,120)),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  UNIQUE (coach_id, weekday, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS coach_availability_lookup_idx ON public.coach_availability(coach_id,weekday,is_active,start_time);
ALTER TABLE public.coach_availability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_availability FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coach_availability TO authenticated;
DROP POLICY IF EXISTS coach_availability_public_read ON public.coach_availability;
CREATE POLICY coach_availability_public_read ON public.coach_availability FOR SELECT TO anon, authenticated
USING (EXISTS (SELECT 1 FROM public.coach_profiles cp WHERE cp.id=coach_id AND cp.is_published AND cp.billing_status='active'));
DROP POLICY IF EXISTS coach_availability_owner_all ON public.coach_availability;
CREATE POLICY coach_availability_owner_all ON public.coach_availability FOR ALL TO authenticated
USING (coach_id=auth.uid() AND public.courtly_is_coach(auth.uid()))
WITH CHECK (coach_id=auth.uid() AND public.courtly_is_coach(auth.uid()));

CREATE TABLE IF NOT EXISTS public.coach_blocked_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS coach_blocked_slots_lookup_idx ON public.coach_blocked_slots(coach_id,starts_at,ends_at);
ALTER TABLE public.coach_blocked_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_blocked_slots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coach_blocked_slots TO authenticated;
DROP POLICY IF EXISTS coach_blocked_slots_owner_all ON public.coach_blocked_slots;
CREATE POLICY coach_blocked_slots_owner_all ON public.coach_blocked_slots FOR ALL TO authenticated
USING (coach_id=auth.uid() AND public.courtly_is_coach(auth.uid()))
WITH CHECK (coach_id=auth.uid() AND public.courtly_is_coach(auth.uid()));

-- ---------------------------------------------------------------------------
-- 3) Coaching bookings and secure receipt storage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coaching_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_reference text NOT NULL UNIQUE,
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE RESTRICT,
  player_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE RESTRICT,
  coach_name_snapshot text NOT NULL DEFAULT '',
  coach_slug_snapshot text NOT NULL DEFAULT '',
  sport_snapshot text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  duration_hours integer NOT NULL CHECK (duration_hours BETWEEN 1 AND 8),
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate > 0),
  subtotal numeric(12,2) NOT NULL CHECK (subtotal > 0),
  coach_transaction_fee numeric(10,2) NOT NULL DEFAULT 50 CHECK (coach_transaction_fee = 50),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','awaiting_verification','confirmed','rejected','refunded')),
  booking_status text NOT NULL DEFAULT 'pending_payment' CHECK (booking_status IN ('pending_payment','awaiting_verification','confirmed','completed','cancelled','rejected')),
  payment_reference text,
  receipt_path text,
  player_note text,
  coach_note text,
  expires_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS coaching_bookings_coach_date_idx ON public.coaching_bookings(coach_id,starts_at DESC);
CREATE INDEX IF NOT EXISTS coaching_bookings_player_date_idx ON public.coaching_bookings(player_id,starts_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_payment_reference_unique_idx
  ON public.coaching_bookings(lower(trim(payment_reference))) WHERE payment_reference IS NOT NULL;
ALTER TABLE public.coaching_bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coaching_bookings FROM anon, authenticated;
GRANT SELECT ON public.coaching_bookings TO authenticated;
DROP POLICY IF EXISTS coaching_bookings_participant_read ON public.coaching_bookings;
CREATE POLICY coaching_bookings_participant_read ON public.coaching_bookings FOR SELECT TO authenticated
USING (coach_id=auth.uid() OR player_id=auth.uid());

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('courtly-coach-payment-receipts','courtly-coach-payment-receipts',false,10485760,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=10485760,allowed_mime_types=EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS coach_receipt_player_upload ON storage.objects;
CREATE POLICY coach_receipt_player_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='courtly-coach-payment-receipts' AND split_part(name,'/',1)=auth.uid()::text
  AND EXISTS (SELECT 1 FROM public.player_profiles pp WHERE pp.id=auth.uid()));
DROP POLICY IF EXISTS coach_receipt_participant_read ON storage.objects;
CREATE POLICY coach_receipt_participant_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='courtly-coach-payment-receipts' AND (
  split_part(name,'/',1)=auth.uid()::text OR EXISTS (
    SELECT 1 FROM public.coaching_bookings b
    WHERE b.receipt_path=name AND (b.player_id=auth.uid() OR b.coach_id=auth.uid())
  ) OR public.is_courtly_admin()
));

-- Public coach browse/profile functions return only business profile fields.
CREATE TABLE IF NOT EXISTS public.coach_follows (
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(coach_id,player_id),
  CHECK(coach_id<>player_id)
);
ALTER TABLE public.coach_follows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_follows FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.coach_follows TO authenticated;
DROP POLICY IF EXISTS coach_follows_read_self ON public.coach_follows;
CREATE POLICY coach_follows_read_self ON public.coach_follows FOR SELECT TO authenticated
USING (player_id=auth.uid() OR coach_id=auth.uid());
DROP POLICY IF EXISTS coach_follows_player_insert ON public.coach_follows;
CREATE POLICY coach_follows_player_insert ON public.coach_follows FOR INSERT TO authenticated
WITH CHECK (player_id=auth.uid() AND EXISTS(SELECT 1 FROM public.player_profiles p WHERE p.id=auth.uid())
  AND EXISTS(SELECT 1 FROM public.coach_profiles c WHERE c.id=coach_id AND c.is_published=true AND c.billing_status='active'));
DROP POLICY IF EXISTS coach_follows_player_delete ON public.coach_follows;
CREATE POLICY coach_follows_player_delete ON public.coach_follows FOR DELETE TO authenticated USING (player_id=auth.uid());


CREATE OR REPLACE FUNCTION public.browse_coaches(
  p_search text DEFAULT NULL,
  p_sport text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  coach_id uuid, coach_name text, slug text, sport text, city text, location_text text,
  hourly_rate numeric, coaching_bio text, experience_years integer,
  profile_image_path text, cover_image_path text, is_verified boolean,
  follower_count bigint, is_following boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT cp.id, cp.coach_name, cp.slug, cp.sport, cp.city, cp.location_text,
         cp.hourly_rate, cp.coaching_bio, cp.experience_years,
         cp.profile_image_path, cp.cover_image_path, cp.is_verified,
         (SELECT count(*)::bigint FROM public.coach_follows f WHERE f.coach_id=cp.id),
         EXISTS (SELECT 1 FROM public.coach_follows f WHERE f.coach_id=cp.id AND f.player_id=auth.uid())
  FROM public.coach_profiles cp
  WHERE cp.is_published=true AND cp.billing_status='active'
    AND (NULLIF(trim(p_search),'') IS NULL OR cp.coach_name ILIKE '%'||trim(p_search)||'%' OR cp.coaching_bio ILIKE '%'||trim(p_search)||'%' OR cp.city ILIKE '%'||trim(p_search)||'%')
    AND (NULLIF(trim(p_sport),'') IS NULL OR cp.sport ILIKE '%'||trim(p_sport)||'%')
    AND (NULLIF(trim(p_city),'') IS NULL OR cp.city ILIKE '%'||trim(p_city)||'%')
  ORDER BY cp.is_verified DESC, cp.created_at DESC
  LIMIT GREATEST(1,LEAST(COALESCE(p_limit,30),60)) OFFSET GREATEST(COALESCE(p_offset,0),0);
$$;
REVOKE ALL ON FUNCTION public.browse_coaches(text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.browse_coaches(text,text,text,integer,integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_coach_profile(p_slug text)
RETURNS TABLE (
  coach_id uuid, coach_name text, slug text, sport text, city text, location_text text,
  hourly_rate numeric, coaching_bio text, experience_years integer,
  profile_image_path text, cover_image_path text, is_verified boolean,
  follower_count bigint, is_following boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT cp.id, cp.coach_name, cp.slug, cp.sport, cp.city, cp.location_text,
         cp.hourly_rate, cp.coaching_bio, cp.experience_years,
         cp.profile_image_path, cp.cover_image_path, cp.is_verified,
         (SELECT count(*)::bigint FROM public.coach_follows f WHERE f.coach_id=cp.id),
         EXISTS (SELECT 1 FROM public.coach_follows f WHERE f.coach_id=cp.id AND f.player_id=auth.uid())
  FROM public.coach_profiles cp
  WHERE cp.slug=p_slug AND cp.is_published=true AND cp.billing_status='active';
$$;
REVOKE ALL ON FUNCTION public.get_public_coach_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_coach_profile(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Coach follows and private chat
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.coach_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.player_profiles(id) ON DELETE CASCADE,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coach_id,player_id)
);
CREATE TABLE IF NOT EXISTS public.coach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.coach_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS coach_messages_conversation_idx ON public.coach_messages(conversation_id,created_at);
ALTER TABLE public.coach_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_conversations, public.coach_messages FROM anon, authenticated;
GRANT SELECT ON public.coach_conversations, public.coach_messages TO authenticated;
DROP POLICY IF EXISTS coach_conversations_participant_read ON public.coach_conversations;
CREATE POLICY coach_conversations_participant_read ON public.coach_conversations FOR SELECT TO authenticated
USING (coach_id=auth.uid() OR player_id=auth.uid());
DROP POLICY IF EXISTS coach_messages_participant_read ON public.coach_messages;
CREATE POLICY coach_messages_participant_read ON public.coach_messages FOR SELECT TO authenticated
USING (EXISTS(SELECT 1 FROM public.coach_conversations c WHERE c.id=conversation_id AND (c.coach_id=auth.uid() OR c.player_id=auth.uid())));

CREATE OR REPLACE FUNCTION public.start_coach_conversation(p_coach_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.player_profiles WHERE id=auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a player account to chat with a coach';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.coach_profiles WHERE id=p_coach_id AND is_published AND billing_status='active') THEN
    RAISE EXCEPTION 'This coach is not available';
  END IF;
  INSERT INTO public.coach_conversations(coach_id,player_id) VALUES(p_coach_id,auth.uid())
  ON CONFLICT(coach_id,player_id) DO UPDATE SET last_message_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.start_coach_conversation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.start_coach_conversation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_coach_message(p_conversation_id uuid,p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in to send a message'; END IF;
  IF length(trim(COALESCE(p_body,''))) NOT BETWEEN 1 AND 3000 THEN RAISE EXCEPTION 'Message must be between 1 and 3000 characters'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.coach_conversations c WHERE c.id=p_conversation_id AND (c.coach_id=auth.uid() OR c.player_id=auth.uid())) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;
  INSERT INTO public.coach_messages(conversation_id,sender_id,body) VALUES(p_conversation_id,auth.uid(),trim(p_body)) RETURNING id INTO v_id;
  UPDATE public.coach_conversations SET last_message_at=now() WHERE id=p_conversation_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.send_coach_message(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.send_coach_message(uuid,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5) Public availability and player booking RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_coach_available_slots(p_coach_id uuid,p_date date,p_duration_hours integer DEFAULT 1)
RETURNS TABLE(slot_start timestamptz,slot_end timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT slots.slot_start, slots.slot_start + make_interval(hours=>GREATEST(1,LEAST(COALESCE(p_duration_hours,1),8))) AS slot_end
  FROM public.coach_availability a
  CROSS JOIN LATERAL generate_series(
    ((p_date + a.start_time) AT TIME ZONE 'Asia/Manila'),
    (((p_date + a.end_time) - make_interval(hours=>GREATEST(1,LEAST(COALESCE(p_duration_hours,1),8)))) AT TIME ZONE 'Asia/Manila'),
    make_interval(mins=>a.slot_minutes)
  ) AS slots(slot_start)
  WHERE a.coach_id=p_coach_id AND a.weekday=extract(dow FROM p_date)::integer AND a.is_active
    AND EXISTS(SELECT 1 FROM public.coach_profiles cp WHERE cp.id=p_coach_id AND cp.is_published AND cp.billing_status='active' AND cp.hourly_rate>0)
    AND slots.slot_start > now()
    AND NOT EXISTS(SELECT 1 FROM public.coaching_bookings b WHERE b.coach_id=p_coach_id
      AND b.booking_status IN ('pending_payment','awaiting_verification','confirmed')
      AND (b.expires_at IS NULL OR b.expires_at>now())
      AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(slots.slot_start,slots.slot_start+make_interval(hours=>GREATEST(1,LEAST(COALESCE(p_duration_hours,1),8))),'[)'))
    AND NOT EXISTS(SELECT 1 FROM public.coach_blocked_slots x WHERE x.coach_id=p_coach_id
      AND tstzrange(x.starts_at,x.ends_at,'[)') && tstzrange(slots.slot_start,slots.slot_start+make_interval(hours=>GREATEST(1,LEAST(COALESCE(p_duration_hours,1),8))),'[)'))
  ORDER BY slots.slot_start;
$$;
REVOKE ALL ON FUNCTION public.get_coach_available_slots(uuid,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_coach_available_slots(uuid,date,integer) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.create_coaching_booking(p_coach_id uuid,p_starts_at timestamptz,p_duration_hours integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_coach public.coach_profiles%ROWTYPE; v_end timestamptz; v_ref text; v_id uuid; v_local timestamp; v_dow integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.player_profiles WHERE id=auth.uid()) THEN
    RAISE EXCEPTION 'Create or sign in to a Courtly player account before booking a coach';
  END IF;
  IF p_duration_hours IS NULL OR p_duration_hours NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'Choose between 1 and 8 coaching hours'; END IF;
  IF p_starts_at IS NULL OR p_starts_at <= now() THEN RAISE EXCEPTION 'Choose a future coaching timeslot'; END IF;
  SELECT * INTO v_coach FROM public.coach_profiles WHERE id=p_coach_id AND is_published=true AND billing_status='active' FOR SHARE;
  IF NOT FOUND OR v_coach.hourly_rate<=0 THEN RAISE EXCEPTION 'This coach is not currently accepting bookings'; END IF;
  IF COALESCE(v_coach.payment_provider,'')='' OR (COALESCE(v_coach.payment_qr_path,'')='' AND COALESCE(v_coach.payment_account_number,'')='') THEN
    RAISE EXCEPTION 'This coach has not completed payment setup yet. Please contact the coach or choose another coach.';
  END IF;
  v_end := p_starts_at + make_interval(hours=>p_duration_hours);
  v_local := p_starts_at AT TIME ZONE 'Asia/Manila';
  v_dow := extract(dow FROM v_local)::integer;
  -- Serialize all booking attempts for this coach so overlapping start times cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('coach-slot:' || p_coach_id::text));
  IF NOT EXISTS(SELECT 1 FROM public.coach_availability a WHERE a.coach_id=p_coach_id AND a.weekday=v_dow AND a.is_active
    AND v_local::time >= a.start_time AND (v_local::time + make_interval(hours=>p_duration_hours)) <= a.end_time
    AND mod((extract(epoch FROM (v_local::time-a.start_time))::integer / 60),a.slot_minutes)=0) THEN
    RAISE EXCEPTION 'That time is outside the coach''s available schedule';
  END IF;
  IF EXISTS(SELECT 1 FROM public.coaching_bookings b WHERE b.coach_id=p_coach_id
    AND b.booking_status IN ('pending_payment','awaiting_verification','confirmed')
    AND (b.expires_at IS NULL OR b.expires_at>now())
    AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,v_end,'[)')) THEN
    RAISE EXCEPTION 'That coaching slot has just been taken. Please choose another time';
  END IF;
  IF EXISTS(SELECT 1 FROM public.coach_blocked_slots x WHERE x.coach_id=p_coach_id AND tstzrange(x.starts_at,x.ends_at,'[)') && tstzrange(p_starts_at,v_end,'[)')) THEN
    RAISE EXCEPTION 'The coach is unavailable during that time';
  END IF;
  v_ref := 'CO-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,9));
  INSERT INTO public.coaching_bookings(booking_reference,coach_id,player_id,coach_name_snapshot,coach_slug_snapshot,sport_snapshot,starts_at,ends_at,duration_hours,hourly_rate,subtotal,coach_transaction_fee,payment_status,booking_status,expires_at)
  VALUES(v_ref,p_coach_id,auth.uid(),v_coach.coach_name,v_coach.slug,v_coach.sport,p_starts_at,v_end,p_duration_hours,v_coach.hourly_rate,v_coach.hourly_rate*p_duration_hours,50,'pending','pending_payment',now()+interval '20 minutes')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('booking_id',v_id,'booking_reference',v_ref,'coach_name',v_coach.coach_name,
    'hourly_rate',v_coach.hourly_rate,'duration_hours',p_duration_hours,'subtotal',v_coach.hourly_rate*p_duration_hours,
    'player_total',v_coach.hourly_rate*p_duration_hours,'coach_transaction_fee',50,
    'fee_payer','coach','payment_provider',v_coach.payment_provider,'payment_account_name',v_coach.payment_account_name,
    'payment_account_number',v_coach.payment_account_number,'payment_qr_path',v_coach.payment_qr_path,
    'payment_instructions',v_coach.payment_instructions,'expires_at',now()+interval '20 minutes');
END; $$;
REVOKE ALL ON FUNCTION public.create_coaching_booking(uuid,timestamptz,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_coaching_booking(uuid,timestamptz,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_coaching_booking_payment(p_booking_id uuid,p_payment_reference text,p_receipt_path text DEFAULT NULL,p_player_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_booking public.coaching_bookings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in to submit payment'; END IF;
  IF NULLIF(trim(p_payment_reference),'') IS NULL THEN RAISE EXCEPTION 'Enter your payment reference number'; END IF;
  SELECT * INTO v_booking FROM public.coaching_bookings WHERE id=p_booking_id AND player_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Coaching booking not found'; END IF;
  IF v_booking.booking_status <> 'pending_payment' OR (v_booking.expires_at IS NOT NULL AND v_booking.expires_at<now()) THEN
    RAISE EXCEPTION 'This payment request has expired. Please select the slot again';
  END IF;
  IF p_receipt_path IS NOT NULL THEN
    IF split_part(p_receipt_path,'/',1)<>auth.uid()::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='courtly-coach-payment-receipts' AND name=p_receipt_path) THEN
      RAISE EXCEPTION 'Uploaded payment proof could not be verified';
    END IF;
  END IF;
  UPDATE public.coaching_bookings SET payment_reference=trim(p_payment_reference),receipt_path=p_receipt_path,
    player_note=NULLIF(trim(p_player_note),''),payment_status='awaiting_verification',booking_status='awaiting_verification',expires_at=NULL,updated_at=now()
  WHERE id=p_booking_id;
  RETURN jsonb_build_object('success',true,'booking_reference',v_booking.booking_reference,'status','awaiting_verification');
END; $$;
REVOKE ALL ON FUNCTION public.submit_coaching_booking_payment(uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_coaching_booking_payment(uuid,text,text,text) TO authenticated;



-- Public, limited payment instructions for an already-published coach.
-- Do not expose internal billing data or unrelated private profile fields.
CREATE OR REPLACE FUNCTION public.get_public_coach_payment_details(p_coach_id uuid)
RETURNS TABLE(payment_provider text, payment_account_name text, payment_account_number text,
              payment_qr_path text, payment_instructions text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT cp.payment_provider, cp.payment_account_name, cp.payment_account_number,
         cp.payment_qr_path, cp.payment_instructions
  FROM public.coach_profiles cp
  WHERE cp.id=p_coach_id AND cp.is_published=true AND cp.billing_status='active'
    AND cp.payment_provider IS NOT NULL
    AND (cp.payment_qr_path IS NOT NULL OR cp.payment_account_number IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.get_public_coach_payment_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_coach_payment_details(uuid) TO anon,authenticated;

-- ---------------------------------------------------------------------------
-- 6) Coach fee ledger, weekly invoices and remittances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coach_fee_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES public.coaching_bookings(id) ON DELETE RESTRICT,
  fee_type text NOT NULL CHECK (fee_type IN ('coaching_session_fee','coaching_session_credit')),
  description text NOT NULL,
  fee_amount numeric(12,2) NOT NULL CHECK (fee_amount<>0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id,fee_type)
);
CREATE INDEX IF NOT EXISTS coach_fee_ledger_due_idx ON public.coach_fee_ledger(coach_id,occurred_at) WHERE invoice_id IS NULL;
CREATE TABLE IF NOT EXISTS public.coach_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  amount_due numeric(12,2) NOT NULL CHECK (amount_due>=0),
  amount_paid numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid>=0),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partially_paid','paid','overdue','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(due_at=issued_at+interval '72 hours')
);
ALTER TABLE public.coach_fee_ledger ADD CONSTRAINT coach_fee_ledger_invoice_fk FOREIGN KEY(invoice_id) REFERENCES public.coach_invoices(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS public.coach_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.coach_invoices(id) ON DELETE CASCADE,
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES public.coach_fee_ledger(id) ON DELETE RESTRICT,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.coach_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.coach_invoices(id) ON DELETE RESTRICT,
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount>0),
  payment_method text NOT NULL,
  payment_reference text NOT NULL,
  proof_path text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  coach_note text,
  admin_note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_remittance_reference_unique_idx ON public.coach_remittances(lower(trim(payment_method)),lower(trim(payment_reference)));

ALTER TABLE public.coach_fee_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_remittances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_fee_ledger,public.coach_invoices,public.coach_invoice_lines,public.coach_remittances FROM anon,authenticated;
GRANT SELECT ON public.coach_fee_ledger,public.coach_invoices,public.coach_invoice_lines,public.coach_remittances TO authenticated;
DROP POLICY IF EXISTS coach_fee_ledger_owner_read ON public.coach_fee_ledger;
CREATE POLICY coach_fee_ledger_owner_read ON public.coach_fee_ledger FOR SELECT TO authenticated USING(coach_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS coach_invoices_owner_read ON public.coach_invoices;
CREATE POLICY coach_invoices_owner_read ON public.coach_invoices FOR SELECT TO authenticated USING(coach_id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS coach_invoice_lines_owner_read ON public.coach_invoice_lines;
CREATE POLICY coach_invoice_lines_owner_read ON public.coach_invoice_lines FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.coach_invoices i WHERE i.id=invoice_id AND (i.coach_id=auth.uid() OR public.is_courtly_admin())));
DROP POLICY IF EXISTS coach_remittances_owner_read ON public.coach_remittances;
CREATE POLICY coach_remittances_owner_read ON public.coach_remittances FOR SELECT TO authenticated USING(coach_id=auth.uid() OR public.is_courtly_admin());


CREATE OR REPLACE FUNCTION public.courtly_record_coach_session_fee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.payment_status='confirmed' AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    INSERT INTO public.coach_fee_ledger(coach_id,booking_id,fee_type,description,fee_amount,occurred_at)
    VALUES(NEW.coach_id,NEW.id,'coaching_session_fee','Courtly coaching session transaction fee · '||NEW.booking_reference,50,now())
    ON CONFLICT(booking_id,fee_type) DO NOTHING;
  END IF;
  IF NEW.payment_status='refunded' AND OLD.payment_status='confirmed' THEN
    INSERT INTO public.coach_fee_ledger(coach_id,booking_id,fee_type,description,fee_amount,occurred_at)
    VALUES(NEW.coach_id,NEW.id,'coaching_session_credit','Credit for refunded coaching session · '||NEW.booking_reference,-50,now())
    ON CONFLICT(booking_id,fee_type) DO NOTHING;
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS courtly_record_coach_session_fee ON public.coaching_bookings;
CREATE TRIGGER courtly_record_coach_session_fee BEFORE UPDATE OF payment_status ON public.coaching_bookings
FOR EACH ROW EXECUTE FUNCTION public.courtly_record_coach_session_fee();

CREATE OR REPLACE FUNCTION public.review_coaching_booking(p_booking_id uuid,p_decision text,p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_booking public.coaching_bookings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in as the coach'; END IF;
  IF p_decision NOT IN ('confirmed','rejected') THEN RAISE EXCEPTION 'Invalid payment decision'; END IF;
  SELECT * INTO v_booking FROM public.coaching_bookings WHERE id=p_booking_id AND coach_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Coaching session not found'; END IF;
  IF v_booking.payment_status=p_decision THEN RETURN jsonb_build_object('success',true,'already_processed',true,'status',p_decision); END IF;
  IF v_booking.payment_status<>'awaiting_verification' THEN RAISE EXCEPTION 'This coaching payment has already been processed'; END IF;
  UPDATE public.coaching_bookings SET payment_status=p_decision,
    booking_status=CASE WHEN p_decision='confirmed' THEN 'confirmed' ELSE 'rejected' END,
    coach_note=COALESCE(NULLIF(trim(p_note),''),coach_note),confirmed_at=CASE WHEN p_decision='confirmed' THEN now() ELSE confirmed_at END,
    updated_at=now() WHERE id=p_booking_id;
  RETURN jsonb_build_object('success',true,'already_processed',false,'status',p_decision,'coach_transaction_fee',CASE WHEN p_decision='confirmed' THEN 50 ELSE 0 END);
END; $$;
REVOKE ALL ON FUNCTION public.review_coaching_booking(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_coaching_booking(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_coaching_booking(p_booking_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
BEGIN
  UPDATE public.coaching_bookings SET booking_status='completed',completed_at=now(),updated_at=now()
  WHERE id=p_booking_id AND coach_id=auth.uid() AND payment_status='confirmed' AND starts_at<=now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Only your confirmed sessions that have started can be marked completed'; END IF;
  RETURN jsonb_build_object('success',true,'status','completed');
END; $$;
REVOKE ALL ON FUNCTION public.complete_coaching_booking(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_coaching_booking(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.get_coach_sessions()
RETURNS TABLE(
  id uuid,booking_reference text,player_id uuid,player_name text,player_skill text,starts_at timestamptz,ends_at timestamptz,
  duration_hours integer,hourly_rate numeric,subtotal numeric,coach_transaction_fee numeric,payment_status text,booking_status text,
  payment_reference text,receipt_path text,player_note text,coach_note text,created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT b.id,b.booking_reference,b.player_id,
    COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player'),pp.skill_level,
    b.starts_at,b.ends_at,b.duration_hours,b.hourly_rate,b.subtotal,b.coach_transaction_fee,b.payment_status,b.booking_status,
    b.payment_reference,b.receipt_path,b.player_note,b.coach_note,b.created_at
  FROM public.coaching_bookings b
  LEFT JOIN public.player_profiles pp ON pp.id=b.player_id
  WHERE b.coach_id=auth.uid() AND public.courtly_is_coach(auth.uid())
  ORDER BY b.starts_at DESC;
$$;
REVOKE ALL ON FUNCTION public.get_coach_sessions() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_coach_sessions() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_coaching_sessions()
RETURNS TABLE(
  id uuid,booking_reference text,coach_id uuid,coach_name text,coach_slug text,sport text,starts_at timestamptz,ends_at timestamptz,
  duration_hours integer,hourly_rate numeric,subtotal numeric,payment_status text,booking_status text,payment_reference text,created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT b.id,b.booking_reference,b.coach_id,b.coach_name_snapshot,b.coach_slug_snapshot,b.sport_snapshot,b.starts_at,b.ends_at,
    b.duration_hours,b.hourly_rate,b.subtotal,b.payment_status,b.booking_status,b.payment_reference,b.created_at
  FROM public.coaching_bookings b WHERE b.player_id=auth.uid() ORDER BY b.starts_at DESC;
$$;
REVOKE ALL ON FUNCTION public.get_my_coaching_sessions() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_coaching_sessions() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_coach_conversations()
RETURNS TABLE(conversation_id uuid,coach_id uuid,player_id uuid,coach_name text,player_name text,last_message_at timestamptz,unread_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT c.id,c.coach_id,c.player_id,cp.coach_name,
    COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player'),c.last_message_at,
    (SELECT count(*)::bigint FROM public.coach_messages m WHERE m.conversation_id=c.id AND m.sender_id<>auth.uid() AND m.read_at IS NULL)
  FROM public.coach_conversations c
  JOIN public.coach_profiles cp ON cp.id=c.coach_id
  JOIN public.player_profiles pp ON pp.id=c.player_id
  WHERE c.coach_id=auth.uid() OR c.player_id=auth.uid()
  ORDER BY c.last_message_at DESC;
$$;
REVOKE ALL ON FUNCTION public.get_my_coach_conversations() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_coach_conversations() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_coach_chat_messages(p_conversation_id uuid)
RETURNS TABLE(message_id uuid,sender_id uuid,sender_name text,body text,created_at timestamptz,is_mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT m.id,m.sender_id,
    CASE WHEN m.sender_id=c.coach_id THEN cp.coach_name ELSE COALESCE(NULLIF(trim(pp.player_name),''),NULLIF(trim(pp.full_name),''),'Courtly Player') END,
    m.body,m.created_at,m.sender_id=auth.uid()
  FROM public.coach_messages m
  JOIN public.coach_conversations c ON c.id=m.conversation_id
  JOIN public.coach_profiles cp ON cp.id=c.coach_id
  JOIN public.player_profiles pp ON pp.id=c.player_id
  WHERE m.conversation_id=p_conversation_id AND (c.coach_id=auth.uid() OR c.player_id=auth.uid())
  ORDER BY m.created_at ASC LIMIT 300;
$$;
REVOKE ALL ON FUNCTION public.get_coach_chat_messages(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_coach_chat_messages(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_weekly_courtly_coach_invoices()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_coach record; v_invoice_id uuid; v_total numeric(12,2); v_count integer:=0;
BEGIN
  FOR v_coach IN SELECT DISTINCT coach_id FROM public.coach_fee_ledger WHERE invoice_id IS NULL ORDER BY coach_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('coach-billing:'||v_coach.coach_id::text));
    SELECT COALESCE(sum(fee_amount),0)::numeric(12,2) INTO v_total FROM public.coach_fee_ledger WHERE coach_id=v_coach.coach_id AND invoice_id IS NULL;
    IF v_total<=0 THEN CONTINUE; END IF;
    INSERT INTO public.coach_invoices(invoice_number,coach_id,period_start,period_end,issued_at,due_at,amount_due)
    VALUES('CC-'||to_char(now() AT TIME ZONE 'Asia/Manila','YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,5)),v_coach.coach_id,
      COALESCE((SELECT min(occurred_at) FROM public.coach_fee_ledger WHERE coach_id=v_coach.coach_id AND invoice_id IS NULL),now()),now(),now(),now()+interval '72 hours',v_total)
    RETURNING id INTO v_invoice_id;
    INSERT INTO public.coach_invoice_lines(invoice_id,ledger_entry_id,description,amount)
    SELECT v_invoice_id,id,description,fee_amount FROM public.coach_fee_ledger WHERE coach_id=v_coach.coach_id AND invoice_id IS NULL;
    UPDATE public.coach_fee_ledger SET invoice_id=v_invoice_id,invoiced_at=now() WHERE coach_id=v_coach.coach_id AND invoice_id IS NULL;
    v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('success',true,'invoices_created',v_count,'created_at',now());
END; $$;
REVOKE ALL ON FUNCTION public.generate_weekly_courtly_coach_invoices() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.generate_weekly_courtly_coach_invoices() TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_overdue_courtly_coaches()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_suspended integer:=0; v_reactivated integer:=0;
BEGIN
  WITH overdue AS (
    SELECT DISTINCT i.coach_id FROM public.coach_invoices i
    WHERE i.status<>'void' AND i.amount_due>i.amount_paid AND i.due_at<=now()
  )
  UPDATE public.coach_profiles cp SET billing_was_published=cp.is_published,is_published=false,billing_status='suspended',billing_suspended_at=now(),
    billing_suspend_reason='An outstanding Courtly coach invoice was not remitted within 72 hours.'
  FROM overdue o WHERE cp.id=o.coach_id AND cp.billing_status<>'suspended';
  GET DIAGNOSTICS v_suspended=ROW_COUNT;
  UPDATE public.coach_profiles cp SET billing_status='active',is_published=cp.billing_was_published,billing_suspended_at=NULL,billing_suspend_reason=NULL,billing_was_published=false
  WHERE cp.billing_status='suspended' AND NOT EXISTS(SELECT 1 FROM public.coach_invoices i WHERE i.coach_id=cp.id AND i.status<>'void' AND i.amount_due>i.amount_paid);
  GET DIAGNOSTICS v_reactivated=ROW_COUNT;
  RETURN jsonb_build_object('success',true,'coaches_suspended',v_suspended,'coaches_reactivated',v_reactivated,'checked_at',now());
END; $$;
REVOKE ALL ON FUNCTION public.enforce_overdue_courtly_coaches() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_overdue_courtly_coaches() TO service_role;

CREATE OR REPLACE FUNCTION public.get_coach_billing()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_profile public.coach_profiles%ROWTYPE; v_settings public.courtly_platform_settings%ROWTYPE; v_balance numeric(12,2); v_invoices jsonb; v_remittances jsonb; v_ledger jsonb; v_accrued numeric(12,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in as a coach'; END IF;
  SELECT * INTO v_profile FROM public.coach_profiles WHERE id=auth.uid(); IF NOT FOUND THEN RAISE EXCEPTION 'Coach profile not found'; END IF;
  SELECT * INTO v_settings FROM public.courtly_platform_settings WHERE singleton=true;
  SELECT COALESCE(sum(amount_due-amount_paid),0)::numeric(12,2) INTO v_balance FROM public.coach_invoices WHERE coach_id=auth.uid() AND status<>'void' AND amount_due>amount_paid;
  SELECT COALESCE(sum(fee_amount),0)::numeric(12,2) INTO v_accrued FROM public.coach_fee_ledger WHERE coach_id=auth.uid() AND invoice_id IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'invoice_number',i.invoice_number,'issued_at',i.issued_at,'due_at',i.due_at,'amount_due',i.amount_due,'amount_paid',i.amount_paid,'balance',i.amount_due-i.amount_paid,'status',i.status,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('description',l.description,'amount',l.amount) ORDER BY l.created_at) FROM public.coach_invoice_lines l WHERE l.invoice_id=i.id),'[]'::jsonb)) ORDER BY i.issued_at DESC),'[]'::jsonb)
    INTO v_invoices FROM public.coach_invoices i WHERE i.coach_id=auth.uid();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'invoice_id',r.invoice_id,'amount',r.amount,'payment_method',r.payment_method,'payment_reference',r.payment_reference,'status',r.status,'coach_note',r.coach_note,'admin_note',r.admin_note,'submitted_at',r.submitted_at) ORDER BY r.submitted_at DESC),'[]'::jsonb)
    INTO v_remittances FROM public.coach_remittances r WHERE r.coach_id=auth.uid();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'description',l.description,'fee_amount',l.fee_amount,'occurred_at',l.occurred_at,'invoice_id',l.invoice_id) ORDER BY l.occurred_at DESC),'[]'::jsonb)
    INTO v_ledger FROM (SELECT * FROM public.coach_fee_ledger WHERE coach_id=auth.uid() ORDER BY occurred_at DESC LIMIT 100) l;
  RETURN jsonb_build_object('balance',v_balance,'accrued_uninvoiced',v_accrued,'billing_status',v_profile.billing_status,'invoices',v_invoices,'remittances',v_remittances,'ledger',v_ledger,
    'payment_settings',jsonb_build_object('payment_method',v_settings.payment_method,'payment_account_name',v_settings.payment_account_name,'payment_account_number',v_settings.payment_account_number,'payment_qr_url',v_settings.payment_qr_url,'payment_instructions',v_settings.payment_instructions));
END; $$;
REVOKE ALL ON FUNCTION public.get_coach_billing() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_coach_billing() TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_coach_remittance(p_invoice_id uuid,p_amount numeric,p_payment_method text,p_payment_reference text,p_proof_path text DEFAULT NULL,p_coach_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_invoice public.coach_invoices%ROWTYPE; v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_is_coach(auth.uid()) THEN RAISE EXCEPTION 'Sign in with your coach account to submit payment'; END IF;
  IF p_amount IS NULL OR p_amount<=0 OR NULLIF(trim(p_payment_reference),'') IS NULL OR NULLIF(trim(p_payment_method),'') IS NULL THEN RAISE EXCEPTION 'Enter the amount, payment method and reference number'; END IF;
  SELECT * INTO v_invoice FROM public.coach_invoices WHERE id=p_invoice_id AND coach_id=auth.uid() FOR UPDATE;
  IF NOT FOUND OR v_invoice.status='void' THEN RAISE EXCEPTION 'Coach invoice not found'; END IF;
  IF p_amount>v_invoice.amount_due-v_invoice.amount_paid THEN RAISE EXCEPTION 'Remittance exceeds the invoice balance'; END IF;
  IF p_proof_path IS NOT NULL AND (split_part(p_proof_path,'/',1)<>auth.uid()::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='courtly-coach-remittance-proofs' AND name=p_proof_path)) THEN RAISE EXCEPTION 'Remittance proof was not found'; END IF;
  INSERT INTO public.coach_remittances(invoice_id,coach_id,amount,payment_method,payment_reference,proof_path,coach_note)
  VALUES(p_invoice_id,auth.uid(),p_amount,trim(p_payment_method),trim(p_payment_reference),p_proof_path,NULLIF(trim(p_coach_note),'')) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'remittance_id',v_id,'status','submitted');
END; $$;
REVOKE ALL ON FUNCTION public.submit_coach_remittance(uuid,numeric,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_coach_remittance(uuid,numeric,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_courtly_admin_coach_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_coaches jsonb; v_invoices jsonb; v_remittances jsonb;
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cp.id,'coach_name',cp.coach_name,'email',cp.email,'sport',cp.sport,'city',cp.city,'hourly_rate',cp.hourly_rate,'is_published',cp.is_published,'is_verified',cp.is_verified,'billing_status',cp.billing_status,'created_at',cp.created_at) ORDER BY cp.created_at DESC),'[]'::jsonb) INTO v_coaches FROM public.coach_profiles cp;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'invoice_number',i.invoice_number,'coach_id',i.coach_id,'coach_name',cp.coach_name,'issued_at',i.issued_at,'due_at',i.due_at,'amount_due',i.amount_due,'amount_paid',i.amount_paid,'status',i.status) ORDER BY i.issued_at DESC),'[]'::jsonb) INTO v_invoices FROM public.coach_invoices i JOIN public.coach_profiles cp ON cp.id=i.coach_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'invoice_id',r.invoice_id,'coach_id',r.coach_id,'coach_name',cp.coach_name,'amount',r.amount,'payment_method',r.payment_method,'payment_reference',r.payment_reference,'status',r.status,'submitted_at',r.submitted_at,'proof_path',r.proof_path) ORDER BY r.submitted_at DESC),'[]'::jsonb) INTO v_remittances FROM public.coach_remittances r JOIN public.coach_profiles cp ON cp.id=r.coach_id;
  RETURN jsonb_build_object('coaches',v_coaches,'invoices',v_invoices,'remittances',v_remittances);
END; $$;
REVOKE ALL ON FUNCTION public.get_courtly_admin_coach_data() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_courtly_admin_coach_data() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_coach_verification(p_coach_id uuid,p_verified boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  UPDATE public.coach_profiles SET is_verified=COALESCE(p_verified,false),verified_at=CASE WHEN p_verified THEN now() ELSE NULL END,verified_by=CASE WHEN p_verified THEN auth.uid() ELSE NULL END,updated_at=now() WHERE id=p_coach_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Coach not found'; END IF;
  RETURN jsonb_build_object('success',true,'is_verified',p_verified);
END; $$;
REVOKE ALL ON FUNCTION public.admin_set_coach_verification(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_set_coach_verification(uuid,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_coach_remittance(p_remittance_id uuid,p_decision text,p_admin_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_remittance public.coach_remittances%ROWTYPE; v_invoice public.coach_invoices%ROWTYPE; v_new_paid numeric(12,2);
BEGIN
  IF NOT public.is_courtly_admin() THEN RAISE EXCEPTION 'Courtly administrator access required'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid remittance decision'; END IF;
  SELECT * INTO v_remittance FROM public.coach_remittances WHERE id=p_remittance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Remittance not found'; END IF;
  IF v_remittance.status=p_decision THEN RETURN jsonb_build_object('success',true,'already_processed',true,'status',p_decision); END IF;
  IF v_remittance.status<>'submitted' THEN RAISE EXCEPTION 'Remittance was already reviewed'; END IF;
  SELECT * INTO v_invoice FROM public.coach_invoices WHERE id=v_remittance.invoice_id FOR UPDATE;
  IF p_decision='approved' THEN
    v_new_paid:=v_invoice.amount_paid+v_remittance.amount;
    IF v_new_paid>v_invoice.amount_due THEN RAISE EXCEPTION 'Approved remittance exceeds invoice amount'; END IF;
    UPDATE public.coach_invoices SET amount_paid=v_new_paid,status=CASE WHEN v_new_paid>=amount_due THEN 'paid' WHEN v_new_paid>0 THEN 'partially_paid' ELSE status END WHERE id=v_invoice.id;
  END IF;
  UPDATE public.coach_remittances SET status=p_decision,admin_note=NULLIF(trim(p_admin_note),''),reviewed_at=now(),reviewed_by=auth.uid() WHERE id=p_remittance_id;
  IF p_decision='approved' THEN
    UPDATE public.coach_profiles cp SET billing_status='active',is_published=cp.billing_was_published,billing_was_published=false,billing_suspended_at=NULL,billing_suspend_reason=NULL
    WHERE cp.id=v_invoice.coach_id AND cp.billing_status='suspended'
      AND NOT EXISTS(SELECT 1 FROM public.coach_invoices i WHERE i.coach_id=cp.id AND i.status<>'void' AND i.amount_due>i.amount_paid);
  END IF;
  RETURN jsonb_build_object('success',true,'status',p_decision);
END; $$;
REVOKE ALL ON FUNCTION public.review_coach_remittance(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_coach_remittance(uuid,text,text) TO authenticated;

-- Coach terms acceptance (separate from venue-owner terms).
CREATE TABLE IF NOT EXISTS public.courtly_coach_terms_acceptance (
  coach_id uuid NOT NULL REFERENCES public.coach_profiles(id) ON DELETE CASCADE,
  terms_version text NOT NULL DEFAULT '2026-11-05-coach-v1',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(coach_id,terms_version)
);
ALTER TABLE public.courtly_coach_terms_acceptance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.courtly_coach_terms_acceptance FROM anon,authenticated;
GRANT SELECT,INSERT ON public.courtly_coach_terms_acceptance TO authenticated;
DROP POLICY IF EXISTS coach_terms_self_read ON public.courtly_coach_terms_acceptance;
CREATE POLICY coach_terms_self_read ON public.courtly_coach_terms_acceptance FOR SELECT TO authenticated USING(coach_id=auth.uid());
DROP POLICY IF EXISTS coach_terms_self_insert ON public.courtly_coach_terms_acceptance;
CREATE POLICY coach_terms_self_insert ON public.courtly_coach_terms_acceptance FOR INSERT TO authenticated WITH CHECK(coach_id=auth.uid() AND public.courtly_is_coach(auth.uid()));

CREATE OR REPLACE FUNCTION public.accept_courtly_coach_terms()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_is_coach(auth.uid()) THEN RAISE EXCEPTION 'Sign in as a coach to accept these terms'; END IF;
  INSERT INTO public.courtly_coach_terms_acceptance(coach_id,terms_version) VALUES(auth.uid(),'2026-11-05-coach-v1') ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('success',true,'terms_version','2026-11-05-coach-v1');
END; $$;
REVOKE ALL ON FUNCTION public.accept_courtly_coach_terms() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.accept_courtly_coach_terms() TO authenticated;

-- Billing proof bucket for coach remittances.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('courtly-coach-remittance-proofs','courtly-coach-remittance-proofs',false,10485760,ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=10485760,allowed_mime_types=EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS coach_remittance_proof_upload ON storage.objects;
CREATE POLICY coach_remittance_proof_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='courtly-coach-remittance-proofs' AND split_part(name,'/',1)=auth.uid()::text AND public.courtly_is_coach(auth.uid()));
DROP POLICY IF EXISTS coach_remittance_proof_read ON storage.objects;
CREATE POLICY coach_remittance_proof_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='courtly-coach-remittance-proofs' AND (split_part(name,'/',1)=auth.uid()::text OR public.is_courtly_admin()));

-- Coach-only community author support and media avatars.
CREATE OR REPLACE FUNCTION public.courtly_community_can_post(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS(SELECT 1 FROM public.player_profiles pp WHERE pp.id=p_user_id)
    OR EXISTS(SELECT 1 FROM public.venues v WHERE v.owner_id=p_user_id)
    OR EXISTS(SELECT 1 FROM public.coach_profiles cp WHERE cp.id=p_user_id)
  );
$$;
REVOKE ALL ON FUNCTION public.courtly_community_can_post(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.courtly_community_can_post(uuid) TO authenticated;


-- Extend the existing Community author model to verified coach accounts.
ALTER TABLE public.community_posts DROP CONSTRAINT IF EXISTS community_posts_author_type_check;
ALTER TABLE public.community_posts ADD CONSTRAINT community_posts_author_type_check
  CHECK (author_type IN ('player','venue_owner','coach'));

CREATE OR REPLACE FUNCTION public.courtly_can_view_community_post(p_post_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_posts p
    WHERE p.id=p_post_id AND public.courtly_community_can_post(auth.uid()) AND p.status='published'
      AND (p.author_type='venue_owner' OR p.author_id=auth.uid()
        OR (p.author_type='player' AND public.courtly_player_profile_is_public(p.author_id))
        OR (p.author_type='coach' AND public.courtly_coach_profile_is_public(p.author_id)))
  );
$$;
CREATE OR REPLACE FUNCTION public.courtly_can_read_community_media(p_object_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.community_posts p
    WHERE p.media_path=p_object_name AND public.courtly_community_can_post(auth.uid()) AND p.status='published'
      AND (p.author_type='venue_owner' OR p.author_id=auth.uid()
        OR (p.author_type='player' AND public.courtly_player_profile_is_public(p.author_id))
        OR (p.author_type='coach' AND public.courtly_coach_profile_is_public(p.author_id)))
  );
$$;

CREATE OR REPLACE FUNCTION public.courtly_prepare_community_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_venue_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.courtly_community_can_post(auth.uid()) THEN
    RAISE EXCEPTION 'Sign in with a Courtly player, coach or venue-owner account to post';
  END IF;
  NEW.author_id:=auth.uid();
  IF EXISTS(SELECT 1 FROM public.player_profiles pp WHERE pp.id=auth.uid()) THEN
    NEW.author_type:='player'; NEW.venue_id:=NULL;
  ELSIF EXISTS(SELECT 1 FROM public.coach_profiles cp WHERE cp.id=auth.uid()) THEN
    NEW.author_type:='coach'; NEW.venue_id:=NULL;
  ELSE
    IF NEW.venue_id IS NOT NULL THEN
      SELECT v.id INTO v_venue_id FROM public.venues v WHERE v.id=NEW.venue_id AND v.owner_id=auth.uid();
    ELSE
      SELECT v.id INTO v_venue_id FROM public.venues v WHERE v.owner_id=auth.uid() ORDER BY v.created_at ASC LIMIT 1;
    END IF;
    IF v_venue_id IS NULL THEN RAISE EXCEPTION 'Your owner account must have a linked venue before posting'; END IF;
    NEW.author_type:='venue_owner'; NEW.venue_id:=v_venue_id;
  END IF;
  IF NEW.media_path IS NOT NULL AND split_part(NEW.media_path,'/',1)<>auth.uid()::text THEN
    RAISE EXCEPTION 'Community media must belong to your signed-in account';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.get_community_feed(
  p_limit integer DEFAULT 30,p_offset integer DEFAULT 0,p_post_id uuid DEFAULT NULL
)
RETURNS TABLE (
  post_id uuid,author_id uuid,author_type text,author_name text,author_avatar_path text,venue_name text,
  body text,media_path text,media_type text,created_at timestamptz,likes_count bigint,comments_count bigint,
  shares_count bigint,viewer_liked boolean,viewer_can_delete boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
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
  WHERE public.courtly_community_can_post(auth.uid()) AND (p_post_id IS NULL OR p.id=p_post_id) AND p.status='published'
    AND (p.author_type='venue_owner' OR p.author_id=auth.uid()
      OR (p.author_type='player' AND public.courtly_player_profile_is_public(p.author_id))
      OR (p.author_type='coach' AND public.courtly_coach_profile_is_public(p.author_id)))
  ORDER BY p.created_at DESC LIMIT GREATEST(1,LEAST(COALESCE(p_limit,30),50)) OFFSET GREATEST(COALESCE(p_offset,0),0);
$$;

CREATE OR REPLACE FUNCTION public.get_community_comments(p_post_id uuid)
RETURNS TABLE(comment_id uuid,author_type text,author_name text,author_avatar_path text,body text,created_at timestamptz,viewer_can_delete boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
  SELECT c.id,CASE WHEN pp.id IS NOT NULL THEN 'player' WHEN cp.id IS NOT NULL THEN 'coach' ELSE 'venue_owner' END,
    CASE WHEN pp.id IS NOT NULL THEN CASE WHEN pp.is_private=false OR pp.id=auth.uid() THEN COALESCE(NULLIF(trim(pp.player_name),''),'Courtly Player') ELSE 'Private Player' END
      WHEN cp.id IS NOT NULL THEN COALESCE(NULLIF(trim(cp.coach_name),''),'Courtly Coach')
      ELSE COALESCE(NULLIF(trim(v.owner_name),''),NULLIF(trim(v.name),''),'Courtly Venue') END,
    CASE WHEN pp.id IS NOT NULL THEN CASE WHEN pp.is_private=false OR pp.id=auth.uid() THEN pp.avatar_url ELSE NULL END
      WHEN cp.id IS NOT NULL THEN cp.profile_image_path ELSE v.logo_url END,
    c.body,c.created_at,c.author_id=auth.uid()
  FROM public.community_comments c JOIN public.community_posts p ON p.id=c.post_id
  LEFT JOIN public.player_profiles pp ON pp.id=c.author_id
  LEFT JOIN public.coach_profiles cp ON cp.id=c.author_id
  LEFT JOIN LATERAL (SELECT v1.owner_name,v1.name,v1.logo_url FROM public.venues v1 WHERE v1.owner_id=c.author_id ORDER BY v1.created_at LIMIT 1) v ON pp.id IS NULL AND cp.id IS NULL
  WHERE c.post_id=p_post_id AND public.courtly_community_can_post(auth.uid()) AND public.courtly_can_view_community_post(p_post_id)
  ORDER BY c.created_at ASC LIMIT 100;
$$;

-- Scheduling: Friday 09:00 Manila invoice generation; overdue enforcement every 5 minutes.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='cron') THEN
    BEGIN
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('courtly-weekly-coach-invoices','courtly-overdue-coach-enforcement');
      PERFORM cron.schedule('courtly-weekly-coach-invoices','0 1 * * 5','SELECT public.generate_weekly_courtly_coach_invoices();');
      PERFORM cron.schedule('courtly-overdue-coach-enforcement','*/5 * * * *','SELECT public.enforce_overdue_courtly_coaches();');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Coach billing cron jobs were not installed automatically: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'pg_cron is not enabled. Coach weekly invoice and overdue jobs must be scheduled after enabling pg_cron.';
  END IF;
END $$;

NOTIFY pgrst,'reload schema';
COMMIT;

-- Verification
SELECT 'coach_profiles' AS object_name, to_regclass('public.coach_profiles') IS NOT NULL AS installed
UNION ALL SELECT 'coach_availability',to_regclass('public.coach_availability') IS NOT NULL
UNION ALL SELECT 'coaching_bookings',to_regclass('public.coaching_bookings') IS NOT NULL
UNION ALL SELECT 'coach_fee_ledger',to_regclass('public.coach_fee_ledger') IS NOT NULL
UNION ALL SELECT 'coach_invoices',to_regclass('public.coach_invoices') IS NOT NULL;
