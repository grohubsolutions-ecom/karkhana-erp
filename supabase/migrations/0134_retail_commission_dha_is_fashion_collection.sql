-- TOP SHOP DHA WAS BEING PAID FASHION COLLECTION'S RATE SHEET, AND EARNED Rs 0.
--
-- retail_commission_calc picked the flat-rate shop like this:
--
--     select b.id into v_dha
--       from retail_branches b
--      where b.name ~* 'dha' or coalesce(b.code,'') ~* 'dha'
--      order by b.id
--      limit 1;
--
-- That was right while Fashion Collection DHA was the only shop in the company
-- with DHA in its name. Two now match:
--
--     id  6   Top Shop DHA             TS_DHA   chain Topshop
--     id 11   Fashion Collection DHA   FC_DHA   chain Fashion Collection
--
-- and `order by b.id limit 1` returns 6. So every Top Shop DHA line was priced
-- off retail_fc_dha_comm, which is Fashion Collection's barcode sheet. Measured
-- on the live table for 1-20 October: 743 Top Shop DHA lines, **0** of them on
-- that sheet, 355 of them on the master. An unlisted barcode earns exactly 0 by
-- design, and the same v_dha also bars the shop from the bonus.
--
-- Since 1 July, on Rs 2,529,798 of sales across 3,197 lines, Top Shop DHA has
-- been shown:
--
--     per-piece owed   Rs 59,431
--     bonus owed       Rs  5,500
--     total owed       Rs 64,931        shown on the Commissions grid: Rs 0
--
-- THE FIX. The flat per-barcode sheet is Fashion Collection's agreement, so the
-- shop has to be BOTH named DHA and a Fashion Collection shop. Three ways of
-- being Fashion Collection are accepted — the chain, the name, or an FC_ code
-- prefix — so one missing `chain` value cannot lose the shop and hand the sheet
-- to a Top Shop again.
--
-- Nothing else in the function changes. Matching rule in the app:
-- lib/retailStale.ts -> findDhaBranch().

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

  -- Named DHA *and* Fashion Collection. A Top Shop that happens to be in DHA is
  -- a Top Shop, and is paid the master percentage like the other five.
  select b.id into v_dha
    from retail_branches b
   where (b.name ~* 'dha' or coalesce(b.code, '') ~* 'dha')
     and (coalesce(b.chain, '') ~* 'fashion'
          or b.name ~* 'fashion'
          or coalesce(b.code, '') ~* '^fc[[:space:]_-]')
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

revoke all on function public.retail_commission_calc(date, date, bigint[]) from public, anon;
grant execute on function public.retail_commission_calc(date, date, bigint[]) to authenticated;
