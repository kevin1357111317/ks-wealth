# Supabase production safety

Production migration history 與這個目錄尚未完成 reconciliation。**禁止直接執行
`supabase db push`**；部分舊檔包含真實財務 DML，重跑可能建立重複貸款或台帳資料。

任何 schema 變更先放在 `proposals/`，並在操作前以 `supabase migration list` 對照
Production `supabase_migrations.schema_migrations`。只有在版本與 statements 全部核對完成後，
才能由單一協作者執行 migration repair／部署。
