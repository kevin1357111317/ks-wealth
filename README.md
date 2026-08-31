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

## 部署

GitHub `main` 已連接 Vercel Production；合併或 push 到 `main` 會觸發正式部署。功能變更應先在工作分支完成測試與 diff review，再合併至 `main`。

Supabase Production schema 與 Git migration history 可能有已知差異。執行 migration 前必須先核對 Production migration history；禁止自動執行名稱含 `proposed` / `not_yet_applied` 的 migration。
