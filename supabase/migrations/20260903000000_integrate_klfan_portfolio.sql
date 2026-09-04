-- Integrate the KLFAN transaction ledger into KS Wealth without counting the
-- same seven live positions twice. The ledger owns transaction history;
-- financial_items remains the household net-worth aggregation layer.

alter table public.klfan_stocks
  add column if not exists household_id uuid references public.households(id) on delete cascade,
  add column if not exists owner_scope text not null default 'husband'
    check (owner_scope in ('husband', 'wife'));

do $$
declare
  target_household uuid;
begin
  if exists (select 1 from public.klfan_stocks where household_id is null) then
    if (select count(*) from public.households) <> 1 then
      raise exception 'KLFAN backfill requires exactly one household';
    end if;
    select id into target_household from public.households limit 1;
    update public.klfan_stocks set household_id = target_household where household_id is null;
  end if;
end $$;

alter table public.klfan_stocks alter column household_id set not null;
create index if not exists klfan_stocks_household_idx on public.klfan_stocks(household_id);
create index if not exists klfan_transactions_stock_date_idx
  on public.klfan_transactions(stock_key, tx_date desc, id desc);

alter table public.financial_items
  add column if not exists portfolio_stock_key text
    references public.klfan_stocks(key) on update cascade on delete set null;

-- Link existing live positions by household, market and normalized quote symbol.
with live_positions as (
  select s.key, s.household_id, s.market,
         regexp_replace(upper(coalesce(s.symbol, s.key)), '^(TPE:|NASDAQ:|NYSEARCA:|NYSE:)', '') as bare_symbol,
         sum(t.shares) as shares
  from public.klfan_stocks s
  join public.klfan_transactions t on t.stock_key = s.key
  group by s.key, s.household_id, s.market, s.symbol
  having abs(sum(t.shares)) > 0.0000001
)
update public.financial_items fi
set portfolio_stock_key = lp.key
from live_positions lp
where fi.portfolio_stock_key is null
  and fi.household_id = lp.household_id
  and fi.kind = 'asset'
  and ((lp.market = '台股' and fi.market = 'TW') or (lp.market = '美股' and fi.market = 'US'))
  and upper(coalesce(fi.symbol, '')) = lp.bare_symbol;

create unique index if not exists financial_items_portfolio_stock_unique
  on public.financial_items(household_id, portfolio_stock_key)
  where portfolio_stock_key is not null;

-- Keep the net-worth aggregation row synchronized whenever ledger shares,
-- prices or USD/TWD change. This also creates the aggregation row when a
-- previously exited or newly added stock becomes an active position.
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
  bare_symbol := regexp_replace(upper(coalesce(stock_row.symbol, stock_row.key)),
    '^(TPE:|NASDAQ:|NYSEARCA:|NYSE:)', '');
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

create or replace function public.sync_klfan_after_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.sync_klfan_financial_item(coalesce(new.stock_key, old.stock_key));
  if tg_op = 'UPDATE' and old.stock_key is distinct from new.stock_key then
    perform public.sync_klfan_financial_item(old.stock_key);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists klfan_transactions_sync_financial on public.klfan_transactions;
create trigger klfan_transactions_sync_financial
after insert or update or delete on public.klfan_transactions
for each row execute function public.sync_klfan_after_transaction();

create or replace function public.sync_klfan_after_quote()
returns trigger language plpgsql security definer set search_path = '' as $$
declare stock_key text;
begin
  for stock_key in select key from public.klfan_stocks where upper(symbol) = upper(new.symbol)
  loop perform public.sync_klfan_financial_item(stock_key); end loop;
  return new;
end;
$$;

drop trigger if exists klfan_quotes_sync_financial on public.klfan_quotes;
create trigger klfan_quotes_sync_financial
after insert or update of price on public.klfan_quotes
for each row execute function public.sync_klfan_after_quote();

create or replace function public.sync_klfan_after_fx()
returns trigger language plpgsql security definer set search_path = '' as $$
declare stock_key text;
begin
  for stock_key in select key from public.klfan_stocks where currency = 'USD'
  loop perform public.sync_klfan_financial_item(stock_key); end loop;
  return new;
end;
$$;

drop trigger if exists klfan_fx_sync_financial on public.klfan_fx_daily;
create trigger klfan_fx_sync_financial
after insert or update of rate on public.klfan_fx_daily
for each row execute function public.sync_klfan_after_fx();

revoke all on function public.sync_klfan_financial_item(text) from public, anon, authenticated;
revoke all on function public.sync_klfan_after_transaction() from public, anon, authenticated;
revoke all on function public.sync_klfan_after_quote() from public, anon, authenticated;
revoke all on function public.sync_klfan_after_fx() from public, anon, authenticated;

alter table public.klfan_stocks enable row level security;
alter table public.klfan_transactions enable row level security;
alter table public.klfan_fx_daily enable row level security;
alter table public.klfan_quotes enable row level security;

drop policy if exists klfan_stocks_member_select on public.klfan_stocks;
drop policy if exists klfan_stocks_member_insert on public.klfan_stocks;
drop policy if exists klfan_stocks_member_update on public.klfan_stocks;
drop policy if exists klfan_stocks_member_delete on public.klfan_stocks;
create policy klfan_stocks_member_select on public.klfan_stocks for select to authenticated
  using (exists (select 1 from public.household_members hm
    where hm.household_id = klfan_stocks.household_id and hm.user_id = (select auth.uid())));
create policy klfan_stocks_member_insert on public.klfan_stocks for insert to authenticated
  with check (exists (select 1 from public.household_members hm
    where hm.household_id = klfan_stocks.household_id and hm.user_id = (select auth.uid())));
create policy klfan_stocks_member_update on public.klfan_stocks for update to authenticated
  using (exists (select 1 from public.household_members hm
    where hm.household_id = klfan_stocks.household_id and hm.user_id = (select auth.uid())))
  with check (exists (select 1 from public.household_members hm
    where hm.household_id = klfan_stocks.household_id and hm.user_id = (select auth.uid())));
create policy klfan_stocks_member_delete on public.klfan_stocks for delete to authenticated
  using (exists (select 1 from public.household_members hm
    where hm.household_id = klfan_stocks.household_id and hm.user_id = (select auth.uid())));

drop policy if exists klfan_transactions_member_select on public.klfan_transactions;
drop policy if exists klfan_transactions_member_insert on public.klfan_transactions;
drop policy if exists klfan_transactions_member_update on public.klfan_transactions;
drop policy if exists klfan_transactions_member_delete on public.klfan_transactions;
create policy klfan_transactions_member_select on public.klfan_transactions for select to authenticated
  using (exists (select 1 from public.klfan_stocks s join public.household_members hm on hm.household_id = s.household_id
    where s.key = klfan_transactions.stock_key and hm.user_id = (select auth.uid())));
create policy klfan_transactions_member_insert on public.klfan_transactions for insert to authenticated
  with check (exists (select 1 from public.klfan_stocks s join public.household_members hm on hm.household_id = s.household_id
    where s.key = klfan_transactions.stock_key and hm.user_id = (select auth.uid())));
create policy klfan_transactions_member_update on public.klfan_transactions for update to authenticated
  using (exists (select 1 from public.klfan_stocks s join public.household_members hm on hm.household_id = s.household_id
    where s.key = klfan_transactions.stock_key and hm.user_id = (select auth.uid())))
  with check (exists (select 1 from public.klfan_stocks s join public.household_members hm on hm.household_id = s.household_id
    where s.key = klfan_transactions.stock_key and hm.user_id = (select auth.uid())));
create policy klfan_transactions_member_delete on public.klfan_transactions for delete to authenticated
  using (exists (select 1 from public.klfan_stocks s join public.household_members hm on hm.household_id = s.household_id
    where s.key = klfan_transactions.stock_key and hm.user_id = (select auth.uid())));

drop policy if exists klfan_fx_authenticated_read on public.klfan_fx_daily;
drop policy if exists klfan_quotes_authenticated_read on public.klfan_quotes;
create policy klfan_fx_authenticated_read on public.klfan_fx_daily for select to authenticated using (true);
create policy klfan_quotes_authenticated_read on public.klfan_quotes for select to authenticated using (true);

grant select, insert, update, delete on public.klfan_stocks to authenticated;
grant select, insert, update, delete on public.klfan_transactions to authenticated;
grant usage, select on sequence public.klfan_transactions_id_seq to authenticated;
grant select on public.klfan_fx_daily, public.klfan_quotes to authenticated;
revoke all on public.klfan_stocks, public.klfan_transactions, public.klfan_fx_daily, public.klfan_quotes from anon;

-- The view must obey its base-table RLS instead of inheriting the creator's privileges.
alter view public.klfan_live_symbols set (security_invoker = true);

grant execute on function public.klfan_bootstrap() to authenticated;
revoke execute on function public.refresh_klfan_quotes() from public, anon, authenticated;
