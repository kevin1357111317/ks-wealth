# Supabase production safety

Production migration history 與這個目錄尚未完成 reconciliation。**禁止直接執行
`supabase db push`**；部分舊檔包含真實財務 DML，重跑可能建立重複貸款或台帳資料。

2026-09-16 已只讀確認 production history 沒有 `20260908180000`、`20260908230000` 或
`20260908231000`；原本撞號的潤隆增貸台帳檔已依實際提交順序改為 `20260908231000`。
這只整理 repository 歷史，沒有對 production 執行 migration 或 repair。

任何 schema 變更先放在 `proposals/`，並在操作前以 `supabase migration list` 對照
Production `supabase_migrations.schema_migrations`。只有在版本與 statements 全部核對完成後，
才能由單一協作者執行 migration repair／部署。
