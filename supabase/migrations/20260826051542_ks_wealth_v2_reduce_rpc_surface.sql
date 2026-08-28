-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- Reconstructed verbatim from production's supabase_migrations.schema_migrations
-- (version 20260826051542, name "ks_wealth_v2_reduce_rpc_surface"), read via SELECT-only query.
-- Contains no personal data — copied as-is.
--
-- This is why public.create_household_invite() cannot currently be called from either
-- frontend (app.js or app-v3.js): EXECUTE was intentionally revoked from `authenticated`
-- here, so invite codes can only be minted by a service-role script or the Supabase
-- dashboard SQL editor.
--
-- This file has NOT been applied to any database. It is for git version-control review only.

revoke execute on function public.create_household_invite(uuid) from authenticated;
