-- Address the database advisor findings introduced by the portfolio link.
alter function public.klfan_bootstrap() set search_path = public, pg_temp;

create index if not exists financial_items_portfolio_stock_key_idx
  on public.financial_items(portfolio_stock_key)
  where portfolio_stock_key is not null;
