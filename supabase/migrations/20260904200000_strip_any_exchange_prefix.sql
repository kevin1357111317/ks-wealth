-- sync_klfan_financial_item() 原本只剝除列舉的那幾個交易所前綴
-- （TPE: NASDAQ: NYSEARCA: NYSE:），遇到 BATS: 就整串照抄進 financial_items.symbol。
-- 帶冒號的代號過不了 refresh-tw-quotes 的 validSymbol（^[0-9A-Z.-]+$），
-- 那一檔從此靜靜地不會被報價 —— BATS:DRAM 就是這樣中的。
-- 改成剝掉任何「英數:」開頭，就不會再有下一個漏掉的前綴。
create or replace function public.sync_klfan_financial_item(target_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  stock_row public.klfan_stocks%rowtype;
  share_total numeric;
  quote_price numeric;
  usd_rate numeric;
  value_twd numeric;
  bare_symbol text;
  market_code text;
begin
  select * into stock_row from public.klfan_stocks where key = target_key;
  if not found then return; end if;
  select coalesce(sum(shares), 0) into share_total
    from public.klfan_transactions where stock_key = target_key;
  select coalesce(q.price, stock_row.manual_price, 0) into quote_price
    from (select 1) seed
    left join public.klfan_quotes q on upper(q.symbol) = upper(stock_row.symbol)
    limit 1;
  select coalesce((select rate from public.klfan_fx_daily order by fx_date desc limit 1), 0)
    into usd_rate;
  value_twd := greatest(0, share_total) * greatest(0, quote_price)
    * case when stock_row.currency = 'USD' then usd_rate else 1 end;
  bare_symbol := regexp_replace(upper(coalesce(stock_row.symbol, stock_row.key)), '^[A-Z0-9]+:', '');
  market_code := case when stock_row.market = '美股' then 'US' else 'TW' end;

  if abs(share_total) > 0.0000001 or exists (
    select 1 from public.financial_items where portfolio_stock_key = target_key
  ) then
    insert into public.financial_items (
      household_id, owner_scope, kind, category, name, amount_twd,
      symbol, market, quantity, quote_currency, quote_source, fx_rate_twd,
      portfolio_stock_key, created_by, updated_by, updated_at
    ) values (
      stock_row.household_id, stock_row.owner_scope, 'asset',
      case when market_code = 'US' then '美股' else '台股' end,
      stock_row.display, value_twd, bare_symbol, market_code, greatest(0, share_total),
      stock_row.currency, case when market_code = 'US' then 'twelve_data' else 'fugle' end,
      case when market_code = 'US' then usd_rate else 1 end,
      target_key, auth.uid(), auth.uid(), now()
    )
    on conflict (household_id, portfolio_stock_key) where portfolio_stock_key is not null
    do update set
      owner_scope = excluded.owner_scope, category = excluded.category, name = excluded.name,
      amount_twd = excluded.amount_twd, symbol = excluded.symbol, market = excluded.market,
      quantity = excluded.quantity, quote_currency = excluded.quote_currency,
      quote_source = excluded.quote_source, fx_rate_twd = excluded.fx_rate_twd,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
end;
$$;

update public.financial_items
set symbol = regexp_replace(upper(symbol), '^[A-Z0-9]+:', '')
where symbol like '%:%';
