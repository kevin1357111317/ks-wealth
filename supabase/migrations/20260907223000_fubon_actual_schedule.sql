-- 依台北富邦 App 2026-09-07 畫面核對信貸摘要與實際期程。
-- 原 KLFAN 排程把開辦費列成一期，且把每月 5 日誤放在每月 30 日；
-- 這會讓 App 顯示 5 / 85，而不是銀行畫面的已繳 4 期、剩 80 期。

update public.financial_items fi
set amount_twd = 2487788,
    interest_rate = 2.6000,
    monthly_payment_twd = 33888,
    updated_at = now()
from public.loan_accounts la
where la.financial_item_id = fi.id
  and la.source_key = '260430_KL_富邦';

update public.loan_accounts
set original_principal_twd = 2600000,
    nominal_annual_rate = 2.6000,
    contractual_monthly_payment_twd = 33888,
    start_date = date '2026-04-30',
    maturity_date = date '2033-04-30',
    projected_total_repayment_twd = 2848280,
    source_note = '富邦 App 核對：原貸款 2,600,000；84 期；每月 5 日；月付 33,888；利率 2.6000%；2026-09-07 已繳 4 期、剩 80 期。',
    updated_at = now()
where source_key = '260430_KL_富邦';

delete from public.loan_schedule ls
using public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '260430_KL_富邦';

insert into public.loan_schedule (loan_account_id, due_date, amount_twd, note)
select
  la.id,
  (date '2026-06-05' + make_interval(months => s.n))::date,
  -33888,
  case s.n
    when 0 then '實際扣款 2026-06-05'
    when 1 then '實際扣款 2026-07-06（應繳日 07-05）'
    when 2 then '實際扣款 2026-08-05'
    when 3 then '實際扣款 2026-09-07（應繳日 09-05）'
    else '合約應繳日；遇假日實際扣款日可能順延'
  end
from public.loan_accounts la
cross join generate_series(0, 83) as s(n)
where la.source_key = '260430_KL_富邦';
