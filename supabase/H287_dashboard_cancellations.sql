/* ===========================================================================
   H287 — HUB DASHBOARD: CANCELLATIONS BY THE DAY SHOPIFY CANCELLED THEM
                                                                 (2 Oct 2026)

   The owner, 2 Oct: "yesterday and today's cancelled orders are not showing".
   They were all there. The five order cards file every order under the day it
   was PLACED, and most cancellations are older orders: on 2 Oct, 38 orders
   were cancelled in Shopify (23 never fulfilled, 15 after fulfilment) but only
   2 of them had been placed that day — so "Today" showed Cancelled 2.

   This adds the other question, without touching the five cards (they still
   add up to Total orders): of everything Shopify cancelled IN the chosen
   dates, how many were never fulfilled, how many after fulfilment, and how
   many had been placed before the period began.

   cancelled_at is turned into the Pakistan day — the same day the business
   lives in, and the same rule order_date already follows. (cancelled_at and
   status = 'Cancelled' agree on every order: 0 differ, 2 Oct.)

   Same dates, store and permission (hub.dashboard.view) as the rest of the
   dashboard. Create-only: nothing else in the database changes. Safe to run
   again. Hub tables only.
   ALREADY APPLIED on the live database (migration h287_dashboard_cancellations,
   2 Oct 2026; checked against this file).
=========================================================================== */

create or replace function hub_dashboard_cancellations(p_from date, p_to date, p_store text)
returns table(cancelled bigint, not_fulfilled bigint, fulfilled bigint, placed_earlier bigint)
language sql stable security definer set search_path to 'public' as $$
  with c as (
    select (o.cancelled_at at time zone 'Asia/Karachi')::date as cancel_day,
           o.order_date,
           upper(coalesce(o.fulfillment_status, '')) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') as f
      from online_orders o
     where o.cancelled_at is not null
       and (p_store is null or p_store = 'ALL' or o.store_code = p_store)
  )
  select count(*)::bigint,
         count(*) filter (where not f)::bigint,
         count(*) filter (where f)::bigint,
         count(*) filter (where p_from is not null and order_date < p_from)::bigint
    from c
   where (p_from is null or cancel_day >= p_from)
     and (p_to   is null or cancel_day <= p_to)
     and has_permission('hub.dashboard.view');
$$;
revoke all on function hub_dashboard_cancellations(date, date, text) from public, anon;
grant execute on function hub_dashboard_cancellations(date, date, text) to authenticated, service_role;
