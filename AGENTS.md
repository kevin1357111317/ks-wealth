# KS Wealth 共用協作規則

本檔適用於所有在這個 repository 工作的 AI／開發者；細節以 `CLAUDE.md`、`README.md` 與 `VERSIONING.md` 為準。

- 開始前先同步並閱讀最新 `main`，確認其他協作者是否剛加入新規則或金融邏輯。
- 使用各自的工作分支；不要覆蓋、回退或夾帶其他人的未完成修改。
- 金融數字與個資只放 Supabase，不寫進前端、測試 fixture、commit 或文件。
- 未經使用者提供來源或明確確認，不改金融數字、持有歸屬或計算定義。
- **對帳單是唯一事實來源。** 只要有券商對帳單／交割紀錄涵蓋某段期間，那段就以對帳單為準，私帳可以直接覆寫或改寫 —— 包含日期、金額、股數，以及把私帳合併的成交拆回對帳單的原始筆數。不必為此再逐筆徵詢。
- 覆寫前先做 per-(標的, 日期) 彙總比對，確認兩邊是同一組交易；覆寫後要能說明每一處差異屬於哪一類（日期、金額、拆併、漏記）。沒有對帳單涵蓋的期間維持原狀，標記為待驗，不得用推測去改。
- 對帳方法與覆蓋率狀態見 `CLAUDE.md`「私帳對帳」；實際金額只留在 Supabase。
- 每個 PR 在合併前都要依 `VERSIONING.md` 明確判定 `Version impact: none / patch / minor / major`；以整個 PR 的最高影響為準，不能預設沿用上一版再 +1。
- 版號採 SemVer 判定：breaking change → MAJOR；向後相容新功能 → MINOR；向後相容 bug fix → PATCH；純文件／測試／CI 且不影響正式產品 → none。
- `incremental patch` 是最小修改的開發方法，不代表 SemVer PATCH；小 diff 也可能是 MAJOR，大 refactor 若完全相容也不必升 MAJOR。
- 前端 runtime 異動要更新 `index.html` 的快取版本；產品正式出貨同步更新三處 App 版號。
- 完整測試使用 `node --test --test-concurrency=1 tests/*.test.mjs`；涉及金額的修正要確認移除修正後測試會失敗，並重新核對原始資料。
- 任何 Supabase 操作前先核對 Production migration history；同一時間只由一位協作者部署 migration。提案放 `supabase/proposals/`，不得混進 `supabase/migrations/`。
- 改到 `supabase/functions/` 要另外部署 Edge Function（Vercel 不含它）；部署後比對線上原始碼，並確認畫面上該變的數字真的變了，不能只看 App 版號。
- 合併前檢查 diff、測試與正式部署；部署後驗證使用者實際操作路徑。
