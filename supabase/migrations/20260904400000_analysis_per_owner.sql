-- 股票分析與美金分析兩頁都要能分老公／老婆看。klfan_stocks 本來就有 owner_scope，
-- 只是 klfan_bootstrap 沒有把它送到前端；usd_transactions 則是還沒有這一欄。

alter table public.usd_transactions
  add column if not exists owner_scope text not null default 'husband'
    check (owner_scope in ('husband', 'wife'));

create index if not exists usd_transactions_household_owner_idx
  on public.usd_transactions(household_id, owner_scope, trade_date, id);

-- s 陣列多帶一個 owner_scope（第 7 個），其餘欄位與順序都不動。
create or replace function public.klfan_bootstrap()
returns jsonb
language sql
set search_path = public, pg_temp
as $$
with keys as (
  select key, (row_number() over (order by key)) - 1 as i from klfan_stocks
),
base as (
  select t.id, t.stock_key, t.tx_date, t.amount, t.shares,
         coalesce(t.bank,'') as bank, t.kind, coalesce(t.note,'') as note,
         round(case when s.currency = 'USD' then t.amount * coalesce(
           (select f.rate from klfan_fx_daily f where f.fx_date <= t.tx_date order by f.fx_date desc limit 1),
           (select f2.rate from klfan_fx_daily f2 order by f2.fx_date desc limit 1))
         else t.amount end, 4) as tw
  from klfan_transactions t join klfan_stocks s on s.key = t.stock_key
),
banks as (select bank, (row_number() over (order by bank)) - 1 as i from (select distinct bank from base) x),
notes as (select note, (row_number() over (order by note)) - 1 as i from (select distinct note from base) y),
kinds as (select kind, (row_number() over (order by kind)) - 1 as i from (select distinct kind from base) z)
select jsonb_build_object(
  's', (select coalesce(jsonb_agg(jsonb_build_array(key, display, market, currency, symbol, manual_price, owner_scope) order by key), '[]'::jsonb) from klfan_stocks),
  'q', (select coalesce(jsonb_agg(jsonb_build_array(symbol, price, currency, source, quoted_at,
          extract(epoch from updated_at) * 1000) order by symbol), '[]'::jsonb) from klfan_quotes),
  't', (select coalesce(jsonb_agg(jsonb_build_array(
          b.id, k.i, b.tx_date::text, round(b.amount, 4), trim_scale(round(b.shares, 6)),
          bk.i, kd.i, nt.i, trim_scale(b.tw)) order by b.id), '[]'::jsonb)
        from base b
        join keys  k  on k.key   = b.stock_key
        join banks bk on bk.bank = b.bank
        join notes nt on nt.note = b.note
        join kinds kd on kd.kind = b.kind),
  'd', jsonb_build_object(
        'banks', (select coalesce(jsonb_agg(bank order by i), '[]'::jsonb) from banks),
        'notes', (select coalesce(jsonb_agg(note order by i), '[]'::jsonb) from notes),
        'kinds', (select coalesce(jsonb_agg(kind order by i), '[]'::jsonb) from kinds)),
  'n', (select count(*) from base)
);
$$;
