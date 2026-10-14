/* ════════════════════════════════════════════════════════════════════════════
   STOP SENDING WHOLE DATE RANGES TO THE BROWSER.

   The retail screens page the raw sale lines down to the phone or the laptop
   and add them up there. Measured on the live database: a 30-day range is
   13,360 lines, which is FOURTEEN sequential HTTPS round trips from Lahore, the
   first of them 1,076 ms because it walks the primary key from id 1 and throws
   away 44,943 rows before it reaches the range. The same question answered
   server-side is ONE call of ~300 ms returning 8 rows.

   Two things were missing before that could be done everywhere:

   1. The aggregate functions take ONE branch. "Top Shop" is six branches, so a
      Top Shop view had to fall back to reading lines. Fixed by a variant that
      takes an ARRAY of branch ids.

   2. Commissions could not be rolled up at all, because the slab bonus is
      computed per RECEIPT and an aggregate loses receipts. Fixed by moving the
      whole commission calculation into the database, bonus included.

   The commission function was checked against the browser's own arithmetic over
   all 58,303 lines before any screen was changed to use it: 783 shop-days each
   side, 0 differing cells, the same Rs 335,137 total.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── 1. THE SLAB BONUS, AS ONE FUNCTION ────────────────────────────────────
   A direct translation of commBonus() in components/retail/kit.tsx, which is
   itself a direct translation of the old Grohub app. It is written once, here,
   so the database and the browser cannot drift into paying different money.

   'exact' pays ONLY on an exact multiple of the slab. It looks like a bug and
   is not — it is a rule some shops run, and floor() would overpay them on every
   bill that lands between slabs.

   Negative totals (a day of net returns) floor to a negative bonus, which is
   what JavaScript's Math.floor does and therefore what the shops have always
   been paid. Do not "fix" it here alone. */
create or replace function public.retail_slab_bonus(
  p_total numeric, p_slab numeric, p_per numeric, p_mode text
) returns numeric
language sql immutable parallel safe as $$
  select case
    when coalesce(p_slab, 0) = 0 then 0
    when p_mode = 'exact' then
      case when p_total > 0 and mod(p_total, p_slab) = 0
           then (p_total / p_slab) * p_per else 0 end
    else floor(p_total / p_slab) * p_per
  end::numeric
$$;

/* ── 2. THE AGGREGATE, SCOPED TO A SHOP ────────────────────────────────────
   Identical to retail_sales_agg in every way except that it filters on a LIST
   of branch ids, so "Top Shop" (six branches) is one call instead of a fallback
   to reading 13,000 lines. retail_sales_agg itself is rewritten below to call
   this, so there is one implementation and not two that can disagree. */
create or replace function public.retail_sales_agg_m(
  p_from date default null,
  p_to date default null,
  p_branches bigint[] default null,
  p_by text[] default array['branch_id']
) returns table(
  branch_id bigint, sale_date date, payment_method text, salesperson text,
  department text, item_code text, gross numeric, sales numeric, margin numeric,
  qty numeric, returns numeric, lines bigint, receipts bigint
)
language plpgsql stable security definer set search_path = public as $$
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
      raise exception 'retail_sales_agg_m: unknown dimension %', d
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
       and ($3 is null or sl.branch_id = any($3))
     group by %s
  $q$, sel, rc, grp) using p_from, p_to, p_branches;
end
$$;

/* The single-branch signature stays exactly as it was — PostgREST's schema
   cache makes DROP FUNCTION unreliable on this project, and nothing needs
   dropping anyway. It now delegates, so there is one implementation. */
create or replace function public.retail_sales_agg(
  p_from date default null,
  p_to date default null,
  p_branch bigint default null,
  p_by text[] default array['branch_id']
) returns table(
  branch_id bigint, sale_date date, payment_method text, salesperson text,
  department text, item_code text, gross numeric, sales numeric, margin numeric,
  qty numeric, returns numeric, lines bigint, receipts bigint
)
language sql stable security definer set search_path = public as $$
  select * from public.retail_sales_agg_m(
    p_from, p_to,
    case when p_branch is null then null else array[p_branch] end,
    p_by);
$$;

/* ── 3. THE COMMISSION, COMPUTED WHERE THE DATA IS ─────────────────────────
   A line-for-line translation of the calculation in
   app/retail/commissions/page.tsx, which is itself the old app's commData().
   The three rules it has to preserve, in order:

     1. Per-piece is retail_price x percentage / 100 x quantity, from
        retail_commission_master. NEVER the `commission` column on that table —
        it is displayed in the rate list and has never been part of the payout.

     2. FC DHA is different and then STOPS. Its per-piece comes from the flat
        retail_fc_dha_comm rate sheet, and it earns NO bonus at all. In the
        JavaScript that is a bare `return`; here it is the `where branch <> dha`
        on the bonus base. An unlisted barcode earns zero rather than falling
        through to a Top Shop rate.

     3. The bonus is slabbed on SALES, so every line of a commissionable shop
        counts toward it — including lines whose item is not on the master at
        all. `bonus_basis` decides the rupee figure: 'receipt' slabs each bill
        and adds them up, 'day' slabs the shop's whole day once. A blank
        receipt_txn collapses the day into a single "receipt", exactly as the
        original does: with no receipt to slab on, the day IS the receipt.

   FC DHA is found by name, not by a hardcoded id. The old app had
   `const DHA_ID = 11`, which was its primary key in the old database; if that
   id ever lands on another shop, a hardcoded 11 silently pays that shop the DHA
   rate sheet and grants DHA a bonus it must never get. */
create or replace function public.retail_commission_calc(
  p_from date default null,
  p_to date default null,
  p_branches bigint[] default null
) returns table(branch_id bigint, sale_date date, per_piece numeric, bonus numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_dha   bigint;
  v_mode  text;
  v_basis text;
  v_slab  numeric;
  v_per   numeric;
begin
  if not retail_can('retail.commissions.view') then return; end if;

  select b.id into v_dha
    from retail_branches b
   where b.name ~* 'dha' or coalesce(b.code, '') ~* 'dha'
   order by b.id
   limit 1;

  select c.bonus_mode, c.bonus_basis, c.bonus_slab, c.bonus_per_slab
    into v_mode, v_basis, v_slab, v_per
    from retail_commission_config c where c.id = 1;

  /* Same fallbacks the screen uses when the config row is missing or blank. */
  v_mode  := coalesce(nullif(v_mode, ''),  'floor');
  v_basis := coalesce(nullif(v_basis, ''), 'receipt');
  v_slab  := coalesce(nullif(v_slab, 0),   5000);
  v_per   := coalesce(nullif(v_per, 0),    50);

  return query
  with l as (
    select sl.branch_id as bid, sl.sale_date as sd, sl.item_code as code,
           coalesce(sl.quantity, 0)     as qty,
           coalesce(sl.sales_amount, 0) as amt,
           coalesce(nullif(sl.receipt_txn, ''), '') as rcpt
      from retail_sale_lines sl
     where (p_from is null or sl.sale_date >= p_from)
       and (p_to   is null or sl.sale_date <= p_to)
       and (p_branches is null or sl.branch_id = any(p_branches))
  ),
  pp as (
    select l.bid, l.sd,
           sum(case
                 when v_dha is not null and l.bid = v_dha
                   then coalesce(fc.commission, 0) * l.qty
                 else coalesce(m.retail_price, 0) * coalesce(m.percentage, 0) / 100.0 * l.qty
               end)::numeric as per_piece
      from l
      /* item_code is the primary key of both rate tables, so neither join can
         fan a line out into two. */
      left join retail_fc_dha_comm fc
             on v_dha is not null and l.bid = v_dha and fc.item_code = l.code
      left join retail_commission_master m
             on (v_dha is null or l.bid <> v_dha) and m.item_code = l.code
     group by l.bid, l.sd
  ),
  base as (
    select l.bid, l.sd, l.rcpt, sum(l.amt) as amt
      from l
     where v_dha is null or l.bid <> v_dha   -- rule 2: DHA earns no bonus
     group by l.bid, l.sd, l.rcpt
  ),
  bon as (
    select b.bid, b.sd,
           case when v_basis = 'day'
                then retail_slab_bonus(sum(b.amt), v_slab, v_per, v_mode)
                else sum(retail_slab_bonus(b.amt, v_slab, v_per, v_mode))
           end::numeric as bonus
      from base b
     group by b.bid, b.sd
  )
  /* FULL JOIN because a day can have per-piece with no bonus (DHA, or a day
     under one slab) and in principle a bonus with no per-piece (every item sold
     was off the master). Dropping either side would under-pay somebody. */
  select coalesce(pp.bid, bon.bid)::bigint,
         coalesce(pp.sd,  bon.sd)::date,
         coalesce(pp.per_piece, 0)::numeric,
         coalesce(bon.bonus, 0)::numeric
    from pp
    full join bon on bon.bid = pp.bid and bon.sd = pp.sd;
end
$$;

revoke all on function public.retail_sales_agg_m(date, date, bigint[], text[]) from public, anon;
revoke all on function public.retail_commission_calc(date, date, bigint[]) from public, anon;
grant execute on function public.retail_sales_agg_m(date, date, bigint[], text[]) to authenticated;
grant execute on function public.retail_commission_calc(date, date, bigint[]) to authenticated;
grant execute on function public.retail_slab_bonus(numeric, numeric, numeric, text) to authenticated;
