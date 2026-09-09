# 2026-08-29 security hardening proposal（歷史封存，禁止直接執行）

這是舊安全檢查留下的提案，不是 Production migration，也不代表目前資料庫狀態。它原本誤放在 `supabase/migrations/`，已移出以避免 CLI 或其他協作者誤套用。

提案當時包含：歷史表唯讀、移除兩個舊欄位、刪除舊函式。欄位移除目前已確定不可直接執行，因為正式前端仍用它們作舊資料 fallback。其餘項目若未來要做，必須重新查 Production schema、依當時程式碼另建 migration 並通過完整測試。
