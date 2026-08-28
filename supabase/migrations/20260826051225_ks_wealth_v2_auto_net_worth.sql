-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- Reconstructed verbatim from production's supabase_migrations.schema_migrations
-- (version 20260826051225, name "ks_wealth_v2_auto_net_worth"), read via SELECT-only query.
-- Contains no personal data — copied as-is.
--
-- NOTE: the trigger created here (refresh_net_worth_after_financial_change) was later
-- dropped by 20260828000000_schedule_next_day_wealth_snapshot.sql (already in git).
-- The function body (private.refresh_net_worth_history) is still present in production
-- as an orphan — it is no longer called by any trigger. See RECONCILIATION_NOTES.md.
--
-- This file has NOT been applied to any database. It is for git version-control review only.

create or replace function private.refresh_net_worth_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  current_net numeric(16,2);
  local_day date;
begin
  hid := coalesce(new.household_id, old.household_id);
  local_day := (now() at time zone 'Asia/Taipei')::date;

  select coalesce(sum(case when kind = 'asset' then amount_twd else -amount_twd end), 0)
    into current_net
  from public.financial_items
  where household_id = hid;

  insert into public.net_worth_history(household_id, recorded_on, net_worth_twd, source, created_by)
  values (hid, local_day, current_net, 'app-auto', auth.uid())
  on conflict (household_id, recorded_on)
  do update set net_worth_twd = excluded.net_worth_twd, source = excluded.source;

  return coalesce(new, old);
end;
$$;
revoke all on function private.refresh_net_worth_history() from public, anon, authenticated;

drop trigger if exists refresh_net_worth_after_financial_change on public.financial_items;
create trigger refresh_net_worth_after_financial_change
after insert or update or delete on public.financial_items
for each row execute function private.refresh_net_worth_history();
