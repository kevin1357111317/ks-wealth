-- KLFAN「黃金」工作表的成本台帳。financial_items 繼續保存即時重量與市值；
-- 這張表只保存每筆歷史成本，讓 App 能用實際投入時點重算 XIRR。
create table if not exists public.gold_transactions (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  owner_scope text not null default 'husband' check (owner_scope in ('husband', 'wife')),
  source_key text not null,
  trade_date date not null,
  cost_twd numeric not null check (cost_twd > 0),
  grams numeric not null check (grams > 0),
  name text not null,
  -- KLFAN 會把仍保有的收藏工錢加回目前價值；成本本身已含工錢，不再重複加。
  valuation_premium_twd numeric not null default 0 check (valuation_premium_twd >= 0),
  note text,
  created_at timestamptz not null default now(),
  unique (household_id, source_key)
);

create index if not exists gold_transactions_household_owner_date_idx
  on public.gold_transactions(household_id, owner_scope, trade_date, id);

alter table public.gold_transactions enable row level security;

drop policy if exists "gold_transactions_member_all" on public.gold_transactions;
create policy "gold_transactions_member_all" on public.gold_transactions for all to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = gold_transactions.household_id and hm.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.household_members hm
  where hm.household_id = gold_transactions.household_id and hm.user_id = (select auth.uid())
));

grant select, insert, update, delete on public.gold_transactions to authenticated;
grant usage, select on sequence public.gold_transactions_id_seq to authenticated;

-- 不寫死 household UUID：以 App 裡既有的黃金資產找到正確家庭。
insert into public.gold_transactions
  (household_id, owner_scope, source_key, trade_date, cost_twd, grams, name, valuation_premium_twd, note)
select gold_households.household_id, seed.owner_scope, seed.source_key, seed.trade_date,
       seed.cost_twd, seed.grams, seed.name, seed.valuation_premium_twd, null
from (select distinct household_id, owner_scope from public.financial_items where market = 'GOLD') gold_households
join (values
  ('husband', 'klfan_20250821_ubs', date '2025-08-21', 332157::numeric, 100::numeric, 'UBS', 0::numeric),
  ('husband', 'klfan_20251217_pamp_goddess', date '2025-12-17', 141246::numeric, 31.1035::numeric, 'PAMP 女神', 0::numeric),
  ('husband', 'klfan_20251218_pamp_goddess_1', date '2025-12-18', 12284::numeric, 2.5::numeric, 'PAMP 女神', 0::numeric),
  ('husband', 'klfan_20251218_pamp_goddess_2', date '2025-12-18', 12284::numeric, 2.5::numeric, 'PAMP 女神', 0::numeric),
  ('husband', 'klfan_20260122_pamp_zodiac', date '2026-01-22', 52696::numeric, 6::numeric, 'PAMP 星座', 23080::numeric),
  ('husband', 'klfan_20260122_pamp_goddess', date '2026-01-22', 158979::numeric, 31.1035::numeric, 'PAMP 女神', 0::numeric),
  ('wife', 'klfan_20251205_pamp_horse', date '2025-12-05', 136474::numeric, 31.1035::numeric, 'PAMP 馬年', 0::numeric)
) as seed(owner_scope, source_key, trade_date, cost_twd, grams, name, valuation_premium_twd)
  on seed.owner_scope = gold_households.owner_scope
on conflict (household_id, source_key) do update set
  trade_date = excluded.trade_date,
  cost_twd = excluded.cost_twd,
  grams = excluded.grams,
  name = excluded.name,
  valuation_premium_twd = excluded.valuation_premium_twd,
  note = excluded.note;
