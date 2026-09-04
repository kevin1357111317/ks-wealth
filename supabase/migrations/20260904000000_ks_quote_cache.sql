-- XAU/USD 的報價快取。
--
-- refresh-tw-quotes 打的 Twelve Data 請求裡，美股與 USD/TWD 可以沿用 KLFAN 的
-- klfan_quotes，只有 XAU/USD 不行 —— KLFAN 沒在追黃金，而且它會 prune 掉不在
-- klfan_live_symbols 裡的代碼，寫進去只會被刪掉。更麻煩的是 KLFAN 用整張表最新的
-- updated_at 判斷要不要重抓，多寫一個它不認得、又一直被更新的代碼會讓它把自己的
-- 舊價當成新的。
--
-- 結果就是 XAU/USD 每一輪都得重抓，而它又是最後才發出的請求：同一分鐘跑兩輪
-- （換 App 回來、頁面重載、手動按更新都會觸發，前端那個 60 秒節流是存在記憶體裡的，
-- 重新載入就歸零）就是 10 credits，超過免費方案的 8，被 429 擋掉的必然是它。
-- 症狀是首頁「部分行情更新失敗」而且永遠只有黃金沒更新。
--
-- 所以給它一張自己的小快取表，不去動 klfan_quotes 的語意。
create table if not exists public.ks_quote_cache (
  symbol     text primary key,
  price      numeric not null,
  updated_at timestamptz not null default now()
);

-- 與 klfan_quotes 一致：開 RLS 但不給 policy，只有 Edge Function 的 service_role 進得來。
-- 這張表沒有任何前端會直接讀。
alter table public.ks_quote_cache enable row level security;
