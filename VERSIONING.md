# KS Wealth 版號規則

目前正式版：**V3.29.9**

> `V3P26` 是舊制最後一個版號。自下一次「產品正式出貨」起改採 Semantic Versioning 2.0.0（SemVer）的 `VMAJOR.MINOR.PATCH` 格式。歷史版號不重寫；遷移判定時視 `V3P26` 為 `V3.26.0` 的 legacy baseline。

## 標準

KS Wealth 的正式版號採業界常見的 Semantic Versioning 2.0.0：

- **MAJOR**：有不相容／破壞性變更（breaking change）時增加。
- **MINOR**：新增向後相容功能時增加。
- **PATCH**：只修正向後相容的錯誤時增加。
- 升 MINOR 時 PATCH 歸零；升 MAJOR 時 MINOR、PATCH 都歸零。

格式範例：`V3.26.1 -> V3.27.0 -> V4.0.0`。

規則來源：Semantic Versioning 2.0.0（https://semver.org/）。Commit 分類參考 Conventional Commits 1.0.0。

## KS Wealth 的「公開契約」

SemVer 原本以 public API 判斷相容性；KS Wealth 是產品型 PWA，因此以下視為使用者與系統依賴的公開契約：

- 已儲存財務／健康資料的**欄位語意、歸屬、scope 與可讀寫方式**。
- 資產、負債、報酬率、XIRR、損益、匯率影響、健康狀態等**核心計算與判定的定義**。
- 既有使用者可依賴的主要操作流程、分析入口與資料存取行為。
- Supabase schema、RLS、RPC／Edge Function 與前端之間已上線的相容契約。
- 已上線客戶端、快取或舊資料能否在不人工修資料的前提下繼續正確運作。

**版號看的是相容性與產品語意，不看 diff 行數。** 10 行也可能是 MAJOR；500 行純重構也可能是 PATCH 或不需要產品版號。

## PATCH：`Vx.y.Z`

只有向後相容的修正時升 PATCH，例如：

- 修 bug，讓行為回到既有定義。
- UI 排版、字級、文案、可讀性、無障礙與互動瑕疵修正。
- 不改定義的資料校正。
- 報價、效能、快取、Realtime、同步可靠性優化，但不改使用者可依賴的資料／流程語意。
- 內部 refactor、測試補強或防呆，且產品行為不變。

例：`V3.26.1 -> V3.26.2`。

## MINOR：`Vx.Y.0`

新增**向後相容**能力時升 MINOR，例如：

- 新增功能頁、分析模組、圖表、篩選器、輸入方式或操作能力。
- 對既有功能做明顯擴充，但舊資料與舊流程仍然有效。
- 新增 optional 欄位、資料表、RPC 或 Edge Function 能力，且舊 client 不會因此壞掉。
- 新增新的計算輸出，但不改既有指標原本的定義。

例：`V3.26.4 -> V3.27.0`。

**新增主要功能不是 MAJOR 的充分條件。** 只要向後相容，照 SemVer 就是 MINOR。

## MAJOR：`VX.0.0`

只要 release 內存在任一 breaking change，就必須升 MAJOR，例如：

- 已存在的資料必須 migration、重新歸戶或重新解讀，否則舊資料會錯。
- 同一份既有資料在新版本被賦予**不同核心財務／健康語意**，且不能只視為 bug fix。
- 改變 ownership、scope、RLS 或資料隔離規則，使舊 client／舊資料不再相容。
- 移除或替換既有主要能力，讓原本可用的操作流程無法繼續使用。
- DB／RPC／Edge Function contract 做不相容調整，舊前端會失敗或產生錯誤結果。
- 需要使用者人工重建資料、清除狀態或完成 migration 才能正確繼續使用。

例：`V3.29.7 -> V4.0.0`。

**大幅重寫程式碼本身不是 MAJOR。** 如果公開契約完全相容，它仍可只是 PATCH／MINOR；反過來，小 diff 只要破壞契約就是 MAJOR。

## 不需要產品版號：`none`

下列變更若沒有改正式站產品行為，可標為 `none`，不修改 `APP_VERSION`：

- 純文件、註解、開發者說明。
- 純測試新增／調整。
- CI、協作規則、PR template、開發工具設定。
- 不影響正式 runtime 的 repo 整理。

只要這類改動同時包含正式產品行為變更，就不能用 `none`。

## 強制判級流程

每次準備合併到 `main` 並正式出貨前，必須先對**整個 release／PR**判級，而不是只看最後一個 commit：

1. 先問：是否有 breaking change？有 → **MAJOR**。
2. 沒有 breaking change，再問：使用者是否得到新的向後相容能力？有 → **MINOR**。
3. 沒有新能力，只是修正既有錯誤／呈現／可靠性？→ **PATCH**。
4. 完全沒有正式產品行為變更？→ **none**。
5. 同一個 release 同時有多種變更時，取**最高等級**：`major > minor > patch > none`。

### 難判時用這三題

- **PATCH vs MINOR**：使用者是否得到以前做不到的新能力？是 → MINOR；否，只是原本功能變正確／更穩 → PATCH。
- **MINOR vs MAJOR**：舊資料、舊 client、舊操作方式能否不經人工處理繼續正確運作？能 → MINOR；不能 → MAJOR。
- **refactor vs 版本**：看外部行為，不看程式改多大。

## 防止無腦一路小版

- 不使用「P 到幾就自動升大版」；SemVer 不以次數決定 MAJOR。
- 但每次正式出貨都必須重新做上面的完整判級，不能預設「沿用上一版再 +1」。
- `incremental patch` 是開發方法，意思是最小範圍修改；**它不等於 SemVer 的 PATCH 版本**。
- 判級要以整個 PR／release 的最終行為為準；多個看似小的 commit 合在一起若形成 breaking change，仍是 MAJOR。

## Commit / PR 規則

新提交建議使用 Conventional Commits：

- `fix(scope): ...` → 通常對應 PATCH。
- `feat(scope): ...` → 通常對應 MINOR。
- `feat(scope)!: ...`、`fix(scope)!: ...` 或 footer `BREAKING CHANGE: ...` → MAJOR。
- `docs:`、`test:`、`chore:`、`ci:`、`refactor:` 預設不自行決定產品版號；仍以實際產品行為判斷。

PR 必須填寫 `Version impact` 與理由；commit 類型只能輔助判斷，**不能覆蓋實際相容性**。

## 從舊制遷移

歷史 `V1`、`V2P4`、`V3P26` 等版號全部保留，不回寫歷史。

`V3P26` 視為遷移基準 `V3.26.0`。下一次產品出貨依內容決定：

- 只有 PATCH：`V3.26.1`
- 有向後相容新功能：`V3.27.0`
- 有 breaking change：`V4.0.0`

一旦出現第一個 `Vx.y.z` 正式版，後續不得再建立新的 `VxPy` 版號。

## 出貨規則

產品正式出貨（Version impact 不是 `none`）時：

1. 先完成 `major / minor / patch` 判級並在 PR 寫明理由。
2. 修改 `app-version.js` 裡的 `APP_VERSION`。
3. 同步更新本文件的「目前正式版」。
4. 修改 `index.html` 中 `/app-version.js?v=` 的快取字串為同一版本。
5. 跑完整測試並確認三處版號一致。
6. squash merge 時建議保留 Conventional Commit 類型，並在 PR／commit body 記錄 `Release-Version: Vx.y.z`。

`app-version.js` 是畫面顯示版號的唯一 runtime 來源；版號以頁尾形式收在內容最後。
