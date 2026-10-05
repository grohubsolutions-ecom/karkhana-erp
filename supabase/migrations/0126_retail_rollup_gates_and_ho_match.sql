-- ════════════════════════════════════════════════════════════════════════════
-- FOUR CORRECTIONS TO 0125, FOUND BY REVIEW BEFORE ANY DATA WAS MIGRATED
--
-- 1. THE PERMISSION GATES WERE WIDER THAN THE TABLES' OWN RLS.
--    These functions are SECURITY DEFINER, so they bypass the row policies 0120
--    put on the tables they read. 0125 gated them on "sales.view OR
--    dashboard.view" and the like — so a role holding only retail.dashboard.view
--    could read, in one call, per-shop turnover and margin, per-salesperson
--    sales, expense totals, the whole cash-book row, card settlements and bank
--    settlements. 0119 exists precisely so the shop accounts person who types
--    today's expenses cannot also read the bank and the salaries.
--
--    Nothing leaked, because retail_can() ORs in the retail.access umbrella and
--    every existing role still holds it. But the moment a role is narrowed in
--    Administration — which 0119 tells the owner to do — these functions would
--    have kept returning exactly what had just been revoked. Each one now
--    requires the permission that guards the TABLE it reads, so an RPC can never
--    show more than a direct select would have.
--
-- 2. HEAD OFFICE WAS MATCHED TWO DIFFERENT WAYS. retail_day_summary used
--    `category ilike '%head office%'`; the cash book uses `category = 'Head
--    Office'`, exactly. A row filed as "HO rent" was a Head Office payment on
--    one screen and an ordinary expense on the other. The cash book is three
--    years old and is the record, so it wins.
--
-- 3. `paid` INCLUDED THE HEAD OFFICE LINES IT ALSO REPORTED SEPARATELY, so no
--    caller could use both without double-counting. `paid` is now the cash
--    book's `exp` — expense rows with Head Office taken out — and `ho` is the
--    other half.
--
-- 4. A SALE LINE WITH NO branch_id FELL OUT OF THE RECEIPT COUNT.
--    `NULL || '|' || x` is NULL and count(distinct NULL) drops it, where the
--    paged JavaScript counted it as "null|<key>". Only migrated history can hold
--    such a row — the importer filters them out — but the two paths must agree.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function retail_sales_rollup(
  p_from date default null, p_to date default null,
  p_branch bigint default null, p_by text[] default array['branch_id']
)
returns table (
  branch_id bigint, sale_date date, payment_method text, salesperson text, department text,
  sales numeric, margin numeric, qty numeric, lines bigint, receipts bigint
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $fn$
declare dims text[] := '{}'; d text; sel text; grp text;
begin
  -- The table's own read policy, and nothing wider. 0120 gates
  -- retail_sale_lines on retail.sales.view, so this does too.
  if not retail_can('retail.sales.view') then return; end if;

  foreach d in array coalesce(p_by, array['branch_id']) loop
    if d not in ('branch_id','sale_date','payment_method','salesperson','department') then
      raise exception 'retail_sales_rollup: unknown dimension %', d
        using hint = 'allowed: branch_id, sale_date, payment_method, salesperson, department';
    end if;
    if not (d = any(dims)) then dims := dims || d; end if;
  end loop;
  if cardinality(dims) = 0 then dims := array['branch_id']; end if;

  sel := format(
    '%s as branch_id, %s as sale_date, %s as payment_method, %s as salesperson, %s as department',
    case when 'branch_id'      = any(dims) then 'sl.branch_id'      else 'null::bigint' end,
    case when 'sale_date'      = any(dims) then 'sl.sale_date'      else 'null::date'   end,
    case when 'payment_method' = any(dims) then 'sl.payment_method' else 'null::text'   end,
    case when 'salesperson'    = any(dims) then 'sl.salesperson'    else 'null::text'   end,
    case when 'department'     = any(dims) then 'sl.department'     else 'null::text'   end
  );
  grp := array_to_string(array(select 'sl.' || quote_ident(x) from unnest(dims) as x), ', ');

  return query execute format($q$
    select %s,
           coalesce(sum(sl.sales_amount), 0)::numeric as sales,
           coalesce(sum(sl.gross_margin), 0)::numeric as margin,
           coalesce(sum(sl.quantity), 0)::numeric     as qty,
           count(*)::bigint                           as lines,
           -- The client's receipt key, character for character. coalesce on the
           -- branch too: a line with no branch_id would otherwise make the whole
           -- concatenation NULL, and count(distinct NULL) drops it — the paged
           -- JavaScript counted it as "null|<key>", so this matches it.
           count(distinct (coalesce(sl.branch_id::text, 'null') || '|' ||
                 coalesce(nullif(sl.receipt_txn, ''), nullif(sl.receipt_no, ''), sl.id::text)
           ))::bigint                                 as receipts
      from retail_sale_lines sl
     where ($1 is null or sl.sale_date >= $1)
       and ($2 is null or sl.sale_date <= $2)
       and ($3 is null or sl.branch_id = $3)
     group by %s
  $q$, sel, grp) using p_from, p_to, p_branch;
end
$fn$;

create or replace function retail_expense_rollup(
  p_from date default null, p_to date default null,
  p_branch bigint default null, p_by text[] default array['branch_id']
)
returns table (
  branch_id bigint, expense_date date, category text, paid_via text,
  expense numeric, income numeric, rows_n bigint
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $fn$
declare dims text[] := '{}'; d text; sel text; grp text;
begin
  -- 0120 gates retail_expenses on retail.expenses.view. Same here.
  if not retail_can('retail.expenses.view') then return; end if;

  foreach d in array coalesce(p_by, array['branch_id']) loop
    if d not in ('branch_id','expense_date','category','paid_via') then
      raise exception 'retail_expense_rollup: unknown dimension %', d
        using hint = 'allowed: branch_id, expense_date, category, paid_via';
    end if;
    if not (d = any(dims)) then dims := dims || d; end if;
  end loop;
  if cardinality(dims) = 0 then dims := array['branch_id']; end if;

  sel := format(
    '%s as branch_id, %s as expense_date, %s as category, %s as paid_via',
    case when 'branch_id'    = any(dims) then 'e.branch_id'    else 'null::bigint' end,
    case when 'expense_date' = any(dims) then 'e.expense_date' else 'null::date'   end,
    case when 'category'     = any(dims) then 'e.category'     else 'null::text'   end,
    case when 'paid_via'     = any(dims) then 'e.paid_via'     else 'null::text'   end
  );
  grp := array_to_string(array(select 'e.' || quote_ident(x) from unnest(dims) as x), ', ');

  return query execute format($q$
    select %s,
           coalesce(sum(case when e.txn_type = 'income' then 0 else e.amount end), 0)::numeric as expense,
           coalesce(sum(case when e.txn_type = 'income' then e.amount else 0 end), 0)::numeric as income,
           count(*)::bigint as rows_n
      from retail_expenses e
     where ($1 is null or e.expense_date >= $1)
       and ($2 is null or e.expense_date <= $2)
       and ($3 is null or e.branch_id = $3)
     group by %s
  $q$, sel, grp) using p_from, p_to, p_branch;
end
$fn$;

create or replace function retail_day_summary(p_date date, p_branch bigint)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $fn$
declare v_unit text; v_chain text; out_j jsonb;
begin
  -- This one reads five tables, so it needs the permission for each. Card
  -- settlements are owner-tier (0120 gates them on retail.cards.view), so a
  -- caller without it gets the day with the card figure left out rather than the
  -- whole call refused — Day Close is still useful to a shop person who is not
  -- allowed to see the bank.
  if not (retail_can('retail.cashbook.view')
          and retail_can('retail.sales.view')
          and retail_can('retail.expenses.view')) then
    return null;
  end if;

  select chain into v_chain from retail_branches where id = p_branch;
  if not found then return null; end if;

  -- Must match unitForBranch() in the app exactly: Top Shop exports one combined
  -- all-stores file, so its six branches share the unit 'topshop'; each Fashion
  -- Collection shop exports on its own as 'b<id>'.
  v_unit := case when coalesce(v_chain, '') = 'Topshop' then 'topshop' else 'b' || p_branch end;

  select jsonb_build_object(
    'date', p_date, 'branch_id', p_branch, 'unit', v_unit,

    'sales', (
      select jsonb_build_object(
        'gross',    coalesce(sum(sl.sales),0),
        'net',      coalesce(sum(sl.sales_amount),0),
        'margin',   coalesce(sum(sl.gross_margin),0),
        'qty',      coalesce(sum(sl.quantity),0),
        'lines',    count(*),
        'receipts', count(distinct coalesce(nullif(sl.receipt_txn,''), nullif(sl.receipt_no,''), sl.id::text)),
        -- Negative-quantity lines, reported POSITIVE because this figure is read
        -- as "how much came back". The cash book keeps it negative in its own
        -- column; same rows, opposite presentation, and anything printing both
        -- must say which it is showing.
        'returns',  coalesce(sum(case when coalesce(sl.quantity,0) < 0 then -sl.sales_amount else 0 end),0),
        'by_method', coalesce((
          select jsonb_object_agg(k, v) from (
            select coalesce(nullif(x.payment_method,''),'unclassified') as k, sum(x.sales_amount) as v
              from retail_sale_lines x
             where x.branch_id = p_branch and x.sale_date = p_date
             group by 1
          ) m
        ), '{}'::jsonb)
      )
      from retail_sale_lines sl
      where sl.branch_id = p_branch and sl.sale_date = p_date
    ),

    'expenses', (
      select jsonb_build_object(
        -- SPLIT THE WAY THE CASH BOOK SPLITS IT, or the two screens disagree:
        --   income is income even when somebody files it under Head Office,
        --   only an expense row can be a Head Office payment,
        --   and `paid` is what is left once Head Office is taken out.
        -- Exact match on the category, not ilike — the cash book has used
        -- `category = 'Head Office'` for three years and it is the record.
        'paid',   coalesce(sum(case when e.txn_type = 'income' then 0
                                   when e.category = 'Head Office' then 0
                                   else e.amount end),0),
        'ho',     coalesce(sum(case when e.txn_type <> 'income' and e.category = 'Head Office'
                                   then e.amount else 0 end),0),
        'income', coalesce(sum(case when e.txn_type = 'income' then e.amount else 0 end),0),
        'rows',   count(*)
      )
      from retail_expenses e
      where e.branch_id = p_branch and e.expense_date = p_date
    ),

    'book', (select to_jsonb(b) from retail_daily_book b
              where b.branch_id = p_branch and b.book_date = p_date),

    'uploaded', coalesce((select jsonb_agg(distinct u.kind) from retail_upload_log u
                           where u.unit = v_unit and u.log_date = p_date), '[]'::jsonb),

    'card_settled', case when retail_can('retail.cards.view') then coalesce((
        select sum(c.amount) from retail_card_settlements c
         where c.branch_id = p_branch and c.sale_date = p_date), 0) else null end,

    'bank_settled', (select s.actual_received from retail_bank_settlements s
                      where s.branch_id = p_branch and s.sale_date = p_date)
  ) into out_j;

  return out_j;
end
$fn$;

revoke all on function retail_sales_rollup(date, date, bigint, text[])   from public, anon;
revoke all on function retail_expense_rollup(date, date, bigint, text[]) from public, anon;
revoke all on function retail_day_summary(date, bigint)                  from public, anon;
grant execute on function retail_sales_rollup(date, date, bigint, text[])   to authenticated;
grant execute on function retail_expense_rollup(date, date, bigint, text[]) to authenticated;
grant execute on function retail_day_summary(date, bigint)                  to authenticated;

-- ── 5. THE UPLOAD LOG'S UNIQUE KEY, GUARANTEED ─────────────────────────────
-- 0118 created retail_upload_log with `unique (unit, log_date, kind)` inside a
-- `create table if not exists`, so on a database where the table already existed
-- the constraint was never added — and both the importer's stamp and the
-- dashboard's "nothing to upload, mark done" use it as an ON CONFLICT target.
-- Without it they fail with "no unique or exclusion constraint matching the ON
-- CONFLICT specification", which is the class of bug 0124 was written for; this
-- table was missed.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'retail_upload_log'
       and indexdef like '%UNIQUE%(unit, log_date, kind)%'
  ) then
    -- Duplicates cannot exist if the constraint was there; if it was not, clear
    -- them first, keeping the earliest stamp for each shop-day-kind.
    delete from retail_upload_log a using retail_upload_log b
     where a.unit = b.unit and a.log_date = b.log_date and a.kind = b.kind and a.id > b.id;
    create unique index if not exists retail_upload_log_unit_date_kind_uniq
      on retail_upload_log (unit, log_date, kind);
  end if;
end $$;
