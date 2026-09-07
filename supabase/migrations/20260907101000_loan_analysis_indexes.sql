create index if not exists loan_accounts_created_by_idx on public.loan_accounts (created_by);
create index if not exists loan_accounts_updated_by_idx on public.loan_accounts (updated_by);
create index if not exists loan_events_household_idx on public.loan_events (household_id);
