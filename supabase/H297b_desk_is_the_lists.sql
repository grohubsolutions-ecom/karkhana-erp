-- =============================================================================
-- H297b — DELIVERY UNDER REVIEW = THE COURIERS' OWN LISTS  (part 2 of 2)
-- 21 Oct 2026 · Hub only. Applied after courier-review-queue had made its first
-- good read of both lists (PostEx 11, OwnEx 7 on 22 Oct morning), so the desk
-- is never empty on the switch.
--
--   hub_rescue_desk__impl()      REWRITTEN IN FULL
--     Today  = exactly the parcels on the latest good read of PostEx's
--              "Delivery Under Review" and OwnEx's "Shipper Advice" — nothing
--              from our own status column. A parcel already decided but still
--              listed by the courier stays, marked as decided (the courier's
--              list is the truth; the mark says why it is still there).
--     Follow-up (new) = parcels WE re-attempted — here or on the courier's
--              portal — that are on no list, not delivered and not coming
--              back: the ones to ring again.
--     History = every failed try as before, plus every "re-attempt again".
--     Each row also carries its days on the courier's list, its tries, how
--     many times it has been sent out, our re-attempts and their log.
--   hub_rescue_decide()          REWRITTEN IN FULL — the three-times rule now
--                                counts every time it was sent out (ours and
--                                the courier's), not only the courier's count
--   hub_rescue_refresh_courier() REWRITTEN IN FULL — Refresh reads the lists too
--   cron sync_review_queue       the lists, every 10 minutes
-- =============================================================================

create or replace function public.hub_rescue_desk__impl(p_view text, p_from date, p_to date)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
/* THE DELIVERY UNDER REVIEW DESK (H280-H283, rebuilt H297 on 21 Oct 2026).

   TODAY IS THE COURIERS' OWN LISTS. Before H297 it was every parcel whose
   status in OUR table looked like a failure — 26 on 21 Oct, against 4 on
   PostEx's Under Review and 5 on OwnEx's Shipper Advice. Now `on_desk` is
   "on the latest good read of its courier's list" (hub_review_queue_now), and
   nothing else.

   A parcel stays on the desk for as long as the courier lists it, decided or
   not; a decided one carries its decision, so it is clear why it is still
   there (PostEx can keep a parcel listed for hours after Return is pressed).

   FOLLOW-UP: parcels we re-attempted (decided here, pressed on the courier's
   portal by our agent, or "re-attempt again") that are on no list now, not
   delivered and not on their way back — the ones to ring again a day or two
   later. HISTORY: every failed try, plus every "re-attempt again". */
with k as (
  select (now() at time zone 'Asia/Karachi')::date as today,
         lower(coalesce(p_view, 'today')) = 'history' as hist
),
rng as (
  select coalesce(p_from, k.today - 6) as d_from, coalesce(p_to, k.today) as d_to from k
),
q as (select * from hub_review_queue_now()),
b as (
  select c.*,
         l.raw_status, l.delivery_status, l.cod_amount, l.dispatch_date, l.return_leg_started_at,
         nullif(btrim(coalesce(l.courier_reason_text, '')), '') as courier_reason,
         coalesce(hub_is_failed_attempt(l.raw_status), false) as under_review,
         (q.tracking_id is not null) as in_queue,
         q.status as q_status, q.reason as q_reason, q.at as q_at, q.read_at as q_read_at
    from online_rescue_cases c
    left join online_logistics l on l.tracking_id = c.tracking_id
    left join q on q.tracking_id = c.tracking_id
),
d as (
  select b.*, b.in_queue as on_desk from b
),
items as (
  /* today: the couriers' lists, one line per parcel, on the try it is on */
  select 'desk'::text as src, d.tracking_id, d.attempts as attempt_no, false as earlier,
         d.last_failed_at as failed_at,
         null::uuid as row_done_by, null::timestamptz as row_done_at, 'desk'::text as left_as,
         null::text as a_customer_said, null::text as a_rider_said, null::text as a_rider_phone,
         null::text as a_verdict, null::text as a_decision, null::text as a_reason,
         null::text as a_return_reason, null::text as a_decided_via, null::text as a_advice_by,
         null::bigint as again_id, null::text as again_note, null::text as again_by_name
    from d, k
   where not k.hist and d.on_desk
  union all
  /* History: every failed try and how it left — except one on a list now */
  select x.* from (
    select 'hist'::text as src, d.tracking_id, a.attempt_no, a.attempt_no < d.attempts as earlier,
           case when a.attempt_no = d.attempts
                then coalesce(d.last_failed_at, a.review_at, a.failed_at)
                else coalesce(a.review_at, a.failed_at) end as failed_at,
           coalesce(a.done_by, case when a.attempt_no = d.attempts and a.done_at is not null then d.done_by end) as row_done_by,
           a.done_at as row_done_at,
           case
             when a.done_at is not null or (a.attempt_no = d.attempts and d.status = 'done' and d.outcome is null) then
               case coalesce(case when a.attempt_no = d.attempts then d.decision end, a.decision)
                 when 'reattempt' then 'reattempt' when 'return' then 'return' else 'done' end
             when a.attempt_no < d.attempts       then 'failed_again'
             when d.outcome = 'delivered'         then 'delivered'
             when d.outcome = 'returned'          then 'returned'
             /* still a failure at the courier, but on neither review list —
                PostEx "Attempted", OwnEx "Verifying Reason": nothing to decide */
             when d.under_review                  then 'not_worked'
             when upper(btrim(coalesce(d.raw_status, ''))) in
                  ('OUT FOR DELIVERY', 'READY FOR RE-ATTEMPT', 'READY FOR DELIVERY', 'DELIVERY EN-ROUTE')
                                                  then 'out_again'
             when d.raw_status ilike 'return%' or d.raw_status ilike 'en-route to lahore%'
                                                  then 'coming_back'
             else 'moved' end as left_as,
           a.customer_said, a.rider_said, a.rider_phone, a.verdict, a.decision, a.reason,
           a.return_reason, a.decided_via, a.advice_by,
           null::bigint as again_id, null::text as again_note, null::text as again_by_name
      from d
      join online_delivery_attempts a on a.tracking_id = d.tracking_id
      cross join k
     where k.hist
       and not (d.on_desk and a.attempt_no = d.attempts)
  ) x cross join rng
  where (x.failed_at at time zone 'Asia/Karachi')::date between rng.d_from and rng.d_to
  union all
  /* History: our own "re-attempt again", made when the parcel was on no list */
  select 'again', d.tracking_id, coalesce(r.try_no, d.attempts), coalesce(r.try_no, d.attempts) < d.attempts,
         r.at, r.by_user, r.at, 'again',
         null, null, null, null, null, null, null, null, null,
         r.id, r.note, r.by_name
    from online_rescue_reattempts r
    join d on d.tracking_id = r.tracking_id
    cross join k cross join rng
   where k.hist and r.undone_at is null
     and (r.at at time zone 'Asia/Karachi')::date between rng.d_from and rng.d_to
),
/* FOLLOW-UP candidates, the cheap tests first */
fc as (
  select d.tracking_id, d.attempts, d.last_failed_at, d.decision, d.decided_via, d.courier_advice_by
    from d, k
   where not k.hist and not d.on_desk
     and d.outcome is null and d.status = 'done'
     and hub_rescue_again_block(d.status, d.decision, d.outcome, d.delivery_status, d.raw_status,
                                d.return_leg_started_at, d.in_queue, 0) is null
     and (coalesce(d.decided_at, d.closed_at, d.last_failed_at) > now() - interval '20 days'
          or exists (select 1 from online_rescue_reattempts r
                      where r.tracking_id = d.tracking_id and r.undone_at is null
                        and r.at > now() - interval '20 days'))
),
fu as (
  select fc.tracking_id, t.last_ours_at,
         exists (select 1 from online_rescue_reattempts r
                  where r.tracking_id = fc.tracking_id and r.undone_at is null
                    and r.at >= coalesce((select a.failed_at from online_delivery_attempts a
                                           where a.tracking_id = fc.tracking_id and a.attempt_no = fc.attempts),
                                         fc.last_failed_at, '-infinity'::timestamptz)) as again_after,
         (fc.decision = 'reattempt'
          and (fc.decided_via = 'desk' or (fc.decided_via = 'courier' and fc.courier_advice_by = 'merchant'))) as cur_ours
    from fc cross join lateral hub_rescue_tries(fc.tracking_id) t
   where t.last_ours_at > now() - interval '20 days'
),
fitems as (
  select 'follow'::text as src, d.tracking_id, d.attempts as attempt_no, false as earlier,
         d.last_failed_at as failed_at,
         null::uuid as row_done_by, fu.last_ours_at as row_done_at,
         case when fu.again_after then 'again' else 'reattempt' end as left_as,
         null::text as a_customer_said, null::text as a_rider_said, null::text as a_rider_phone,
         null::text as a_verdict, null::text as a_decision, null::text as a_reason,
         null::text as a_return_reason, null::text as a_decided_via, null::text as a_advice_by,
         null::bigint as again_id, null::text as again_note, null::text as again_by_name
    from fu join d on d.tracking_id = fu.tracking_id
   where fu.again_after or fu.cur_ours
),
all_items as (
  select * from items
  union all
  select * from fitems
),
/* once per parcel: its tries, times out, our re-attempts, its days on a list */
pt as (
  select x.tracking_id, t.tries, t.sent_out, t.ours, t.again, t.by_courier, t.last_ours_at, t.log,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'day', to_char(qd.day, 'YYYY-MM-DD'), 'courier', qd.courier, 'status', qd.status,
                    'first', qd.first_seen_at, 'last', qd.last_seen_at) order by qd.day desc), '[]'::jsonb)
            from online_review_queue_days qd where qd.tracking_id = x.tracking_id) as queue_days
    from (select distinct tracking_id from all_items) x
    cross join lateral hub_rescue_tries(x.tracking_id) t
),
v as (
  select c.tracking_id, c.order_number, c.store_code, c.verdict, c.rider_phone, c.updated_at as seen_at
    from online_rescue_cases c where c.verdict is not null
  union all
  select a.tracking_id, c.order_number, c.store_code, a.verdict, a.rider_phone,
         coalesce(a.done_at, a.review_at, a.failed_at)
    from online_delivery_attempts a join online_rescue_cases c on c.tracking_id = a.tracking_id
   where a.verdict is not null
),
rows as (
  select
    case when i.src = 'again'  then i.tracking_id || ':again:' || i.again_id
         when i.src = 'follow' then i.tracking_id || ':follow'
         else i.tracking_id || ':' || i.attempt_no end                       as row_key,
    i.src, i.attempt_no, i.left_as, i.failed_at,
    to_char(i.failed_at at time zone 'Asia/Karachi', 'YYYY-MM-DD')            as day,
    i.row_done_at                                                              as done_at,
    coalesce(u.full_name, i.again_by_name)                                     as done_by_name,
    d.tracking_id, d.courier, d.order_number, d.store_code,
    d.attempts, d.last_failed_at, d.opened_at,
    case when i.earlier then i.a_rider_phone   else d.rider_phone   end      as rider_phone,
    case when i.earlier then null              else d.rider_name    end      as rider_name,
    case when i.earlier then (case when i.a_customer_said is not null then i.failed_at end)
                        else d.customer_called_at end                        as customer_called_at,
    case when i.earlier then i.a_customer_said else d.customer_said end      as customer_said,
    case when i.earlier then (case when i.a_rider_said is not null then i.failed_at end)
                        else d.rider_called_at end                           as rider_called_at,
    case when i.earlier then i.a_rider_said    else d.rider_said    end      as rider_said,
    case when i.earlier then i.a_verdict       else d.verdict       end      as verdict,
    case when i.earlier then i.a_decision      else d.decision      end      as decision,
    case when i.earlier then i.a_return_reason else d.return_reason end      as return_reason,
    case when i.earlier then i.a_decided_via   else d.decided_via   end      as decided_via,
    case when i.earlier then null              else d.decided_at    end      as decided_at,
    case when i.earlier then null              else d.courier_advice end     as courier_advice,
    case when i.earlier then null              else d.courier_advice_at end  as courier_advice_at,
    case when i.earlier then i.a_advice_by     else d.courier_advice_by end  as courier_advice_by,
    d.courier_attempts, d.courier_attempt_at, d.courier_checked_at,
    d.note, d.status, d.outcome, d.closed_at,
    d.cod_amount, d.dispatch_date, d.raw_status, d.delivery_status,
    case when i.earlier then i.a_reason
         else coalesce(d.courier_reason,
                (select a.reason from online_delivery_attempts a
                  where a.tracking_id = d.tracking_id and a.reason is not null
                  order by a.attempt_no desc limit 1),
                d.q_reason) end                                              as reason,
    o.customer_name, coalesce(o.phone_e164, o.phone) as phone, o.city, o.address,
    round(extract(epoch from (now() - d.last_failed_at)) / 3600.0, 1)        as waiting_hours,
    (select count(distinct v.order_number) from v
       join online_orders o2
         on o2.order_number = v.order_number and o2.store_code is not distinct from v.store_code
      where v.verdict = 'customer'
        and v.tracking_id <> d.tracking_id
        and v.seen_at > now() - interval '12 months'
        and hub_normalise_phone(coalesce(o.phone_e164, o.phone)) is not null
        and hub_normalise_phone(coalesce(o2.phone_e164, o2.phone))
            = hub_normalise_phone(coalesce(o.phone_e164, o.phone)))           as past_refusals,
    (select count(*) from v
      where v.verdict = 'rider'
        and v.tracking_id <> d.tracking_id
        and v.seen_at > now() - interval '12 months'
        and hub_normalise_phone(case when i.earlier then i.a_rider_phone else d.rider_phone end) is not null
        and hub_normalise_phone(v.rider_phone)
            = hub_normalise_phone(case when i.earlier then i.a_rider_phone else d.rider_phone end)) as rider_strikes,
    /* H297: the courier's list, and our own count */
    d.in_queue, d.q_status, d.q_reason, d.q_at, d.q_read_at,
    pt.queue_days,
    pt.tries, pt.sent_out, pt.ours as our_reattempts, pt.again as again_count,
    pt.by_courier as courier_reattempts, pt.last_ours_at, pt.log as reattempt_log,
    (pt.sent_out < 3 and d.outcome is null)                                  as can_reattempt,
    hub_rescue_again_block(d.status, d.decision, d.outcome, d.delivery_status, d.raw_status,
                           d.return_leg_started_at, d.in_queue, pt.sent_out) as again_block,
    i.again_id, i.again_note
  from all_items i
  join d on d.tracking_id = i.tracking_id
  join pt on pt.tracking_id = i.tracking_id
  left join online_orders o
         on o.order_number = d.order_number
        and o.store_code is not distinct from d.store_code
  left join app_users u on u.id = i.row_done_by
),
/* each courier's list: when it was last read well, and how the last try went */
lst as (
  select cr.courier,
         (select r.taken_at from online_review_queue_runs r
           where r.courier = cr.courier and r.ok order by r.taken_at desc limit 1) as read_at,
         (select r.n from online_review_queue_runs r
           where r.courier = cr.courier and r.ok order by r.taken_at desc limit 1) as n,
         (select jsonb_build_object('at', r.taken_at, 'ok', r.ok, 'error', r.error, 'checked', r.checked)
            from online_review_queue_runs r
           where r.courier = cr.courier order by r.taken_at desc limit 1) as last
    from (values ('PostEx'), ('OwnEx')) cr(courier)
)
select jsonb_build_object(
  'ok', true,
  'view', case when (select hist from k) then 'history' else 'today' end,
  'may_work', hub_rescue_may_work(),
  'today', to_char((select today from k), 'YYYY-MM-DD'),
  'range', (select jsonb_build_object('from', to_char(d_from, 'YYYY-MM-DD'), 'to', to_char(d_to, 'YYYY-MM-DD')) from rng),
  'lists', (select jsonb_object_agg(lst.courier, jsonb_build_object(
                     'read_at', lst.read_at, 'n', coalesce(lst.n, 0),
                     'last_at', lst.last->>'at', 'last_ok', (lst.last->>'ok')::boolean,
                     'error', lst.last->>'error')) from lst),
  'summary', jsonb_build_object(
      'desk',       (select count(*) from d where on_desk),
      'postex',     (select count(*) from d where on_desk and courier = 'PostEx'),
      'ownex',      (select count(*) from d where on_desk and courier = 'OwnEx'),
      'untouched',  (select count(*) from d where on_desk and status = 'open' and customer_called_at is null),
      'no_rider',   (select count(*) from d where on_desk and status = 'open' and rider_phone is null),
      /* H297: nothing is "under review" off the couriers' lists any more */
      'not_worked', 0,
      'done_today', (select count(*) from online_delivery_attempts a, k
                      where (a.done_at at time zone 'Asia/Karachi')::date = k.today
                        and a.decided_via is distinct from 'courier'),
      'courier_today', (select count(*) from online_delivery_attempts a, k
                      where (a.done_at at time zone 'Asia/Karachi')::date = k.today
                        and a.decided_via = 'courier'),
      'again_today', (select count(*) from online_rescue_reattempts r, k
                      where r.undone_at is null and (r.at at time zone 'Asia/Karachi')::date = k.today),
      'follow',     (select count(*) from rows where src = 'follow'),
      /* decided on this desk, but the courier still lists it — somebody has
         to press it on the courier's own portal */
      'not_sent',   (select count(*) from d
                      where in_queue and decided_via = 'desk' and decision is not null and outcome is null
                        and (courier_advice is null
                             or (courier_advice <> decision and courier_advice_by = 'merchant'))),
      'not_sent_list', (select coalesce(jsonb_agg(jsonb_build_object(
                           'tracking_id', tracking_id, 'order_number', order_number, 'decision', decision, 'courier', courier)
                           order by decided_at), '[]'::jsonb)
                      from d
                      where in_queue and decided_via = 'desk' and decision is not null and outcome is null
                        and (courier_advice is null
                             or (courier_advice <> decision and courier_advice_by = 'merchant'))),
      'saved',      (select count(*) from online_rescue_cases where outcome = 'delivered'),
      'lost',       (select count(*) from online_rescue_cases where outcome = 'returned')),
  'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.failed_at desc nulls last, r.attempt_no desc)
                      from rows r where r.src <> 'follow'), '[]'::jsonb),
  'follow', coalesce((select jsonb_agg(to_jsonb(r) order by r.done_at desc nulls last)
                        from rows r where r.src = 'follow'), '[]'::jsonb)
);
$function$;

-- ------------------------------------------------------------------ decide
create or replace function public.hub_rescue_decide(p_trackings text[], p_decision text, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_ids text[]; v_third integer := 0;
begin
  if not coalesce(hub_rescue_may_work(), false) then
    return jsonb_build_object('ok', false, 'error', 'This desk is not yours to change.');
  end if;
  if p_trackings is null or cardinality(p_trackings) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Pick at least one parcel.');
  end if;
  if cardinality(p_trackings) > 500 then
    return jsonb_build_object('ok', false, 'error', 'At most 500 at a time.');
  end if;
  if p_decision is null or p_decision not in ('reattempt', 'return', 'undo') then
    return jsonb_build_object('ok', false, 'error', 'The decision is re-attempt or return.');
  end if;
  if p_decision = 'return' and (v_reason is null or length(v_reason) < 4) then
    return jsonb_build_object('ok', false, 'error', 'Say why it should come back — a return needs a proper reason.');
  end if;

  if p_decision = 'undo' then
    with pick as (
      select distinct btrim(x) as tr from unnest(p_trackings) x where btrim(coalesce(x, '')) <> ''
    ), moved as (
      update online_rescue_cases c
         set status = 'open', closed_at = null, done_by = null,
             decision = null, decided_by = null, decided_at = null,
             return_reason = null, decided_via = null, updated_at = now()
        from pick
       where c.tracking_id = pick.tr and c.status = 'done' and c.outcome is null
         and c.decided_via = 'desk'
         /* only while nothing has happened at the courier yet */
         and c.courier_advice is null
         and exists (select 1 from online_logistics l
                      where l.tracking_id = c.tracking_id and hub_is_failed_attempt(l.raw_status))
      returning c.tracking_id, c.attempts
    ), ledger as (
      update online_delivery_attempts a
         set done_by = null, done_at = null, decision = null, return_reason = null, decided_via = null
        from moved m
       where a.tracking_id = m.tracking_id and a.attempt_no = m.attempts
      returning 1
    )
    select coalesce(array_agg(tracking_id), '{}') into v_ids from moved;
    if cardinality(v_ids) = 0 then
      return jsonb_build_object('ok', false, 'error',
        'It cannot be undone now — the courier has already acted on it, or it was decided on the courier''s own portal.');
    end if;
    return jsonb_build_object('ok', true, 'changed', cardinality(v_ids), 'ids', to_jsonb(v_ids));
  end if;

  /* THE OWNER'S RULE: three times out, then it comes back — never out again.
     H297: "three times" counts every time it was sent out or asked to be —
     the first time, every re-attempt by us (here, on the courier's portal, or
     "re-attempt again") and the courier's own — not only the courier's count
     of failed tries (hub_rescue_tries). */
  if p_decision = 'reattempt' then
    select count(*) into v_third from online_rescue_cases c
     where c.tracking_id = any (select btrim(x) from unnest(p_trackings) x)
       and (select t.sent_out from hub_rescue_tries(c.tracking_id) t) >= 3;
  end if;

  with pick as (
    select distinct btrim(x) as tr from unnest(p_trackings) x where btrim(coalesce(x, '')) <> ''
  ), moved as (
    update online_rescue_cases c
       set decision = p_decision, decided_by = auth.uid(), decided_at = now(),
           return_reason = case when p_decision = 'return' then v_reason end,
           decided_via = 'desk',
           status = 'done', closed_at = coalesce(c.closed_at, now()), done_by = auth.uid(),
           updated_at = now()
      from pick
     where c.tracking_id = pick.tr
       and c.outcome is null
       and (c.status = 'open' or c.decision is null)
       and not (p_decision = 'reattempt'
                and (select t.sent_out from hub_rescue_tries(c.tracking_id) t) >= 3)
    returning c.tracking_id, c.attempts
  ), ledger as (
    update online_delivery_attempts a
       set done_by = auth.uid(), done_at = now(), decision = p_decision,
           return_reason = case when p_decision = 'return' then v_reason end,
           decided_via = 'desk'
      from moved m
     where a.tracking_id = m.tracking_id and a.attempt_no = m.attempts
    returning 1
  )
  select coalesce(array_agg(tracking_id), '{}') into v_ids from moved;

  return jsonb_build_object('ok', true, 'changed', cardinality(v_ids), 'ids', to_jsonb(v_ids),
                            'third_try_refused', v_third);
end;
$function$;

-- --------------------------------------------------------- Refresh, now with the lists
create or replace function public.hub_rescue_refresh_courier()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
/* REFRESH (H281, H283; H297 adds the couriers' own lists, read first so the
   desk changes soonest). Each one at most every two minutes. */
declare q_px boolean := false; q_ox boolean := false; q_list boolean := false;
begin
  if not coalesce(hub_rescue_may_see(), false) then
    return jsonb_build_object('ok', false, 'error', 'This desk is not open to you.');
  end if;
  if not exists (select 1 from hub_sync_calls where fn = 'courier-review-queue' and called_at > now() - interval '2 minutes') then
    perform call_sync('courier-review-queue', '{}'::jsonb);
    q_list := true;
  end if;
  if not exists (select 1 from hub_sync_calls where fn = 'postex-review' and called_at > now() - interval '2 minutes') then
    perform call_sync('postex-review', '{"limit": 80}'::jsonb);
    q_px := true;
  end if;
  if not exists (select 1 from hub_sync_calls where fn = 'ownex-review' and called_at > now() - interval '2 minutes') then
    perform call_sync('ownex-review', '{"limit": 60}'::jsonb);
    q_ox := true;
  end if;
  return jsonb_build_object('ok', true, 'queued', q_px or q_ox or q_list,
                            'lists', q_list, 'postex', q_px, 'ownex', q_ox);
end;
$function$;

-- --------------------------------------------------- the lists, every 10 minutes
select cron.schedule('sync_review_queue', '2-59/10 * * * *',
                     $$select call_sync('courier-review-queue', '{}'::jsonb)$$);
