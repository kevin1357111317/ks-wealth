-- 潤隆房貸：用中信「貸款繳息明細」的實際數字覆蓋歷史，並修掉一個會算出負利息的 bug。
--
-- 明細把差 1,878 元的原因講清楚了 —— 就是升息，屋主猜對了。反推每一期的利率：
--   2023-10-05 ~ 2024-04-05  2.0600%
--   2024-05-05               2.1085%（過渡月，利率在月中改的，約 4/23 前後）
--   2024-06-05 起            2.1800%
-- 央行 2024-03-21 升息 0.125%，中信隔一個月才反映；月付也同時從 29,811 改成 30,287。
-- 我原本猜升息前是 2.055%、4 月就生效，兩個都差一點，所以之前怎麼湊都對不上。
--
-- 也確認了算法：actual/365，而且利息算到「應繳日」而不是實際入帳日 —— 2023-11-06 那筆
-- 用 11/05 算才會得到乾淨的 2.06%。跟富邦是同一套。
--
-- bug：原本 days 是 due_date 減 last_payment_applied_on，沒有下限。一筆貸款如果帶著
-- 「已套用到今天」的狀態、卻還有更早的未套用排程（新匯入的貸款就是這樣），days 會變負的，
-- 利息跟著變負，本金就爆掉 —— 潤隆房貸第一期就被寫成本金 502,231、利息 -471,944。
-- 餘額本身沒被寫壞（是另一支遷移後來蓋回去的），但那些欄位是垃圾。
update public.loan_schedule s set amount_twd = -29811
from public.loan_accounts la where la.id = s.loan_account_id and la.name = '潤隆房貸'
  and s.entry_type = 'payment' and s.due_date between date '2023-10-05' and date '2024-05-05';

update public.loan_schedule s set
  actual_date = v.actual_date, applied_principal_twd = v.principal,
  applied_interest_twd = v.interest, applied_balance_twd = v.balance
from public.loan_accounts la, (values
  (date '2023-10-05', date '2023-10-05', 16266, 13545, 7983734),
  (date '2023-11-05', date '2023-11-06', 15843, 13968, 7967891),
  (date '2023-12-05', date '2023-12-05', 16319, 13492, 7951572),
  (date '2024-01-05', date '2024-01-05', 15899, 13912, 7935673),
  (date '2024-02-05', date '2024-02-05', 15927, 13884, 7919746),
  (date '2024-03-05', date '2024-03-05', 16849, 12962, 7902897),
  (date '2024-04-05', date '2024-04-08', 15984, 13827, 7886913),
  (date '2024-05-05', date '2024-05-06', 16143, 13668, 7870770),
  (date '2024-06-05', date '2024-06-05', 15713, 14574, 7855057),
  (date '2024-07-05', date '2024-07-05', 16212, 14075, 7838845),
  (date '2024-08-05', date '2024-08-05', 15773, 14514, 7823072),
  (date '2024-09-05', date '2024-09-05', 15803, 14484, 7807269),
  (date '2024-10-05', date '2024-10-07', 16298, 13989, 7790971),
  (date '2024-11-05', date '2024-11-05', 15860, 14427, 7775111),
  (date '2024-12-05', date '2024-12-05', 16356, 13931, 7758755),
  (date '2025-01-05', date '2025-01-06', 15922, 14365, 7742833),
  (date '2025-02-05', date '2025-02-05', 15950, 14337, 7726883),
  (date '2025-03-05', date '2025-03-05', 17365, 12922, 7709518),
  (date '2025-04-05', date '2025-04-07', 16013, 14274, 7693505),
  (date '2025-05-05', date '2025-05-05', 16500, 13787, 7677005),
  (date '2025-06-05', date '2025-06-05', 16073, 14214, 7660932),
  (date '2025-07-05', date '2025-07-07', 16560, 13727, 7644372),
  (date '2025-08-05', date '2025-08-05', 16131, 14156, 7628241),
  (date '2025-09-05', date '2025-09-05', 16163, 14124, 7612078),
  (date '2025-10-05', date '2025-10-07', 16648, 13639, 7595430),
  (date '2025-11-05', date '2025-11-05', 16222, 14065, 7579208),
  (date '2025-12-05', date '2025-12-05', 16707, 13580, 7562501),
  (date '2026-01-05', date '2026-01-05', 16285, 14002, 7546216),
  (date '2026-02-05', date '2026-02-05', 16315, 13972, 7529901),
  (date '2026-03-05', date '2026-03-05', 17695, 12592, 7512206),
  (date '2026-04-05', date '2026-04-07', 16378, 13909, 7495828),
  (date '2026-05-05', date '2026-05-05', 16854, 13433, 7478974),
  (date '2026-06-05', date '2026-06-05', 16440, 13847, 7462534),
  (date '2026-07-05', date '2026-07-06', 16916, 13371, 7445618),
  (date '2026-08-05', null::date, 16501, 13786, 7429117),
  (date '2026-09-05', null::date, 16532, 13755, 7412585)
) as v(due_date, actual_date, principal, interest, balance)
where la.id = s.loan_account_id and la.name = '潤隆房貸'
  and s.entry_type = 'payment' and s.due_date = v.due_date;

-- 最後一期算出來的餘額：7,412,585

update public.loan_accounts
set source_note = '中信貸款繳息明細 2026-09-08 核對（帳號 ...888423）：撥款 8,000,000（2023-09-05）、'
  '管理費 1,000；利率 2.06% 至 2024-04-05，2024-06-05 起 2.18%（央行 2024-03-21 升息 0.125%，'
  '中信隔月反映，過渡月 2024-05-05 為 2.1085%）；月付同步由 29,811 改為 30,287；'
  'actual/365 且利息算到應繳日。明細涵蓋到 2026-07-05，之後兩期用同一套算法推，'
  '算出來 7,412,585 與記錄的餘額 7,412,586 差 1 元。'
where name = '潤隆房貸';

-- days 夾在 0 以上：新匯入的貸款會帶著「已套用到今天」但排程從過去開始，
-- 沒有下限的話天數是負的，利息跟著變負、本金爆掉。
create or replace function public.apply_due_loan_payments()
returns table (
  loan_account_id uuid,
  loan_name text,
  due_date date,
  principal_twd numeric,
  interest_twd numeric,
  balance_twd numeric
)
language plpgsql
as $$
declare
  today date := (now() at time zone 'Asia/Taipei')::date;
  acct record;
  pay_row record;
  bal numeric;
  prev date;
  days integer;
  interest numeric;
  principal numeric;
begin
  for acct in
    select la.id, la.name, la.start_date, la.grace_until, la.interest_day_count as day_count,
           coalesce(fi.interest_rate, la.nominal_annual_rate, 0)::numeric as rate,
           fi.id as item_id,
           fi.amount_twd::numeric as balance,
           coalesce(la.last_payment_applied_on, la.start_date) as last_due
    from public.loan_accounts la
    join public.financial_items fi on fi.id = la.financial_item_id
    where la.status = 'active' and la.autopay and fi.kind = 'liability'
    order by la.id
  loop
    perform 1 from public.loan_accounts where id = acct.id for update;

    bal := acct.balance;
    prev := acct.last_due;

    for pay_row in
      select s.id, s.due_date as on_date, abs(s.amount_twd)::numeric as pay
      from public.loan_schedule s
      where s.loan_account_id = acct.id
        and s.entry_type = 'payment'
        and s.due_date <= today
        and s.applied_at is null
      order by s.due_date, s.id
    loop
      update public.loan_schedule set applied_at = now()
      where id = pay_row.id and applied_at is null;
      if not found then continue; end if;

      days := greatest(0, pay_row.on_date - prev);
      interest := greatest(0, case acct.day_count
        when 'month12' then round(bal * acct.rate / 100 / 12)
        else round(bal * acct.rate / 100 * days / 365.0)
      end);
      if acct.grace_until is not null and pay_row.on_date <= acct.grace_until then
        principal := 0;                      -- 寬限期只繳息
      else
        principal := greatest(0, round(pay_row.pay - interest));
      end if;
      principal := least(principal, bal);
      bal := bal - principal;

      update public.loan_schedule
      set applied_principal_twd = principal,
          applied_interest_twd = interest,
          applied_balance_twd = bal
      where id = pay_row.id;

      prev := greatest(prev, pay_row.on_date);
      loan_account_id := acct.id;
      loan_name := acct.name;
      due_date := pay_row.on_date;
      principal_twd := principal;
      interest_twd := interest;
      balance_twd := bal;
      return next;
    end loop;

    if prev <> acct.last_due then
      update public.financial_items
      set amount_twd = bal, updated_at = now()
      where id = acct.item_id;
      update public.loan_accounts
      set last_payment_applied_on = prev, updated_at = now()
      where id = acct.id;
    end if;
  end loop;
end $$;

grant execute on function public.apply_due_loan_payments() to authenticated, service_role;

update public.loan_accounts la
set projected_total_repayment_twd = (
  select sum(abs(s.amount_twd)) from public.loan_schedule s
  where s.loan_account_id = la.id and s.entry_type = 'payment')
where la.name = '潤隆房貸';
