-- 0135 — the ledger has to know WHICH SHOP'S TILL paid the advance.
--
-- THE PROBLEM, in the owner's own words: Kashif works at Fashion Collection
-- DHA. He moves to FC Paragon. He takes Rs 2,000 advance at FC Paragon.
--
-- Today retail_employee_ledger stores only employee_id. "Which shop" is then
-- read off retail_employees.branch_id — the employee's CURRENT shop — so:
--
--   · the Rs 2,000 reads as FC DHA's money if he is still filed there, and as
--     FC Paragon's the moment somebody edits his record, and
--   · every advance he ever took at his old shop silently changes shop with
--     him, because there is one branch_id and it is the present tense.
--
-- A shop paid that cash out of its own till on a particular day. That is a
-- fact about the past and it needs its own column.
--
-- THIS IS NOT THE SAME QUESTION AS WHO OWES THE MONEY. Kashif owes it wherever
-- he works; FC Paragon's till is short. Recording both lets either policy be
-- reported — recover from his payroll and settle between the shops, or charge
-- it to the shop that paid — and neither is possible while only one of the two
-- is stored. Nothing in this migration decides that policy. It only stops the
-- information being thrown away.
--
-- Legacy rows are left NULL rather than back-filled from the employee's current
-- shop. A guess written into a money column is indistinguishable from a fact a
-- week later, and the screens read NULL as "not recorded" and fall back to the
-- employee's shop exactly as they do today.

alter table public.retail_employee_ledger
  add column if not exists branch_id bigint references public.retail_branches(id);

comment on column public.retail_employee_ledger.branch_id is
  'The shop whose till actually paid this advance out, which is NOT necessarily '
  'the employee''s current branch — staff move between shops. NULL on rows '
  'written before 0135, meaning "not recorded"; read the employee''s branch then.';

create index if not exists retail_employee_ledger_branch_idx
  on public.retail_employee_ledger (branch_id, entry_date);

-- ── the importer fills it in ────────────────────────────────────────────────
-- p_adv_rows gains a branch_id, which the app already knows: it is the branch
-- of the expense row the advance was read from. Older callers that do not send
-- it still work — the column is simply left NULL, exactly as before.

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
         nullif(a.v->>'branch_id','')::bigint as branch_id,   -- 0135: the paying shop
         (a.v->>'entry_date')::date as entry_date,
         coalesce((a.v->>'advance')::numeric,0) as advance,
         coalesce((a.v->>'purchase_credit')::numeric,0) as purchase_credit,
         coalesce((a.v->>'paid')::numeric,0) as paid,
         a.v->>'purchase_details' as purchase_details, a.ord as ord
  from jsonb_array_elements(coalesce(p_adv_rows,'[]'::jsonb)) with ordinality as a(v, ord);
  delete from _in_adv where employee_id is null or entry_date is null;

  -- REPLACE PER EMPLOYEE, NOT PER BRANCH-RANGE (0133). The blanket delete that
  -- used to sit here removed every nimbus ledger row in the file's range for the
  -- file's branches, whether or not this run had anything to put back. Scoping
  -- to the employees actually in this payload is all that re-import safety
  -- needs; dedupe_key + on-conflict already makes doubling impossible.
  delete from retail_employee_ledger el
  using (select employee_id, min(entry_date) dmin, max(entry_date) dmax from _in_adv group by employee_id) s
  where el.source='nimbus' and el.employee_id=s.employee_id and el.entry_date between s.dmin and s.dmax;
  get diagnostics v_del_adv = row_count;

  insert into retail_employee_ledger
    (employee_id, branch_id, entry_date, advance, purchase_credit, paid, purchase_details, source, dedupe_key)
  select a.employee_id, a.branch_id, a.entry_date, a.advance, a.purchase_credit, a.paid, a.purchase_details, 'nimbus',
    md5(a.employee_id::text||'|'||a.entry_date::text||'|'||
        to_char(a.advance,'FM9999999999990.00')||'|'||
        to_char(a.purchase_credit,'FM9999999999990.00')||'|'||
        to_char(a.paid,'FM9999999999990.00')||'|'||coalesce(a.purchase_details,'')||'|'||
        row_number() over (partition by a.employee_id, a.entry_date, a.advance, a.purchase_credit,
                                        a.paid, coalesce(a.purchase_details,'') order by a.ord)::text)
  from _in_adv a
  on conflict (dedupe_key) where source='nimbus' do nothing;
  get diagnostics v_adv = row_count;

  -- The dedupe_key deliberately does NOT include branch_id: the same advance
  -- re-imported after the paying shop was corrected must UPDATE, not duplicate.
  update retail_employee_ledger el
     set branch_id = a.branch_id
    from _in_adv a
   where el.source = 'nimbus' and el.branch_id is null and a.branch_id is not null
     and el.employee_id = a.employee_id and el.entry_date = a.entry_date
     and el.advance = a.advance;

  return json_build_object('inserted', v_inserted, 'advances', v_adv,
                           'expenses_replaced', v_del_exp, 'advances_replaced', v_del_adv);
end;
$function$;
