-- 繳款日到了就自動把負債扣掉，不用每個月手動改。
--
-- 分本金／利息的算法是從實際餘額反推出來的，不是猜的：銀行用 actual/365，
-- 利息 = 餘額 × 年利率 × 兩次繳款日相隔天數 ÷ 365，本金 = 月付 − 利息。
-- 把每一筆從撥款日重播到今天，跟 KLFAN 與銀行 App 核對過的餘額對答案：
-- 元大、富邦、將來、潤隆完全一樣，連線 25 期差 28 元（四捨五入累積）。
--
-- 用 due_date 不是 actual_date：富邦第 2、4 期遇假日順延，用實際扣款日重播會多算
-- 361 元 —— 銀行的利息是算到應繳日為止，順延那幾天不多收。
--
-- 潤隆是寬限期只繳息，月付 15,160 幾乎等於當月利息，本金完全沒動；這種期間用上面的
-- 公式會多扣幾百塊，所以另外記 grace_until，寬限期內本金一律 0。2028-06-05 起排程
-- 跳到 30,000，那時才開始真的還本金。
--
-- 哪些列算還款由 loan_cashflow_types 那支的 entry_type 決定，撥款與開辦費不會被扣。

alter table public.loan_schedule
  add column if not exists applied_at timestamptz,
  add column if not exists applied_principal_twd numeric,
  add column if not exists applied_interest_twd numeric,
  add column if not exists applied_balance_twd numeric;

alter table public.loan_accounts
  add column if not exists grace_until date,
  add column if not exists last_payment_applied_on date,
  add column if not exists autopay boolean not null default true;

create index if not exists loan_schedule_pending_idx
  on public.loan_schedule (loan_account_id, due_date) where applied_at is null;

-- 潤隆增貸寬限期到 2028-05-05（排程最後一筆 15,160 就是這天）。
update public.loan_accounts
set grace_until = date '2028-05-05'
where lender = '中國信託' and loan_type = 'topup' and start_date = date '2025-04-29'
  and grace_until is null;

-- 回填。搬進來的餘額本來就已經反映了今天以前的所有期數，不能再追溯扣一次，
-- 所以把過去的排程列直接標成已套用（不填金額 —— 那些期數不是這支程式算的）。
update public.loan_schedule s
set applied_at = now()
where s.applied_at is null
  and s.due_date <= (now() at time zone 'Asia/Taipei')::date;

update public.loan_accounts la
set last_payment_applied_on = coalesce((
  select max(s.due_date) from public.loan_schedule s
  where s.loan_account_id = la.id
    and s.entry_type = 'payment'
    and s.due_date <= (now() at time zone 'Asia/Taipei')::date
), la.start_date)
where la.last_payment_applied_on is null;

-- 把到期的期數套用到 financial_items 的負債餘額上。回傳實際扣了哪幾期，
-- 前端據此決定要不要重載。呼叫多少次都一樣 —— 只處理 applied_at is null 的列。
--
-- security invoker：跟 klfan_bootstrap 一樣走 RLS，前端用自己的身分呼叫只動得到
-- 自己家的資料；每日快照那支邊緣函式用 service role 呼叫則不受限。
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
    select la.id, la.name, la.start_date, la.grace_until,
           coalesce(fi.interest_rate, la.nominal_annual_rate, 0)::numeric as rate,
           fi.id as item_id,
           fi.amount_twd::numeric as balance,
           coalesce(la.last_payment_applied_on, la.start_date) as last_due
    from public.loan_accounts la
    join public.financial_items fi on fi.id = la.financial_item_id
    where la.status = 'active' and la.autopay and fi.kind = 'liability'
    order by la.id
  loop
    -- 鎖住這筆貸款，兩台裝置同時開 App 也不會各扣一次。
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

      interest := round(bal * acct.rate / 100 * (pay_row.on_date - prev) / 365.0);
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
