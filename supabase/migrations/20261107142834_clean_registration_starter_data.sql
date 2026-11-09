BEGIN;

-- Existing test/demo activity is intentionally removed so current and newly
-- registered accounts see a clean production workspace.
TRUNCATE TABLE
  public.courtly_checkout_request_keys,
  public.courtly_checkout_holds,
  public.open_play_registrations,
  public.open_play_events,
  public.bookings,
  public.court_blocks,
  public.community_activity_notifications,
  public.community_event_registrations,
  public.community_event_rsvps,
  public.community_events,
  public.community_comments,
  public.community_post_likes,
  public.community_post_shares,
  public.community_reports,
  public.community_posts,
  public.player_messages,
  public.player_conversations,
  public.player_follows,
  public.payment_receipts,
  public.courtly_delivery_jobs,
  public.courtly_billing_email_events,
  public.courtly_invoice_lines,
  public.courtly_remittances,
  public.courtly_fee_ledger,
  public.courtly_invoices
RESTART IDENTITY CASCADE;

-- Keep owner accounts, venue shells and court shells, but remove public/test state.
UPDATE public.venues
SET is_published = false,
    updated_at = clock_timestamp();

UPDATE public.courts
SET hourly_rate = 0,
    off_peak_rate = 0,
    peak_rate = 0,
    is_active = false,
    updated_at = clock_timestamp();

-- New courts should never arrive with a sample commercial rate.
ALTER TABLE public.courts ALTER COLUMN hourly_rate SET DEFAULT 0;
ALTER TABLE public.courts ALTER COLUMN off_peak_rate SET DEFAULT 0;
ALTER TABLE public.courts ALTER COLUMN peak_rate SET DEFAULT 0;
ALTER TABLE public.courts ALTER COLUMN is_active SET DEFAULT false;

CREATE OR REPLACE FUNCTION public.courtly_create_owner_venue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
  business_name text;
  business_address text;
  venue_sport text;
  requested_count text;
  court_total integer:=1;
  base_slug text;
  candidate_slug text;
  suffix integer:=2;
  new_venue_id uuid;
  i integer;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'account_type','') IN ('player','coach','club','sports_club','courtly_admin') THEN
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.venues WHERE owner_id=NEW.id) THEN
    RETURN NEW;
  END IF;

  business_name:=COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'business_name'),''),'My Courtly Venue');
  business_address:=NULLIF(trim(NEW.raw_user_meta_data->>'business_address'),'');
  venue_sport:=COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'sport'),''),'Multi-sport');
  requested_count:=COALESCE(NEW.raw_user_meta_data->>'court_count','1');
  court_total:=CASE
    WHEN requested_count IN ('4–5','4-5') THEN 4
    WHEN requested_count IN ('6–10','6-10') THEN 6
    WHEN requested_count='11+' THEN 11
    ELSE GREATEST(1,LEAST(50,COALESCE(NULLIF(regexp_replace(requested_count,'[^0-9]','','g'),'')::integer,1)))
  END;

  base_slug:=public.courtly_make_slug(business_name);
  PERFORM pg_advisory_xact_lock(hashtext(base_slug));
  candidate_slug:=base_slug;
  WHILE EXISTS(SELECT 1 FROM public.venues WHERE slug=candidate_slug) LOOP
    candidate_slug:=base_slug||'-'||suffix::text;
    suffix:=suffix+1;
  END LOOP;

  INSERT INTO public.venues(
    owner_id,slug,name,address,city,admin_email,owner_name,phone,sport,is_published
  ) VALUES(
    NEW.id,candidate_slug,business_name,business_address,
    NULLIF(trim(NEW.raw_user_meta_data->>'city'),''),
    NEW.email,
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_name'),''),
    NULLIF(trim(NEW.raw_user_meta_data->>'owner_phone'),''),
    venue_sport,
    false
  ) RETURNING id INTO new_venue_id;

  FOR i IN 1..court_total LOOP
    INSERT INTO public.courts(
      venue_id,name,sport,hourly_rate,off_peak_rate,peak_rate,is_active,display_order
    ) VALUES(
      new_venue_id,'Court '||i,venue_sport,0,0,0,false,i
    )
    ON CONFLICT(venue_id,name) DO NOTHING;
  END LOOP;

  RETURN NEW;
END
$function$;

NOTIFY pgrst,'reload schema';
COMMIT;