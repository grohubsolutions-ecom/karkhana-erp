-- ════════════════════════════════════════════════════════════════════════════
-- retail_sales_agg — ONE AGGREGATE FOR THE SCREENS THAT ONLY WANTED SUMS
--
-- 0125's retail_sales_rollup was missing three things, so three screens kept
-- reading raw lines and kept timing out (see 0127's header for the measurements):
--
--   1. `item_code` as a dimension — commissions multiplies each line's quantity
--      by that item's rate, so it needs item detail, not one row per LINE.
--   2. `gross` — sum(sales), the pre-discount figure. The cash book needs gross
--      AND net on one row; the roll-up returned only net.
--   3. `returns` — the negative-quantity lines, which the cash book also needs.
--
-- WHY A NEW NAME rather than replacing retail_sales_rollup: the return type
-- changes, so the old one would have to be DROPPED, and DROP needs an exclusive
-- lock that contends with PostgREST's schema-cache reload. It blocked twice on
-- the live database. Taking the department down to tidy a name is not a trade
-- worth making while shops are open, so the fuller function lands beside it and
-- retail_sales_rollup is dropped in a quiet window once nothing calls it. Both
-- read the same table with the same gate, so they cannot disagree about a figure.
--
-- THE BILL COUNT IS OPT-IN, AND COSTS 31× THE REST OF THE QUERY WHEN ON.
-- Measured, same grouping, same three months of 58,303 lines:
--
--     with    count(distinct <receipt key>)   2,174 ms  ← sorts every row,
--                                                         spills to disk
--     without                                    70 ms  ← one hash aggregate
--
-- Every sum here is a hash aggregate: no sort, linear. count(distinct) cannot be
-- hashed alongside them, so Postgres sorts all 58,303 rows by the grouping keys
-- PLUS the receipt key, and that sort does not fit in work_mem ("external merge,
-- Peak Disk: 1608kB"). Only two callers of six need it — the dashboard's "Bills"
-- tile and the sales screen's per-shop count — and they were making the other
-- four pay for it.
--
-- The switch lives in `p_by` rather than in a new argument for the same
-- lock reason as the name:
--
--     p_by => ['branch_id']               cheap; receipts comes back 0
--     p_by => ['branch_id','receipts']    the bill count, and you pay for it
--
-- The column is always present so the result shape never changes and no caller
-- needs a second row type. 0 means "not asked for", never "no bills".
--
-- Applied 9 Oct 2026. The definition below was read back out of the live
-- catalogue with pg_get_functiondef, so this file and the database cannot differ.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function retail_sales_agg(
  p_from   date   default null,
  p_to     date   default null,
  p_branch bigint default null,
  p_by     text[] default array['branch_id']
)
returns table (
  branch_id bigint, sale_date date, payment_method text, salesperson text,
  department text, item_code text,
  gross numeric, sales numeric, margin numeric, qty numeric, returns numeric,
  lines bigint, receipts bigint
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $fn$
declare
  dims      text[]  := '{}';
  d         text;
  want_rcpt boolean := false;
  sel       text;
  grp       text;
  rc        text;
begin
  -- The table's own read policy, and nothing wider: 0120 gates
  -- retail_sale_lines on retail.sales.view, so this does too.
  if not retail_can('retail.sales.view') then return; end if;

  foreach d in array coalesce(p_by, array['branch_id']) loop
    if d = 'receipts' then want_rcpt := true; continue; end if;
    if d not in ('branch_id','sale_date','payment_method','salesperson','department','item_code') then
      raise exception 'retail_sales_agg: unknown dimension %', d
        using hint = 'allowed: branch_id, sale_date, payment_method, salesperson, department, item_code, and the flag receipts';
    end if;
    if not (d = any(dims)) then dims := dims || d; end if;
  end loop;
  if cardinality(dims) = 0 then dims := array['branch_id']; end if;

  -- Every dimension is always in the result shape; the ones not grouped on come
  -- back NULL. One row type for every caller, and a caller cannot read a column
  -- it did not group by and get a plausible-looking wrong answer.
  sel := format(
    '%s as branch_id, %s as sale_date, %s as payment_method, %s as salesperson, %s as department, %s as item_code',
    case when 'branch_id'      = any(dims) then 'sl.branch_id'      else 'null::bigint' end,
    case when 'sale_date'      = any(dims) then 'sl.sale_date'      else 'null::date'   end,
    case when 'payment_method' = any(dims) then 'sl.payment_method' else 'null::text'   end,
    case when 'salesperson'    = any(dims) then 'sl.salesperson'    else 'null::text'   end,
    case when 'department'     = any(dims) then 'sl.department'     else 'null::text'   end,
    case when 'item_code'      = any(dims) then 'sl.item_code'      else 'null::text'   end
  );
  grp := array_to_string(array(select 'sl.' || quote_ident(x) from unnest(dims) as x), ', ');

  -- When the count IS wanted, the branch is prefixed onto the key only where
  -- branch_id is not already a grouping key: inside a per-branch group no two
  -- branches can collide, so the prefix is 58,000 needlessly longer strings to
  -- sort. Without the branch in the grouping it is required, because two shops
  -- really can print the same receipt number on the same day.
  if want_rcpt then
    rc := 'count(distinct (' || case when 'branch_id' = any(dims)
            then $k$coalesce(nullif(sl.receipt_txn,''), nullif(sl.receipt_no,''), sl.id::text)$k$
            else $k$coalesce(sl.branch_id::text,'null') || '|' ||
                    coalesce(nullif(sl.receipt_txn,''), nullif(sl.receipt_no,''), sl.id::text)$k$
          end || '))::bigint';
  else
    rc := '0::bigint';
  end if;

  return query execute format($q$
    select %s,
           coalesce(sum(sl.sales), 0)::numeric         as gross,
           coalesce(sum(sl.sales_amount), 0)::numeric  as sales,
           coalesce(sum(sl.gross_margin), 0)::numeric  as margin,
           coalesce(sum(sl.quantity), 0)::numeric      as qty,
           -- Returns POSITIVE: the negative-quantity lines, which is how the
           -- cash book has always found them. It keeps them negative in its own
           -- column, so anything printing both must say which it is showing.
           coalesce(sum(case when coalesce(sl.quantity,0) < 0
                             then -sl.sales_amount else 0 end), 0)::numeric as returns,
           count(*)::bigint as lines,
           %s               as receipts
      from retail_sale_lines sl
     where ($1 is null or sl.sale_date >= $1)
       and ($2 is null or sl.sale_date <= $2)
       and ($3 is null or sl.branch_id = $3)
     group by %s
  $q$, sel, rc, grp) using p_from, p_to, p_branch;
end
$fn$;

revoke all on function retail_sales_agg(date, date, bigint, text[]) from public, anon;
grant execute on function retail_sales_agg(date, date, bigint, text[]) to authenticated;
