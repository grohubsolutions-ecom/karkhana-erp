-- H316 (14 Nov 2026): Shopify's "Total sales breakdown" card for the Hub dashboard.
-- One row, same lines as Shopify. Free-shipping discounts are taken off shipping,
-- not off products, exactly as Shopify does — otherwise TopShop's Rs 3,600 of
-- free shipping showed as Rs 3,600 of product discounts and Gross never matched.
--   ship_disc   = part of discount_total that cancelled the shipping fee
--   Gross sales = subtotal + product discounts
--   Sales reversals = product value of cancelled orders (before or after fulfilment)
--   Net sales   = Gross − Discounts − Sales reversals
--   Shipping    = shipping actually charged, less shipping on cancelled orders
--   Taxes       = whatever is left of amount (0 on these stores today)
--   Total sales = Net + Shipping + Return fees + Taxes
create or replace function public.hub_sales_breakdown(
  p_from date default null, p_to date default null, p_store text default null)
returns table(gross_sales numeric, discounts numeric, sales_reversals numeric,
              net_sales numeric, shipping_charges numeric, return_fees numeric,
              taxes numeric, total_sales numeric, order_count bigint)
language sql stable security definer set search_path to 'public'
as $$
  with o as (
    select coalesce(subtotal,0) as sub, coalesce(discount_total,0) as disc,
           coalesce(shipping_total,0) as ship, coalesce(amount,0) as amt,
           cancelled_at is not null as cancelled
    from online_orders
    where (p_from is null or order_date >= p_from)
      and (p_to   is null or order_date <= p_to)
      and (p_store is null or p_store = 'ALL' or store_code = p_store)
  ), x as (
    select *, greatest(0, least(disc, ship, sub + ship - amt)) as ship_disc from o
  ), y as (
    select *, disc - ship_disc as prod_disc, ship - ship_disc as ship_net,
           greatest(0, amt - sub - (ship - ship_disc)) as tax
    from x
  ), t as (
    select sum(sub + prod_disc) as gross, sum(prod_disc) as d,
           sum(sub) filter (where cancelled) as rev,
           sum(ship_net) filter (where not cancelled) as shp,
           sum(tax) filter (where not cancelled) as tx,
           count(*) as n
    from y
  )
  select coalesce(gross,0), coalesce(d,0), coalesce(rev,0),
         coalesce(gross,0) - coalesce(d,0) - coalesce(rev,0),
         coalesce(shp,0), 0::numeric, coalesce(tx,0),
         coalesce(gross,0) - coalesce(d,0) - coalesce(rev,0) + coalesce(shp,0) + coalesce(tx,0),
         coalesce(n,0)
  from t
  where has_permission('hub.dashboard.view');
$$;

grant execute on function public.hub_sales_breakdown(date, date, text) to authenticated;
