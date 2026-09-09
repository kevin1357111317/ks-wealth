-- Fix object resolution without changing function behavior or permissions.
alter function public.apply_due_loan_payments()
  set search_path = pg_catalog, public, pg_temp;
