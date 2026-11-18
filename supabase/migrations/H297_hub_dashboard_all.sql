-- H297 — Hub dashboard in one call + Shopify sales block (21 Oct 2026)
-- Reads online_orders and online_logistics only (Hub). Touches no shared table.
-- Create-only: the four old functions stay, so a page still calling them keeps working.

create index if not exists online_orders_cancelled_at_idx
  on public.online_orders (cancelled_at) where cancelled_at is not null;

create or replace function public.hub_dashboard_all(p_from date, p_to date, p_store text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v jsonb;
begin
  if not coalesce(has_permission('hub.dashboard.view'), false) then
    return null;
  end if;

  with s as materialized (
    select * from hub_order_states(p_from, p_to, p_store)
  ),
  o as materialized (
    select x.store_code,
           coalesce(x.amount, 0)                                   as amount,
           coalesce(x.subtotal, 0)                                 as subtotal,
           coalesce(x.discount_total, 0)                           as discount,
           coalesce(x.shipping_total, 0)                           as shipping,
           coalesce(x.tax_total, 0)                                as tax,
           coalesce(x.refunded_amount, 0)                          as refunded,
           coalesce(x.item_count, 0)                               as items,
           upper(coalesce(x.financial_status, ''))                 as fin,
           (x.cancelled_at is not null or x.status = 'Cancelled')  as c,
           upper(coalesce(x.fulfillment_status, '')) in ('FULFILLED','PARTIAL','PARTIALLY_FULFILLED') as f
      from online_orders x
     where (p_from  is null or x.order_date >= p_from)
       and (p_to    is null or x.order_date <= p_to)
       and (p_store is null or p_store = 'ALL' or x.store_code = p_store)
  ),
  cx as (
    select (x.cancelled_at at time zone 'Asia/Karachi')::date as cancel_day,
           x.order_date,
           upper(coalesce(x.fulfillment_status, '')) in ('FULFILLED','PARTIAL','PARTIALLY_FULFILLED') as f
      from online_orders x
     where x.cancelled_at is not null
       and (p_from is null or x.cancelled_at >= (p_from::timestamp at time zone 'Asia/Karachi'))
       and (p_to   is null or x.cancelled_at <  ((p_to + 1)::timestamp at time zone 'Asia/Karachi'))
       and (p_store is null or p_store = 'ALL' or x.store_code = p_store)
  )
  select jsonb_build_object(

    /* = hub_dashboard_summary */
    'summary', (select jsonb_build_object(
        'total_orders',     count(*),
        'pending',          count(*) filter (where state = 'pending'),
        'returned_cancel',  count(*) filter (where state in ('returned','cancelled')),
        'delivered',        count(*) filter (where state in ('delivered_paid','delivered_unpaid')),
        'in_transit',       count(*) filter (where state = 'in_transit'),
        'order_value',      coalesce(sum(amount) filter (where state <> 'cancelled'), 0),
        'avg_order',        case when count(*) filter (where state <> 'cancelled') > 0
                                 then round(sum(amount) filter (where state <> 'cancelled')
                                            / count(*) filter (where state <> 'cancelled'), 0) else 0 end,
        'delivery_rate',    case when count(*) filter (where state in ('delivered_paid','delivered_unpaid','returned')) > 0
                                 then round(count(*) filter (where state in ('delivered_paid','delivered_unpaid'))::numeric * 100
                                            / count(*) filter (where state in ('delivered_paid','delivered_unpaid','returned')), 1) else 0 end,
        'cod_received',     coalesce(sum(cod_in), 0),
        'cod_receivable',   coalesce(sum(cod_out), 0),
        'receivable_count', count(*) filter (where owes_money)
      ) from s),

    /* = hub_dashboard_breakdown */
    'stores', (select coalesce(jsonb_agg(to_jsonb(x) order by x.is_total, x.store_code), '[]'::jsonb) from (
       select coalesce(store_code, 'ALL') as store_code,
              (grouping(store_code) = 1) as is_total,
              count(*) as orders,
              count(*) filter (where state <> 'cancelled') as sale_orders,
              coalesce(sum(amount) filter (where state <> 'cancelled'), 0) as sale_value,
              count(*) filter (where state = 'pending') as pending_n,
              coalesce(sum(amount) filter (where state = 'pending'), 0) as pending_v,
              count(*) filter (where state in ('in_transit','delivered_paid','delivered_unpaid','returned')) as dispatched_n,
              coalesce(sum(amount) filter (where state in ('in_transit','delivered_paid','delivered_unpaid','returned')), 0) as dispatched_v,
              count(*) filter (where state = 'in_transit') as transit_n,
              coalesce(sum(amount) filter (where state = 'in_transit'), 0) as transit_v,
              count(*) filter (where state = 'delivered_paid') as paid_n,
              coalesce(sum(amount) filter (where state = 'delivered_paid'), 0) as paid_v,
              count(*) filter (where state = 'delivered_unpaid') as unpaid_n,
              coalesce(sum(amount) filter (where state = 'delivered_unpaid'), 0) as unpaid_v,
              count(*) filter (where state = 'returned') as returned_n,
              coalesce(sum(amount) filter (where state = 'returned'), 0) as returned_v,
              count(*) filter (where state = 'cancelled') as cancelled_n,
              coalesce(sum(amount) filter (where state = 'cancelled'), 0) as cancelled_v,
              case when count(*) filter (where state in ('delivered_paid','delivered_unpaid','returned')) > 0
                   then round(count(*) filter (where state in ('delivered_paid','delivered_unpaid'))::numeric * 100
                              / count(*) filter (where state in ('delivered_paid','delivered_unpaid','returned')), 1)
              end as delivery_rate
         from s group by grouping sets ((store_code), ())
    ) x),

    'couriers', (select coalesce(jsonb_agg(to_jsonb(c) order by c.dispatched desc), '[]'::jsonb) from (
       select coalesce(courier, '—') as courier,
              count(*) as dispatched,
              count(*) filter (where state in ('delivered_paid','delivered_unpaid')) as delivered,
              count(*) filter (where state = 'returned') as returned
         from s where state in ('in_transit','delivered_paid','delivered_unpaid','returned')
        group by 1
    ) c),

    'cities', (select coalesce(jsonb_agg(jsonb_build_object('label', label, 'value', value)
                                         order by (label = 'Others'), value desc), '[]'::jsonb) from (
       select case when rk <= 5 then label else 'Others' end as label, sum(n)::bigint as value
         from (select initcap(lower(coalesce(city, 'Unknown'))) as label, count(*) as n,
                      row_number() over (order by count(*) desc) as rk
                 from s group by 1) t
        group by 1
    ) cc),

    /* = hub_dashboard_counts */
    'counts', (select jsonb_build_object(
        'total_orders',          count(*),
        'pending',               count(*) filter (where not c and not f),
        'dispatched',            count(*) filter (where not c and f),
        'returned',              count(*) filter (where c and f),
        'cancelled_unfulfilled', count(*) filter (where c and not f),
        'cancelled_all',         count(*) filter (where c)
      ) from o),

    /* = hub_dashboard_cancellations (by the day Shopify cancelled) */
    'cancellations', (select jsonb_build_object(
        'cancelled',      count(*),
        'not_fulfilled',  count(*) filter (where not f),
        'fulfilled',      count(*) filter (where f),
        'placed_earlier', count(*) filter (where p_from is not null and order_date < p_from)
      ) from cx),

    /* NEW — Shopify sales, one row per store + ALL, every order under the day it was placed.
       Same four buckets as the cards: pending + dispatched + returned + cancelled = orders.
       gross = product value before discounts (subtotal + discount); total = what the customer
       was charged (amount = subtotal + shipping); net = total of orders not returned/cancelled. */
    'shopify', (select coalesce(jsonb_agg(to_jsonb(y) order by y.is_total, y.store_code), '[]'::jsonb) from (
       select coalesce(store_code, 'ALL')                                      as store_code,
              (grouping(store_code) = 1)                                       as is_total,
              count(*)                                                         as orders,
              coalesce(sum(subtotal + discount), 0)                            as gross_sales,
              coalesce(sum(discount), 0)                                       as discounts,
              coalesce(sum(shipping), 0)                                       as shipping,
              coalesce(sum(tax), 0)                                            as taxes,
              coalesce(sum(amount), 0)                                         as total_sales,
              count(*) filter (where not c and not f)                          as pending_n,
              coalesce(sum(amount) filter (where not c and not f), 0)          as pending_v,
              count(*) filter (where not c and f)                              as dispatched_n,
              coalesce(sum(amount) filter (where not c and f), 0)              as dispatched_v,
              count(*) filter (where c and f)                                  as returned_n,
              coalesce(sum(amount) filter (where c and f), 0)                  as returned_v,
              count(*) filter (where c and not f)                              as cancelled_n,
              coalesce(sum(amount) filter (where c and not f), 0)              as cancelled_v,
              coalesce(sum(amount) filter (where not c), 0)                    as net_sales,
              count(*) filter (where not c)                                    as net_orders,
              case when count(*) filter (where not c) > 0
                   then round(sum(amount) filter (where not c) / count(*) filter (where not c), 0) else 0 end as avg_order,
              coalesce(sum(items), 0)                                          as items_ordered,
              coalesce(sum(items) filter (where not c), 0)                     as items_net,
              count(*) filter (where fin = 'PAID')                             as paid_n,
              coalesce(sum(amount) filter (where fin = 'PAID'), 0)             as paid_v,
              coalesce(sum(refunded), 0)                                       as refunds,
              case when count(*) filter (where f) > 0
                   then round(count(*) filter (where c and f)::numeric * 100 / count(*) filter (where f), 1) end as return_rate,
              case when count(*) > 0
                   then round(count(*) filter (where c and not f)::numeric * 100 / count(*), 1) end as cancel_rate
         from o group by grouping sets ((store_code), ())
    ) y)
  ) into v;

  return v;
end;
$function$;

revoke all on function public.hub_dashboard_all(date, date, text) from public, anon;
grant execute on function public.hub_dashboard_all(date, date, text) to authenticated, service_role;
