alter table public.financial_items
  add column if not exists native_currency text,
  add column if not exists native_amount numeric;

alter table public.financial_items
  drop constraint if exists financial_items_native_currency_check;

alter table public.financial_items
  add constraint financial_items_native_currency_check
  check (native_currency is null or native_currency in ('TWD', 'USD'));

update public.financial_items
set native_currency = 'TWD',
    native_amount = amount_twd
where market = 'MANUAL'
  and native_currency is null;
