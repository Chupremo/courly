-- Courtly Community media: raise the existing private bucket to 100 MB.
-- Supabase Storage's project-wide global upload limit must also be at least 100 MB.
UPDATE storage.buckets
SET file_size_limit = 104857600
WHERE id = 'courtly-community-media';

NOTIFY pgrst, 'reload schema';
