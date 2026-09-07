-- 排程改成完整現金流：撥款、費用、還款與調整分開，讓前端能用 XIRR
-- 計算含所有費用與實際日期的年化成本，也不會再把開辦費算成一期。

alter table public.loan_schedule
  add column if not exists entry_type text,
  add column if not exists actual_date date;

update public.loan_schedule ls
set entry_type = case
  when ls.amount_twd > 0 then 'disbursement'
  when ls.amount_twd < 0 and ls.due_date = la.start_date then 'fee'
  else 'payment'
end
from public.loan_accounts la
where la.id = ls.loan_account_id
  and ls.entry_type is null;

alter table public.loan_schedule
  alter column entry_type set default 'payment',
  alter column entry_type set not null;

alter table public.loan_schedule
  drop constraint if exists loan_schedule_entry_type_check;

alter table public.loan_schedule
  add constraint loan_schedule_entry_type_check
  check (entry_type in ('disbursement', 'fee', 'payment', 'adjustment'));

-- 富邦 App 的真實資料：撥款與開辦費獨立列出，84 期還款才是期數。
delete from public.loan_schedule ls
using public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '260430_KL_富邦';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2026-04-30', date '2026-04-30', 2600000,
       'disbursement', '貸款撥款'
from public.loan_accounts la
where la.source_key = '260430_KL_富邦';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2026-04-30', date '2026-04-30', -1688,
       'fee', '開辦費'
from public.loan_accounts la
where la.source_key = '260430_KL_富邦';

insert into public.loan_schedule
  (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select
  la.id,
  (date '2026-06-05' + make_interval(months => s.n))::date,
  case s.n
    when 0 then date '2026-06-05'
    when 1 then date '2026-07-06'
    when 2 then date '2026-08-05'
    when 3 then date '2026-09-07'
    else null
  end,
  -33888,
  'payment',
  case s.n
    when 0 then '第 1 期實際繳款'
    when 1 then '第 2 期實際繳款；應繳日 07-05，遇假日順延'
    when 2 then '第 3 期實際繳款'
    when 3 then '第 4 期實際繳款；應繳日 09-05，遇假日順延'
    else '合約應繳；遇假日實際扣款日可能順延'
  end
from public.loan_accounts la
cross join generate_series(0, 83) as s(n)
where la.source_key = '260430_KL_富邦';

update public.loan_accounts
set effective_annual_cost = 0.026362188059457878,
    projected_total_repayment_twd = 2848280,
    source_note = '富邦 App 核對：撥款 2,600,000；開辦費 1,688；84 期；每月 5 日；月付 33,888；利率 2.6000%；2026-09-07 已繳 4 期、剩 80 期；依實際日期與全部現金流計算有效年成本約 2.6362%。',
    updated_at = now()
where source_key = '260430_KL_富邦';
