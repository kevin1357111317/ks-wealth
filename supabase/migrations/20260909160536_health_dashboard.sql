-- Private household health-check history. The app is read-only; imports are
-- performed through the trusted database administration path after a report is
-- reviewed, so medical data cannot be changed from a compromised browser.

create table public.health_checkups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner_scope text not null check (owner_scope in ('husband', 'wife')),
  checkup_year smallint not null check (checkup_year between 1900 and 2200),
  checkup_date date,
  source_label text not null default '年度健檢',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, owner_scope, checkup_year)
);

create table public.health_metrics (
  id bigint generated always as identity primary key,
  checkup_id uuid not null references public.health_checkups(id) on delete cascade,
  metric_key text not null,
  label text not null,
  category text not null,
  value_numeric numeric,
  value_text text,
  unit text,
  reference_low numeric,
  reference_high numeric,
  reference_text text,
  status text not null default 'normal'
    check (status in ('normal', 'low', 'high', 'watch', 'positive', 'info')),
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (value_numeric is not null or value_text is not null),
  unique (checkup_id, metric_key)
);

create index health_checkups_household_owner_year_idx
  on public.health_checkups (household_id, owner_scope, checkup_year desc);
create index health_metrics_checkup_sort_idx
  on public.health_metrics (checkup_id, sort_order, metric_key);

alter table public.health_checkups enable row level security;
alter table public.health_metrics enable row level security;

create policy health_checkups_select_household_member
on public.health_checkups for select to authenticated
using (exists (
  select 1 from public.household_members hm
  where hm.household_id = health_checkups.household_id
    and hm.user_id = (select auth.uid())
));

create policy health_metrics_select_household_member
on public.health_metrics for select to authenticated
using (exists (
  select 1
  from public.health_checkups hc
  join public.household_members hm on hm.household_id = hc.household_id
  where hc.id = health_metrics.checkup_id
    and hm.user_id = (select auth.uid())
));

revoke all on table public.health_checkups from anon, authenticated;
revoke all on table public.health_metrics from anon, authenticated;
revoke all on sequence public.health_metrics_id_seq from anon, authenticated;
grant select on table public.health_checkups to authenticated;
grant select on table public.health_metrics to authenticated;
