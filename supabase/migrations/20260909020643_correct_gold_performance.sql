-- 依 2026-09-09 提供的完整黃金表修正績效口徑：
-- 工錢已包含在成本，不假設可回收；送父母的 5g 留紀錄但不計入績效。
alter table public.gold_transactions
  add column if not exists workmanship_twd numeric not null default 0
    check (workmanship_twd >= 0),
  add column if not exists include_in_performance boolean not null default true;

update public.gold_transactions
set workmanship_twd = 23080,
    valuation_premium_twd = 0,
    note = '含工錢 NT$23,080'
where source_key = 'klfan_20260122_pamp_zodiac';

update public.gold_transactions
set include_in_performance = false,
    note = '送給父母，不計入年化'
where source_key in (
  'klfan_20251218_pamp_goddess_1',
  'klfan_20251218_pamp_goddess_2'
);

insert into public.gold_transactions
  (household_id, owner_scope, source_key, trade_date, cost_twd, grams, name,
   valuation_premium_twd, workmanship_twd, include_in_performance, note)
select distinct household_id, 'husband', 'klfan_20260811_pamp_goddess',
       date '2026-08-11', 145594, 31.1035, 'PAMP 女神', 0, 0, true, null
from public.financial_items
where market = 'GOLD' and owner_scope = 'husband'
on conflict (household_id, source_key) do update set
  trade_date = excluded.trade_date,
  cost_twd = excluded.cost_twd,
  grams = excluded.grams,
  name = excluded.name,
  valuation_premium_twd = excluded.valuation_premium_twd,
  workmanship_twd = excluded.workmanship_twd,
  include_in_performance = excluded.include_in_performance,
  note = excluded.note;

update public.financial_items
set amount_twd = round(amount_twd / nullif(quantity, 0) * 204.3105, 2),
    quantity = 204.3105,
    updated_at = now()
where market = 'GOLD'
  and owner_scope = 'husband'
  and quantity = 193.3105;
