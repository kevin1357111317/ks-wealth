-- 用實際現金流重算每一筆進行中貸款的實際年化成本（XIRR），寫回 effective_annual_cost。
--
-- 這個欄位是「排程還沒載入時」卡片要顯示的值 —— 鼎宇房貸兩筆是 null、潤隆增貸是舊值，
-- 所以第一次進貸款分析會先看到錯的數字。搭配 app-v3.js 那邊的修正（算不出來顯示破折號
-- 而不是 0.00%），先補好這裡就連破折號都不會閃。
--
-- 算法跟前端 loan-core.js 一致：撥款為正、費用與還款為負，日期取 actual_date（沒有就用
-- due_date），用二分法解 NPV = 0。

with recursive flows as (
  select la.id, coalesce(s.actual_date, s.due_date) as d, s.amount_twd::numeric as amt
  from public.loan_accounts la
  join public.loan_schedule s on s.loan_account_id = la.id
  where la.status = 'active' and s.amount_twd <> 0
), base as (
  select id, min(d) as d0 from flows group by id
), f as (
  select f.id, f.amt, (f.d - b.d0) / 365.0 as t
  from flows f join base b on b.id = f.id
), bisect as (
  select b.id, (-0.5)::numeric as lo, 1.0::numeric as hi, 0 as i from base b
  union all
  select s.id,
         case when (select sum(f.amt * power(1 + (s.lo + s.hi) / 2, -f.t)) from f where f.id = s.id) < 0
              then (s.lo + s.hi) / 2 else s.lo end,
         case when (select sum(f.amt * power(1 + (s.lo + s.hi) / 2, -f.t)) from f where f.id = s.id) < 0
              then s.hi else (s.lo + s.hi) / 2 end,
         s.i + 1
  from bisect s where s.i < 50
)
update public.loan_accounts la
set effective_annual_cost = round((b.lo + b.hi) / 2, 8),
    updated_at = now()
from bisect b
where b.id = la.id and b.i = 50
  and la.effective_annual_cost is distinct from round((b.lo + b.hi) / 2, 8);
