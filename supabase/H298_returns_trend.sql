-- =============================================================================
-- H298 — RETURNS MONTH BY MONTH, PostEx and OwnEx (22 Oct 2026). Hub only.
-- The owner: "a graph of the returns from PostEx and OwnEx by dates, so he can
-- compare the returns of any month with any month — are returns managed or not."
--
-- hub_returns_trend(p_months) — one row per month per courier, by the month
-- the parcel was SENT (dispatch_date), so a month is compared with a month on
-- the same parcels:
--   sent       booked and sent out (cancelled / never booked left out)
--   delivered  delivered
--   returned   returned, or on its way back (RTS)
--   moving     still out there — the month has not finished settling
--   failed     failed at least once (it reached the Delivery Under Review desk)
--   saved      of those, delivered in the end
--   lost       of those, came back
-- The screen works out the return rate as returned / (delivered + returned).
-- Open to whoever may see the desk (hub_rescue_may_see).
-- =============================================================================
create or replace function public.hub_returns_trend(p_months integer default 13)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_to   date := date_trunc('month', (now() at time zone 'Asia/Karachi')::date)::date;
  v_n    integer := greatest(1, least(coalesce(p_months, 13), 36));
  v_from date;
begin
  if not coalesce(hub_rescue_may_see(), false) then
    return jsonb_build_object('ok', false, 'error', 'This is not open to you.');
  end if;
  v_from := (v_to - make_interval(months => v_n - 1))::date;
  return (
    with m as (
      select generate_series(v_from, v_to, interval '1 month')::date as month
    ),
    c as (select unnest(array['PostEx', 'OwnEx']) as courier),
    l as (
      select date_trunc('month', l.dispatch_date)::date as month, l.courier, l.tracking_id,
             case when l.delivery_status = 'Delivered' then 'delivered'
                  when l.delivery_status in ('Returned', 'RTS') then 'returned'
                  when lower(coalesce(l.delivery_status, '')) like 'cancel%'
                       or l.delivery_status = 'Unbooked' then 'cancelled'
                  else 'moving' end as state
        from online_logistics l
       where l.courier in ('PostEx', 'OwnEx')
         and l.dispatch_date >= v_from
         and l.dispatch_date < (v_to + interval '1 month')
    ),
    agg as (
      select l.month, l.courier,
             count(*) filter (where l.state <> 'cancelled')                       as sent,
             count(*) filter (where l.state = 'delivered')                        as delivered,
             count(*) filter (where l.state = 'returned')                         as returned,
             count(*) filter (where l.state = 'moving')                           as moving,
             count(r.tracking_id) filter (where l.state <> 'cancelled')           as failed,
             count(r.tracking_id) filter (where l.state = 'delivered')            as saved,
             count(r.tracking_id) filter (where l.state = 'returned')             as lost
        from l left join online_rescue_cases r on r.tracking_id = l.tracking_id
       group by 1, 2
    )
    select jsonb_build_object(
      'ok', true,
      'from', to_char(v_from, 'YYYY-MM'), 'to', to_char(v_to, 'YYYY-MM'),
      'today', to_char((now() at time zone 'Asia/Karachi')::date, 'YYYY-MM-DD'),
      'rows', coalesce(jsonb_agg(jsonb_build_object(
                 'month', to_char(m.month, 'YYYY-MM'), 'courier', c.courier,
                 'sent', coalesce(a.sent, 0), 'delivered', coalesce(a.delivered, 0),
                 'returned', coalesce(a.returned, 0), 'moving', coalesce(a.moving, 0),
                 'failed', coalesce(a.failed, 0), 'saved', coalesce(a.saved, 0), 'lost', coalesce(a.lost, 0))
               order by m.month, c.courier), '[]'::jsonb))
      from m cross join c
      left join agg a on a.month = m.month and a.courier = c.courier
  );
end;
$function$;

revoke all on function public.hub_returns_trend(integer) from public, anon;
grant execute on function public.hub_returns_trend(integer) to authenticated, service_role;
