-- 依 KLFAN「250429_KL_CTBC」工作表核對潤隆增貸的所有其他費用。
-- 20260907233000 曾把所有 fee 的名稱統一成「開辦費」，並且 2026-08-28
-- 的火災險被誤判為 payment；這裡恢復原始費用名稱與正確分類。

update public.loan_schedule ls
set entry_type = 'fee',
    note = case ls.amount_twd
      when -9000 then '管帳費'
      when -66 then '火災險'
      when -2210 then '火災險'
      when -11560 then '代辦費'
      else ls.note
    end
from public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '250429_KL_CTBC'
  and ls.due_date = date '2025-04-29'
  and ls.amount_twd in (-9000, -66, -2210, -11560);

update public.loan_schedule ls
set entry_type = 'fee',
    note = '火災險'
from public.loan_accounts la
where ls.loan_account_id = la.id
  and la.source_key = '250429_KL_CTBC'
  and ls.due_date = date '2026-08-28'
  and ls.amount_twd = -2210;

update public.loan_accounts
set source_note = 'KLFAN 250429_KL_CTBC 核對：其他費用共 5 筆、NT$ 25,046（管帳費 9,000；火災險 66、2,210、2,210；代辦費 11,560）。所有現金流原已納入 XIRR，修正分類後實際年化成本維持約 2.6309%。',
    updated_at = now()
where source_key = '250429_KL_CTBC';
