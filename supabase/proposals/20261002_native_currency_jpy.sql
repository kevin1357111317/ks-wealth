-- 現金及存款新增日圓存款（2026-10-02，屋主要求日圓跟美金一樣自動更新匯率）
--
-- 這一條已經在 production 用 SQL 直接執行，沒有走 supabase db push，也沒有寫入
-- supabase_migrations.schema_migrations —— production migration history 還沒 reconcile
-- （見 supabase/README.md）。之後做 reconciliation 時要跟 20260930_loan_type_pledge.sql 一起補。
--
-- 只放寬 CHECK，多允許一個值；既有資料全部落在 TWD/USD，不受影響。
alter table public.financial_items drop constraint financial_items_native_currency_check;
alter table public.financial_items add constraint financial_items_native_currency_check
  check (native_currency is null or native_currency = any (array['TWD'::text, 'USD'::text, 'JPY'::text]));
