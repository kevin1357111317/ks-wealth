-- ⚠️ PROPOSAL ONLY — DO NOT APPLY WITHOUT REVIEW ⚠️
-- Unlike every other file in this folder, this migration does NOT reconstruct anything that
-- already exists in production. It is a draft of optional hardening changes surfaced by the
-- 2026-08-28 security review, listed separately so it's never ambiguous which files describe
-- production's actual current state vs. a proposed future change.
--
-- Covers 3 of the 4 "nice to have" items from that review (the 4th — enabling Supabase Auth's
-- leaked-password protection — is an Auth service setting, not SQL, and must be toggled in the
-- Supabase Dashboard under Authentication > Policies instead).
--
-- This file has NOT been applied to any database, and should not be applied until you've
-- decided you want each part of it.

-- ---------------------------------------------------------------------------
-- A. Tighten net_worth_history / financial_scope_history so household members
--    can only READ them, not write them directly via the REST API.
--    Today both tables use a `for all` policy, so any signed-in household member
--    can insert/update/delete these snapshot rows directly — even though neither
--    frontend (app.js or app-v3.js) exposes any UI to do so. These tables are meant
--    to be written only by the two Edge Functions (which use the service role key
--    and therefore bypass RLS entirely, so this change does not break them).
-- ---------------------------------------------------------------------------

drop policy if exists "history_member_all" on public.net_worth_history;
create policy "history_member_select" on public.net_worth_history for select to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = net_worth_history.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "financial_scope_history_member_insert" on public.financial_scope_history;
drop policy if exists "financial_scope_history_member_update" on public.financial_scope_history;
-- financial_scope_history_member_select already exists and is kept as-is.

-- ---------------------------------------------------------------------------
-- B. Drop orphan columns on financial_items: original_currency / original_amount.
--    Neither app.js nor app-v3.js reads or writes these — both use native_currency /
--    native_amount instead (added later by add_native_currency_amount.sql). Confirmed
--    via grep across the whole frontend before proposing this.
-- ---------------------------------------------------------------------------

alter table public.financial_items
  drop column if exists original_currency,
  drop column if exists original_amount;

-- ---------------------------------------------------------------------------
-- C. Drop orphan function private.refresh_net_worth_history().
--    Its trigger (refresh_net_worth_after_financial_change) was already dropped by
--    20260828000000_schedule_next_day_wealth_snapshot.sql; nothing calls this function
--    anymore.
-- ---------------------------------------------------------------------------

drop function if exists private.refresh_net_worth_history();
