-- 潤隆增貸：用中信「貸款繳息明細」的實際數字重建寬限期排程。
--
-- 明細 17 期反推的利率全部落在 actual/365 × 2.55%、利息算到應繳日（每月 5 號），
-- 一分不差 —— 跟潤隆房貸同一套。各月天數對應的利息：
--   28 天 13,693   29 天 14,182   30 天 14,671   31 天 15,160
-- 原本從 KLFAN 搬來的排程大多寫死 15,160，30 天跟 28 天的月份就會偏高。
--
-- 期數：App 顯示「16 / 360 期」，而明細上到 2026-09-05 為止已經扣了 17 次 ——
-- 差的那一次是撥款日到首次扣款之間的 6 天零頭（2025-05-05 收 2,934），銀行不算一期。
-- 所以第 1 期是 2025-06-05，第 360 期是 2055-05-05，跟已記的到期日一致。
--
-- 寬限期後（2028-06-05 起 324 期）的月付還是推估：原本 KLFAN 寫 30,000 是個整數，
-- 改成用合約條件算出來的 29,911（7,000,000、2.55%、324 期年金）。兩個都還是估的，
-- 但這個至少是從條件推出來的。真正的數字要等 2028 年銀行出攤還表，那時利率也早就變了。

delete from public.loan_schedule s
using public.loan_accounts la
where la.id = s.loan_account_id and la.name = '潤隆增貸' and s.entry_type = 'payment';

-- 撥款日到首次扣款的 6 天零頭
insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2025-05-05', date '2025-05-05', -2934, 'payment', '撥款日至首次扣款的零頭利息'
from public.loan_accounts la where la.name = '潤隆增貸';

-- 第 1~36 期：寬限期只繳息，金額 = 7,000,000 × 2.55% × 當期天數 ÷ 365
insert into public.loan_schedule (loan_account_id, due_date, amount_twd, entry_type, note)
select la.id, due.on_date,
       -round(7000000 * 0.0255 * (due.on_date - (due.on_date - interval '1 month')::date) / 365.0),
       'payment', '寬限期只繳息'
from public.loan_accounts la
cross join generate_series(0, 35) as s(n)
cross join lateral (select (date '2025-06-05' + make_interval(months => s.n))::date as on_date) as due
where la.name = '潤隆增貸';

-- 第 37~360 期：寬限期後本息攤還（推估）
insert into public.loan_schedule (loan_account_id, due_date, amount_twd, entry_type, note)
select la.id, (date '2028-06-05' + make_interval(months => s.n))::date, -29911, 'payment',
       '寬限期後本息攤還（依合約條件試算，非銀行提供）'
from public.loan_accounts la
cross join generate_series(0, 323) as s(n)
where la.name = '潤隆增貸';

-- 明細上看得到的實際入帳日（遇假日順延）
update public.loan_schedule s set actual_date = v.actual_date
from public.loan_accounts la, (values
  (date '2025-06-05', date '2025-06-05'), (date '2025-07-05', date '2025-07-07'),
  (date '2025-08-05', date '2025-08-05'), (date '2025-09-05', date '2025-09-05'),
  (date '2025-10-05', date '2025-10-07'), (date '2025-11-05', date '2025-11-05'),
  (date '2025-12-05', date '2025-12-05'), (date '2026-01-05', date '2026-01-05'),
  (date '2026-02-05', date '2026-02-05'), (date '2026-03-05', date '2026-03-05'),
  (date '2026-04-05', date '2026-04-07'), (date '2026-05-05', date '2026-05-05'),
  (date '2026-06-05', date '2026-06-05'), (date '2026-07-05', date '2026-07-06'),
  (date '2026-08-05', date '2026-08-05'), (date '2026-09-05', date '2026-09-07')
) as v(due_date, actual_date)
where la.id = s.loan_account_id and la.name = '潤隆增貸'
  and s.entry_type = 'payment' and s.due_date = v.due_date;

-- 寬限期本金不動：已扣過的期數本金 0、利息就是扣款金額、餘額維持 7,000,000
update public.loan_schedule s
set applied_at = now(), applied_principal_twd = 0,
    applied_interest_twd = abs(s.amount_twd), applied_balance_twd = 7000000
from public.loan_accounts la
where la.id = s.loan_account_id and la.name = '潤隆增貸'
  and s.entry_type = 'payment'
  and s.due_date <= (now() at time zone 'Asia/Taipei')::date;

update public.loan_accounts la
set last_payment_applied_on = (
      select max(s.due_date) from public.loan_schedule s
      where s.loan_account_id = la.id and s.entry_type = 'payment'
        and s.due_date <= (now() at time zone 'Asia/Taipei')::date),
    projected_total_repayment_twd = (
      select sum(abs(s.amount_twd)) from public.loan_schedule s
      where s.loan_account_id = la.id and s.entry_type = 'payment'),
    source_note = '中信貸款繳息明細 2026-09-08 核對（帳號 ...732645，融資型房貸）：'
      '撥款 7,000,000（2025-04-29）、管理費 9,000；利率 2.55%；actual/365 且利息算到應繳日（每月 5 號）；'
      '2025-05-05 收 6 天零頭利息 2,934（銀行不算一期），第 1 期為 2025-06-05，App 顯示 16/360 期；'
      '寬限期只繳息，餘額維持 7,000,000；明細 17 期反推利率全部吻合。'
      '寬限期後（2028-06-05 起 324 期）月付 29,911 為依合約條件試算，非銀行提供。'
      'KLFAN 另記火災險與代辦費等費用，未出現在本帳號明細（在貸款帳戶外支付）。'
where la.name = '潤隆增貸';
