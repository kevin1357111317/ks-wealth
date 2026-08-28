-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- Reconstructed from production's supabase_migrations.schema_migrations
-- (version 20260826051443, name "ks_wealth_v2_cashflow_start"), read via SELECT-only query.
--
-- DELIBERATE DIFFERENCE FROM PRODUCTION HISTORY:
-- The original migration also contained:
--   update public.household_settings set cashflow_start_balance_twd = <real household balance>
--   where household_id = '<real household id>';
-- That statement set a real personal cash balance and is intentionally omitted here so no
-- personal financial figure enters git history. Production already has this value set;
-- it does not need to be re-applied.
--
-- This file has NOT been applied to any database. It is for git version-control review only.

alter table public.household_settings add column if not exists cashflow_start_balance_twd numeric(16,2) not null default 0;
