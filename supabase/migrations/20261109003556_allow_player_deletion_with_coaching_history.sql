BEGIN;
ALTER TABLE public.coaching_bookings ALTER COLUMN player_id DROP NOT NULL;
ALTER TABLE public.coaching_bookings DROP CONSTRAINT IF EXISTS coaching_bookings_player_id_fkey;
ALTER TABLE public.coaching_bookings
  ADD CONSTRAINT coaching_bookings_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES public.player_profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.courtly_prepare_player_account_deletion(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_alias text := 'deleted+' || replace(p_user_id::text, '-', '') || '@courtly.invalid';
BEGIN
  UPDATE public.bookings
    SET customer_name = 'Deleted Player',
        customer_email = v_alias,
        customer_phone = NULL,
        player_id = NULL,
        customer_user_id = NULL
    WHERE player_id = p_user_id OR customer_user_id = p_user_id;

  UPDATE public.open_play_registrations
    SET player_name = 'Deleted Player',
        player_email = v_alias,
        player_phone = NULL,
        player_id = NULL
    WHERE player_id = p_user_id;

  UPDATE public.payment_receipts
    SET player_id = NULL,
        player_name = 'Deleted Player',
        player_email = v_alias
    WHERE player_id = p_user_id;

  UPDATE public.coaching_bookings
    SET player_id = NULL,
        player_note = NULL
    WHERE player_id = p_user_id;

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.courtly_prepare_player_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.courtly_prepare_player_account_deletion(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
