create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Historical points are written only by the 06:00 Asia/Taipei scheduled job.
-- Financial item changes continue to be captured by the separate audit trigger.
drop trigger if exists financial_items_scope_history_trigger on public.financial_items;
drop trigger if exists refresh_net_worth_after_financial_change on public.financial_items;

select cron.unschedule(jobid)
from cron.job
where jobname = 'daily-wealth-snapshot-06-taipei';

select cron.schedule(
  'daily-wealth-snapshot-06-taipei',
  '0 22 * * *',
  $job$
  select net.http_post(
    url := 'https://gbxsnwqbjmgfikpblyot.supabase.co/functions/v1/daily-wealth-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'daily_snapshot_cron_secret_v1'
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $job$
);
