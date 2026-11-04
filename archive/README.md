# Archived legacy files

`legacy-migrations/` contains historical SQL patches and earlier copies of schema, seed, registration, payment-receipt, and Open Play migrations from prior Courtly iterations.

Do not apply these files to the updated project. The supported database setup is:

1. Run `schema.sql` once only for a brand-new Supabase project.
2. Run `supabase/001_complete_supabase_backend.sql` once after backing up the database.

For an existing Courtly project, skip the base schema and apply only the consolidated backend migration after backup/staging review.
