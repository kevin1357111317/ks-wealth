-- 鼎宇房貸（玉山銀行）。夫妻各付一半，所以拆成兩筆各 11,895,000、月付 21,609.5 記錄，
-- 兩邊加起來就是銀行 App 上的 23,790,000 與月付 43,219。
--
-- 玉山這筆的利息是「年利率 ÷ 12」，不是其他信貸的 actual/365 —— 每個月不管幾天都固定
-- 43,219 就是證據：23,790,000 × 2.18% ÷ 12 = 43,218.5，四捨五入剛好 43,219。所以另外記
-- interest_day_count，出寬限期之後拆本金才會對。
--
-- 寬限期 2024-03-01 ~ 2027-03-01 只繳息、本金不動，跟 App 上「本金已償還 0%」對得上。
-- 2027-03-05 起 325 期本息攤還，每半份 48,494 是照 2.18% 試算的，不是銀行給的數字 ——
-- 銀行 App 有「本息攤還表」，拿到之後要用實際數字覆蓋。

alter table public.loan_accounts
  add column if not exists interest_day_count text not null default 'act365';

alter table public.loan_accounts
  drop constraint if exists loan_accounts_interest_day_count_check;
alter table public.loan_accounts
  add constraint loan_accounts_interest_day_count_check
  check (interest_day_count in ('act365', 'month12'));

-- 負債列（夫妻各一筆）本來就在了，這裡只補上分析用的貸款主檔
insert into public.loan_accounts
  (household_id, owner_scope, financial_item_id, source_key, lender, name, loan_type,
   original_principal_twd, nominal_annual_rate, contractual_monthly_payment_twd,
   start_date, maturity_date, grace_until, interest_day_count,
   projected_total_repayment_twd, status, source_note)
select fi.household_id, fi.owner_scope, fi.id,
       case fi.owner_scope when 'husband' then '240301_KL_ESUN_MORTGAGE'
                           else '240301_CH_ESUN_MORTGAGE' end,
       '玉山銀行', '鼎宇房貸', 'mortgage',
       11895000, 2.18, 21609.5,
       date '2024-03-01', date '2054-03-01', date '2027-03-01', 'month12',
       16516874, 'active',
       '玉山 App 2026-09-08 核對：初貸 23,790,000（夫妻各半 11,895,000）；2.18%；'
       '借款期間 2024-03-01~2054-03-01；寬限期至 2027-03-01；寬限期月付 43,219（各半 21,609.5）；'
       '本金已償還 0%；下次應繳 2026-10-05。寬限期後 325 期本息攤還為 2.18% 試算，非銀行提供。'
from public.financial_items fi
where fi.name = '鼎宇房貸' and fi.kind = 'liability'
  and not exists (select 1 from public.loan_accounts la where la.financial_item_id = fi.id);

insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, date '2024-03-01', date '2024-03-01', 11895000, 'disbursement', '貸款撥款'
from public.loan_accounts la where la.name = '鼎宇房貸';

-- 360 期，每月 5 日。前 35 期（到 2027-02-05）在寬限期內只繳息，
-- 2027-03-05 起本息攤還。actual_date 是 App 上看得到的實際扣款日，遇假日順延。
insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id,
       due.on_date,
       real.actual_date,
       case when s.n < 35 then -21609.5 else -48494 end,
       'payment',
       case when s.n < 35 then '寬限期只繳息' else '寬限期後本息攤還（試算）' end
from public.loan_accounts la
cross join generate_series(0, 359) as s(n)
cross join lateral (select (date '2024-04-05' + make_interval(months => s.n))::date as on_date) as due
left join (values
  (date '2026-03-05', date '2026-03-05'),
  (date '2026-04-05', date '2026-04-07'),
  (date '2026-05-05', date '2026-05-05'),
  (date '2026-06-05', date '2026-06-05'),
  (date '2026-07-05', date '2026-07-06'),
  (date '2026-08-05', date '2026-08-05'),
  (date '2026-09-05', date '2026-09-07')
) as real(due_date, actual_date) on real.due_date = due.on_date
where la.name = '鼎宇房貸';

-- 今天以前的期數當作已經反映在餘額裡（寬限期本金本來就沒動），不追溯重扣
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
-- 自動扣款要照各家銀行自己的算法拆本金／利息。玉山這筆是年利率 ÷ 12，
-- 其他信貸是 actual/365（元大、富邦、將來重播到今天都完全對得上）。
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

      interest := case acct.day_count
        when 'month12' then round(bal * acct.rate / 100 / 12)
        else round(bal * acct.rate / 100 * (pay_row.on_date - prev) / 365.0)
      end;
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

      prev := pay_row.on_date;
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
