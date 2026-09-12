-- 已套用 Production：把老婆加入前原本只屬於老公的家庭淨資產，正式歸到 husband scope。
-- Production migration history 尚未 reconciliation，因此本檔留在 proposals，禁止用 db push 執行。
begin;

alter table public.financial_scope_history
  drop constraint if exists financial_scope_history_kind_check;

alter table public.financial_scope_history
  add constraint financial_scope_history_kind_check
  check (kind = any (array['asset'::text, 'liability'::text, 'net'::text]));

with wife_cutover as (
  select household_id, min(recorded_on) as recorded_on
  from public.financial_scope_history
  where owner_scope = 'wife'
  group by household_id
)
insert into public.financial_scope_history
  (household_id, owner_scope, kind, total_twd, recorded_on, source, created_at)
select h.household_id, 'husband', 'net', h.net_worth_twd, h.recorded_on,
       'legacy-husband-net-backfill', h.created_at
from public.net_worth_history h
left join wife_cutover w on w.household_id = h.household_id
where h.recorded_on < coalesce(w.recorded_on, 'infinity'::date)
  and h.net_worth_twd >= 0
on conflict (household_id, owner_scope, kind, recorded_on) do nothing;

commit;
