BEGIN;

REVOKE EXECUTE ON FUNCTION public.courtly_activity_receipt_upload_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_activity_receipt_upload_allowed(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.courtly_owner_can_view_activity_receipt(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_can_view_activity_receipt(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.courtly_owner_can_view_receipt(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_owner_can_view_receipt(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.courtly_ensure_owner_venue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.courtly_ensure_owner_venue() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.expire_owner_courtly_booking_holds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_owner_courtly_booking_holds() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_owner_open_play_earnings(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owner_open_play_earnings(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.courtly_attach_player_to_booking() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_attach_player_to_open_play_registration() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_create_club_profile() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_create_owner_venue() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_create_player_profile() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_guard_coach_profile_fields() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_guard_venue_billing_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_next_receipt_number() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_record_booking_fee() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_record_coach_session_fee() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.courtly_record_open_play_fee() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_courtly_booking(
  uuid, uuid, text, text, text, timestamptz, integer, text
) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
