-- 依 2026-09-07 LINE Bank App 畫面核對 240820_KL_LB 的貸款條件與實際流水。

alter table public.loan_schedule
add column if not exists balance_after_twd numeric;

update public.loan_accounts
set original_principal_twd = 3500000,
    nominal_annual_rate = 2.18,
    contractual_monthly_payment_twd = 39763,
    start_date = date '2024-08-20',
    maturity_date = date '2032-08-20',
    projected_total_repayment_twd = 3818174,
    effective_annual_cost = 0.022082550246961295,
    source_note = 'LINE Bank App 2026-09-07 核對：貸款 3,500,000；實收 3,499,112；開辦費 888；首期 20,523；其後月付 39,763；2026-09-05 餘額 2,663,371；已繳 25 次、剩 72 次；每月 5 日還款；到期 2032-08-20；12 個月內提前清償違約金 3.0%。',
    updated_at = now()
where source_key = '240820_KL_LB';

update public.financial_items fi
set amount_twd = 2663371,
    monthly_payment_twd = 39763,
    interest_rate = 2.18,
    updated_at = now()
from public.loan_accounts la
where la.financial_item_id = fi.id
  and la.source_key = '240820_KL_LB';

update public.loan_schedule ls
set actual_date = ls.due_date,
    note = case ls.entry_type
      when 'disbursement' then 'LINE Bank 實際撥款（實收 NT$ 3,499,112）'
      when 'fee' then '開辦費'
      when 'payment' then '實際繳款（LINE Bank App 核對）'
      else ls.note
    end
from public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '240820_KL_LB'
  and (
    ls.entry_type in ('disbursement', 'fee')
    or (ls.entry_type = 'payment' and ls.due_date <= date '2026-09-05')
  );

update public.loan_schedule ls
set balance_after_twd = v.balance_after_twd
from public.loan_accounts la
join (values
  (date '2024-09-05', 3482822::numeric),
  (date '2024-10-05', 3449386::numeric),
  (date '2024-11-05', 3415889::numeric),
  (date '2024-12-05', 3382332::numeric),
  (date '2025-01-05', 3348714::numeric),
  (date '2025-02-05', 3315034::numeric),
  (date '2025-03-05', 3281293::numeric),
  (date '2025-04-05', 3247491::numeric),
  (date '2025-05-05', 3213628::numeric),
  (date '2025-06-05', 3179703::numeric),
  (date '2025-07-05', 3145716::numeric),
  (date '2025-08-05', 3111668::numeric),
  (date '2025-09-05', 3077558::numeric),
  (date '2025-10-05', 3043386::numeric),
  (date '2025-11-05', 3009152::numeric),
  (date '2025-12-05', 2974856::numeric),
  (date '2026-01-05', 2940497::numeric),
  (date '2026-02-05', 2906076::numeric),
  (date '2026-03-05', 2871592::numeric),
  (date '2026-04-05', 2837046::numeric),
  (date '2026-05-05', 2802437::numeric),
  (date '2026-06-05', 2767765::numeric),
  (date '2026-07-05', 2733030::numeric),
  (date '2026-08-05', 2698232::numeric),
  (date '2026-09-05', 2663371::numeric)
) as v(due_date, balance_after_twd) on true
where ls.loan_account_id = la.id
  and la.source_key = '240820_KL_LB'
  and ls.entry_type = 'payment'
  and ls.due_date = v.due_date;
