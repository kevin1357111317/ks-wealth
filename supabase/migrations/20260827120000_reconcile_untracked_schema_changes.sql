-- RECONCILIATION MIGRATION — 2026-08-28 security review
-- Unlike the other reconstructed migrations, this file has NO corresponding entry in
-- production's supabase_migrations.schema_migrations. It reconciles three pieces of schema
-- that exist in production today but were applied directly (dashboard / SQL editor), with
-- zero migration history — meaning git never recorded when or how they were created.
--
-- The timestamp prefix (20260827120000) is a PLACEHOLDER: it is chosen only to sit between
-- 20260826052600 (last known tracked migration) and 20260828000736 (schedule_next_day_wealth_
-- snapshot, already in git), because that migration DROPs the trigger this file creates.
-- The real creation time in production is unknown — check Supabase project log retention /
-- Postgres logs if you need the exact moment, but it is not required for schema correctness.
--
-- What this reconciles:
--   1. Seven columns on financial_items that back the V3 "husband/wife" split and live
--      stock-quote features (owner_scope, symbol, market, quantity, average_cost,
--      quote_currency, quote_source).
--   2. The financial_scope_history table in full (columns, indexes, RLS policies, grants).
--   3. capture_financial_scope_history() + the trigger that called it. That trigger,
--      financial_items_scope_history_trigger, was already dropped by the migration that
--      IS in git (20260828000000_schedule_next_day_wealth_snapshot.sql), so recreating it
--      here and then letting that later migration run again reproduces the correct final
--      production state: the function stays (as a currently-unused/orphan function, exactly
--      as production has it today), the trigger does not.
--      NOTE: production no longer has this trigger to inspect directly, so its exact
--      definition (AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW) is inferred from the
--      function's signature and the naming/behavior pattern of the sibling audit triggers
--      created in ks_wealth_v2_initial. Please double-check this against your own memory of
--      what you built before ever applying this file anywhere.
--   4. The rls_auto_enable() event trigger that auto-enables RLS on newly created tables.
--
-- This file has NOT been applied to any database. It is for git version-control review only.
-- All statements are written idempotently (if not exists / or replace) so it is safe to run
-- against a database that already has some or all of this schema.

-- 1. financial_items: husband/wife split + live quote columns
alter table public.financial_items
  add column if not exists owner_scope text not null default 'husband',
  add column if not exists symbol text,
  add column if not exists market text,
  add column if not exists quantity numeric,
  add column if not exists average_cost numeric,
  add column if not exists quote_currency text not null default 'TWD',
  add column if not exists quote_source text not null default 'manual';

alter table public.financial_items
  drop constraint if exists financial_items_owner_scope_check;
alter table public.financial_items
  add constraint financial_items_owner_scope_check
  check (owner_scope = any (array['husband','wife']));

alter table public.financial_items
  drop constraint if exists financial_items_market_check;
alter table public.financial_items
  add constraint financial_items_market_check
  check (market is null or market = any (array['TW','US','FX','MANUAL']));

alter table public.financial_items
  drop constraint if exists financial_items_quantity_check;
alter table public.financial_items
  add constraint financial_items_quantity_check
  check (quantity is null or quantity >= 0);

alter table public.financial_items
  drop constraint if exists financial_items_average_cost_check;
alter table public.financial_items
  add constraint financial_items_average_cost_check
  check (average_cost is null or average_cost >= 0);

alter table public.financial_items
  drop constraint if exists financial_items_quote_source_check;
alter table public.financial_items
  add constraint financial_items_quote_source_check
  check (quote_source = any (array['manual','fugle','twelve_data']));

-- 2. financial_scope_history table
create table if not exists public.financial_scope_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner_scope text not null check (owner_scope = any (array['husband','wife'])),
  kind text not null check (kind = any (array['asset','liability'])),
  total_twd numeric(18,2) not null default 0 check (total_twd >= 0),
  recorded_on date not null default (timezone('Asia/Taipei', now()))::date,
  source text not null default 'app-auto',
  created_at timestamptz not null default now()
);

create unique index if not exists financial_scope_history_household_id_owner_scope_kind_recor_key
  on public.financial_scope_history (household_id, owner_scope, kind, recorded_on);
create index if not exists financial_scope_history_lookup_idx
  on public.financial_scope_history (household_id, owner_scope, kind, recorded_on);

alter table public.financial_scope_history enable row level security;

drop policy if exists "financial_scope_history_member_select" on public.financial_scope_history;
create policy "financial_scope_history_member_select" on public.financial_scope_history for select to authenticated
using (household_id in (select hm.household_id from public.household_members hm where hm.user_id = (select auth.uid())));

drop policy if exists "financial_scope_history_member_insert" on public.financial_scope_history;
create policy "financial_scope_history_member_insert" on public.financial_scope_history for insert to authenticated
with check (household_id in (select hm.household_id from public.household_members hm where hm.user_id = (select auth.uid())));

drop policy if exists "financial_scope_history_member_update" on public.financial_scope_history;
create policy "financial_scope_history_member_update" on public.financial_scope_history for update to authenticated
using (household_id in (select hm.household_id from public.household_members hm where hm.user_id = (select auth.uid())))
with check (household_id in (select hm.household_id from public.household_members hm where hm.user_id = (select auth.uid())));

-- Matches production's actual grants (verified via information_schema.role_table_grants):
-- authenticated has select/insert/update/delete at table level, but there is deliberately
-- no DELETE policy above, so RLS denies delete for every authenticated user regardless.
grant select, insert, update, delete on public.financial_scope_history to authenticated;
revoke all on public.financial_scope_history from anon;

-- 3. capture_financial_scope_history() + its trigger (see header note on the trigger)
create or replace function public.capture_financial_scope_history()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  snapshot_date date := (timezone('Asia/Taipei', now()))::date;
begin
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and (old.owner_scope, old.kind) is distinct from (new.owner_scope, new.kind)) then
    insert into public.financial_scope_history
      (household_id, owner_scope, kind, total_twd, recorded_on, source)
    select old.household_id, old.owner_scope, old.kind, coalesce(sum(fi.amount_twd), 0),
           snapshot_date, 'app-auto'
    from public.financial_items fi
    where fi.household_id = old.household_id
      and fi.owner_scope = old.owner_scope
      and fi.kind::text = old.kind::text
    on conflict (household_id, owner_scope, kind, recorded_on)
    do update set total_twd = excluded.total_twd, source = excluded.source;
  end if;

  if tg_op <> 'DELETE' then
    insert into public.financial_scope_history
      (household_id, owner_scope, kind, total_twd, recorded_on, source)
    select new.household_id, new.owner_scope, new.kind::text, coalesce(sum(fi.amount_twd), 0),
           snapshot_date, 'app-auto'
    from public.financial_items fi
    where fi.household_id = new.household_id
      and fi.owner_scope = new.owner_scope
      and fi.kind::text = new.kind::text
    on conflict (household_id, owner_scope, kind, recorded_on)
    do update set total_twd = excluded.total_twd, source = excluded.source;
  end if;

  return coalesce(new, old);
end;
$function$;

-- INFERRED trigger definition — see header note. Production no longer has this trigger to
-- read back directly (it was dropped by 20260828000000_schedule_next_day_wealth_snapshot.sql,
-- already in git); this recreates it here so that later migration's DROP is meaningful, and
-- the two files together reproduce today's true end state (function exists, trigger does not).
drop trigger if exists financial_items_scope_history_trigger on public.financial_items;
create trigger financial_items_scope_history_trigger
after insert or update or delete on public.financial_items
for each row execute function public.capture_financial_scope_history();

-- 4. rls_auto_enable() event trigger — auto-enables RLS on any new table created in `public`
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
-- Matches production: EXECUTE was revoked from authenticated/anon/public by
-- 20260826051112_ks_wealth_v2_security_realtime.sql (already recreated above in this batch).

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
