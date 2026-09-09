# KS Wealth 共用協作規則

本檔適用於所有在這個 repository 工作的 AI／開發者；細節以 `CLAUDE.md`、`README.md` 與 `VERSIONING.md` 為準。

- 開始前先同步並閱讀最新 `main`，確認其他協作者是否剛加入新規則或金融邏輯。
- 使用各自的工作分支；不要覆蓋、回退或夾帶其他人的未完成修改。
- 金融數字與個資只放 Supabase，不寫進前端、測試 fixture、commit 或文件。
- 未經使用者提供來源或明確確認，不改金融數字、持有歸屬或計算定義。
- 前端檔案異動要更新 `index.html` 的快取版本；正式出貨同步更新三處 App 版號。
- 完整測試使用 `node --test --test-concurrency=1 tests/*.test.mjs`；涉及金額的修正要確認移除修正後測試會失敗，並重新核對原始資料。
- 任何 Supabase 操作前先核對 Production migration history；同一時間只由一位協作者部署 migration。提案放 `supabase/proposals/`，不得混進 `supabase/migrations/`。
- 合併前檢查 diff、測試與正式部署；部署後驗證使用者實際操作路徑。
