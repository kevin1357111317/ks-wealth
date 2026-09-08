-- 依使用者提供資料補上潤隆房貸開辦費，並更新含費用的實際年化成本。
update public.loan_accounts
set effective_annual_cost = 0.02199399761367926,
    source_note = '中國信託房貸 App 2026-09-08 核對：原貸款 8,000,000；目前餘額 7,412,586；360 期，已繳 36 期；月付 30,287；表定利率 2.18%；每月 5 日還款；到期 2053-09-05。2023-09-05 開辦費 1,000。',
    updated_at = now()
where source_key = '230905_KL_CTBC_MORTGAGE';

delete from public.loan_schedule ls
using public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '230905_KL_CTBC_MORTGAGE'
  and ls.entry_type = 'fee';

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
  -1000,
  'fee',
  '開辦費'
from public.loan_accounts la
where la.source_key = '230905_KL_CTBC_MORTGAGE';
