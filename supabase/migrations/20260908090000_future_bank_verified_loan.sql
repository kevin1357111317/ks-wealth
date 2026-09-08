-- 依 2026-09-08 將來銀行 App 畫面核對貸款條件與還款狀態。
-- 夫妻之間的責任移轉留在 loan_events 作歷史資料，不混入銀行貸款現金流。

update public.loan_accounts
set original_principal_twd = 7010000,
    nominal_annual_rate = 2.38,
    contractual_monthly_payment_twd = 65706,
    start_date = date '2026-03-23',
    maturity_date = date '2036-03-23',
    projected_total_repayment_twd = 7887363,
    effective_annual_cost = 0.024125360640412617,
    source_note = '將來銀行 App 2026-09-08 核對：貸款 7,010,000；120 期；機動利率 2.38%；月付 65,706；2026-08-23 繳款後已還本金 259,629、本金餘額 6,750,371；下次 2026-09-23；到期 2036-03-23。開辦費 2,643 沿用 KLFAN 紀錄並納入實際年化成本。',
    updated_at = now()
where source_key = '260323_KL_將來';

update public.financial_items fi
set amount_twd = 6750371,
    monthly_payment_twd = 65706,
    interest_rate = 2.38,
    updated_at = now()
from public.loan_accounts la
where la.financial_item_id = fi.id
  and la.source_key = '260323_KL_將來';

delete from public.loan_schedule ls
using public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '260323_KL_將來';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2026-03-23', date '2026-03-23', 7010000,
       'disbursement', '將來銀行貸款撥款'
from public.loan_accounts la
where la.source_key = '260323_KL_將來';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2026-03-23', date '2026-03-23', -2643,
       'fee', '開辦費（KLFAN 紀錄）'
from public.loan_accounts la
where la.source_key = '260323_KL_將來';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, balance_after_twd, entry_type, note)
select
  la.id,
  (date '2026-04-23' + make_interval(months => s.n))::date,
  case when s.n between 0 and 4
    then (date '2026-04-23' + make_interval(months => s.n))::date
    else null
  end,
  -65706,
  case when s.n = 4 then 6750371 else null end,
  'payment',
  case when s.n between 0 and 4
    then '實際繳款（將來銀行 App 核對）'
    else '合約預計月付；機動利率變更時金額可能調整'
  end
from public.loan_accounts la
cross join generate_series(0, 119) as s(n)
where la.source_key = '260323_KL_將來';
