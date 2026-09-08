-- 鼎宇房貸：用玉山 App 的實際扣款紀錄重建排程。這推翻了前面兩個推論。
--
-- 1) 寬限期的月付不是一開始就 43,219。反推每一期（餘額 × 年利率 ÷ 12）：
--      2024-04-05、2024-05-05  40,840 -> 2.0600%
--      2024-06-05              41,991 -> 2.1181%（過渡月）
--      2024-07-05 起           43,219 -> 2.1800%
--    跟潤隆房貸同一次升息（央行 2024-03-21 +0.125%），玉山在 2024-06 反映，
--    中信在 2024-05，差一個月。
--
-- 2) 排程尾端多一個月的原因不是繳款日改期（那是先前的猜測，錯了），是撥款日到第一次
--    扣款之間有一筆 4 天的零頭利息：2024-03-01 撥款、2024-03-05 收 5,633
--    （23,790,000 × 2.16% × 4/365）。那是第 1 期，所以：
--      第 1 期        2024-03-05            零頭利息
--      第 2~37 期     2024-04-05~2027-03-05  36 期寬限 = 寬限期間 36 個月
--      第 38~361 期   2027-04-05~2054-03-05  324 期攤還 = 借款期間 360 個月
--    攤還表說「第 38 期開始還本金」完全吻合，最後一期就是 2054-03-05，不多不少。
--
-- 3) 2024-03-01 另有手續費 3,000（各半 1,500），先前漏記。

update public.loan_accounts
set grace_until = date '2027-03-05',
    maturity_date = date '2054-03-05',
    source_note = '玉山 App 2026-09-08 核對（扣款紀錄 + 本息攤還表）：'
      '2024-03-01 撥款 23,790,000（夫妻各半 11,895,000）、手續費 3,000；'
      '2024-03-05 收 4 天零頭利息 5,633；'
      '寬限期月付 40,840（2.06%）-> 41,991（2024-06 過渡）-> 43,219（2.18%，央行 2024-03-21 升息）；'
      '第 1 期為零頭、第 2~37 期寬限、第 38~361 期本息攤還 97,207.69（324 期年金），'
      '最後一期 2054-03-05。利息用年利率 ÷ 12。'
where name = '鼎宇房貸';

delete from public.loan_schedule s
using public.loan_accounts la
where la.id = s.loan_account_id and la.name = '鼎宇房貸'
  and s.entry_type in ('payment', 'fee');

insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2024-03-01', date '2024-03-01', -1500, 'fee', '手續費'
from public.loan_accounts la where la.name = '鼎宇房貸';

-- 第 1 期是撥款日到 3/5 的零頭，之後每月 5 日，共 361 期
insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id,
       due.on_date,
       real.actual_date,
       case
         when s.n = 1 then -2816.5           -- 5,633 的一半：4 天零頭利息
         when s.n in (2, 3) then -20420      -- 40,840 的一半：2.06%
         when s.n = 4 then -20995.5          -- 41,991 的一半：過渡月
         when s.n <= 37 then -21609.25       -- 43,218.5 的一半：2.18%
         else -48603.84                      -- 97,207.69 的一半：324 期年金
       end,
       'payment',
       case
         when s.n = 1 then '撥款日至首次扣款的零頭利息'
         when s.n <= 4 then '寬限期只繳息（升息前／過渡）'
         when s.n <= 37 then '寬限期只繳息'
         else '本息攤還（玉山本息攤還表）'
       end
from public.loan_accounts la
cross join generate_series(1, 361) as s(n)
cross join lateral (select (date '2024-03-05' + make_interval(months => s.n - 1))::date as on_date) as due
left join (values
  (date '2024-03-05', date '2024-03-05'), (date '2024-04-05', date '2024-04-08'),
  (date '2024-05-05', date '2024-05-06'), (date '2024-06-05', date '2024-06-05'),
  (date '2024-07-05', date '2024-07-05'), (date '2024-08-05', date '2024-08-05'),
  (date '2024-09-05', date '2024-09-05'), (date '2024-10-05', date '2024-10-07'),
  (date '2024-11-05', date '2024-11-05'), (date '2024-12-05', date '2024-12-05'),
  (date '2025-01-05', date '2025-01-06'), (date '2025-02-05', date '2025-02-05'),
  (date '2025-03-05', date '2025-03-05'), (date '2025-04-05', date '2025-04-07'),
  (date '2025-05-05', date '2025-05-05'), (date '2026-03-05', date '2026-03-05'),
  (date '2026-04-05', date '2026-04-07'), (date '2026-05-05', date '2026-05-05'),
  (date '2026-06-05', date '2026-06-05'), (date '2026-07-05', date '2026-07-06'),
  (date '2026-08-05', date '2026-08-05'), (date '2026-09-05', date '2026-09-07')
) as real(due_date, actual_date) on real.due_date = due.on_date
where la.name = '鼎宇房貸';

update public.loan_accounts la
set projected_total_repayment_twd = (
  select sum(abs(s.amount_twd)) from public.loan_schedule s
  where s.loan_account_id = la.id and s.entry_type = 'payment')
where la.name = '鼎宇房貸';

-- 寬限期本金不動，今天以前的期數直接標成已套用
update public.loan_schedule s
set applied_at = now()
from public.loan_accounts la
where la.id = s.loan_account_id and la.name = '鼎宇房貸'
  and s.applied_at is null
  and s.due_date <= (now() at time zone 'Asia/Taipei')::date;

update public.loan_accounts la
set last_payment_applied_on = (
  select max(s.due_date) from public.loan_schedule s
  where s.loan_account_id = la.id and s.entry_type = 'payment'
    and s.due_date <= (now() at time zone 'Asia/Taipei')::date)
where la.name = '鼎宇房貸';
