-- 房子帳（2026-11-04，屋主要求把「房子統計」Google 試算表搬進 App，不再維護 Excel）
--
-- 這一條已經在 production 用 SQL 直接執行，沒有走 supabase db push，也沒有寫入
-- supabase_migrations.schema_migrations —— production migration history 還沒 reconcile
-- （見 supabase/README.md）。之後做 reconciliation 時要一起補。
--
-- 只有 schema。試算表的金額與坪數直接寫進 production，不進 repo（AGENTS.md：金融數字只放 Supabase）。
--
-- properties：一列一間房子。試算表「詳細」工作表的總價、車位價、五種面積。
--   總面積、建物面積（扣車位）、每坪單價都是導出值，前端自己算，不存。
-- property_expenses：試算表「竹科潤隆」「森林之星」的每一列款項。
--   amount_twd 照試算表的正負號：負數是付出去的錢，正數是退款或收入（機車位出租）。
create table if not exists public.properties (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  key text not null,
  name text not null,
  label text,
  acquired_on date,
  total_price_wan numeric check (total_price_wan is null or total_price_wan >= 0),
  parking_price_wan numeric not null default 0 check (parking_price_wan >= 0),
  original_price_twd numeric check (original_price_twd is null or original_price_twd >= 0),
  indoor_ping numeric not null default 0 check (indoor_ping >= 0),
  awning_ping numeric not null default 0 check (awning_ping >= 0),
  balcony_ping numeric not null default 0 check (balcony_ping >= 0),
  common_ping numeric not null default 0 check (common_ping >= 0),
  parking_ping numeric not null default 0 check (parking_ping >= 0),
  has_ledger boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (household_id, key)
);

create table if not exists public.property_expenses (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  property_id bigint not null references public.properties(id) on delete cascade,
  category text not null check (length(btrim(category)) > 0),
  expense_date date not null,
  amount_twd numeric not null,
  item text not null check (length(btrim(item)) > 0),
  detail text,
  payer text,
  sort_order integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists property_expenses_household_property_idx
  on public.property_expenses(household_id, property_id, expense_date, id);

alter table public.properties enable row level security;
alter table public.property_expenses enable row level security;

drop policy if exists "properties_member_all" on public.properties;
create policy "properties_member_all" on public.properties for all to authenticated
using (exists (select 1 from public.household_members hm
  where hm.household_id = properties.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm
  where hm.household_id = properties.household_id and hm.user_id = (select auth.uid())));

-- with check 另外要求 property_id 屬於同一個家庭，免得把款項掛到別人的房子上。
drop policy if exists "property_expenses_member_all" on public.property_expenses;
create policy "property_expenses_member_all" on public.property_expenses for all to authenticated
using (exists (select 1 from public.household_members hm
  where hm.household_id = property_expenses.household_id and hm.user_id = (select auth.uid())))
with check (
  exists (select 1 from public.household_members hm
    where hm.household_id = property_expenses.household_id and hm.user_id = (select auth.uid()))
  and exists (select 1 from public.properties p
    where p.id = property_expenses.property_id and p.household_id = property_expenses.household_id)
);

grant select, insert, update, delete on public.properties to authenticated;
grant select, insert, update, delete on public.property_expenses to authenticated;
