-- 用玉山 App「本息攤還表」的實際數字覆蓋原本自己試算的排程。
--
-- 攤還表上看得到的：寬限期只繳息一路到「第 37 期」，第 38 期才開始還本金
-- （53,989 / 43,219 / 97,208）—— 原本按「寬限期間 2024-03-01~2027-03-01」推的 35 期是錯的，
-- 銀行實際多繳兩期利息。
--
-- 反推出銀行的算法：月付 97,207.69 對應「324 期」的年金（323 期會是 97,428、325 期是
-- 96,988，都對不上），利息 = 餘額 × 2.18% ÷ 12，餘額不四捨五入往下帶。用這組規則重算，
-- 攤還表上抽查的 12 列有 11 列分毫不差（只有第 114 期的本金差 1 元，精確值 61,974.64
-- 落在進位邊界上），而且最後一期餘額剛好歸零。
--
-- 第 38 期起 324 期會排到 2054-04-05，比「借款期間 2054-03-01」多一個月。銀行的月付金額
-- 就是這樣算出來的，攤還表最後一列還沒看到 —— 之後翻到表尾要再對一次。
--
-- 寬限期利息精確值是 43,218.50（App 顯示 43,219/43,218 交替就是這個半元在跳），
-- 所以每半份記 21,609.25 而不是之前的 21,609.5。

update public.loan_accounts
set grace_until = date '2027-04-05',
    contractual_monthly_payment_twd = 21609.25,
    source_note = '玉山 App 2026-09-08 核對，含本息攤還表：初貸 23,790,000（夫妻各半 11,895,000）；'
      '2.18%；寬限期只繳息至第 37 期（2027-04-05），第 38 期起 324 期本息攤還；'
      '全額寬限期月付 43,218.5、攤還期月付 97,207.69（各半 21,609.25 / 48,603.84）；'
      '本金已償還 0%；下次應繳 2026-10-05。攤還表抽查 12 列有 11 列完全吻合。'
where name = '鼎宇房貸';

delete from public.loan_schedule s
using public.loan_accounts la
where la.id = s.loan_account_id and la.name = '鼎宇房貸' and s.entry_type = 'payment';

-- 第 1~37 期：寬限期只繳息
insert into public.loan_schedule (loan_account_id, due_date, actual_date, amount_twd, entry_type, note)
select la.id, due.on_date, real.actual_date, -21609.25, 'payment', '寬限期只繳息'
from public.loan_accounts la
cross join generate_series(1, 37) as s(n)
cross join lateral (select (date '2024-04-05' + make_interval(months => s.n - 1))::date as on_date) as due
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

-- 第 38~361 期：本息攤還，金額照攤還表反推的月付
insert into public.loan_schedule (loan_account_id, due_date, amount_twd, entry_type, note)
select la.id, (date '2024-04-05' + make_interval(months => s.n - 1))::date, -48603.84, 'payment',
       '本息攤還（玉山本息攤還表）'
from public.loan_accounts la
cross join generate_series(38, 361) as s(n)
where la.name = '鼎宇房貸';

update public.loan_accounts la
set projected_total_repayment_twd = (
  select sum(abs(s.amount_twd)) from public.loan_schedule s
  where s.loan_account_id = la.id and s.entry_type = 'payment')
where la.name = '鼎宇房貸';

-- 今天以前的期數當作已經反映在餘額裡（寬限期本金本來就沒動）
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
