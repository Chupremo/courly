# Courtly SQL setup

The current canonical instructions are in [`SUPABASE_COMPLETE_SETUP.md`](SUPABASE_COMPLETE_SETUP.md).

For a clean Supabase project, run one copy of `schema.sql` and then run `supabase/001_complete_supabase_backend.sql`. For an existing Courtly project that already has the base `venues`, `courts`, and `bookings` tables, back up the project and run only the consolidated migration.

Do not run the older individual migration scripts after the consolidated migration. They are retained in the repository as historical reference files only.
