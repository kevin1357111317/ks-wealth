-- 依 2026-09-08 中國信託房貸 App 畫面新增潤隆房貸。
alter table public.loan_accounts
  drop constraint if exists loan_accounts_loan_type_check;

alter table public.loan_accounts
  add constraint loan_accounts_loan_type_check
  check (loan_type in ('personal', 'topup', 'mortgage'));

insert into public.loan_accounts (
  household_id,
  owner_scope,
  financial_item_id,
  source_key,
  lender,
  name,
  loan_type,
  original_principal_twd,
  nominal_annual_rate,
  contractual_monthly_payment_twd,
  start_date,
  maturity_date,
  projected_total_repayment_twd,
  effective_annual_cost,
  status,
  source_note,
  autopay,
  last_payment_applied_on
)
select
  fi.household_id,
  fi.owner_scope,
  fi.id,
  '230905_KL_CTBC_MORTGAGE',
  '中國信託',
  '潤隆房貸',
  'mortgage',
  8000000,
  2.18,
  30287,
  date '2023-09-05',
  date '2053-09-05',
  10903320,
  null,
  'active',
  '中國信託房貸 App 2026-09-08 核對：原貸款 8,000,000；目前餘額 7,412,586；360 期，已繳 36 期；月付 30,287；表定利率 2.18%；每月 5 日還款；到期 2053-09-05。其他費用待補，實際年化成本暫不顯示。',
  true,
  date '2026-09-05'
from public.financial_items fi
where fi.kind = 'liability'
  and fi.owner_scope = 'husband'
  and fi.category = '房貸'
  and fi.name = '潤隆房貸'
on conflict (household_id, source_key) do update set
  owner_scope = excluded.owner_scope,
  financial_item_id = excluded.financial_item_id,
  lender = excluded.lender,
  name = excluded.name,
  loan_type = excluded.loan_type,
  original_principal_twd = excluded.original_principal_twd,
  nominal_annual_rate = excluded.nominal_annual_rate,
  contractual_monthly_payment_twd = excluded.contractual_monthly_payment_twd,
  start_date = excluded.start_date,
  maturity_date = excluded.maturity_date,
  projected_total_repayment_twd = excluded.projected_total_repayment_twd,
  effective_annual_cost = excluded.effective_annual_cost,
  status = excluded.status,
  closed_on = null,
  source_note = excluded.source_note,
  autopay = excluded.autopay,
  last_payment_applied_on = excluded.last_payment_applied_on,
  updated_at = now();

update public.financial_items fi
set amount_twd = 7412586,
    interest_rate = 2.18,
    monthly_payment_twd = 30287,
    category = '房貸',
    updated_at = now()
from public.loan_accounts la
where la.financial_item_id = fi.id
  and la.source_key = '230905_KL_CTBC_MORTGAGE';

delete from public.loan_schedule ls
using public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '230905_KL_CTBC_MORTGAGE';

insert into public.loan_schedule (
  loan_account_id,
  due_date,
  actual_date,
  amount_twd,
  entry_type,
  note
)
select
  la.id,
  date '2023-09-05',
  date '2023-09-05',
  8000000,
  'disbursement',
  '撥款'
from public.loan_accounts la
where la.source_key = '230905_KL_CTBC_MORTGAGE';

insert into public.loan_schedule (
  loan_account_id,
  due_date,
  actual_date,
  amount_twd,
  balance_after_twd,
  entry_type,
  note
)
select
  la.id,
  (date '2023-09-05' + make_interval(months => s.n))::date,
  case
    when s.n <= 36 then (date '2023-09-05' + make_interval(months => s.n))::date
    else null
  end,
  -30287,
  case when s.n = 36 then 7412586 else null end,
  'payment',
  case when s.n <= 36 then '過往繳款' else '未來繳款' end
from public.loan_accounts la
cross join generate_series(1, 360) as s(n)
where la.source_key = '230905_KL_CTBC_MORTGAGE';
