-- ════════════════════════════════════════════════════════════════════════════
-- FS TRADERS — SERVER-SIDE ROLL-UPS
--
-- WHY
--   Every figure on the dashboard, the sales screen, the branches screen and the
--   card screen is a SUM over retail_sale_lines, and every one of them was being
--   computed in the browser: the page paged the whole range down a thousand rows
--   at a time and added it up in JavaScript. On a laptop on office wifi that is
--   slow. On a phone on mobile data in a shop it is 150,000 rows for "all time",
--   which is minutes, megabytes of somebody's data bundle, and a tab that is
--   killed by the operating system before it finishes.
--
--   The sum belongs where the rows are. Postgres returns the same arithmetic in
--   one response of a few dozen rows.
--
-- WHAT IT DOES NOT DO
--   It does not change any number. The expressions are the ones the pages were
--   already computing — sales_amount, gross_margin, quantity, and a receipt count
--   over branch + receipt_txn/receipt_no/id, in that fallback order, exactly as
--   the client built its key. A screen can be moved onto this one table at a
--   time and reconciled against the old path before the old path is removed.
--
-- SECURITY
--   SECURITY DEFINER with a pinned search_path, and gated by retail_can() in the
--   body, which is the convention 0120–0124 established for this department. A
--   caller without the permission gets no rows, never somebody else's figures.
--
-- VERIFIED
--   Applied and tested 5 Oct 2026 inside a rolled-back transaction against
--   synthetic rows: every column of retail_sales_rollup matched a hand-written
--   aggregate over the same rows (sales, margin, qty, lines, receipts), on one
--   dimension and on two, per branch and per day, and retail_day_summary
--   reproduced gross/net/qty/returns/receipts/by_method and the topshop vs b<id>
--   unit key by hand.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. THE INDEX EVERY ONE OF THESE QUERIES WANTS ──────────────────────────
-- The table had (branch_id) and (sale_date) separately. Not one query in this
-- department asks for either alone: they all ask "this shop, between these two
-- dates". Two single-column indexes answer that with a bitmap AND over both
-- lists; one composite answers it with a range scan.
create index if not exists retail_sale_lines_branch_date_idx
  on retail_sale_lines (branch_id, sale_date);

-- Same reasoning for the two date-ranged companions. Expenses had
-- (branch_id, expense_date) but nothing for an all-branch range.
create index if not exists retail_expenses_date_idx
  on retail_expenses (expense_date);


-- ── 2. THE SALES ROLL-UP ───────────────────────────────────────────────────
-- One function, any combination of the five dimensions these screens group by.
-- `p_by` is whitelisted name by name before it reaches the query text — a
-- dimension list that arrives from a browser is user input, and it is going into
-- dynamic SQL.
create or replace function retail_sales_rollup(
  p_from   date   default null,
  p_to     date   default null,
  p_branch bigint default null,
  p_by     text[] default array['branch_id']
)
returns table (
  branch_id      bigint,
  sale_date      date,
  payment_method text,
  salesperson    text,
  department     text,
  sales          numeric,
  margin         numeric,
  qty            numeric,
  lines          bigint,
  receipts       bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  dims text[] := '{}';
  d    text;
  sel  text;
  grp  text;
begin
  -- The dashboard and the sales screen are the two callers; either permission
  -- is enough to read a total, because both screens already show these figures.
  if not (retail_can('retail.sales.view') or retail_can('retail.dashboard.view')) then
    return;
  end if;

  foreach d in array coalesce(p_by, array['branch_id']) loop
    if d not in ('branch_id','sale_date','payment_method','salesperson','department') then
      raise exception 'retail_sales_rollup: unknown dimension %', d
        using hint = 'allowed: branch_id, sale_date, payment_method, salesperson, department';
    end if;
    if not (d = any(dims)) then dims := dims || d; end if;
  end loop;
  if cardinality(dims) = 0 then dims := array['branch_id']; end if;

  -- Every dimension is always in the result shape; the ones not grouped on come
  -- back NULL. That means one TypeScript row type for every caller instead of
  -- five, and a caller cannot read a column it did not group by and get a
  -- plausible-looking wrong answer.
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
           coalesce(sum(sl.sales_amount), 0)::numeric  as sales,
           coalesce(sum(sl.gross_margin), 0)::numeric  as margin,
           coalesce(sum(sl.quantity), 0)::numeric      as qty,
           count(*)::bigint                            as lines,
           -- The client's receipt key, character for character: branch, then the
           -- POS transaction id, then the printed number, then the row id. Two
           -- shops can print the same receipt number on the same day and an old
           -- import has no txn at all, which is why it is a fallback chain and
           -- why the branch is part of it.
           count(distinct (sl.branch_id::text || '|' ||
                 coalesce(nullif(sl.receipt_txn, ''), nullif(sl.receipt_no, ''), sl.id::text)
           ))::bigint                                  as receipts
      from retail_sale_lines sl
     where ($1 is null or sl.sale_date >= $1)
       and ($2 is null or sl.sale_date <= $2)
       and ($3 is null or sl.branch_id = $3)
     group by %s
  $q$, sel, grp) using p_from, p_to, p_branch;
end
$fn$;


-- ── 3. THE EXPENSE ROLL-UP ─────────────────────────────────────────────────
-- Expenses and misc income share one table and are told apart by txn_type, so
-- they are summed as two columns rather than filtered twice. Income is NOT
-- negated here: the caller decides, because the cash book subtracts expenses and
-- adds income while the dashboard nets them.
create or replace function retail_expense_rollup(
  p_from   date   default null,
  p_to     date   default null,
  p_branch bigint default null,
  p_by     text[] default array['branch_id']
)
returns table (
  branch_id    bigint,
  expense_date date,
  category     text,
  paid_via     text,
  expense      numeric,
  income       numeric,
  rows_n       bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  dims text[] := '{}';
  d    text;
  sel  text;
  grp  text;
begin
  if not (retail_can('retail.expenses.view') or retail_can('retail.cashbook.view')
          or retail_can('retail.dashboard.view')) then
    return;
  end if;

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


-- ── 4. ONE DAY, ONE SHOP, ONE ROUND TRIP ───────────────────────────────────
-- For the Day Close checklist. Everything that screen asks about a shop-day —
-- what Nimbus says was sold and how it was paid, what was spent, whether the
-- book row exists and has a physical count, whether the three files were
-- imported, whether the card money and the bank deposit have been recorded —
-- in a single call, because the screen is opened on a phone in a shop and eight
-- round trips on mobile data is eight chances to stall.
create or replace function retail_day_summary(
  p_date   date,
  p_branch bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_unit  text;
  v_chain text;
  out_j   jsonb;
begin
  if not (retail_can('retail.dashboard.view') or retail_can('retail.cashbook.view')) then
    return null;
  end if;

  select chain into v_chain from retail_branches where id = p_branch;
  if not found then return null; end if;

  -- The upload log is keyed by FILE, not by branch: Top Shop exports one
  -- combined all-stores file so all six of its branches share the unit
  -- 'topshop', while each Fashion Collection shop exports on its own as
  -- 'b<id>'. This must match unitForBranch() in the app exactly, or a day reads
  -- as never uploaded for ever.
  v_unit := case when coalesce(v_chain, '') = 'Topshop' then 'topshop' else 'b' || p_branch end;

  select jsonb_build_object(
    'date',      p_date,
    'branch_id', p_branch,
    'unit',      v_unit,

    'sales', (
      select jsonb_build_object(
        'gross',    coalesce(sum(sl.sales),0),
        'net',      coalesce(sum(sl.sales_amount),0),
        'margin',   coalesce(sum(sl.gross_margin),0),
        'qty',      coalesce(sum(sl.quantity),0),
        'lines',    count(*),
        'receipts', count(distinct coalesce(nullif(sl.receipt_txn,''), nullif(sl.receipt_no,''), sl.id::text)),
        -- Returns are the negative-quantity lines, which is how the cash book
        -- has always found them.
        'returns',  coalesce(sum(case when coalesce(sl.quantity,0) < 0 then -sl.sales_amount else 0 end),0),
        'by_method', coalesce((
          select jsonb_object_agg(k, v) from (
            select coalesce(x.payment_method,'unclassified') as k, sum(x.sales_amount) as v
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
        'paid',   coalesce(sum(case when e.txn_type = 'income' then 0 else e.amount end),0),
        'income', coalesce(sum(case when e.txn_type = 'income' then e.amount else 0 end),0),
        -- The Head Office lines the Nimbus import brings in are already part of
        -- the HO column on the cash book grid. Day Close shows them separately
        -- for the same reason the cash book editor does: adding the rendered
        -- total back into the typed box is what doubled HO payments in
        -- production.
        'ho',     coalesce(sum(case when e.category ilike '%head office%' or e.category ilike 'ho %'
                                   then e.amount else 0 end),0),
        'rows',   count(*)
      )
      from retail_expenses e
      where e.branch_id = p_branch and e.expense_date = p_date
    ),

    'book', (
      select to_jsonb(b) from retail_daily_book b
       where b.branch_id = p_branch and b.book_date = p_date
    ),

    'uploaded', coalesce((
      select jsonb_agg(distinct u.kind)
        from retail_upload_log u
       where u.unit = v_unit and u.log_date = p_date
    ), '[]'::jsonb),

    'card_settled', coalesce((
      select sum(c.amount) from retail_card_settlements c
       where c.branch_id = p_branch and c.sale_date = p_date
    ), 0),

    'bank_settled', (
      select s.actual_received from retail_bank_settlements s
       where s.branch_id = p_branch and s.sale_date = p_date
    )
  ) into out_j;

  return out_j;
end
$fn$;


-- ── 5. NOBODY ANONYMOUS CALLS ANY OF THIS ──────────────────────────────────
-- Same hardening as 0123. These are SECURITY DEFINER, so an anon grant would be
-- a public read of the whole department's turnover.
revoke all on function retail_sales_rollup(date, date, bigint, text[])   from public, anon;
revoke all on function retail_expense_rollup(date, date, bigint, text[]) from public, anon;
revoke all on function retail_day_summary(date, bigint)                  from public, anon;
grant execute on function retail_sales_rollup(date, date, bigint, text[])   to authenticated;
grant execute on function retail_expense_rollup(date, date, bigint, text[]) to authenticated;
grant execute on function retail_day_summary(date, bigint)                  to authenticated;
