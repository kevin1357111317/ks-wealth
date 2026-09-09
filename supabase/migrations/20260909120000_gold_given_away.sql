-- 送出去的黃金（送父母那兩筆各 2.5g）不是自己的部位了：不計年化、也不算進目前持有，
-- 只留買進紀錄。原本只有 include_in_performance = false，重量還留在資產頁上。
alter table public.gold_transactions
  add column if not exists still_held boolean not null default true;

comment on column public.gold_transactions.still_held is
  '是否仍持有。false 代表已送出／轉讓，只留買進紀錄，不計入部位也不計入年化。';

update public.gold_transactions
set still_held = false,
    include_in_performance = false,
    note = '送給父母，只留紀錄'
where source_key in (
  'klfan_20251218_pamp_goddess_1',
  'klfan_20251218_pamp_goddess_2'
);

-- 資產頁的重量扣掉送出去的 5g（204.3105 → 199.3105）。每公克單價不變，市值照比例縮，
-- 下一輪報價更新會用新的重量重算 amount_twd。
update public.financial_items
set amount_twd = round(amount_twd / nullif(quantity, 0) * 199.3105, 2),
    quantity = 199.3105,
    updated_at = now()
where market = 'GOLD'
  and owner_scope = 'husband'
  and quantity = 204.3105;
