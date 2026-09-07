-- 每一筆貸款的還款排程。KLFAN 試算表裡本來就有這張表（每一期的日期與金額），
-- 之前只把摘要搬進 loan_accounts，排程留在試算表裡。
--
-- 不用公式現算的原因：實際條件有寬限期、責任轉移、增貸這些例外，算出來對不上。
-- 元大那筆就是例子 —— 試算表的「結算日期」欄寫 2033，但排程列一路到 2036，
-- 用 7 年去算月付會變成 14,371（實際是 10,606），10 年才對得上。

create table if not exists public.loan_schedule (
  id bigint generated always as identity primary key,
  loan_account_id uuid not null references public.loan_accounts(id) on delete cascade,
  due_date date not null,
  -- 負為還款、正為撥款或責任轉移，跟試算表的「投入」同一個符號約定
  amount_twd numeric not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists loan_schedule_account_date_idx
  on public.loan_schedule (loan_account_id, due_date, id);

alter table public.loan_schedule enable row level security;

drop policy if exists loan_schedule_member_all on public.loan_schedule;
create policy loan_schedule_member_all on public.loan_schedule
  for all to authenticated
  using (exists (
    select 1 from public.loan_accounts la
    join public.household_members hm on hm.household_id = la.household_id
    where la.id = loan_schedule.loan_account_id and hm.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.loan_accounts la
    join public.household_members hm on hm.household_id = la.household_id
    where la.id = loan_schedule.loan_account_id and hm.user_id = (select auth.uid())
  ));

-- 元大是 10 年期（120 期），不是原本記的 7 年。用 3.75% 算：120 期月付 10,606、
-- 10,606 × 120 + 開辦費 2,888 = 1,275,608，跟試算表的總成本完全吻合。
update public.loan_accounts
set maturity_date = date '2036-08-07',
    source_note = coalesce(source_note || ' ', '') || '到期日更正為 2036-08-07（120 期）'
where source_key is not null and start_date = date '2026-08-07' and lender = '元大銀行';
