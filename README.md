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

## 台股／美股走交易台帳

台股與美股的股數與市值**不是手動輸入的**，是從 `klfan_transactions` 推算出來的：交易一有異動，
`sync_klfan_financial_item()` 觸發器就會重算股數與市值，upsert 回 `financial_items`
（靠 `financial_items.portfolio_stock_key` 連結）。所以那一列完全是衍生資料。

因此「新增／編輯財務項目」表單在資產屬性選到台股或美股時：

- 收起「持有股數」與「名稱」，改成三組兩欄的交易輸入：代號＋類型／金額＋股數／日期＋銀行
- 股票沒有名稱欄，名字由代號決定：台股查 `tw_stock_names` 用證交所／櫃買中心的正式中文名，
  美股用英文代號
- 台股那一欄收代號也收中文名（`2330` 或「台積電」都可以），打完會顯示查到的對照；
  查不到就照輸入的存
- 新標的的第一筆交易是必填的（表單上沒有寫出來，靠儲存時的錯誤訊息提示）—— 觸發器只在股數不為零時才建 `financial_items` 那一列，
  沒有交易的標的只會出現在「股票投資」、不會出現在資產裡
- 編輯既有標的時交易區可以整區留白，代表這次只改名稱或代號
- 只列最近 10 筆交易讓人補漏或刪掉打錯的；完整歷史在「股票投資」清單裡把那一檔展開（展開的卡片只看歷史，不重複放一份新增交易表單）
- 只有**全新**的標的存檔後會強制重抓報價 —— 既有標的記一筆交易不會讓行情變動，強制重抓只是
  白白吃掉 Twelve Data 每分鐘 8 credits 的額度，連續存個幾筆就會超過
- 交易沒有備註欄，`klfan_transactions.note` 一律填「股票」／「股息」；表單下方那個「備註（選填）」是
  項目自己的 `financial_items.notes`，兩個放在一起只會搞混
- 儲存時只寫 `klfan_stocks` / `klfan_transactions`，**不自己插 `financial_items`** ——
  自己插一列會跟觸發器建的那列重複，資產被算兩次
- 刪除要從 `klfan_stocks` 刪（交易 cascade 跟著走）。只刪 `financial_items` 沒有用，
  下一筆交易或報價更新會讓觸發器把它重建回來

報價代號在台帳裡一律帶交易所前綴（`TPE:2330`、`NASDAQ:QQQ`），`sync_klfan_financial_item()`
就是靠這個前綴把裸代號切出來寫進 `financial_items.symbol`。表單允許只打 `2330`，會自動補上
並顯示補完的結果。

「股票投資」是狀態切換不是換頁，返回手勢預設不會有反應，所以進去時 `window.history.pushState()`
推一筆、`popstate` 再把畫面收回來（`app-v3.js` 有個模組層的 `history` 變數存淨資產歷史，會遮蔽
`window.history`，一定要寫全）。底部導覽切分頁也走同一條路 —— `render()` 在台帳頁會直接回傳
台帳畫面，不先收掉會被困住。頁面上沒有返回按鈕。

「股票投資」清單的卡片是**就地展開**的，不跳頁：展開後在原位往下長出已實現與未實現損益、
累計股息、目前股價、投資期間、持有股數，以及完整交易紀錄。收合的卡片只顯示市值、累計損益與
年化報酬率 —— 每個數字只出現在其中一邊，不重複。
一次只開一檔，再點一次收起來。

`render()` 是整個重建 DOM，捲動位置會掉回頂部，所以展開／收合（以及資產列表的分類展開）
走 `renderKeepingAnchor()`：記下被點元素的**文件座標**，重繪後先還原捲動位置再量一次、補上差值。
重點是重繪完當下瀏覽器的捲動狀態是未定的，所以不能用相對的 `scrollBy`，也不能在還原之前量。

已實現與未實現用**先進先出**配對賣出（`splitRealized()`）—— 賣掉的那幾股要用當初買它們的成本
算損益，不是整體平均；同一檔在不同價位分批買進時兩者差很多。股息沒有對應成本，整筆算已實現。
不變式是「已實現 ＋ 未實現 ＝ 累計損益」，`tests/portfolio-core.test.mjs` 有守，而且有一組
FIFO 與加權平均會給出不同答案的案例，改回平均成本就會被擋下來。

`tests/portfolio-ledger.test.mjs` 在真的瀏覽器裡跑這條路徑，supabase client 換成記憶體版
（`tests/support/fake-supabase.js`，含觸發器與 FK cascade 的行為）。它需要 playwright，沒裝會
自動跳過；裝在專案外面的話用 `PLAYWRIGHT_PATH` 指到進入點。

### 台股名稱對照

`tw_stock_names`（`code` / `name` / `board`）由 `refresh_tw_stock_names()` 從證交所 OpenAPI 與
櫃買中心 OpenAPI 各抓一次填入 —— 上市清單不含上櫃，兩邊都要。`board` 決定代號要配 `TPE:`
還是 `TWO:` 前綴。抓取走資料庫的 `http` 擴充，前端與 Edge Function 都不碰。

這是公開市場資料，登入後可讀；寫入的函式對 `public` / `anon` / `authenticated` 都撤銷執行權限
（否則任何登入者都能觸發對外抓取），要更新清單時用管理連線手動 `select refresh_tw_stock_names();`。

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
