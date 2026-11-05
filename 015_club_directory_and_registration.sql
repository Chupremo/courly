-- Courtly club registration and public club directory
BEGIN;
CREATE TABLE IF NOT EXISTS public.club_profiles (
 id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 club_name text NOT NULL, slug text NOT NULL UNIQUE, email text NOT NULL DEFAULT '',
 phone text, sport text NOT NULL DEFAULT 'Multi-sport', city text NOT NULL DEFAULT '',
 location_text text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', website text,
 logo_url text, cover_url text, is_published boolean NOT NULL DEFAULT false,
 is_verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_profiles_public_idx ON public.club_profiles(is_published,city,sport,created_at DESC);
CREATE OR REPLACE FUNCTION public.courtly_create_club_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_temp AS $$
DECLARE v_name text; v_base text; v_slug text; v_suffix integer:=2;
BEGIN
 IF COALESCE(NEW.raw_user_meta_data->>'account_type','') NOT IN ('club','sports_club') THEN RETURN NEW; END IF;
 v_name:=COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'club_name'),''),'Sports Club');
 v_base:=trim(both '-' from regexp_replace(lower(v_name),'[^a-z0-9]+','-','g'));
 IF v_base='' THEN v_base:='sports-club'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('club-slug:'||v_base)); v_slug:=v_base;
 WHILE EXISTS(SELECT 1 FROM public.club_profiles WHERE slug=v_slug) LOOP v_slug:=v_base||'-'||v_suffix::text; v_suffix:=v_suffix+1; END LOOP;
 INSERT INTO public.club_profiles(id,club_name,slug,email,phone,sport,city,location_text,description,website)
 VALUES(NEW.id,v_name,v_slug,COALESCE(lower(NEW.email),''),NULLIF(trim(NEW.raw_user_meta_data->>'phone'),''),COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''),'Multi-sport'),COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'city'),''),''),COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'location_text'),''),''),COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'description'),''),''),NULLIF(trim(NEW.raw_user_meta_data->>'website'),''))
 ON CONFLICT(id) DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS courtly_create_club_profile_after_signup ON auth.users;
CREATE TRIGGER courtly_create_club_profile_after_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.courtly_create_club_profile();
-- The owner signup trigger must not create a venue for club accounts.
CREATE OR REPLACE FUNCTION public.courtly_create_owner_venue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,extensions AS $$
DECLARE business_name text; business_address text; venue_sport text; requested_count text; court_total integer:=1; base_slug text; candidate_slug text; suffix integer:=2; new_venue_id uuid; i integer;
BEGIN
 IF COALESCE(NEW.raw_user_meta_data->>'account_type','') IN ('player','coach','club','sports_club','courtly_admin') THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.venues WHERE owner_id=NEW.id) THEN RETURN NEW; END IF;
 business_name:=COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'business_name'),''),'My Courtly Venue'); business_address:=NULLIF(trim(NEW.raw_user_meta_data->>'business_address'),''); venue_sport:=COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''),'Multi-sport'); requested_count:=COALESCE(NEW.raw_user_meta_data->>'court_count','1');
 court_total:=CASE WHEN requested_count IN ('4–5','4-5') THEN 4 WHEN requested_count IN ('6–10','6-10') THEN 6 WHEN requested_count='11+' THEN 11 ELSE GREATEST(1,LEAST(50,COALESCE(NULLIF(regexp_replace(requested_count,'[^0-9]','','g'),'')::integer,1))) END;
 base_slug:=public.courtly_make_slug(business_name); PERFORM pg_advisory_xact_lock(hashtext(base_slug)); candidate_slug:=base_slug;
 WHILE EXISTS(SELECT 1 FROM public.venues WHERE slug=candidate_slug) LOOP candidate_slug:=base_slug||'-'||suffix::text; suffix:=suffix+1; END LOOP;
 INSERT INTO public.venues(owner_id,slug,name,address,city,admin_email,owner_name,phone,sport) VALUES(NEW.id,candidate_slug,business_name,business_address,NULLIF(trim(NEW.raw_user_meta_data->>'city'),''),NEW.email,NULLIF(trim(NEW.raw_user_meta_data->>'owner_name'),''),NULLIF(trim(NEW.raw_user_meta_data->>'owner_phone'),''),venue_sport) RETURNING id INTO new_venue_id;
 FOR i IN 1..court_total LOOP INSERT INTO public.courts(venue_id,name,sport,hourly_rate,is_active,display_order) VALUES(new_venue_id,'Court '||i,venue_sport,350,true,i) ON CONFLICT(venue_id,name) DO NOTHING; END LOOP;
 RETURN NEW;
END $$;
ALTER TABLE public.club_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.club_profiles TO anon,authenticated;
GRANT UPDATE ON public.club_profiles TO authenticated;
DROP POLICY IF EXISTS club_public_directory ON public.club_profiles;
CREATE POLICY club_public_directory ON public.club_profiles FOR SELECT TO anon,authenticated USING(is_published=true OR id=auth.uid() OR public.is_courtly_admin());
DROP POLICY IF EXISTS club_update_own_profile ON public.club_profiles;
CREATE POLICY club_update_own_profile ON public.club_profiles FOR UPDATE TO authenticated USING(id=auth.uid()) WITH CHECK(id=auth.uid());
COMMIT;
