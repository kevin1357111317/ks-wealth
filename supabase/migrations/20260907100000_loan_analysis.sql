create table if not exists public.loan_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner_scope text not null default 'husband' check (owner_scope in ('husband', 'wife')),
  financial_item_id uuid unique references public.financial_items(id) on delete set null,
  source_key text not null,
  lender text not null,
  name text not null,
  loan_type text not null default 'personal' check (loan_type in ('personal', 'topup')),
  original_principal_twd numeric not null check (original_principal_twd >= 0),
  nominal_annual_rate numeric check (nominal_annual_rate is null or nominal_annual_rate >= 0),
  contractual_monthly_payment_twd numeric check (contractual_monthly_payment_twd is null or contractual_monthly_payment_twd >= 0),
  start_date date not null,
  maturity_date date,
  projected_total_repayment_twd numeric check (projected_total_repayment_twd is null or projected_total_repayment_twd >= 0),
  effective_annual_cost numeric,
  status text not null default 'active' check (status in ('active', 'closed')),
  closed_on date,
  source_note text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, source_key)
);

create index if not exists loan_accounts_household_idx on public.loan_accounts (household_id);
create index if not exists loan_accounts_owner_status_idx on public.loan_accounts (household_id, owner_scope, status);

alter table public.loan_accounts enable row level security;

drop policy if exists loan_accounts_member_all on public.loan_accounts;
create policy loan_accounts_member_all on public.loan_accounts
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = loan_accounts.household_id
      and hm.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = loan_accounts.household_id
      and hm.user_id = (select auth.uid())
  ));

alter table public.loan_events
  add column if not exists loan_account_id uuid references public.loan_accounts(id) on delete set null;

create index if not exists loan_events_account_idx on public.loan_events (loan_account_id);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'loan_accounts'
  ) then
    alter publication supabase_realtime add table public.loan_accounts;
  end if;
end $$;
