-- 提案：私帳對帳覆蓋率表 klfan_recon_coverage
--
-- 狀態：**已於 2026-09-22 用 Supabase MCP 的 execute_sql 直接在 production 建立**，
--       本檔是該次 DDL 的逐字紀錄，供日後 migration reconciliation 收編用。
--
-- 為什麼不是 migration：
--   `supabase/README.md` 規定 production history 與 supabase/migrations/ 尚未完成
--   reconciliation，禁止 db push、schema 提案只能放這裡。所以這次刻意用 execute_sql
--   而不是 apply_migration —— apply_migration 會在 production 的
--   supabase_migrations.schema_migrations 寫進一筆 repo 沒有對應檔案的版本，讓分歧更深。
--   代價是 production 多了一張沒有 history 紀錄的表；做 reconciliation 的人請把本檔
--   連同當時的版本號一起補進 migrations/，不要重跑（重跑會因 if not exists 而無害，
--   但 policy 會撞名）。
--
-- 為什麼要有這張表：
--   CLAUDE.md「私帳對帳 / 覆蓋率」一節寫明覆蓋率狀態要存在 Supabase，但實際上從來
--   沒有建過，schema 裡也找不到。結果是「哪一段驗過」只能靠對話記憶，而
--   klfan_transactions.note 只記錄「改過什麼」—— 驗過而沒問題的列不會留 note，
--   所以從 note 反推不出覆蓋率。
--
-- 實際資料（各段期間、筆數、依據文件）只寫進 Supabase，不進 repo：
--   AGENTS.md 規定金融數字與個資不進前端、測試 fixture、commit 或文件。

create table if not exists public.klfan_recon_coverage (
  id            bigserial primary key,
  household_id  uuid not null references public.households(id) on delete cascade,
  broker        text not null,
  asset_class   text not null,
  kind          text not null default 'trade'
                check (kind in ('trade','dividend','all')),
  period_start  date not null,
  period_end    date not null,
  status        text not null
                check (status in ('verified','partial','unverified')),
  method        text,
  source_doc    text,
  matched_rows  integer,
  ledger_rows   integer,
  open_items    integer not null default 0,
  verified_on   date,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint klfan_recon_coverage_period check (period_end >= period_start)
);

comment on table public.klfan_recon_coverage is
  '私帳對帳覆蓋率：哪一段（券商×資產類別×期間）用哪份文件驗過、強度如何。規則見 CLAUDE.md「私帳對帳」。覆蓋率分母是配對得上的筆數（matched_rows），不是落在區間內的筆數。';
comment on column public.klfan_recon_coverage.method is
  '驗證方法：per_fill_statement（逐筆對帳單）／bank_net_settlement（銀行每日淨額回推）／broker_app_csv（券商 App 匯出）／none';
comment on column public.klfan_recon_coverage.matched_rows is
  '逐筆雙向配對成功的筆數。status=verified 時應等於 ledger_rows。';
comment on column public.klfan_recon_coverage.open_items is
  '該區段仍未結案的個案數；細節寫在對應 klfan_transactions.note。';

create index if not exists klfan_recon_coverage_lookup
  on public.klfan_recon_coverage (household_id, broker, asset_class, period_start);

alter table public.klfan_recon_coverage enable row level security;

-- RLS 比照 klfan_stocks：以 household_id 對 household_members 判斷。
create policy klfan_recon_coverage_member_select on public.klfan_recon_coverage
  for select using (exists (select 1 from household_members hm
    where hm.household_id = klfan_recon_coverage.household_id and hm.user_id = (select auth.uid())));
create policy klfan_recon_coverage_member_insert on public.klfan_recon_coverage
  for insert with check (exists (select 1 from household_members hm
    where hm.household_id = klfan_recon_coverage.household_id and hm.user_id = (select auth.uid())));
create policy klfan_recon_coverage_member_update on public.klfan_recon_coverage
  for update using (exists (select 1 from household_members hm
    where hm.household_id = klfan_recon_coverage.household_id and hm.user_id = (select auth.uid())))
  with check (exists (select 1 from household_members hm
    where hm.household_id = klfan_recon_coverage.household_id and hm.user_id = (select auth.uid())));
create policy klfan_recon_coverage_member_delete on public.klfan_recon_coverage
  for delete using (exists (select 1 from household_members hm
    where hm.household_id = klfan_recon_coverage.household_id and hm.user_id = (select auth.uid())));

-- 收尾檢查（每次更新覆蓋率後都要跑，確保每一列私帳都被涵蓋剛好一次）：
--   select (select sum(ledger_rows) from klfan_recon_coverage) =
--          (select count(*) from klfan_transactions where stock_key not like '%-wife');
