-- 使用者已無法確認已結清信貸的表定利率，因此不要保留推測值。
-- 實際年化成本仍由 loan_schedule 的真實現金流計算，不受此欄位清空影響。

update public.loan_accounts
set nominal_annual_rate = null,
    updated_at = now()
where status = 'closed'
  and loan_type = 'personal';
