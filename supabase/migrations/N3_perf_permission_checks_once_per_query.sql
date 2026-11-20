-- N3 (20 Nov 2026): PERMISSION CHECKS RUN ONCE PER QUERY, NOT ONCE PER ROW.
--
-- WHY THE HUB / SHOPS / LOGISTICS / EMPLOYEE SCREENS FETCH SLOWLY
--   Report functions filter with  `where has_permission('x')`  (or retail_can,
--   hub_is_boss, ...). Those helpers are SECURITY DEFINER, so Postgres cannot
--   inline them and runs the check — a 3-table lookup — for EVERY row it scans:
--   90k times for a Shops sales report, 25k for a Hub dashboard tile.
--
--   Measured on the live database, same query, same rows:
--     where retail_can('retail.sales.view')            1,312 ms
--     where (select retail_can('retail.sales.view'))      20 ms
--   retail_sales_discount (30 days, super admin): 5,063 ms before.
--
-- THE CHANGE
--   Every constant-argument call, e.g. has_permission('hub.dashboard.view'), is
--   wrapped as (select has_permission('hub.dashboard.view')). A scalar subquery
--   with no reference to the row becomes an InitPlan: evaluated once. Same
--   true/false, same rows returned — only the number of times it is asked.
--   A call that passes a column (per-row by design) is NOT touched. The helper
--   functions themselves are not touched.
--
--   Dry run: 181 of 369 public functions change. Single transaction: if any one
--   fails to recreate, nothing changes.
--
-- VERIFY AFTER APPLYING
--   Re-run the timing/md5 benchmark (see claude/ALL_DB_SPEED_N3.md): the hashes
--   must match the "before" values; only the milliseconds should drop.
do $mig$
declare r record; nd text; n int := 0;
begin
  for r in
    select p.oid, pg_get_functiondef(p.oid) d
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and l.lanname in ('sql','plpgsql')
       and p.proname not in ('retail_can','has_permission','hub_is_boss',
                             'hub_may_manage_staff','hub_rescue_may_see','hub_rescue_may_work')
  loop
    nd := regexp_replace(r.d,
      $re$(?<![a-z_.])(?<!select\s)(retail_can|has_permission|hub_is_boss|hub_may_manage_staff|hub_rescue_may_see|hub_rescue_may_work)\s*\(\s*((?:'[a-z0-9_.]*'(?:::text)?\s*,?\s*)*)\)$re$,
      '(select \1(\2))', 'gi');
    if nd <> r.d then
      execute nd;
      n := n + 1;
    end if;
  end loop;
  raise notice 'rewrote % functions', n;
end
$mig$;

-- The courier syncs ask every 10 minutes for "this courier's live parcels, least
-- recently checked first". With only a single-column courier index that read the
-- whole table each time (22k calls, ~130 ms each), competing with staff page
-- loads for the same CPU. This index serves it directly, in order.
create index if not exists online_logistics_courier_sync_idx
  on public.online_logistics (courier, updated_at nulls first)
  where tracking_id is not null;

analyze public.online_logistics;
analyze public.online_orders;
analyze public.retail_sale_lines;
