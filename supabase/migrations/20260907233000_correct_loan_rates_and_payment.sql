-- 依使用者核對資料，修正三筆舊信貸表定利率、統一費用名稱，並補記元大首期實際繳款。

update public.loan_accounts
set nominal_annual_rate = 2.18,
    updated_at = now()
where source_key in ('211125_KL_CTBC', '240105_CH_LB', '250409_KL_LB');

update public.loan_schedule
set note = '開辦費'
where entry_type = 'fee'
  and note is distinct from '開辦費';

update public.loan_schedule ls
set actual_date = date '2026-09-07',
    note = '第 1 期實際繳款'
from public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '260807_KL_元大'
  and ls.entry_type = 'payment'
  and ls.due_date = date '2026-09-07'
  and ls.actual_date is null;
