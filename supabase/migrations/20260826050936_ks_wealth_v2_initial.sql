-- RECONSTRUCTED MIGRATION — 2026-08-28 security review
-- This file did not exist in git before this review. It was reconstructed from the
-- exact SQL recorded in production's `supabase_migrations.schema_migrations` table
-- (version 20260826050936, name "ks_wealth_v2_initial"), read via a SELECT-only query.
--
-- DELIBERATE DIFFERENCE FROM PRODUCTION HISTORY:
-- The original migration also contained a large block of `insert into financial_items /
-- cashflow_forecasts / net_worth_history / loan_events` statements seeding REAL household
-- financial data (bank balances, brokerage holdings, mortgage amounts, a hashed invite code,
-- personal notes). Per explicit instruction during this review, that data has been removed
-- from this file so it never enters git history. Production already has this data — it does
-- NOT need to be re-inserted anywhere. This file only reconstructs the schema (DDL).
--
-- This file has NOT been applied to any database. It is for git version-control review only.

create extension if not exists pgcrypto;

do $$ begin
  create type public.member_role as enum ('owner','member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.financial_kind as enum ('asset','liability');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code_hash text not null unique,
  max_uses smallint not null default 1 check (max_uses between 1 and 10),
  use_count smallint not null default 0 check (use_count >= 0),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (use_count <= max_uses)
);

create table if not exists public.financial_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  kind public.financial_kind not null,
  category text not null,
  name text not null,
  amount_twd numeric(16,2) not null default 0,
  original_currency text not null default 'TWD',
  original_amount numeric(18,4),
  fx_rate_twd numeric(18,8),
  interest_rate numeric(8,4),
  monthly_payment_twd numeric(16,2),
  notes text,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_items_amount_nonnegative check (amount_twd >= 0)
);
create index if not exists financial_items_household_kind_idx on public.financial_items(household_id, kind);
create index if not exists financial_items_household_category_idx on public.financial_items(household_id, category);

create table if not exists public.cashflow_forecasts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  month date not null,
  income_twd numeric(16,2) not null default 0,
  debt_payment_twd numeric(16,2) not null default 0,
  living_spending_twd numeric(16,2) not null default 0,
  closing_balance_twd numeric(16,2) not null default 0,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, month)
);

create table if not exists public.net_worth_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recorded_on date not null,
  net_worth_twd numeric(16,2) not null,
  source text not null default 'app',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (household_id, recorded_on)
);

create table if not exists public.loan_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  event_date date not null,
  title text not null,
  amount_twd numeric(16,2) not null default 0,
  note text,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.household_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  base_currency text not null default 'TWD',
  manual_stock_leverage numeric(10,4),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_household_created_idx on public.activity_log(household_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.financial_items enable row level security;
alter table public.cashflow_forecasts enable row level security;
alter table public.net_worth_history enable row level security;
alter table public.loan_events enable row level security;
alter table public.household_settings enable row level security;
alter table public.activity_log enable row level security;

drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "members_select_self" on public.household_members;
create policy "members_select_self" on public.household_members for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "members_insert_owner_self" on public.household_members;
create policy "members_insert_owner_self" on public.household_members for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and role = 'owner'
  and exists (
    select 1 from public.households h
    where h.id = household_members.household_id and h.created_by = (select auth.uid())
  )
);

drop policy if exists "households_select_member" on public.households;
create policy "households_select_member" on public.households for select to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = households.id and hm.user_id = (select auth.uid())
));
drop policy if exists "households_insert_creator" on public.households;
create policy "households_insert_creator" on public.households for insert to authenticated
with check (created_by = (select auth.uid()));
drop policy if exists "households_update_owner" on public.households;
create policy "households_update_owner" on public.households for update to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = households.id and hm.user_id = (select auth.uid()) and hm.role = 'owner'
))
with check (exists (
  select 1 from public.household_members hm
  where hm.household_id = households.id and hm.user_id = (select auth.uid()) and hm.role = 'owner'
));

drop policy if exists "invites_owner_all" on public.household_invites;
create policy "invites_owner_all" on public.household_invites for all to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = household_invites.household_id and hm.user_id = (select auth.uid()) and hm.role = 'owner'
))
with check (exists (
  select 1 from public.household_members hm
  where hm.household_id = household_invites.household_id and hm.user_id = (select auth.uid()) and hm.role = 'owner'
));

drop policy if exists "financial_items_member_select" on public.financial_items;
create policy "financial_items_member_select" on public.financial_items for select to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = financial_items.household_id and hm.user_id = (select auth.uid())));
drop policy if exists "financial_items_member_insert" on public.financial_items;
create policy "financial_items_member_insert" on public.financial_items for insert to authenticated
with check (exists (select 1 from public.household_members hm where hm.household_id = financial_items.household_id and hm.user_id = (select auth.uid())));
drop policy if exists "financial_items_member_update" on public.financial_items;
create policy "financial_items_member_update" on public.financial_items for update to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = financial_items.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm where hm.household_id = financial_items.household_id and hm.user_id = (select auth.uid())));
drop policy if exists "financial_items_member_delete" on public.financial_items;
create policy "financial_items_member_delete" on public.financial_items for delete to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = financial_items.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "cashflow_member_all" on public.cashflow_forecasts;
create policy "cashflow_member_all" on public.cashflow_forecasts for all to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = cashflow_forecasts.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm where hm.household_id = cashflow_forecasts.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "history_member_all" on public.net_worth_history;
create policy "history_member_all" on public.net_worth_history for all to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = net_worth_history.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm where hm.household_id = net_worth_history.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "loan_events_member_all" on public.loan_events;
create policy "loan_events_member_all" on public.loan_events for all to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = loan_events.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm where hm.household_id = loan_events.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "settings_member_all" on public.household_settings;
create policy "settings_member_all" on public.household_settings for all to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = household_settings.household_id and hm.user_id = (select auth.uid())))
with check (exists (select 1 from public.household_members hm where hm.household_id = household_settings.household_id and hm.user_id = (select auth.uid())));

drop policy if exists "activity_member_select" on public.activity_log;
create policy "activity_member_select" on public.activity_log for select to authenticated
using (exists (select 1 from public.household_members hm where hm.household_id = activity_log.household_id and hm.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.households to authenticated;
grant select, insert on public.household_members to authenticated;
grant select, insert, update, delete on public.household_invites to authenticated;
grant select, insert, update, delete on public.financial_items to authenticated;
grant select, insert, update, delete on public.cashflow_forecasts to authenticated;
grant select, insert, update, delete on public.net_worth_history to authenticated;
grant select, insert, update, delete on public.loan_events to authenticated;
grant select, insert, update, delete on public.household_settings to authenticated;
grant select on public.activity_log to authenticated;

revoke all on public.profiles, public.households, public.household_members, public.household_invites,
  public.financial_items, public.cashflow_forecasts, public.net_worth_history, public.loan_events,
  public.household_settings, public.activity_log from anon;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  hid uuid;
  eid uuid;
  details jsonb;
begin
  uid := auth.uid();
  if uid is null then return coalesce(new, old); end if;
  hid := coalesce(new.household_id, old.household_id);
  eid := coalesce(new.id, old.id);
  details := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  insert into public.activity_log(household_id, user_id, entity_type, entity_id, action, payload)
  values (hid, uid, tg_table_name, eid, lower(tg_op), details);
  return coalesce(new, old);
end;
$$;
revoke all on function private.audit_row_change() from public, anon, authenticated;

drop trigger if exists audit_financial_items on public.financial_items;
create trigger audit_financial_items after insert or update or delete on public.financial_items
for each row execute function private.audit_row_change();
drop trigger if exists audit_cashflow_forecasts on public.cashflow_forecasts;
create trigger audit_cashflow_forecasts after insert or update or delete on public.cashflow_forecasts
for each row execute function private.audit_row_change();

create or replace function public.join_household_by_code(raw_code text)
returns table (household_id uuid, member_role public.member_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.household_invites%rowtype;
  assigned_role public.member_role;
begin
  if uid is null then raise exception 'authentication required'; end if;
  if raw_code is null or length(trim(raw_code)) < 12 then raise exception 'invalid invite code'; end if;

  select * into inv
  from public.household_invites
  where code_hash = encode(digest(trim(raw_code), 'sha256'), 'hex')
    and expires_at > now()
    and use_count < max_uses
  for update;

  if not found then raise exception 'invite code invalid or expired'; end if;

  select hm.role into assigned_role
  from public.household_members hm
  where hm.household_id = inv.household_id and hm.user_id = uid;

  if assigned_role is not null then
    return query select inv.household_id, assigned_role;
    return;
  end if;

  if exists (select 1 from public.household_members hm where hm.household_id = inv.household_id) then
    assigned_role := 'member';
  else
    assigned_role := 'owner';
  end if;

  insert into public.household_members(household_id, user_id, role)
  values (inv.household_id, uid, assigned_role);

  if assigned_role = 'owner' then
    update public.households set created_by = coalesce(created_by, uid), updated_at = now()
    where id = inv.household_id;
  end if;

  update public.household_invites set use_count = use_count + 1 where id = inv.id;
  return query select inv.household_id, assigned_role;
end;
$$;
revoke all on function public.join_household_by_code(text) from public, anon;
grant execute on function public.join_household_by_code(text) to authenticated;

create or replace function public.create_household_invite(target_household uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  raw_code text;
begin
  if uid is null then raise exception 'authentication required'; end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = target_household and hm.user_id = uid and hm.role = 'owner'
  ) then
    raise exception 'owner access required';
  end if;

  raw_code := 'KS-' || encode(gen_random_bytes(18), 'hex');
  insert into public.household_invites(household_id, code_hash, max_uses, use_count, expires_at, created_by)
  values (target_household, encode(digest(raw_code, 'sha256'), 'hex'), 1, 0, now() + interval '30 days', uid);
  return raw_code;
end;
$$;
revoke all on function public.create_household_invite(uuid) from public, anon;
grant execute on function public.create_household_invite(uuid) to authenticated;

-- NOTE: the original production migration also inserted seed rows here
-- (households / household_invites / financial_items / cashflow_forecasts /
-- net_worth_history / loan_events containing real personal financial data).
-- Those statements are intentionally omitted from this reconstructed file.
-- Production already has this data; it does not need to be re-applied anywhere.
