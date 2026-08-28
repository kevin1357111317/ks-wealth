# Migration reconciliation — 2026-08-28 security review

This note explains the new files added to this folder during the review. Nothing in this
folder has been applied to any database, committed, or pushed — it's all local, for your
review only.

## What was added and why

Production's `supabase_migrations.schema_migrations` table recorded **8** migrations; git
had only **2**. These files close that gap:

| File | Recreates production version | Notes |
|---|---|---|
| `20260826050936_ks_wealth_v2_initial.sql` | `20260826050936` | DDL only — see "Data removed" below |
| `20260826051112_ks_wealth_v2_security_realtime.sql` | `20260826051112` | Copied verbatim, no data |
| `20260826051225_ks_wealth_v2_auto_net_worth.sql` | `20260826051225` | Copied verbatim, no data |
| `20260826051443_ks_wealth_v2_cashflow_start.sql` | `20260826051443` | DDL only — see "Data removed" below |
| `20260826051542_ks_wealth_v2_reduce_rpc_surface.sql` | `20260826051542` | Copied verbatim, no data |
| `20260826052600_ks_wealth_v2_source_name_alignment.sql` | `20260826052600` | DDL only — see "Data removed" below |
| `20260827120000_reconcile_untracked_schema_changes.sql` | *(none — see below)* | New: catches up 3 pieces of schema that were never tracked by any migration at all |
| `20260829000000_proposed_hardening_not_yet_applied.sql` | *(none — proposal, not production state)* | New: optional follow-up hardening, **not** a reconstruction of current state |

## Data removed from the reconstructed files

Per your instruction, all `insert`/`update` statements carrying real household financial
data were stripped from the reconstructed files. Production already has this data — nothing
needs to be re-applied. Specifically removed:

- `20260826050936_ks_wealth_v2_initial.sql`: seed inserts into `households`, `household_invites`
  (including a real invite code's SHA-256 hash), `financial_items`, `cashflow_forecasts`,
  `net_worth_history`, `loan_events`.
- `20260826051443_ks_wealth_v2_cashflow_start.sql`: an `update household_settings set
  cashflow_start_balance_twd = <real balance>` statement.
- `20260826052600_ks_wealth_v2_source_name_alignment.sql`: several `update financial_items
  set name = ...` statements renaming real holdings, and an `insert into net_worth_history
  ... select ...` that wrote a real computed net-worth figure.

If you ever want the *exact* original statements (e.g. for a personal encrypted backup, not
for git), they're still readable straight from production via
`select statements from supabase_migrations.schema_migrations where version = '...'` — I did
not save them anywhere outside this conversation.

## `20260827120000_reconcile_untracked_schema_changes.sql` — the important one

This is the one file that isn't reconstructing a real migration — it's catching up **three
pieces of schema that were created directly against production (dashboard / SQL editor) with
zero migration record ever**:

1. `financial_items.owner_scope / symbol / market / quantity / average_cost / quote_currency /
   quote_source` — the columns that back the entire "husband vs wife" split and live
   stock-quote features in `app-v3.js`.
2. The `financial_scope_history` table in full, including its RLS policies and grants.
3. `capture_financial_scope_history()` and the trigger `financial_items_scope_history_trigger`
   that called it (that trigger is already dropped by the migration that *is* in git,
   `20260828000000_schedule_next_day_wealth_snapshot.sql` — recreating it here and letting that
   later file drop it again reproduces today's real end state: function present, unused;
   trigger absent).
4. The `ensure_rls` event trigger (function `rls_auto_enable()`) that auto-enables RLS on any
   new table created in `public`.

**Caveat**: because the trigger in #3 no longer exists in production, I could not read its
exact original definition back — I inferred `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`
from the function signature and the pattern of the sibling audit triggers. Everything else in
this file (columns, table, RLS policies, grants, both function bodies, the event trigger) was
read directly from production, not guessed.

The timestamp prefix `20260827120000` is a placeholder — the real change happened sometime
between the last tracked migration (`...052600`, Aug 26) and the next tracked one
(`...000736`, Aug 28), but production doesn't record exactly when.

## `20260829000000_proposed_hardening_not_yet_applied.sql` — separate, opt-in

This one is different in kind from all the others above: it does **not** describe production's
current state. It's a draft of the "nice to have" hardening items you asked me to use my
judgment on:

- Stop letting household members write directly to `net_worth_history` /
  `financial_scope_history` via the REST API (both are meant to be Edge-Function-only writes;
  the service role bypasses RLS so this doesn't break the existing Edge Functions).
- Drop the two unused legacy columns `financial_items.original_currency` / `original_amount`.
- Drop the orphaned function `private.refresh_net_worth_history()`.

Enabling Supabase Auth's leaked-password protection (the other WARN from the security advisor)
isn't a SQL change — it's a toggle in the Supabase Dashboard under Authentication → Policies —
so there's no file for it.

## One more thing worth knowing before you apply anything

The two migration files that were **already** in git before this review
(`20260828000000_schedule_next_day_wealth_snapshot.sql` and
`20260828190000_add_native_currency_amount.sql`) have filename version prefixes
(`20260828000000`, `20260828190000`) that **don't match** the versions actually recorded in
production's migration history (`20260828000736`, `20260828100918`). Their *contents* are
identical to what production ran — only the timestamp in the filename differs. This matters if
you (or `supabase db push`) ever rely on the Supabase CLI to detect "which migrations are
already applied" by version number: the CLI would see these as unapplied and try to re-run
them. Both files happen to be written defensively enough that re-running them would likely be a
no-op or safely idempotent, but this hasn't been tested against a real CLI push, and it's worth
fixing (renaming those two files to their real recorded versions) before ever trusting
`supabase db push` against this project.

## Nothing here has touched production

Every fact in these files and this note came from read-only `SELECT` queries against
production (`list_tables`, `pg_policies`, `pg_indexes`, `information_schema`,
`pg_get_functiondef`, `supabase_migrations.schema_migrations`). No DDL/DML was executed against
production, no file outside `supabase/migrations/` was touched, and nothing has been committed
or pushed.
