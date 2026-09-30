-- 貸款分析新增「質押」類型（2026-09-30，屋主同意）
--
-- 這一條已經在 production 用 SQL 直接執行，沒有走 supabase db push，也沒有寫入
-- supabase_migrations.schema_migrations —— production migration history 還沒 reconcile
-- （見 supabase/README.md），不想讓落差變大。之後做 reconciliation 時，這個檔案就是
-- 「production 有、history 沒記」的其中一筆，要一起補。
--
-- 只放寬 CHECK，多允許一個值；既有資料全部落在舊的三個值裡，不受影響。
alter table public.loan_accounts drop constraint loan_accounts_loan_type_check;
alter table public.loan_accounts add constraint loan_accounts_loan_type_check
  check (loan_type = any (array['personal'::text, 'topup'::text, 'mortgage'::text, 'pledge'::text]));
