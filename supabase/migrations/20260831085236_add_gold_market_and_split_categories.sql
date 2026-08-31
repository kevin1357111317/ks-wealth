alter table public.financial_items
  drop constraint if exists financial_items_market_check;

alter table public.financial_items
  add constraint financial_items_market_check
  check (market is null or market = any (array['TW','US','FX','MANUAL','GOLD']));

-- These two production rows are unambiguous by exact name. Amounts and market
-- remain unchanged; gold stays manual until the user supplies its true grams.
update public.financial_items
set category = '黃金'
where category = '黃金與收藏' and name = '黃金';

update public.financial_items
set category = '收藏'
where category = '黃金與收藏' and name = '寶可夢卡牌';
