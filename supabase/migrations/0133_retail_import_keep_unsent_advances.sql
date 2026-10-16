-- 0133 — an expense import must not delete advances it is not replacing.
--
-- RUN THIS BEFORE THE NEXT EXPENSE IMPORT. It is the half of the advance fix
-- that lives in the database; the other half ships in the app.
--
-- THE BUG. The advance side of retail_import_nimbus_expenses ran a blanket
-- delete of every source='nimbus' ledger row inside the file's date range for
-- the file's branches — and it ran whether or not the call supplied any
-- advances to put back:
--
--   delete from retail_employee_ledger el
--    where el.source='nimbus'
--      and el.entry_date between p_min_date and p_max_date
--      and el.employee_id in (select id from retail_employees
--                              where branch_id = any(p_branch_ids));
--
-- The old Grohub app got away with that because its importer stopped and made
-- a human attach every flagged advance to a person before writing, so the set
-- it sent was always complete. Nothing guarantees that here, and until today
-- the app sent p_adv_rows = '[]' on every single run.
--
-- Measured against live data on 15 Oct 2026, before the change: one ordinary
-- September expense re-import would have deleted 88 ledger rows — Rs 294,050
-- of advances across 26 staff — and put nothing back. 178 such rows
-- (Rs 632,590) came over in the migration from the old app, where they had
-- been linked by hand.
--
-- THE FIX. Replace per employee, not per branch-range. The delete that remains
-- is scoped to the employees actually present in the payload and to their own
-- min/max dates, which is all that re-import safety requires; the dedupe_key
-- with on-conflict-do-nothing already makes doubling impossible regardless.
--
-- WHAT THIS GIVES UP. An advance that was in an earlier version of the file and
-- has since been removed from it survives, if that employee has no other
-- advance in the new file. That is the right way round: a stale row is visible
-- on the person's ledger and goes in one click, while silently wiping money
-- owed across 26 people is neither visible nor recoverable.
--
-- The expense side is untouched. Expenses genuinely are re-sent in full every
-- run, so replacing the whole range for those branches stays correct.
--
-- Safe to run more than once.

create or replace function public.retail_import_nimbus_expenses(
  p_branch_ids bigint[], p_min_date date, p_max_date date,
  p_rows jsonb, p_adv_rows jsonb default '[]'::jsonb
) returns json
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_inserted int := 0; v_adv int := 0; v_del_exp int := 0; v_del_adv int := 0; v_tmp int := 0;
begin
  if not retail_can('retail.import.run') then
    raise exception 'Not allowed to run the Nimbus import' using errcode = '42501';
  end if;

  create temp table _in_exp on commit drop as
  select nullif(r.v->>'branch_id','')::bigint as branch_id,
         (r.v->>'expense_date')::date as expense_date,
         (r.v->>'amount')::numeric as amount,
         coalesce(nullif(r.v->>'txn_type',''), 'expense') as txn_type,
         r.v->>'category' as category, r.v->>'description' as description,
         coalesce(nullif(r.v->>'paid_via',''), 'cash') as paid_via, r.ord as ord
  from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) with ordinality as r(v, ord);
  delete from _in_exp where branch_id is null or expense_date is null or amount is null;

  delete from retail_expenses e
  using (select branch_id, min(expense_date) dmin, max(expense_date) dmax from _in_exp group by branch_id) s
  where e.source='nimbus' and e.branch_id=s.branch_id and e.expense_date between s.dmin and s.dmax;
  get diagnostics v_del_exp = row_count;

  if array_length(p_branch_ids,1) is not null and p_min_date is not null and p_max_date is not null then
    delete from retail_expenses e
     where e.source='nimbus' and e.branch_id = any(p_branch_ids)
       and e.expense_date between p_min_date and p_max_date;
    get diagnostics v_tmp = row_count; v_del_exp := v_del_exp + v_tmp;
  end if;

  insert into retail_expenses
    (branch_id, expense_date, amount, txn_type, category, description, paid_via, source, dedupe_key)
  select i.branch_id, i.expense_date, i.amount, i.txn_type, i.category, i.description, i.paid_via, 'nimbus',
    md5(i.branch_id::text||'|'||i.expense_date::text||'|'||coalesce(i.category,'')||'|'||
        coalesce(i.description,'')||'|'||to_char(i.amount,'FM9999999999990.00')||'|'||
        coalesce(i.paid_via,'')||'|'||coalesce(i.txn_type,'')||'|'||
        row_number() over (partition by i.branch_id, i.expense_date, coalesce(i.category,''),
                                        coalesce(i.description,''), i.amount, coalesce(i.paid_via,''),
                                        coalesce(i.txn_type,'') order by i.ord)::text)
  from _in_exp i
  on conflict (dedupe_key) where source='nimbus' do nothing;
  get diagnostics v_inserted = row_count;

  create temp table _in_adv on commit drop as
  select (a.v->>'employee_id')::bigint as employee_id,
         (a.v->>'entry_date')::date as entry_date,
         coalesce((a.v->>'advance')::numeric,0) as advance,
         coalesce((a.v->>'purchase_credit')::numeric,0) as purchase_credit,
         coalesce((a.v->>'paid')::numeric,0) as paid,
         a.v->>'purchase_details' as purchase_details, a.ord as ord
  from jsonb_array_elements(coalesce(p_adv_rows,'[]'::jsonb)) with ordinality as a(v, ord);
  delete from _in_adv where employee_id is null or entry_date is null;

  -- REPLACE PER EMPLOYEE, NOT PER BRANCH-RANGE. The blanket delete that used to
  -- sit here removed every nimbus ledger row in the file's range for the file's
  -- branches, whether or not this run had anything to put back -- and the client
  -- sent an empty advance list on every run until now. Measured before the fix:
  -- one September re-import would have deleted 88 rows, Rs 294,050 across 26
  -- staff, including 178 rows hand-linked in the old app and migrated across.
  -- Scoping to the employees actually in this payload is all that re-import
  -- safety needs; dedupe_key + on-conflict already makes doubling impossible.
  delete from retail_employee_ledger el
  using (select employee_id, min(entry_date) dmin, max(entry_date) dmax from _in_adv group by employee_id) s
  where el.source='nimbus' and el.employee_id=s.employee_id and el.entry_date between s.dmin and s.dmax;
  get diagnostics v_del_adv = row_count;

  insert into retail_employee_ledger
    (employee_id, entry_date, advance, purchase_credit, paid, purchase_details, source, dedupe_key)
  select a.employee_id, a.entry_date, a.advance, a.purchase_credit, a.paid, a.purchase_details, 'nimbus',
    md5(a.employee_id::text||'|'||a.entry_date::text||'|'||
        to_char(a.advance,'FM9999999999990.00')||'|'||
        to_char(a.purchase_credit,'FM9999999999990.00')||'|'||
        to_char(a.paid,'FM9999999999990.00')||'|'||coalesce(a.purchase_details,'')||'|'||
        row_number() over (partition by a.employee_id, a.entry_date, a.advance, a.purchase_credit,
                                        a.paid, coalesce(a.purchase_details,'') order by a.ord)::text)
  from _in_adv a
  on conflict (dedupe_key) where source='nimbus' do nothing;
  get diagnostics v_adv = row_count;

  return json_build_object('inserted', v_inserted, 'advances', v_adv,
                           'expenses_replaced', v_del_exp, 'advances_replaced', v_del_adv);
end;
$function$;
