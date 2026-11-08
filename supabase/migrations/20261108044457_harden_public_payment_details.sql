BEGIN;

REVOKE EXECUTE ON FUNCTION public.get_public_coach_payment_details(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_coach_payment_details(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_venue_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', v.id,
    'slug', v.slug,
    'name', v.name,
    'address', v.address,
    'city', v.city,
    'timezone', v.timezone,
    'currency', v.currency,
    'payment_qr_url', NULL,
    'courts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'sport', c.sport,
        'hourly_rate', c.hourly_rate
      ) ORDER BY c.created_at, c.name)
      FROM public.courts c
      WHERE c.venue_id = v.id
        AND c.is_active = true
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.venues v
  WHERE lower(v.slug) = lower(btrim(p_slug))
    AND v.is_published = true
    AND coalesce(v.activation_status,'trial') IN ('trial','active')
    AND coalesce(v.billing_status,'active') = 'active'
    AND (
      coalesce(v.activation_status,'trial') = 'active'
      OR v.trial_ends_at IS NULL
      OR v.trial_ends_at > clock_timestamp()
    );

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_public_venue_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_venue_by_slug(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
