-- Courtly admin coach marketplace cards
-- Adds the coach media/profile fields needed by admin-coaches.html's marketplace-style cards.
-- Safe to run after 014_coach_marketplace_and_portal.sql.

CREATE OR REPLACE FUNCTION public.get_courtly_admin_coach_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,auth,pg_temp
AS $$
DECLARE
  v_coaches jsonb;
  v_invoices jsonb;
  v_remittances jsonb;
BEGIN
  IF NOT public.is_courtly_admin() THEN
    RAISE EXCEPTION 'Courtly administrator access required';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',cp.id,
        'coach_name',cp.coach_name,
        'slug',cp.slug,
        'email',cp.email,
        'sport',cp.sport,
        'city',cp.city,
        'location_text',cp.location_text,
        'coaching_bio',cp.coaching_bio,
        'experience_years',cp.experience_years,
        'hourly_rate',cp.hourly_rate,
        'profile_image_path',cp.profile_image_path,
        'cover_image_path',cp.cover_image_path,
        'is_published',cp.is_published,
        'is_verified',cp.is_verified,
        'billing_status',cp.billing_status,
        'created_at',cp.created_at
      )
      ORDER BY cp.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_coaches
  FROM public.coach_profiles cp;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',i.id,'invoice_number',i.invoice_number,'coach_id',i.coach_id,
        'coach_name',cp.coach_name,'issued_at',i.issued_at,'due_at',i.due_at,
        'amount_due',i.amount_due,'amount_paid',i.amount_paid,'status',i.status
      )
      ORDER BY i.issued_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_invoices
  FROM public.coach_invoices i
  JOIN public.coach_profiles cp ON cp.id=i.coach_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',r.id,'invoice_id',r.invoice_id,'coach_id',r.coach_id,
        'coach_name',cp.coach_name,'amount',r.amount,
        'payment_method',r.payment_method,'payment_reference',r.payment_reference,
        'status',r.status,'submitted_at',r.submitted_at,'proof_path',r.proof_path
      )
      ORDER BY r.submitted_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_remittances
  FROM public.coach_remittances r
  JOIN public.coach_profiles cp ON cp.id=r.coach_id;

  RETURN jsonb_build_object(
    'coaches',v_coaches,
    'invoices',v_invoices,
    'remittances',v_remittances
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_courtly_admin_coach_data() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_courtly_admin_coach_data() TO authenticated;
