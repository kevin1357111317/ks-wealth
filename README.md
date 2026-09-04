# 布布一二的家

私人家庭財務 PWA。前端部署於 Vercel，正式資料儲存在 Supabase。

## 安全架構
- 每位家庭成員使用自己的 Supabase Auth 帳號。
- 兩人加入同一 household 後共享財務資料。
- 資產、負債、現金流與歷史資料不存放於 GitHub / 前端原始碼。
- 前端只有 Supabase publishable key；真正資料存取由 JWT + Row Level Security 控制。
- 未登入者無權讀取財務資料。

## 正式架構

- `index.html`：正式 App shell、PWA 與 Apple Web App metadata
- `app-v3.js`：主要前端流程（Auth、家庭、資料載入、行情、Realtime、CRUD、趨勢）
- `financial-core.js`：金額正規化、範圍篩選與彙總計算
- `auth-tools.js`：密碼重設等 Auth 輔助流程
- `sheet-gesture.js`：手機 Sheet 關閉手勢
- `v3.css`：主要手機優先 UI
- `v3-trends.css`：趨勢、分類卡片與目前「布布一二的家」主題樣式
- `supabase/functions/`：市場行情與每日快照等後端 Edge Functions
- `supabase/migrations/`：資料庫 schema 歷史；不代表每個 proposed migration 都已套用

`app.js` 與 `style.css` 是舊版保留檔案，目前沒有被正式 `index.html` 引用。

## 資料與計算

- `financial_items.amount_twd` 是家庭、個人、配置與歷史快照的台幣計算基準。
- 台幣手動項目使用 `native_currency=TWD`，且 `native_amount=amount_twd`。
- 美元手動項目以 `native_amount × fx_rate_twd` 計算 `amount_twd`。
- 股票以股數與行情計算；台股為股數 × 台幣市價，美股再乘 USD/TWD。
- 舊資料仍可由 `original_currency` / `original_amount` fallback 讀取，新增與編輯統一寫入 `native_*`。
- `net_worth_history` 保存家庭歷史，`financial_scope_history` 保存老公／老婆範圍歷史；今日顯示值只在前端即時計算。

## 行情額度與共用快取

這個 Supabase 專案同時服務兩個 App：本專案與 KLFAN（`KLFAN-stock-tracker`），兩邊共用同一把
`TWELVE_DATA_API_KEY`。Twelve Data 免費方案是每分鐘 8 credits、一個 symbol 算一個，而兩邊各自
抓一輪剛好是 9 個：本專案 `USD/TWD` + 三檔美股 + `XAU/USD`，KLFAN 三檔美股 + `USD/TWD`。
超額的那一個會被 429 擋掉，而且必然是排在最後的 `XAU/USD` —— 症狀就是首頁出現
「部分行情更新失敗，沿用上一筆價格」，而且只有黃金沒更新。

`refresh-tw-quotes` 因此把 KLFAN 的 `klfan_quotes` 當共用快取：

- **讀**：美股與匯率在 10 分鐘內抓過就直接沿用，只有真的缺的才打 API。台股走 Fugle、沒有額度問題，一律重抓。
- **寫**：這一輪每一檔都真的重抓到、而且涵蓋 `klfan_quotes` 現有的每一個代碼時，才把結果寫回去。
  KLFAN 是用整張表最新的 `updated_at` 決定要不要重抓，只補一半會讓它把沒更新的那幾檔也當成新的。
- 讀寫都走 service role，不必為了快取放寬 `klfan_quotes` 的 RLS。

`XAU/USD` 是例外，它進不了 `klfan_quotes`：KLFAN 沒在追黃金、會把不認得的代碼 prune 掉，而且多一個
它不認得又一直被更新的代碼會弄壞它「整張表最新的 `updated_at`」那個新鮮度判斷。所以金價走自己的
`ks_quote_cache`（同樣 10 分鐘、同樣只有 service role 進得來）。少了這層，金價每一輪都得重抓，而它
又是最後才發出的請求 —— 前端那個 60 秒節流是存在記憶體裡的，換 App 回來或頁面重載就歸零，同一分鐘
跑兩輪就是 10 credits，被擋掉的必然是它。

結果是不論哪一個 App 先開、同一分鐘跑幾輪，都不會再超過額度。回應裡的 `cache` 欄位（`read` /
`write` / `error`）與 `gold.cached` 可以看出這一輪沿用了幾筆、有沒有寫回。前端狀態列也會把失敗的
標的名字與原因寫出來（例如「黃金：行情商額度用完了」），不必再去翻資料庫的 `updated_at` 才知道是
誰沒更新。

`tests/quote-cache.test.mjs` 直接跑 Edge Function 原始碼、把 fetch 換成假的來數 credit，改動這一段
時請先跑它。

## 部署

GitHub `main` 已連接 Vercel Production；合併或 push 到 `main` 會觸發正式部署。功能變更應先在工作分支完成測試與 diff review，再合併至 `main`。

Supabase Production schema 與 Git migration history 可能有已知差異。執行 migration 前必須先核對 Production migration history；禁止自動執行名稱含 `proposed` / `not_yet_applied` 的 migration。
