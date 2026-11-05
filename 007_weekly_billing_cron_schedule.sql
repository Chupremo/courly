-- Courtly scheduler (Supabase pg_cron)
-- Friday 01:00 UTC = Friday 09:00 Asia/Manila.
-- Overdue enforcement runs every five minutes so suspension follows the 72-hour deadline closely.
-- Enable the pg_cron extension in Supabase Database > Extensions before running if needed.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('courtly-weekly-invoice-generation','courtly-overdue-enforcement')
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'courtly-weekly-invoice-generation',
    '0 1 * * 5',
    'SELECT public.generate_weekly_courtly_invoices();'
  );

  PERFORM cron.schedule(
    'courtly-overdue-enforcement',
    '*/5 * * * *',
    'SELECT public.enforce_overdue_courtly_venues();'
  );
END $$;

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN ('courtly-weekly-invoice-generation','courtly-overdue-enforcement')
ORDER BY jobname;
