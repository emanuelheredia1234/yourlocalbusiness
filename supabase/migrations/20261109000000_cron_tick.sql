-- The hourly tick that drives the app's periodic jobs (server/cron/index.mjs). Replit Autoscale scales the app to
-- zero, so nothing inside it can wake itself: pg_cron calls POST /api/cron/tick every hour through pg_net, with
-- "Authorization: Bearer <cron_secret>". The app answers 503 NOT_SET_UP until it has CRON_SECRET, and 401 when the
-- bearer doesn't match; each job runs at most once per period behind its own claim, so a repeated or late call is
-- harmless.
--
-- OWNER STEP before (or after) running this file, in Supabase → SQL Editor, with the SAME value as the CRON_SECRET
-- Replit Secret (32+ random bytes, e.g. `openssl rand -hex 32`; never commit it):
--
--   select vault.create_secret('<the CRON_SECRET value>', 'cron_secret', 'Bearer for POST /api/cron/tick');
--
-- To change it later: select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new>');
-- then update CRON_SECRET in Replit and republish. Until the secret exists the schedule makes no call at all.
--
-- Safe to run again: the extensions are created only if missing and the job is replaced by name.
-- Check it: select * from cron.job where jobname = 'ylb-cron-tick';
--           select * from cron.job_run_details order by start_time desc limit 5;
--           select id, status_code, left(content, 200) from net._http_response order by created desc limit 5;
-- Remove it: select cron.unschedule('ylb-cron-tick');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
-- (supabase_vault is on in every Supabase project; vault.decrypted_secrets is readable by postgres, which runs the job)

-- the old job of this name goes first, so a changed schedule or address takes effect
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ylb-cron-tick') then
    perform cron.unschedule('ylb-cron-tick');
  end if;
end
$$;

-- minute 7 of every hour (off the top of the hour, when most schedules fire). The app's tick answers within its 40 s
-- budget; the request may take up to 55 s. No secret → no row → no call.
select cron.schedule(
  'ylb-cron-tick',
  '7 * * * *',
  $job$
    select net.http_post(
      url := 'https://yourlocalbusiness.replit.app/api/cron/tick',
      headers := jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer ' || s.decrypted_secret),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    from vault.decrypted_secrets s
    where s.name = 'cron_secret' and coalesce(s.decrypted_secret, '') <> '';
  $job$
);
