-- =============================================================================
-- H297a — DELIVERY UNDER REVIEW = THE COURIERS' OWN LISTS  (part 1 of 2)
-- 21 Oct 2026 · Hub only (online_* / hub_*). Karkhana and FS Traders untouched.
--
-- THE OWNER, 21 OCT:
--   "Suppose today there are 5 reviews on PostEx — it should fetch all 5, and
--    show them on our portal. Not any other parcel. The desk shows 42-43 that
--    are not on the official portals."
--   "When we confirm with the customer and re-attempt, the parcel disappears
--    from PostEx's portal and there is no history of how many times it was
--    re-attempted. 1-2 days later the agent rings the customer again; if he
--    says he did not receive it, we re-attempt again from our side — and that
--    must be kept as history too, because on the courier's portal there is no
--    button for it any more." The same for OwnEx's Shipper Advice.
--
-- WHAT WAS WRONG
--   The desk was built from OUR status column (hub_is_failed_attempt) — every
--   PostEx "Attempted" and every OwnEx "Verifying Reason" counted as under
--   review. Neither is on the courier's review list: PostEx "Attempted" is
--   PostEx retrying by itself (status 17), "Verifying Reason" is OwnEx not
--   having asked us yet. PostEx's real list is status 9 ("Under Verification"
--   in its API, "Delivery Under Review" on its portal); OwnEx's is "Waiting
--   for Advice" (its Shipper Advice page).
--
-- PART 1 (this file) ADDS, AND CHANGES NOTHING THAT RUNS TODAY
--   online_review_queue_runs   every read of each courier's list, with its
--                              items; the latest GOOD read is the desk
--   online_review_queue_days   one row per parcel per Pakistan day it was on a
--                              courier's list — the history the couriers
--                              themselves do not keep
--   online_rescue_reattempts   "re-attempt again", recorded by us when the
--                              parcel is on no list (kept apart from the try
--                              ledger, which the courier-history reader may
--                              renumber or fold — these rows are never touched
--                              by it)
--   hub_review_queue_record()        writes one read (service role only)
--   hub_review_queue_now()           the latest good list of each courier
--   hub_review_queue_ownex_candidates()  which OwnEx parcels to look at
--   hub_rescue_tries()               tries / times sent out / ours / the log
--   hub_rescue_again_block()         the rules for "re-attempt again", once
--   hub_rescue_reattempt_again()     record one        (desk workers)
--   hub_rescue_reattempt_note()      fix its note      (desk workers)
--   hub_rescue_reattempt_undo()      take it back      (desk workers)
-- Part 2 (H297b) switches the desk over, once the first reads are in.
-- =============================================================================

-- ---------------------------------------------------------------- the tables
/* A RING OF 30 DAYS. Each read lands in its 10-minute slot of a 30-day cycle
   and writes over the read that held that slot a month ago, so the table
   never grows and nothing ever has to be cleared out of it. */
create table if not exists public.online_review_queue_runs (
  courier   text not null check (courier in ('PostEx', 'OwnEx')),
  slot      integer not null check (slot between 0 and 4319),
  taken_at  timestamptz not null default now(),
  ok        boolean not null,
  n         integer not null default 0,
  checked   integer,
  error     text,
  items     jsonb not null default '[]'::jsonb,
  primary key (courier, slot)
);
create index if not exists online_review_queue_runs_courier_idx
  on public.online_review_queue_runs (courier, taken_at desc);
create index if not exists online_review_queue_runs_ok_idx
  on public.online_review_queue_runs (courier, taken_at desc) where ok;

create table if not exists public.online_review_queue_days (
  courier       text not null check (courier in ('PostEx', 'OwnEx')),
  tracking_id   text not null,
  day           date not null,
  order_number  text,
  status        text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (courier, tracking_id, day)
);
create index if not exists online_review_queue_days_tracking_idx
  on public.online_review_queue_days (tracking_id, day desc);

create table if not exists public.online_rescue_reattempts (
  id          bigserial primary key,
  tracking_id text not null,
  courier     text,
  try_no      integer,
  at          timestamptz not null default now(),
  by_user     uuid,
  by_name     text,
  note        text check (note is null or length(note) <= 300),
  edited_at   timestamptz,
  edited_by   uuid,
  undone_at   timestamptz,
  undone_by   uuid
);
create index if not exists online_rescue_reattempts_tracking_idx
  on public.online_rescue_reattempts (tracking_id, at desc);

/* Like the rest of the desk's tables: no direct access from the app at all.
   Everything goes through the functions below. */
alter table public.online_review_queue_runs  enable row level security;
alter table public.online_review_queue_days  enable row level security;
alter table public.online_rescue_reattempts  enable row level security;
revoke all on table public.online_review_queue_runs, public.online_review_queue_days,
                    public.online_rescue_reattempts from public, anon, authenticated;
grant all on table public.online_review_queue_runs, public.online_review_queue_days,
                   public.online_rescue_reattempts to service_role;
revoke all on sequence public.online_rescue_reattempts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.online_rescue_reattempts_id_seq to service_role;

-- --------------------------------------------------------- one read, written
create or replace function public.hub_review_queue_record(
  p_courier text, p_ok boolean, p_items jsonb, p_error text default null, p_checked integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
/* ONE READ OF A COURIER'S OWN REVIEW LIST (H297). Called only by the
   courier-review-queue edge function.

   A GOOD read becomes the desk until the next good read. A FAILED read is
   kept with its error — so the desk can say the list is old — and never
   empties the desk.

   Every parcel actually seen on a good read gets its day in
   online_review_queue_days: the courier's portal forgets a parcel the moment
   it is decided; this table does not.

   And every parcel on the list has a failed try open on the desk. Normally the
   status sync opened it already and nothing changes here. A try is opened only
   when the parcel has no case yet, or its last try was closed by the parcel
   going out again — then this is a new failure the status sync has not seen
   yet. A parcel delivered or returned in our books is left alone. */
declare
  v_ok    boolean := coalesce(p_ok, false);
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_slot  integer := (floor(extract(epoch from now()) / 600)::bigint % 4320)::integer;
  v_items jsonb;
  x       jsonb;
  v_tn text; v_order text; v_status text; v_kept boolean;
  c online_rescue_cases;
  v_l_found boolean; v_l_courier text; v_l_order text; v_l_store text;
  v_l_raw text; v_l_deliv text; v_l_reason text;
  v_store text; v_ins boolean;
  n_items integer := 0; n_opened integer := 0; n_new_days integer := 0;
begin
  if p_courier is null or p_courier not in ('PostEx', 'OwnEx') then
    return jsonb_build_object('ok', false, 'error', 'The courier is PostEx or OwnEx.');
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'The items must be a list.');
  end if;

  /* one entry per tracking number; anything that is not one is dropped */
  select coalesce(jsonb_agg(s.e order by s.e->>'tracking_id'), '[]'::jsonb) into v_items
    from (
      select distinct on (btrim(i->>'tracking_id'))
             jsonb_build_object(
               'tracking_id',  btrim(i->>'tracking_id'),
               'order_number', left(nullif(btrim(coalesce(i->>'order_number', '')), ''), 40),
               'status',       left(nullif(btrim(coalesce(i->>'status', '')), ''), 120),
               'reason',       left(nullif(btrim(coalesce(i->>'reason', '')), ''), 200),
               'at',           case when coalesce(i->>'at', '') ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
                                    then left(i->>'at', 40) end,
               'kept',         coalesce(i->'kept' = 'true'::jsonb, false)) as e
        from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
       where jsonb_typeof(i) = 'object'
         and btrim(coalesce(i->>'tracking_id', '')) ~ '^[A-Za-z0-9-]{4,40}$'
       order by btrim(i->>'tracking_id')
       limit 1000
    ) s;
  n_items := jsonb_array_length(v_items);

  insert into online_review_queue_runs (courier, slot, taken_at, ok, n, checked, error, items)
  values (p_courier, v_slot, now(), v_ok, n_items, p_checked,
          left(nullif(btrim(coalesce(p_error, '')), ''), 500), v_items)
  on conflict (courier, slot) do update
    set taken_at = excluded.taken_at, ok = excluded.ok, n = excluded.n, checked = excluded.checked,
        error = excluded.error, items = excluded.items;

  if v_ok then
    for x in select * from jsonb_array_elements(v_items) loop
      v_tn := x->>'tracking_id'; v_order := x->>'order_number'; v_status := x->>'status';
      v_kept := coalesce((x->>'kept')::boolean, false);

      /* the day it was seen — only if it was really seen on this read */
      if not v_kept then
        insert into online_review_queue_days (courier, tracking_id, day, order_number, status, first_seen_at, last_seen_at)
        values (p_courier, v_tn, v_today, v_order, v_status, now(), now())
        on conflict (courier, tracking_id, day) do update
          set last_seen_at = now(),
              order_number = coalesce(excluded.order_number, online_review_queue_days.order_number),
              status       = coalesce(excluded.status, online_review_queue_days.status)
        returning (xmax = 0) into v_ins;
        if v_ins then n_new_days := n_new_days + 1; end if;
      end if;

      /* a failed try open on the desk for it */
      select true, l.courier, l.order_number, l.store_code, l.raw_status, l.delivery_status, l.courier_reason_text
        into v_l_found, v_l_courier, v_l_order, v_l_store, v_l_raw, v_l_deliv, v_l_reason
        from online_logistics l where l.tracking_id = v_tn;
      select * into c from online_rescue_cases where tracking_id = v_tn;
      if (c.tracking_id is null or not c.leg_open)
         and c.outcome is null
         and hub_is_final_state(v_l_deliv) is null then
        v_store := v_l_store;
        if v_store is null and v_order is not null then
          select o.store_code into v_store from online_orders o where o.order_number = v_order
           order by o.order_date desc nulls last limit 1;
        end if;
        perform hub_rescue_open_attempt(v_tn, coalesce(v_l_courier, p_courier), coalesce(v_l_order, v_order),
                                        v_store, now(), coalesce(v_status, v_l_raw), v_l_reason);
        n_opened := n_opened + 1;
      end if;
      v_l_found := null; v_l_courier := null; v_l_order := null; v_l_store := null;
      v_l_raw := null; v_l_deliv := null; v_l_reason := null;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'slot', v_slot, 'courier', p_courier, 'good_read', v_ok,
                            'n', n_items, 'opened', n_opened, 'new_days', n_new_days);
end;
$function$;

-- ------------------------------------------------- the lists, as they are now
create or replace function public.hub_review_queue_now()
 returns table(courier text, tracking_id text, status text, reason text, at text, kept boolean, read_at timestamptz)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* The latest GOOD read of each courier's list (H297). */
  select r.courier, x->>'tracking_id', x->>'status', x->>'reason', x->>'at',
         coalesce((x->>'kept')::boolean, false), r.taken_at
    from (select distinct on (q.courier) q.courier, q.taken_at, q.items
            from online_review_queue_runs q
           where q.ok
           order by q.courier, q.taken_at desc) r
   cross join lateral jsonb_array_elements(r.items) x;
$function$;

-- ------------------------------------- which OwnEx parcels to read the tracker of
create or replace function public.hub_review_queue_ownex_candidates(p_limit integer default 250)
 returns table(tracking_id text)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* OwnEx has no list to download, so its Shipper Advice is found by asking
     its tracker about every OwnEx parcel still out there (H297).

     NOT FROM OUR OWN STATUS COLUMN. On 21 Oct #TS4893 was "Waiting for Advice"
     on OwnEx while our status for it was still empty — the status sync had not
     read it yet. So every OwnEx parcel not yet delivered, returned or
     cancelled, sent in the last 60 days, is asked — plus whatever was on the
     last good list, so nothing drops off it unread. */
  with prev as (
    select x->>'tracking_id' as tracking_id
      from (select q.items from online_review_queue_runs q
             where q.courier = 'OwnEx' and q.ok order by q.taken_at desc limit 1) s
     cross join lateral jsonb_array_elements(s.items) x
  ),
  live as (
    select l.tracking_id, coalesce(l.dispatch_date, l.created_at::date) as d
      from online_logistics l
     where l.courier = 'OwnEx'
       and btrim(coalesce(l.tracking_id, '')) <> ''
       and coalesce(l.delivery_status, '') not in ('Delivered', 'Returned', 'Cancelled')
       and hub_is_final_state(l.delivery_status) is null
       and coalesce(l.dispatch_date, l.created_at::date) >= (now() at time zone 'Asia/Karachi')::date - 60
  )
  select t.tracking_id
    from (select p.tracking_id, 0 as pri, null::date as d from prev p
          union all
          select v.tracking_id, 1, v.d from live v) t
   where btrim(coalesce(t.tracking_id, '')) <> ''
   group by t.tracking_id
   order by min(t.pri), max(t.d) desc nulls last, t.tracking_id
   limit greatest(1, least(coalesce(p_limit, 250), 400));
$function$;

-- ------------------------------------------------ tries, and the re-attempt log
create or replace function public.hub_rescue_tries(p_tracking text)
 returns table(tries integer, sent_out integer, ours integer, again integer, by_courier integer,
               last_ours_at timestamptz, log jsonb)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* HOW MANY TIMES, AND WHO (H297).

     tries      which try the parcel is on: the courier's own count, but never
                less than one more than the re-attempts made before this try
     sent_out   how many times it has been sent out, or asked to be: the first
                time plus every re-attempt — ours, and the courier's own
     ours       re-attempts by us: decided on this desk, pressed on the
                courier's portal by our agent, or "re-attempt again" recorded
                here when the parcel was on no list
     log        every re-attempt in order: when, how, by whom, any note

     THE OWNER'S RULE uses sent_out: three times out, then it comes back. */
  with c as (
    select c.tracking_id, c.attempts, c.decision, c.decided_via, c.courier_advice_by,
           c.decided_at, c.courier_advice_at, c.decided_by
      from online_rescue_cases c
     where c.tracking_id = btrim(coalesce(p_tracking, ''))
  ),
  led as (
    select a.attempt_no, a.failed_at,
           case when a.attempt_no = c.attempts then coalesce(a.decision, c.decision) else a.decision end as decision,
           case when a.attempt_no = c.attempts then coalesce(a.decided_via, c.decided_via) else a.decided_via end as via,
           case when a.attempt_no = c.attempts then coalesce(a.advice_by, c.courier_advice_by) else a.advice_by end as adv_by,
           coalesce(a.done_at, case when a.attempt_no = c.attempts then coalesce(c.decided_at, c.courier_advice_at) end) as at,
           coalesce(a.done_by, case when a.attempt_no = c.attempts then c.decided_by end) as by_user
      from c join online_delivery_attempts a on a.tracking_id = c.tracking_id
  ),
  ag as (
    select r.id, r.at, r.by_name, r.by_user, r.note, r.try_no
      from c join online_rescue_reattempts r on r.tracking_id = c.tracking_id
     where r.undone_at is null
  ),
  ev as (
    select led.at, led.attempt_no as try_no,
           case when led.via = 'courier' and led.adv_by = 'merchant' then 'portal'
                when led.via = 'courier' then 'courier'
                else 'desk' end as how,
           null::bigint as id, null::text as note, u.full_name as by_name
      from led left join app_users u on u.id = led.by_user
     where led.decision = 'reattempt'
    union all
    select ag.at, ag.try_no, 'again', ag.id, ag.note, coalesce(u.full_name, ag.by_name)
      from ag left join app_users u on u.id = ag.by_user
  ),
  evn as (
    select ev.*,
           case when ev.how <> 'courier'
                then count(*) filter (where ev.how <> 'courier')
                       over (order by ev.at nulls first, ev.try_no, ev.id nulls first rows unbounded preceding) end as n
      from ev
  )
  select
    greatest(c.attempts,
             1 + (select count(*)::int from led where led.attempt_no < c.attempts and led.decision = 'reattempt')
               + (select count(*)::int from ag
                   where ag.at < coalesce((select led.failed_at from led where led.attempt_no = c.attempts),
                                          '-infinity'::timestamptz)))::int,
    greatest(c.attempts, 1 + (select count(*)::int from ev))::int,
    (select count(*)::int from ev where ev.how <> 'courier'),
    (select count(*)::int from ag),
    (select count(*)::int from ev where ev.how = 'courier'),
    (select max(ev.at) from ev where ev.how <> 'courier'),
    coalesce((select jsonb_agg(jsonb_build_object('n', evn.n, 'at', evn.at, 'how', evn.how, 'try', evn.try_no,
                                                  'by', evn.by_name, 'note', evn.note, 'id', evn.id)
                               order by evn.at nulls first, evn.try_no, evn.id nulls first)
                from evn), '[]'::jsonb)
  from c;
$function$;

-- ------------------------------------ the rules for "re-attempt again", once
create or replace function public.hub_rescue_again_block(
  p_status text, p_decision text, p_outcome text, p_delivery text, p_raw text,
  p_return_leg timestamptz, p_in_queue boolean, p_sent_out integer)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  /* null = "re-attempt again" may be recorded; otherwise why not (H297).
     The desk shows the button by this, and hub_rescue_reattempt_again()
     refuses by this — one set of rules, not two. */
  select case
    when p_outcome is not null or hub_is_final_state(p_delivery) is not null then 'settled'
    when lower(coalesce(p_delivery, '')) like 'cancel%' then 'cancelled'
    when p_return_leg is not null or upper(coalesce(p_delivery, '')) = 'RTS'
         or coalesce(p_raw, '') ilike 'return%' or coalesce(p_raw, '') ilike 'en-route to lahore%' then 'coming_back'
    when p_status = 'open' and p_decision is null then 'undecided'
    when coalesce(p_in_queue, false) then 'on_list'
    when coalesce(p_sent_out, 0) >= 3 then 'third_time'
    else null end;
$function$;

-- --------------------------------------------- re-attempt again: record one
create or replace function public.hub_rescue_reattempt_again(p_tracking text, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
/* "RE-ATTEMPT AGAIN" (H297). The agent rang the customer a day or two after a
   re-attempt; the customer says it never came. The parcel is on no review
   list now, so the courier's portal has no button for it — the agent asks the
   courier directly, and records it here. This records; it sends nothing. */
declare
  v_tn   text := btrim(coalesce(p_tracking, ''));
  v_note text := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), 300), '');
  c online_rescue_cases;
  v_deliv text; v_raw text; v_leg timestamptz;
  v_in_queue boolean;
  t record;
  v_block text; v_id bigint; v_name text; v_n integer; v_cn text; v_th text;
begin
  if not coalesce(hub_rescue_may_work(), false) then
    return jsonb_build_object('ok', false, 'error', 'This desk is not yours to change.');
  end if;
  select * into c from online_rescue_cases where tracking_id = v_tn for update;
  if c.tracking_id is null then
    return jsonb_build_object('ok', false, 'error',
      'That parcel has no failed try on record, so there is nothing to re-attempt.');
  end if;
  select l.delivery_status, l.raw_status, l.return_leg_started_at into v_deliv, v_raw, v_leg
    from online_logistics l where l.tracking_id = v_tn;
  select exists (select 1 from hub_review_queue_now() q where q.tracking_id = v_tn) into v_in_queue;
  select * into t from hub_rescue_tries(v_tn);
  v_cn := coalesce(c.courier, 'the courier');

  v_block := hub_rescue_again_block(c.status, c.decision, c.outcome, v_deliv, v_raw, v_leg, v_in_queue, t.sent_out);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'block', v_block, 'error', case v_block
      when 'settled'     then 'It is already ' || coalesce(c.outcome, lower(hub_is_final_state(v_deliv)), 'settled') || ' — nothing to re-attempt.'
      when 'cancelled'   then 'It is cancelled at ' || v_cn || ' — nothing to re-attempt.'
      when 'coming_back' then 'It is on its way back to us — it cannot be re-attempted now.'
      when 'undecided'   then 'Its latest try has not been decided yet — use Re-attempt or Return on it.'
      when 'on_list'     then 'It is on ' || v_cn || '''s review list right now — decide it on the desk.'
      when 'third_time'  then 'It has been sent out 3 times already — by the rule it comes back now. Ask '
                              || v_cn || ' to return it.'
      else 'It cannot be re-attempted now.' end);
  end if;

  /* the same press twice is one re-attempt */
  if exists (select 1 from online_rescue_reattempts r
              where r.tracking_id = v_tn and r.undone_at is null and r.at > now() - interval '15 minutes') then
    return jsonb_build_object('ok', false, 'error', 'A re-attempt was recorded for it a few minutes ago already.');
  end if;

  select u.full_name into v_name from app_users u where u.id = auth.uid();
  insert into online_rescue_reattempts (tracking_id, courier, try_no, at, by_user, by_name, note)
  values (v_tn, c.courier, c.attempts, now(), auth.uid(), v_name, v_note)
  returning id into v_id;

  v_n := t.ours + 1;
  v_th := v_n || case when v_n % 100 between 11 and 13 then 'th'
                      when v_n % 10 = 1 then 'st' when v_n % 10 = 2 then 'nd' when v_n % 10 = 3 then 'rd'
                      else 'th' end;
  return jsonb_build_object('ok', true, 'id', v_id, 'n', v_n, 'sent_out', t.sent_out + 1,
    'report', v_th || ' re-attempt by us recorded for ' || coalesce(c.order_number, v_tn)
              || '. Ask ' || v_cn || ' to send it out again — this desk does not send it.');
end;
$function$;

-- ------------------------------------------------ re-attempt again: fix the note
create or replace function public.hub_rescue_reattempt_note(p_id bigint, p_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
/* A wrong note on a "re-attempt again" is corrected, not left (H297). */
declare v_note text := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), 300), '');
        v_n integer;
begin
  if not coalesce(hub_rescue_may_work(), false) then
    return jsonb_build_object('ok', false, 'error', 'This desk is not yours to change.');
  end if;
  update online_rescue_reattempts
     set note = v_note, edited_at = now(), edited_by = auth.uid()
   where id = p_id and undone_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'That re-attempt is not on record any more.');
  end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$function$;

-- ------------------------------------------------- re-attempt again: take it back
create or replace function public.hub_rescue_reattempt_undo(p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
/* Recorded by mistake: taken back, and kept as taken back (H297). Only the
   latest one of a parcel, so the count never has a hole in the middle. */
declare r online_rescue_reattempts;
begin
  if not coalesce(hub_rescue_may_work(), false) then
    return jsonb_build_object('ok', false, 'error', 'This desk is not yours to change.');
  end if;
  select * into r from online_rescue_reattempts where id = p_id for update;
  if r.id is null or r.undone_at is not null then
    return jsonb_build_object('ok', false, 'error', 'That re-attempt is not on record any more.');
  end if;
  if exists (select 1 from online_rescue_reattempts x
              where x.tracking_id = r.tracking_id and x.undone_at is null and x.at > r.at) then
    return jsonb_build_object('ok', false, 'error', 'Take back the later re-attempt first.');
  end if;
  update online_rescue_reattempts set undone_at = now(), undone_by = auth.uid() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'tracking_id', r.tracking_id);
end;
$function$;

-- ---------------------------------------------------------------- who may call
revoke all on function public.hub_review_queue_record(text, boolean, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.hub_review_queue_now() from public, anon, authenticated;
revoke all on function public.hub_review_queue_ownex_candidates(integer) from public, anon, authenticated;
revoke all on function public.hub_rescue_tries(text) from public, anon, authenticated;
revoke all on function public.hub_rescue_again_block(text, text, text, text, text, timestamptz, boolean, integer) from public, anon, authenticated;
revoke all on function public.hub_rescue_reattempt_again(text, text) from public, anon;
revoke all on function public.hub_rescue_reattempt_note(bigint, text) from public, anon;
revoke all on function public.hub_rescue_reattempt_undo(bigint) from public, anon;

grant execute on function public.hub_review_queue_record(text, boolean, jsonb, text, integer) to service_role;
grant execute on function public.hub_review_queue_now() to service_role;
grant execute on function public.hub_review_queue_ownex_candidates(integer) to service_role;
grant execute on function public.hub_rescue_tries(text) to service_role;
grant execute on function public.hub_rescue_again_block(text, text, text, text, text, timestamptz, boolean, integer) to service_role;
grant execute on function public.hub_rescue_reattempt_again(text, text) to authenticated, service_role;
grant execute on function public.hub_rescue_reattempt_note(bigint, text) to authenticated, service_role;
grant execute on function public.hub_rescue_reattempt_undo(bigint) to authenticated, service_role;
