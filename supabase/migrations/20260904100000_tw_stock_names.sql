-- 台股代號 ↔ 證交所／櫃買中心正式中文名。
--
-- 表單的股票欄位收代號也收中文名（打 2330 或「台積電」都可以），存進去的一律是
-- 官方名稱 —— 只看代號記不住哪支是哪支。美股沒有這個問題，維持英文代號。
--
-- 抓取交給資料庫自己做（http 擴充），前端與 Edge Function 都不必碰這件事。
-- 上市清單不含上櫃，所以兩邊都要抓，board 決定代號該配 TPE: 還是 TWO: 前綴。
create table if not exists public.tw_stock_names (
  code       text primary key,
  name       text not null,
  board      text not null default 'TPE' check (board in ('TPE', 'TWO')),
  updated_at timestamptz not null default now()
);
create index if not exists tw_stock_names_name_idx on public.tw_stock_names(name);

alter table public.tw_stock_names enable row level security;

-- 公開的市場資料，沒有任何家庭資訊，登入後可讀即可；寫入只走下面的 security definer 函式。
drop policy if exists tw_stock_names_read on public.tw_stock_names;
create policy tw_stock_names_read on public.tw_stock_names for select to authenticated using (true);
grant select on public.tw_stock_names to authenticated;
revoke all on public.tw_stock_names from anon;

create or replace function public.refresh_tw_stock_names()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  listed jsonb;
  otc    jsonb;
  written integer;
begin
  select content::jsonb into listed
  from extensions.http_get('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');

  insert into public.tw_stock_names (code, name, board, updated_at)
  select r->>'Code', r->>'Name', 'TPE', now()
  from jsonb_array_elements(listed) r
  where coalesce(r->>'Code', '') <> '' and coalesce(r->>'Name', '') <> ''
  on conflict (code) do update
    set name = excluded.name, board = excluded.board, updated_at = excluded.updated_at;
  get diagnostics written = row_count;

  select content::jsonb into otc
  from extensions.http_get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');

  insert into public.tw_stock_names (code, name, board, updated_at)
  select r->>'SecuritiesCompanyCode', r->>'CompanyName', 'TWO', now()
  from jsonb_array_elements(otc) r
  where coalesce(r->>'SecuritiesCompanyCode', '') <> '' and coalesce(r->>'CompanyName', '') <> ''
  on conflict (code) do update
    set name = excluded.name, board = excluded.board, updated_at = excluded.updated_at;

  return written + (select count(*) from jsonb_array_elements(otc));
end;
$$;

-- 任何登入者都能觸發的話，等於開放對外抓取；只留給用管理連線手動執行。
revoke all on function public.refresh_tw_stock_names() from public, anon, authenticated;
