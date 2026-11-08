-- Keep the activities table private. Use its existing authorised read RPC
-- instead of a direct table subquery inside a shared Storage policy.
-- CASE also avoids evaluating activity IDs for unrelated upload buckets.
ALTER POLICY "Courtly players upload own activity banners"
ON storage.objects
WITH CHECK (
  CASE
    WHEN bucket_id = 'courtly-community-banners'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN EXISTS (
      SELECT 1
      FROM public.get_community_events(((storage.foldername(name))[2])::uuid, 1) e
      WHERE e.host_id = (SELECT auth.uid())
        AND e.event_status = 'published'
        AND e.event_id::text = (storage.foldername(name))[2]
    )
    ELSE false
  END
);
