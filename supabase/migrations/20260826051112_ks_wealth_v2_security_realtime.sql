-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- Reconstructed verbatim from production's supabase_migrations.schema_migrations
-- (version 20260826051112, name "ks_wealth_v2_security_realtime"), read via SELECT-only query.
-- Contains no personal data — copied as-is.
--
-- This file has NOT been applied to any database. It is for git version-control review only.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.financial_items;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.cashflow_forecasts;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.net_worth_history;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.loan_events;
  exception when duplicate_object then null; end;
end $$;
