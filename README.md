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
- 同一檔再買一次會**併回原本的標的**（用裸代號比對，前綴不算數）—— 出清過的舊紀錄才不會
  跟新買的分成兩筆各自為政
- 交易所前綴一律用「英數:」通則剝除，不要列舉 —— 列舉漏掉 `BATS:` 過一次，帶冒號的代號
  會過不了 `refresh-tw-quotes` 的 `validSymbol`，那一檔就靜靜地不再被報價
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

台帳連動的股票出清後，`financial_items` 那一列是被更新成 0 股 0 元、**不是刪掉** —— 唯一索引建在
`portfolio_stock_key` 上，再買回來要能接回同一列。所以 `getItemsForScope()` 在顯示層把 0 股的
台帳部位濾掉；原始的 `items` 陣列不動，`syncPortfolioFinancialItem()` 還要靠它找到那一列。
手動建立的 0 元項目不受影響。

## 分析頁分老公／老婆

股票分析與美金分析在兩個人的頁面上都有，各自只看自己名下的部位：

- 股票照 `klfan_stocks.owner_scope` 切。這一欄本來就有，只是 `klfan_bootstrap()` 沒有把它送到
  前端 —— `s` 陣列現在多帶第 7 個元素 `owner_scope`
- 美金照 `usd_transactions.owner_scope` 切，在美金分析頁記的那筆就記在當下看的那個人名下
- 合起來的 `portfolioModel` 還是要留著：編輯表單與 `syncPortfolioFinancialItem()` 是照 key
  找標的，跟歸屬無關，用切過的那份會找不到

## 美金分析

美金部位自己一本帳（`usd_transactions`），跟 `financial_items` **沒有連動** —— 買賣只在美金分析頁裡進出，
資產頁上的任何一列都不會因此改變。這是刻意的：美金是換匯不是持股，混進資產列表只會兩邊互相蓋。

成本用**移動加權平均**（`usd-core.js`），跟股票那邊的 FIFO 不一樣，這是為了對齊 KLFAN 試算表
「美金」工作表原本的算法：

- 買進把台幣成本加進去、重算平均成本
- 賣出用當下的平均成本認列已實現匯兌損益，平均成本本身不動
- 未實現＝目前市值－剩餘成本；出清後餘額與成本一起歸零
- 剩餘成本－已實現＝累計淨投入，這兩邊要對得起來（`tests/usd-core.test.mjs` 有守）

`tests/fixtures/usd-ledger.json` 是試算表那 107 筆真實交易，測試拿它比對試算表自己算出來的
每一個數字（部位、平均成本、市值、淨投入、已實現、未實現、XIRR）。改算法時這支測試會先叫。

一筆交易存三個數字：`usd_amount`（正買負賣）、`rate`、`twd_amount`（正負號跟 usd 相反）。
匯率不是推導出來的而是存下來的 —— 有些單是「買 100,000 台幣」、有些是「買 2,000 美元」，
兩邊都會有零頭，只存兩個數字對不回試算表。

## 貸款分析

個人頁的分析入口有「股票分析／美金分析／貸款分析」三個按鈕。貸款分析統整信貸、房屋增貸，
並可在之後納入房貸。`loan_accounts` 保存 KLFAN 工作表的原貸款、期程、預估總還款與結清狀態；
進行中貸款以 `financial_item_id` 連回
`financial_items` 的既有負債列，畫面上的目前本金、利率與月付以負債列為準。
分析頁以「信貸／增貸／房貸」三段切換，預設顯示信貸；摘要數字、進行中清單與已結清紀錄
都只計算目前選取的貸款類型。

這個連結是防止重複計算的邊界：`loan_accounts` 只供分析，不能再加進資產負債總額。
KLFAN 中已結清的舊信貸保留在分析頁，但餘額固定為零。夫妻間的責任移轉仍保存在
`loan_events` 作歷史資料，不再顯示於貸款分析頁，也不會混入銀行貸款現金流。

`loan_schedule` 是完整的貸款現金流，以 `entry_type` 區分撥款、費用、還款與調整，並同時保存
應繳日 `due_date` 和已知的實際扣款日 `actual_date`。貸款卡片點一下會列出資金流入、所有費用、
過往繳款與未來排程，並用每筆實際現金流做 XIRR，顯示含開辦費的「實際年化成本」。費用不會
再被誤算成還款期數；「每月還款」那格的
平均每天是 `月付 × 12 ÷ 365`。排程是懶載入的（`ensureLoanSchedule()`），沒點開分析頁就不抓。

`240820_KL_LB` 已依 2026-09-07 LINE Bank App 畫面核對：本金 350 萬、實收 3,499,112、
開辦費 888、首期 20,523、其後月付 39,763；截至 2026-09-05 已繳 25 次、剩 72 次，
本金餘額 2,663,371。已知的每期繳後本金存於 `balance_after_twd`，僅供核對，不會重複計入 XIRR。

`260323_KL_將來` 已依 2026-09-08 將來銀行 App 畫面核對：本金 7,010,000、120 期、
機動利率 2.38%、月付 65,706；截至 2026-08-23 已還本金 259,629，本金餘額 6,750,371，
下次繳款日 2026-09-23，到期日 2036-03-23。KLFAN 記錄的開辦費 2,643 仍納入 XIRR。

匯入排程時順手修了兩個對不起來的數字：連線銀行信貸的預估總還款漏掉最後一期 19,278
（3,798,896 → 3,818,174）。元大的結算日期在試算表裡
是舊的 2033，但排程列走到 2036 —— 10,606 × 120 + 2,888 = 1,275,608 剛好對上，所以 `maturity_date`
改成 2036-08-07。

新增股票只有一個入口：「新增財務項目」表單。台帳頁不放第二個新增入口，也沒有返回按鈕。

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

## 狀態列那一條的顏色

iOS 的 `apple-mobile-web-app-status-bar-style: default` 不會讓網頁蓋到狀態列底下 ——
網頁從安全區下面才開始，狀態列那一條是拿 **`html` 的背景色**去填的。所以只要 `html` 的
背景跟畫面最上緣畫出來的顏色不一樣，那條就會跟畫面接出一條硬邊。

三個畫面最上緣的顏色不一樣，`html` 要跟著走：

- App 畫面：`body::before` 的漸層起頭 `#d9f5f1` → `html{background:#d9f5f1}`
- 載入／登入畫面：`.center,.auth` 的漸層起頭 `#9fe4df` → `html:has(#root.center),html:has(#root.auth)`

改任何一邊的漸層起頭，`html` 那邊要一起改。`tests/status-bar-strip.test.mjs` 會把
`html` 的 computed 背景色跟畫面最上緣的實際像素對起來比，對不上就失敗。

## 趨勢圖的手勢

刮動趨勢圖的監聽器**不掛在 `#root` 上**。WebKit 會把「有 non-passive `pointermove` 監聽器」
的範圍整塊標成主執行緒捲動區 —— 捲動前每一個 move 都得先回 JS 問過才交給合成器。掛在 `#root`
等於整個 App 都是。

現在的做法：

- 平常只有圖表自己一個 **passive** 的 `pointerdown`（`bindTrendChart()`，每次 render 重掛）
- `pointermove` / `pointerup` / `pointercancel` 只在真的在拖曳的那幾百毫秒掛在 `window` 上，
  放開、或判斷成直向手勢，就整組收掉
- `pointermove` 裡**不呼叫 `preventDefault()`**：`.trendChart` 的 `touch-action: pan-y`
  已經擋掉橫向平移，擋了反而讓監聽器變成 non-passive
- **完全不抓 `setPointerCapture()`**。抓了瀏覽器就沒辦法把判斷錯的手勢收回去捲頁，整頁會被釘住
- 刮動被半路收走則是另一件事，用 **`touchmove`** 解決：`touch-action: pan-y` 把直向永遠讓給
  瀏覽器，橫著刮時手指只要有一點上下位移，瀏覽器就會接手捲頁並丟一個 `pointercancel` 過來 ——
  提示框當場停住。`touchmove` 不受這件事影響，會一路發到手指離開，所以觸控時多掛一組
  `touchmove`／`touchend`／`touchcancel`，並且**忽略 `pointercancel`**（觸控的 pointercancel
  幾乎都是瀏覽器接手捲頁發的，不代表手指離開了），由 `touchend` 決定什麼時候結束。
  座標來源有兩種，判斷與更新的邏輯只有 `trackTrendDrag()` 那一份
- 方向要**明顯**才算數：至少移動 10px，而且橫向要贏過直向 1.5 倍才當成刮動；直向先跨過
  10px 就直接放手。手指按下去的第一個取樣幾乎都是斜的，拿單一取樣比 `|dx| > |dy|` 的話，
  明明是往上滑也會被判成刮動 —— 而且中不中招看那一下的抖動，所以症狀是「有時候會有時候不會」

`tests/trend-chart.test.mjs` 會直接用 CDP 讀 `window` / `#root` / 圖表上的監聽器來守這件事，
順便確認刮動本身、以及從圖表上往上滑還捲得動頁面。

## 匯率一輪只有一個

`financial_items.fx_rate_twd` 有**兩個寫入者**：

1. `refresh-tw-quotes` Edge Function —— 一輪只用一個 `fxRate`（快取夠新就沿用 `klfan_quotes`
   的 `USD/TWD`，否則打 Twelve Data），美股、美元現金、黃金三條路徑都吃它
2. `sync_klfan_financial_item()` 觸發器 —— 讀的是 **`klfan_fx_daily` 最新那一列**

兩邊各自取數，同一輪就會在資料庫裡留下兩個不同的匯率。2026-09-07 08:45 美股是 31.61732、
黃金與美元現金是 31.62785，差 0.03%；而 App 是拿 `sort_order` 最前面那一列的匯率，
剛好落在黃金那一組。

修法是**讓觸發器的來源跟著這一輪走**：Edge Function 在更新任何一列之前，先把這一輪要用的
匯率 upsert 進 `klfan_fx_daily`（台北日期當 key）。之後兩邊讀到的是同一個數字。

`klfan_fx_daily` 是跟 KLFAN 共用的表，KLFAN 自己也會寫；兩邊寫的都是 Twelve Data 的
USD/TWD，最後寫的那個就是當下的匯率，這正是我們要的「兩個 App 對得起來」。

`tests/quote-cache.test.mjs` 守兩件事：一輪裡所有 USD 項目的 `fx_rate_twd` 只能有一個值，
而且 `klfan_fx_daily` 要拿到同一個值；匯率抓不到時則完全不動那張表（寫 null 會弄壞觸發器的來源）。

## 手動項目的幣別

**保險**與**其他**這兩類沒有行情可抓、金額是手打的，但可能是美金計價，所以表單上有一個
幣別選單（`CURRENCY_CHOICE_ATTRIBUTES`）。選 USD 就走跟現金一樣的 `manual-usd`：存
`native_currency` / `native_amount` 與當下的 `fx_rate_twd`，之後 `refresh-tw-quotes` 會
跟著匯率把 `amount_twd` 重算。

現金及存款不在這個名單裡 —— 它是靠「台幣」「美金」兩個資產屬性分的，多一個選單只會打架。

要新增別的類別到這個名單，只要把 value 加進 `CURRENCY_CHOICE_ATTRIBUTES`；儲存那段是照
`mode` 分支的，不必動。

## 螢幕恆亮與自動更新

App 開著的時候會用 Screen Wake Lock 讓螢幕不要自己關掉，行情分成**兩條快慢不同的路徑**，
因為兩邊的成本差很多：

| | 間隔 | 來源 | 成本 | 寫資料庫 |
|---|---|---|---|---|
| 台股 | 5 秒 | Fugle | 免費、沒有 credit | **不寫** |
| 美股／匯率／黃金 | 60 秒 | Twelve Data | 一輪 7 credits，上限每分鐘 8 | 寫 |

台股那一條走 Edge Function 的 `scope='tw'`：只打 Fugle、只把價格回傳，**完全不碰資料庫**。
碰了的話 `financial_items` 的 realtime 訂閱會被自己觸發，每 5 秒重載整本台帳（一千多筆交易）
—— 那不是報價快，是把 App 拖垮。前端拿到價之後直接改 `items[].amount_twd` 再 render，
資料庫的權威值由 60 秒那一輪負責寫。

60 秒是美股那條的**上限**，不是保守值：一輪 7 credits、每分鐘只有 8，跑兩次就爆。
`refreshQuotes()` 的節流門檻因此設成間隔的一半，不然計時器早幾毫秒觸發會被自己擋掉。

Fugle 的每分鐘上限沒有查到明文；4 檔 × 每 5 秒 = 48 次／分，貼著一般免費方案的邊。
真的被 429 就把 `QUOTE_TW_INTERVAL_MS` 調大，狀態列會直接把失敗的標的與原因寫出來。

兩條都綁在「畫面看得到」這個條件上：

- Wake Lock 本來就會在切到背景時被系統收回，所以 `visibilitychange` 回到前景要**重新要一次**
  （並且掛 `release` 事件把 `wakeLock` 清成 null，不然下次會以為還握著）
- 背景分頁的計時器會被瀏覽器降頻，更新了也沒人看，只是耗電跟吃額度
- 螢幕關著那段時間計時器是停的，所以回前景時如果距離上次完整更新已經超過 60 秒，先補一次
- 台股那一輪不動狀態列 —— 每 5 秒閃一次「更新中」比不更新還糟

`navigator.wakeLock` 拿不到（低電量模式、使用者不給、瀏覽器沒支援）就安靜跳過，照系統原本的
螢幕逾時走。

`tests/awake-autorefresh.test.mjs` 用 Playwright 的假時鐘把時間快轉掉，守住兩條路徑各自的
節奏；`tests/quote-cache.test.mjs` 守住 `scope='tw'` 那一輪一個 credit 都不花、也不寫資料庫。

## 更新報價不重載台帳

`klfan_bootstrap()` 回傳 **92 KB，其中 89 KB 是那 1489 筆交易**。報價更新只改價格、交易
一筆都沒動，所以那一輪**不整包重載**：

- 資產列的金額：Edge Function 已經算好在 `results[].amountTwd`，直接套進 `items`
- 股票分析的股價：另外去 `klfan_quotes` 撈一次（約 3 KB），重掛到 `portfolioStocks[].quote`
  再重算 `portfolioModel`

`realtime` 的 `financial_items` 事件也不能整包重載 —— 每一輪報價更新都會寫它，事件會送回來
給我們自己，照單全收就等於每分鐘重載一次。那一條改成 `reloadItems()`，只重抓 `financial_items`。
交易真的變了會由 `klfan_transactions` 的事件帶進來，**那一條才走完整重載**。

（試過用時間窗把「自己的寫入」濾掉，但別的裝置剛好在窗口內改東西就會漏，所以改成分流。）

`tests/awake-autorefresh.test.mjs` 會數 `klfan_bootstrap` 被叫了幾次：三輪完整報價更新之後
必須還是 0 次。

### 台帳是延遲載入的

開 App **完全不載台帳**。資產列的股數與市值是 `sync_klfan_financial_item()` 觸發器算好存在
`financial_items` 的，那 92 KB 只有兩個地方要用：

- 股票分析頁 → `openAnalysis('stocks')` 時 `ensureLedger()`，載好再 render 一次
- 編輯表單的交易紀錄 → `editItem()` 在 `item.portfolio_stock_key` 有值時才等

**`saveLedgerStock()` 一定要先 `await ensureLedger()`**：它要靠 `portfolioStocks` 比對有沒有
同一檔，沒載好就會把已經有的標的再開一筆。這是這個改動唯一真的會壞資料的地方。

`ensureLedger()` 是單飛行的，載過就不再載；`loadData()` 只有在**已經載過**的情況下才重載它。

`tests/awake-autorefresh.test.mjs` 守住「開 App 跟切到個人頁都不該叫 `klfan_bootstrap`，
但入口按鈕還是要在」。

## 行情額度與 klfan_quotes

Twelve Data 免費方案是每分鐘 8 credits、一個 symbol 算一個。這一輪要 `USD/TWD` + 美股
+ `XAU/USD`，全抓就快貼著上限，所以 `refresh-tw-quotes` 把 `klfan_quotes` 當快取：

- **讀**：美股與匯率在 10 分鐘內抓過就直接沿用，只有真的缺的才打 API。台股走 Fugle、
  沒有額度問題，一律重抓
- **寫**：仍持有的標的這一輪全部都真的重抓到，才整批寫回。只補一半的話，最新的
  `updated_at` 會讓沒更新的那幾檔看起來也很新
- **修剪**：寫回之後把不在「仍持有」名單裡的列刪掉
- 讀寫都走 service role，不必為了這張表放寬 RLS

### 為什麼追蹤名單要看 `klfan_live_symbols`

`klfan_quotes` 原本由 KLFAN（`KLFAN-stock-tracker`）那支 `refresh-klfan-quotes` 維護，
本專案以前每次更新會**連它一起呼叫**。但兩支抓的是完全一樣的 8 檔，等於自己跟自己搶額度
（2026-09-07 核對過，兩邊的標的一模一樣），所以那個呼叫已經拿掉，整張表由這裡接手。

接手的關鍵是名單要跟著 `klfan_live_symbols`（仍持有的標的）走，**不能**看「`klfan_quotes`
現在有哪些列」：

- 剛買進的股票表裡還沒有它 → 永遠不會被寫進去
- 已出清的舊列還在 → 涵蓋率永遠不滿 → **整個寫回停擺，所有報價一起凍住**

修剪也是同樣的原因：舊價留著會被當成即時價顯示，一個看起來很新、其實早就過期的價格比沒有
價格更糟。

`XAU/USD` 不在仍持有名單裡（會被修剪掉），所以金價走自己的 `ks_quote_cache`，同樣 10 分鐘、
同樣只有 service role 進得來。少了這層，金價每一輪都得重抓，而它又是最後才發出的請求 ——
前端那個 60 秒節流是存在記憶體裡的，換 App 回來或頁面重載就歸零，同一分鐘跑兩輪必定壓死它。

回應裡的 `cache`（`read` / `write` / `error`）與 `gold.cached` 可以看出這一輪沿用了幾筆、
有沒有寫回、修剪成不成功。前端狀態列也會把失敗的標的名字與原因寫出來（例如「黃金：行情商
額度用完了」）。

`tests/quote-cache.test.mjs` 直接跑 Edge Function 原始碼、把 fetch 換成假的來數 credit，
改動這一段時請先跑它。

## 部署

GitHub `main` 已連接 Vercel Production；合併或 push 到 `main` 會觸發正式部署。功能變更應先在工作分支完成測試與 diff review，再合併至 `main`。

Supabase Production schema 與 Git migration history 可能有已知差異。執行 migration 前必須先核對 Production migration history；禁止自動執行名稱含 `proposed` / `not_yet_applied` 的 migration。
