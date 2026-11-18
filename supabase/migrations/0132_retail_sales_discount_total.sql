/* THE ONE FIGURE THE AGGREGATE CANNOT ANSWER.
 *
 * The Sales screen's second row of tiles asks four desk questions: items sold,
 * discounts given, lines read, shops that sold anything. Three of the four come
 * straight out of retail_sales_agg_m. Discounts do not — it has no discount
 * column.
 *
 * The obvious fix is to add one, and it is not available: changing a function's
 * return type needs DROP FUNCTION, and DROP FUNCTION hangs on this project
 * against PostgREST's schema-cache lock (it has now failed four times, on
 * retail_sales_agg, on an index, and twice here). So the figure gets its own
 * small function instead, asked for in the same Promise.all as the aggregate —
 * a second round trip that costs no wall-clock because it runs beside the first.
 *
 * Without this the tile would have read Rs 0 on a computer the moment the
 * screen stopped reading raw lines: a real number replaced by a plausible wrong
 * one, which is the failure this department keeps being audited for.
 */
create or replace function public.retail_sales_discount(
  p_from date default null,
  p_to date default null,
  p_branches bigint[] default null
) returns table(branch_id bigint, discount numeric)
language sql stable security definer set search_path = public as $$
  select sl.branch_id, coalesce(sum(sl.discount), 0)::numeric
    from retail_sale_lines sl
   where retail_can('retail.sales.view')
     and (p_from is null or sl.sale_date >= p_from)
     and (p_to   is null or sl.sale_date <= p_to)
     and (p_branches is null or sl.branch_id = any(p_branches))
   group by sl.branch_id;
$$;

revoke all on function public.retail_sales_discount(date, date, bigint[]) from public, anon;
grant execute on function public.retail_sales_discount(date, date, bigint[]) to authenticated;
