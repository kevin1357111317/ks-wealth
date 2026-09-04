-- 美金部位自己記一本帳。這一本跟 financial_items 沒有連動：美金的買賣只在
-- 美金分析頁裡進出，不影響資產頁上的任何一列。成本用移動加權平均計算，
-- 跟 KLFAN 試算表的「美金」工作表同一套。

create table if not exists public.usd_transactions (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  trade_date date not null,
  -- 正為買進、負為賣出；台幣現金流的正負號相反（買進流出、賣出流入）。
  usd_amount numeric not null check (usd_amount <> 0),
  rate numeric not null check (rate > 0),
  twd_amount numeric not null check (twd_amount <> 0),
  note text,
  created_at timestamptz not null default now(),
  constraint usd_transactions_direction check (sign(usd_amount) = -sign(twd_amount))
);

create index if not exists usd_transactions_household_date_idx
  on public.usd_transactions(household_id, trade_date, id);

alter table public.usd_transactions enable row level security;

drop policy if exists "usd_transactions_member_all" on public.usd_transactions;
create policy "usd_transactions_member_all" on public.usd_transactions for all to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = usd_transactions.household_id and hm.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.household_members hm
  where hm.household_id = usd_transactions.household_id and hm.user_id = (select auth.uid())
));
