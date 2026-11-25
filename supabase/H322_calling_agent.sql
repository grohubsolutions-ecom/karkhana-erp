-- H322 — CALLING AGENT (Hub → Calling Agent)
--
-- Three worklists for the calling agent, who has no Shopify login:
--   1. ARCHIVED   orders archived in Shopify, never fulfilled, never cancelled —
--                 ring for confirmation.
--   2. DELIVERY UNDER REVIEW — the existing desk (H276/H297), unchanged; the
--                 agent's key now opens it too.
--   3. RETURNS    LM and TS orders fulfilled and then cancelled in Shopify —
--                 ring to ask whether they want the parcel again.
--
-- The agent records a choice; the office sees every choice and presses
-- Create order / Cancel order / Wait. A return that becomes a NEW order is
-- linked to the new order number, so the agent's work follows the parcel.
--
-- BONUS: Rs 200 (online_call_settings) per parcel the agent worked that is
-- DELIVERED and inside a PostEx CPR / OwnEx invoice (online_logistics.cpr_number).
-- Nothing is earned on a confirmation alone.
--
-- Rollback: H322_rollback.sql

begin;

-------------------------------------------------------------------------------
-- 1. Archived = Shopify closed_at. The webhook stores every payload in
--    online_shopify_events; a trigger lifts closed_at from it, so no edge
--    function had to be redeployed. Out-of-order deliveries are ignored by
--    comparing the payload's updated_at.
-------------------------------------------------------------------------------
alter table online_orders add column if not exists closed_at timestamptz;
alter table online_orders add column if not exists closed_src_at timestamptz;
create index if not exists online_orders_closed_open_idx
  on online_orders (closed_at) where closed_at is not null and cancelled_at is null;

create or replace function online_orders_closed_from_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_upd timestamptz;
begin
  if new.topic like 'orders/%' and new.shopify_order_id is not null and new.payload ? 'closed_at' then
    begin
      v_upd := nullif(new.payload->>'updated_at', '')::timestamptz;
      update online_orders
         set closed_at = nullif(new.payload->>'closed_at', '')::timestamptz,
             closed_src_at = v_upd
       where shopify_order_id = new.shopify_order_id
         and (closed_src_at is null or v_upd is null or v_upd >= closed_src_at);
    exception when others then null;   -- never fail a webhook over this
    end;
  end if;
  return new;
end $$;

drop trigger if exists online_orders_closed_from_event on online_shopify_events;
create trigger online_orders_closed_from_event after insert on online_shopify_events
  for each row execute function online_orders_closed_from_event();

-- Backfill from the payloads already kept (about a month).
with last as (
  select distinct on (shopify_order_id) shopify_order_id,
         nullif(payload->>'closed_at', '')::timestamptz as closed_at,
         nullif(payload->>'updated_at', '')::timestamptz as upd
    from online_shopify_events
   where topic like 'orders/%' and shopify_order_id is not null and payload ? 'closed_at'
   order by shopify_order_id, nullif(payload->>'updated_at', '')::timestamptz desc nulls last, id desc
)
update online_orders o set closed_at = last.closed_at, closed_src_at = last.upd
  from last where o.shopify_order_id = last.shopify_order_id;

-------------------------------------------------------------------------------
-- 2. Tables
-------------------------------------------------------------------------------
create table if not exists online_call_settings (
  id int primary key default 1 check (id = 1),
  bonus_amount numeric not null default 200,
  starts_on date not null default date '2026-11-25',
  archive_lookback_days int not null default 30,
  return_lookback_days int not null default 3,
  max_no_answer int not null default 3,
  updated_at timestamptz default now(),
  updated_by uuid
);
insert into online_call_settings (id) values (1) on conflict do nothing;
alter table online_call_settings enable row level security;
comment on table online_call_settings is 'H322 — calling agent bonus amount and start date. One row.';

create table if not exists online_call_cases (
  id bigserial primary key,
  kind text not null check (kind in ('archive', 'return')),
  store_code text not null,
  order_number text not null,
  shopify_order_id bigint,
  source_at timestamptz,                 -- closed_at (archive) / cancelled_at (return)
  items jsonb,                           -- line items as Shopify sent them
  opened_at timestamptz not null default now(),
  status text not null default 'to_call'
    check (status in ('to_call', 'to_office', 'waiting', 'done', 'dropped')),
  calls int not null default 0,
  last_call_at timestamptz,
  call_back_at timestamptz,
  agent_choice text,
  agent_note text,
  agent_by uuid,
  agent_at timestamptz,
  office_action text check (office_action in ('create_order', 'cancel_order', 'wait')),
  office_note text,
  office_by uuid,
  office_at timestamptz,
  result_order_number text,              -- the order whose payment earns the bonus
  result_store_code text,
  dropped_reason text,
  updated_at timestamptz not null default now(),
  unique (kind, store_code, order_number)
);
create index if not exists online_call_cases_status_idx on online_call_cases (status, kind);
create index if not exists online_call_cases_result_idx on online_call_cases (result_store_code, result_order_number);
alter table online_call_cases enable row level security;
comment on table online_call_cases is 'H322 — one order the calling agent rings: archived (confirm) or fulfilled+cancelled (wants it again?).';

create table if not exists online_call_log (
  id bigserial primary key,
  case_id bigint not null references online_call_cases(id) on delete cascade,
  at timestamptz not null default now(),
  by_user uuid,
  who text not null check (who in ('agent', 'office', 'system')),
  choice text not null,
  note text
);
create index if not exists online_call_log_case_idx on online_call_log (case_id, at);
alter table online_call_log enable row level security;
comment on table online_call_log is 'H322 — append only: every call and every office decision.';

-------------------------------------------------------------------------------
-- 3. Permissions and role
-------------------------------------------------------------------------------
insert into permissions (code, module, description) values
  ('hub.calling.work',   'hub', 'Calling agent: ring archived orders, Delivery Under Review and returns, and record the customer''s answer'),
  ('hub.calling.manage', 'hub', 'See every calling-agent answer, press Create order / Cancel order / Wait, and see all agents'' bonus')
on conflict (code) do nothing;

insert into roles (code, name, description)
values ('calling_agent', 'Calling Agent', 'Hub calling agent — archived orders, Delivery Under Review, returns')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
 where r.code = 'calling_agent' and p.code in ('hub.calling.work', 'returns.rescue')
   and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
 where r.name in ('Super Administrator', 'Administrator') and p.code in ('hub.calling.work', 'hub.calling.manage')
   and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);

-- The agent's key opens the existing Delivery Under Review desk too.
create or replace function hub_rescue_may_see() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('returns.rescue'), false)
      or coalesce(has_permission('hub.logistics.view'), false)
      or coalesce(has_permission('hub.logistics.manage'), false)
      or coalesce(has_permission('hub.calling.work'), false);
$$;
create or replace function hub_rescue_may_work() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('returns.rescue'), false)
      or coalesce(has_permission('hub.logistics.manage'), false)
      or coalesce(has_permission('hub.calling.work'), false);
$$;

create or replace function hub_call_may_work() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('hub.calling.work'), false) or coalesce(has_permission('hub.calling.manage'), false);
$$;
create or replace function hub_call_may_manage() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('hub.calling.manage'), false);
$$;

-- Does a given user (not the caller) hold a permission through a role?
create or replace function hub_call_user_has(p_user uuid, p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles ur
                   join role_permissions rp on rp.role_id = ur.role_id
                   join permissions p on p.id = rp.permission_id
                  where ur.user_id = p_user and p.code = p_code);
$$;

-------------------------------------------------------------------------------
-- 4. Helpers
-------------------------------------------------------------------------------
create or replace function hub_call_norm_order(p text) returns text
language sql immutable as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              else '#' || upper(regexp_replace(btrim(p), '^#|\s', '', 'g')) end;
$$;

create or replace function hub_call_phone10(p text) returns text
language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

create or replace function hub_call_items(p_shopify_order_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select (select jsonb_agg(jsonb_build_object(
            'title', li->>'title', 'variant', li->>'variant_title',
            'qty', (li->>'quantity')::numeric, 'price', (li->>'price')::numeric))
            from jsonb_array_elements(e.payload->'line_items') li)
    from online_shopify_events e
   where e.shopify_order_id = p_shopify_order_id and e.topic like 'orders/%'
     and jsonb_typeof(e.payload->'line_items') = 'array'
   order by e.id desc limit 1;
$$;

-------------------------------------------------------------------------------
-- 5. Refresh: new cases in, stale archive cases out
-------------------------------------------------------------------------------
create or replace function hub_call_refresh() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s online_call_settings; v_arch int := 0; v_ret int := 0; v_drop int := 0;
begin
  select * into s from online_call_settings where id = 1;

  with ins as (
    insert into online_call_cases (kind, store_code, order_number, shopify_order_id, source_at, items)
    select 'archive', o.store_code, o.order_number, o.shopify_order_id, o.closed_at, hub_call_items(o.shopify_order_id)
      from online_orders o
     where o.closed_at is not null and o.cancelled_at is null
       and coalesce(o.fulfillment_status, 'UNFULFILLED') = 'UNFULFILLED'
       and o.closed_at >= (s.starts_on - s.archive_lookback_days)
       and not exists (select 1 from online_logistics l
                        where l.shopify_order_id = o.shopify_order_id
                           or (l.order_number = o.order_number and l.store_code = o.store_code))
    on conflict (kind, store_code, order_number) do nothing
    returning 1)
  select count(*) into v_arch from ins;

  with ins as (
    insert into online_call_cases (kind, store_code, order_number, shopify_order_id, source_at, items)
    select 'return', o.store_code, o.order_number, o.shopify_order_id, o.cancelled_at, hub_call_items(o.shopify_order_id)
      from online_orders o
     where o.store_code in ('LM', 'TS')
       and o.cancelled_at is not null
       and o.fulfillment_status = 'FULFILLED'
       and o.cancelled_at >= (s.starts_on - s.return_lookback_days)
    on conflict (kind, store_code, order_number) do nothing
    returning 1)
  select count(*) into v_ret from ins;

  -- An archived order nobody has rung yet, that the office has since
  -- un-archived, fulfilled or cancelled in Shopify, is no longer a call.
  with gone as (
    update online_call_cases c
       set status = 'dropped', updated_at = now(),
           dropped_reason = case when o.cancelled_at is not null then 'Cancelled in Shopify'
                                 when o.fulfillment_status = 'FULFILLED' then 'Fulfilled in Shopify'
                                 else 'Un-archived in Shopify' end
      from online_orders o
     where c.kind = 'archive' and c.status = 'to_call' and c.calls = 0
       and o.shopify_order_id = c.shopify_order_id
       and (o.cancelled_at is not null or o.fulfillment_status = 'FULFILLED' or o.closed_at is null)
    returning c.id, c.dropped_reason)
  , logged as (
    insert into online_call_log (case_id, who, choice, note)
    select id, 'system', 'dropped', dropped_reason from gone returning 1)
  select count(*) into v_drop from logged;

  return jsonb_build_object('archive', v_arch, 'return', v_ret, 'dropped', v_drop);
end $$;

-------------------------------------------------------------------------------
-- 6. Bonus state of one case: which parcels, and whether they are paid
-------------------------------------------------------------------------------
create or replace function hub_call_parcel_state(p_store text, p_order text)
returns table (tracking_id text, courier text, delivery_status text, cpr_number text, earned_on date, state text)
language sql stable security definer set search_path = public as $$
  select l.tracking_id, l.courier, l.delivery_status, l.cpr_number,
         coalesce(l.payment_date,
                  (select min(c.cpr_date) from online_cpr c where c.cpr_number = l.cpr_number),
                  l.delivery_date) as earned_on,
         case when l.delivery_status = 'Delivered' and l.cpr_number is not null then 'earned'
              when l.delivery_status in ('Returned', 'RTS', 'Cancelled') or is_returning(l.delivery_status, l.raw_status) then 'lost'
              else 'pending' end as state
    from online_logistics l
   where l.order_number = p_order and l.store_code = p_store;
$$;

-------------------------------------------------------------------------------
-- 7. The board
--   p_view: 'agent'   — to ring now, and the call-backs still to come
--           'office'  — answers waiting for Create / Cancel / Wait
--           'history' — finished in the last p_days
-------------------------------------------------------------------------------
create or replace function hub_call_board(p_view text default 'agent', p_days int default 7) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb; v_counts jsonb; v_refresh jsonb; v_manage boolean := hub_call_may_manage();
        v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';
begin
  if not hub_call_may_work() then
    return jsonb_build_object('ok', false, 'error', 'The calling desk is not open to you.');
  end if;
  v_refresh := hub_call_refresh();

  select jsonb_build_object(
    'archive',  count(*) filter (where kind = 'archive' and status = 'to_call' and (call_back_at is null or call_back_at <= now())),
    'return',   count(*) filter (where kind = 'return'  and status = 'to_call' and (call_back_at is null or call_back_at <= now())),
    'later',    count(*) filter (where status = 'to_call' and call_back_at > now()),
    'office',   count(*) filter (where status = 'to_office'),
    'waiting',  count(*) filter (where status = 'waiting'),
    'done_today', count(*) filter (where status = 'done' and office_at >= v_today),
    'called_today', (select count(*) from online_call_log g where g.who = 'agent' and g.at >= v_today))
    into v_counts from online_call_cases;

  select coalesce(jsonb_agg(r order by r_sort, r_at), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'store_code', c.store_code, 'order_number', c.order_number,
      'status', c.status, 'source_at', c.source_at, 'opened_at', c.opened_at, 'items', c.items,
      'calls', c.calls, 'last_call_at', c.last_call_at, 'call_back_at', c.call_back_at,
      'agent_choice', c.agent_choice, 'agent_note', c.agent_note, 'agent_at', c.agent_at,
      'agent_name', (select u.full_name from app_users u where u.id = c.agent_by),
      'office_action', c.office_action, 'office_note', c.office_note, 'office_at', c.office_at,
      'office_name', (select u.full_name from app_users u where u.id = c.office_by),
      'result_order_number', c.result_order_number, 'dropped_reason', c.dropped_reason,
      'customer_name', o.customer_name, 'phone', o.phone, 'city', o.city, 'address', o.address,
      'amount', o.amount, 'order_date', o.order_date, 'note', o.note, 'tags', to_jsonb(o.tags),
      'item_count', o.item_count, 'cancel_reason', o.cancel_reason, 'cancel_staff_note', o.cancel_staff_note,
      'total_orders', o.total_orders, 'delivered_orders', o.delivered_orders, 'failed_orders', o.failed_orders,
      'parcel', (select jsonb_build_object('tracking_id', l.tracking_id, 'courier', l.courier,
                         'delivery_status', l.delivery_status, 'raw_status', l.raw_status,
                         'reason', coalesce(l.courier_reason_text, l.rts_reason))
                   from online_logistics l
                  where (l.shopify_order_id = c.shopify_order_id
                         or (l.order_number = c.order_number and l.store_code = c.store_code))
                  order by l.id desc limit 1),
      'log', (select jsonb_agg(jsonb_build_object('at', g.at, 'who', g.who, 'choice', g.choice, 'note', g.note,
                       'name', (select u.full_name from app_users u where u.id = g.by_user)) order by g.at)
                from online_call_log g where g.case_id = c.id),
      -- A return the customer wants again: orders placed since, on the same phone.
      'suggest', case when c.kind = 'return' and c.status in ('to_office', 'waiting') then
                   (select jsonb_agg(jsonb_build_object('order_number', n.order_number, 'store_code', n.store_code,
                                     'order_date', n.order_date, 'amount', n.amount) order by n.order_date desc)
                      from online_orders n
                     where hub_call_phone10(n.phone) = hub_call_phone10(o.phone)
                       and n.order_number <> c.order_number
                       and n.shopify_created_at >= c.opened_at - interval '1 day'
                       and n.cancelled_at is null)
                 end,
      'bonus', case when c.result_order_number is not null then
                 (select jsonb_agg(to_jsonb(ps)) from hub_call_parcel_state(c.result_store_code, c.result_order_number) ps)
               end
    ) as r,
    case c.status when 'to_call' then (case when c.kind = 'archive' then 0 else 1 end) else 2 end as r_sort,
    coalesce(c.agent_at, c.source_at, c.opened_at) as r_at
      from online_call_cases c
      left join lateral (select * from online_orders oo
                          where oo.shopify_order_id = c.shopify_order_id
                             or (c.shopify_order_id is null and oo.order_number = c.order_number and oo.store_code = c.store_code)
                          order by oo.id desc limit 1) o on true
     where case p_view
             when 'agent'   then c.status = 'to_call'
             when 'office'  then c.status in ('to_office', 'waiting')
             when 'history' then c.status in ('done', 'dropped')
                                 and c.updated_at >= now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
             else false end
  ) x;

  return jsonb_build_object('ok', true, 'view', p_view, 'may_manage', v_manage,
                            'counts', v_counts, 'rows', v_rows, 'refresh', v_refresh,
                            'settings', (select to_jsonb(s) - 'updated_by' from online_call_settings s where id = 1));
end $$;

-------------------------------------------------------------------------------
-- 8. The agent's answer
-------------------------------------------------------------------------------
create or replace function hub_call_answer(p_id bigint, p_choice text, p_note text default null,
                                           p_call_back timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c online_call_cases; s online_call_settings; v_note text := nullif(btrim(coalesce(p_note, '')), '');
        v_ok text[];
begin
  if not hub_call_may_work() then return jsonb_build_object('ok', false, 'error', 'The calling desk is not open to you.'); end if;
  select * into c from online_call_cases where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'That call is no longer on the list.'); end if;
  if c.status <> 'to_call' then return jsonb_build_object('ok', false, 'error', 'Already answered — it is with the office.'); end if;
  select * into s from online_call_settings where id = 1;

  v_ok := case c.kind when 'archive' then array['confirmed', 'cancel', 'no_answer', 'call_later', 'wrong_number']
                      else array['wants_parcel', 'not_interested', 'no_answer', 'call_later', 'wrong_number'] end;
  if p_choice is null or not (p_choice = any (v_ok)) then
    return jsonb_build_object('ok', false, 'error', 'Pick one of the answers.');
  end if;
  if p_choice = 'call_later' and (p_call_back is null or p_call_back <= now()) then
    return jsonb_build_object('ok', false, 'error', 'When should it be rung again? Pick a time later than now.');
  end if;
  if p_choice in ('cancel', 'not_interested') and (v_note is null or length(v_note) < 3) then
    return jsonb_build_object('ok', false, 'error', 'Write why the customer does not want it.');
  end if;

  insert into online_call_log (case_id, by_user, who, choice, note)
  values (c.id, auth.uid(), 'agent', p_choice,
          nullif(btrim(coalesce(v_note, '') || case when p_choice = 'call_later'
            then ' (ring at ' || to_char(p_call_back at time zone 'Asia/Karachi', 'DD Mon HH24:MI') || ')' else '' end), ''));

  update online_call_cases set
    calls = calls + 1, last_call_at = now(),
    agent_choice = p_choice, agent_note = coalesce(v_note, agent_note),
    agent_by = auth.uid(), agent_at = now(),
    call_back_at = case when p_choice = 'call_later' then p_call_back
                        when p_choice = 'no_answer' then now() + interval '2 hours' else null end,
    status = case when p_choice = 'call_later' then 'to_call'
                  when p_choice = 'no_answer' and calls + 1 < s.max_no_answer then 'to_call'
                  else 'to_office' end,
    updated_at = now()
  where id = c.id;

  return jsonb_build_object('ok', true);
end $$;

-------------------------------------------------------------------------------
-- 9. The office's decision
-------------------------------------------------------------------------------
create or replace function hub_call_decide(p_id bigint, p_action text, p_note text default null,
                                           p_new_order text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c online_call_cases; v_no text := hub_call_norm_order(p_new_order); v_store text;
        v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not hub_call_may_manage() then return jsonb_build_object('ok', false, 'error', 'Only the office decides these.'); end if;
  select * into c from online_call_cases where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Not found.'); end if;

  if p_action = 'recall' then
    if c.status not in ('to_office', 'waiting') then return jsonb_build_object('ok', false, 'error', 'Only an open answer can go back to the agent.'); end if;
    update online_call_cases set status = 'to_call', call_back_at = null, updated_at = now() where id = c.id;
    insert into online_call_log (case_id, by_user, who, choice, note) values (c.id, auth.uid(), 'office', 'recall', v_note);
    return jsonb_build_object('ok', true);
  end if;

  if p_action = 'undo' then
    if c.status <> 'done' then return jsonb_build_object('ok', false, 'error', 'Only a decided call can be undone.'); end if;
    update online_call_cases set status = 'to_office', office_action = null, office_by = null, office_at = null,
           office_note = null, result_order_number = null, result_store_code = null, updated_at = now() where id = c.id;
    insert into online_call_log (case_id, by_user, who, choice, note) values (c.id, auth.uid(), 'office', 'undo', v_note);
    return jsonb_build_object('ok', true);
  end if;

  if p_action not in ('create_order', 'cancel_order', 'wait') then
    return jsonb_build_object('ok', false, 'error', 'Create order, Cancel order or Wait.');
  end if;
  if c.status not in ('to_office', 'waiting') then
    return jsonb_build_object('ok', false, 'error', 'This one is not waiting for the office.');
  end if;

  if p_action = 'create_order' then
    if c.kind = 'archive' then
      v_no := coalesce(v_no, c.order_number);   -- the same order, un-archived and shipped
    elsif v_no is null then
      return jsonb_build_object('ok', false, 'error', 'Type the NEW order number you created, so the agent''s bonus follows it.');
    end if;
    select o.store_code into v_store from online_orders o where o.order_number = v_no order by o.id desc limit 1;
    if v_store is null then
      return jsonb_build_object('ok', false, 'error', v_no || ' is not in the system yet. Create it in Shopify first, wait a minute, then try again.');
    end if;
    if exists (select 1 from online_call_cases x where x.id <> c.id and x.result_order_number = v_no and x.result_store_code = v_store) then
      return jsonb_build_object('ok', false, 'error', v_no || ' is already linked to another call.');
    end if;
  end if;

  update online_call_cases set
    office_action = p_action, office_note = coalesce(v_note, office_note),
    office_by = auth.uid(), office_at = now(),
    status = case when p_action = 'wait' then 'waiting' else 'done' end,
    result_order_number = case when p_action = 'create_order' then v_no end,
    result_store_code   = case when p_action = 'create_order' then v_store end,
    updated_at = now()
  where id = c.id;
  insert into online_call_log (case_id, by_user, who, choice, note)
  values (c.id, auth.uid(), 'office', p_action, nullif(concat_ws(' — ', v_note, case when p_action = 'create_order' then v_no end), ''));

  return jsonb_build_object('ok', true, 'order', v_no);
end $$;

-------------------------------------------------------------------------------
-- 10. Bonus
--   Rs <bonus_amount> per parcel the agent worked that is Delivered AND in a
--   CPR / invoice. Counted in the month the money came in. Two sources:
--     * calls the office turned into an order (archive or return)
--     * Delivery Under Review parcels the agent sent for re-attempt
--   Only people holding hub.calling.work through a role are counted.
-------------------------------------------------------------------------------
create or replace function hub_call_bonus(p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s online_call_settings; v_from date; v_to date; v_manage boolean := hub_call_may_manage();
        v_lines jsonb; v_people jsonb;
begin
  if not hub_call_may_work() then return jsonb_build_object('ok', false, 'error', 'Not open to you.'); end if;
  select * into s from online_call_settings where id = 1;
  v_from := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Karachi')::date))::date;
  v_to := (v_from + interval '1 month')::date;

  drop table if exists _b;
  create temp table _b on commit drop as
  with calls as (
    select c.agent_by as agent, c.kind as source, c.order_number as worked_order,
           c.result_order_number as order_number, c.result_store_code as store_code, c.office_at as worked_at
      from online_call_cases c
     where c.office_action = 'create_order' and c.status = 'done' and c.agent_by is not null
       and c.result_order_number is not null
  ), dur as (
    select r.decided_by as agent, 'review'::text as source, r.order_number as worked_order,
           r.order_number, r.store_code, r.decided_at as worked_at, r.tracking_id as only_tracking
      from online_rescue_cases r
     where r.decision = 'reattempt' and r.decided_via = 'desk' and r.decided_by is not null
       and r.decided_at >= s.starts_on
  ), parcels as (
    select k.agent, k.source, k.worked_order, k.order_number, k.store_code, k.worked_at, ps.*
      from calls k cross join lateral hub_call_parcel_state(k.store_code, k.order_number) ps
    union all
    select d.agent, d.source, d.worked_order, d.order_number, d.store_code, d.worked_at, ps.*
      from dur d cross join lateral hub_call_parcel_state(d.store_code, d.order_number) ps
     where ps.tracking_id = d.only_tracking
  )
  select p.*, case when p.state = 'earned' then s.bonus_amount else 0 end as amount
    from parcels p
   where hub_call_user_has(p.agent, 'hub.calling.work')
     and (v_manage or p.agent = auth.uid());

  select coalesce(jsonb_agg(jsonb_build_object(
           'agent', (select u.full_name from app_users u where u.id = b.agent),
           'source', b.source, 'worked_order', b.worked_order, 'order_number', b.order_number,
           'tracking_id', b.tracking_id, 'courier', b.courier, 'delivery_status', b.delivery_status,
           'cpr_number', b.cpr_number, 'earned_on', b.earned_on, 'state', b.state, 'amount', b.amount,
           'worked_at', b.worked_at) order by b.earned_on desc nulls first, b.worked_at desc), '[]'::jsonb)
    into v_lines
    from _b b
   where (b.state = 'earned' and b.earned_on >= v_from and b.earned_on < v_to)
      or (b.state = 'pending')
      or (b.state = 'lost' and b.worked_at >= v_from and b.worked_at < v_to);

  select coalesce(jsonb_agg(x order by x->>'agent'), '[]'::jsonb) into v_people from (
    select jsonb_build_object(
      'agent', (select u.full_name from app_users u where u.id = b.agent),
      'earned_parcels', count(*) filter (where b.state = 'earned' and b.earned_on >= v_from and b.earned_on < v_to),
      'earned', coalesce(sum(b.amount) filter (where b.state = 'earned' and b.earned_on >= v_from and b.earned_on < v_to), 0),
      'pending_parcels', count(*) filter (where b.state = 'pending'),
      'pending', count(*) filter (where b.state = 'pending') * s.bonus_amount,
      'lost_parcels', count(*) filter (where b.state = 'lost' and b.worked_at >= v_from and b.worked_at < v_to)) as x
      from _b b group by b.agent) y;

  return jsonb_build_object('ok', true, 'month', v_from, 'bonus_amount', s.bonus_amount,
                            'starts_on', s.starts_on, 'may_manage', v_manage,
                            'people', v_people, 'lines', v_lines);
end $$;

create or replace function hub_call_settings_set(p_amount numeric, p_starts date) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not hub_call_may_manage() then return jsonb_build_object('ok', false, 'error', 'Only the office changes this.'); end if;
  if p_amount is null or p_amount < 0 then return jsonb_build_object('ok', false, 'error', 'Bonus must be zero or more.'); end if;
  update online_call_settings set bonus_amount = p_amount, starts_on = coalesce(p_starts, starts_on),
         updated_at = now(), updated_by = auth.uid() where id = 1;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function hub_call_refresh() from public, anon, authenticated;
revoke all on function hub_call_user_has(uuid, text) from public, anon, authenticated;
revoke all on function hub_call_parcel_state(text, text) from public, anon, authenticated;
revoke all on function hub_call_items(bigint) from public, anon, authenticated;
revoke all on function hub_call_board(text, int), hub_call_answer(bigint, text, text, timestamptz),
  hub_call_decide(bigint, text, text, text), hub_call_bonus(date), hub_call_settings_set(numeric, date)
  from public, anon;
grant execute on function hub_call_board(text, int), hub_call_answer(bigint, text, text, timestamptz),
  hub_call_decide(bigint, text, text, text), hub_call_bonus(date), hub_call_settings_set(numeric, date),
  hub_call_may_work(), hub_call_may_manage() to authenticated;

commit;
