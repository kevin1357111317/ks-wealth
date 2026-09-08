# 給 Claude 的工作方式

屋主的偏好是**簡單講**，用中文，做完講重點就好，不要長篇報告。

## 這個專案

家庭資產 App，正式站 https://ks-bubu-yier.vercel.app 。純前端（`app-v3.js` 一支扛全部）
+ Supabase（Postgres／RLS／Edge Functions）。沒有打包步驟 —— 改完 push 到 `main`，
Vercel 直接部署靜態檔。

**改前端一定要記得動 `index.html` 裡的 `?v=` 快取字串**，不然 PWA 會續用舊檔。

`README.md` 是真正的設計文件：每個怪地方為什麼長這樣、數字跟哪份資料對過，都寫在裡面。
動到某一塊之前先讀那一節，改完把新的理由補回去。

## 版控

正式版號規則寫在 `VERSIONING.md`，**每次正式更新都要升版號**。

- 大更新：`V1 -> V2 -> V3`
- 小更新：`V1 -> V1P1 -> V1P2`
- 大版升級時小版號歸零，例如 `V1P8 -> V2`

`app-version.js` 裡的 `APP_VERSION` 是畫面顯示版號的唯一來源。每次出貨要同步更新：

1. `app-version.js` 的 `APP_VERSION`
2. `VERSIONING.md` 的目前正式版
3. `index.html` 的 `/app-version.js?v=` 快取字串

commit message 建議直接帶版號，方便日後追蹤。

## 出貨流程

在 `claude/asset-tracking-folder-fs4nqp` 上開發，開 PR，squash merge 進 `main`。

`node --test tests/*.test.mjs` 要全過才推。playwright 沒裝的話測試會自己 skip，
先 `npm i --no-save playwright`（Chromium 已經在 `/opt/pw-browsers`，不要再下載）。
平行跑偶爾會因為同時開太多 Chromium 逾時，`--test-concurrency=1` 可以確認是不是假紅。

改到會動錢的邏輯，測試要先確認「拿掉修正就會紅」再算數 —— 這個 repo 裡已經有兩次
測試對著沒修好的程式碼變綠的紀錄。

## 資料

貸款、股票台帳、美金這幾塊的數字都跟 KLFAN 試算表或銀行 App 核對過，`README.md` 裡有
對照結果。動到計算邏輯就重新對一次，別只看測試綠。
