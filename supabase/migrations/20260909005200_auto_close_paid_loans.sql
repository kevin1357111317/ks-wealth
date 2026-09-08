-- 最後一期繳完、餘額歸零且沒有未處理還款時，自動把貸款由 active 轉為 closed。
-- closed_on 使用最後一筆實際套用的應繳日，而不是使用者晚幾天才打開 App 的日期。

create or replace function public.apply_due_loan_payments()
returns table(
  loan_account_id uuid,
  loan_name text,
  due_date date,
  principal_twd numeric,
  interest_twd numeric,
  balance_twd numeric
)
language plpgsql
as $function$
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
    select la.id, la.name, la.start_date, la.maturity_date, la.grace_until,
           la.interest_day_count as day_count,
           coalesce(fi.interest_rate, la.nominal_annual_rate, 0)::numeric as rate,
           fi.id as item_id,
           fi.amount_twd::numeric as balance,
           coalesce(la.last_payment_applied_on, la.start_date) as last_due
    from public.loan_accounts la
    join public.financial_items fi on fi.id = la.financial_item_id
    where la.status = 'active'
      and la.autopay
      and fi.kind = 'liability'
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
      update public.loan_schedule
      set applied_at = now()
      where id = pay_row.id
        and applied_at is null;
      if not found then
        continue;
      end if;

      days := greatest(0, pay_row.on_date - prev);
      interest := greatest(0, case acct.day_count
        when 'month12' then round(bal * acct.rate / 100 / 12)
        else round(bal * acct.rate / 100 * days / 365.0)
      end);

      if acct.grace_until is not null and pay_row.on_date <= acct.grace_until then
        principal := 0;
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
      set amount_twd = bal,
          updated_at = now()
      where id = acct.item_id;

      update public.loan_accounts
      set last_payment_applied_on = prev,
          updated_at = now()
      where id = acct.id;
    end if;

    -- 完整生命週期收尾：本金已歸零，而且沒有任何尚未處理的 payment 排程時才自動結清。
    -- 若有殘餘本金或仍有未來期數，維持 active，避免因資料異常誤判結清。
    if bal <= 0
       and not exists (
         select 1
         from public.loan_schedule s
         where s.loan_account_id = acct.id
           and s.entry_type = 'payment'
           and s.applied_at is null
       ) then
      update public.financial_items
      set amount_twd = 0,
          updated_at = now()
      where id = acct.item_id;

      update public.loan_accounts
      set status = 'closed',
          closed_on = coalesce(prev, acct.maturity_date, today),
          autopay = false,
          last_payment_applied_on = coalesce(prev, acct.last_due),
          updated_at = now()
      where id = acct.id
        and status = 'active';
    end if;
  end loop;
end
$function$;
