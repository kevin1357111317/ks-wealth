-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- Reconstructed from production's supabase_migrations.schema_migrations
-- (version 20260826052600, name "ks_wealth_v2_source_name_alignment"), read via SELECT-only query.
--
-- DELIBERATE DIFFERENCE FROM PRODUCTION HISTORY:
-- The original migration also contained several `update public.financial_items set name=...`
-- statements renaming specific real holdings (e.g. fund/ETF display names), and a final
-- `insert into public.net_worth_history (...) select ... from public.financial_items` that
-- wrote a real computed net-worth figure. Those statements touched real personal portfolio
-- data and are intentionally omitted here. Production already reflects these changes; they
-- do not need to be re-applied.
--
-- Only the structural statement (the index) is kept below.
--
-- This file has NOT been applied to any database. It is for git version-control review only.

create index if not exists household_members_user_id_idx on public.household_members(user_id);
