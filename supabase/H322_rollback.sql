-- H322 rollback — removes the calling agent desk. Restores the H276 rescue keys.
begin;
drop trigger if exists online_orders_closed_from_event on online_shopify_events;
drop function if exists online_orders_closed_from_event();
drop function if exists hub_call_board(text, int, text);
drop function if exists hub_call_board(text, int);
drop function if exists hub_call_answer(bigint, text, text, timestamptz);
drop function if exists hub_call_decide(bigint, text, text, text);
drop function if exists hub_call_bonus(date);
drop function if exists hub_call_settings_set(numeric, date);
drop function if exists hub_call_refresh();
drop function if exists hub_call_parcel_state(text, text);
drop function if exists hub_call_items(bigint);
drop function if exists hub_call_phone10(text);
drop function if exists hub_call_norm_order(text);
drop function if exists hub_call_user_has(uuid, text);
drop function if exists hub_call_may_work();
drop function if exists hub_call_may_manage();
drop table if exists online_call_log;
drop table if exists online_call_cases;
drop table if exists online_call_settings;
create or replace function hub_rescue_may_see() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('returns.rescue'), false)
      or coalesce(has_permission('hub.logistics.view'), false)
      or coalesce(has_permission('hub.logistics.manage'), false);
$$;
create or replace function hub_rescue_may_work() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(has_permission('returns.rescue'), false)
      or coalesce(has_permission('hub.logistics.manage'), false);
$$;
delete from role_permissions where permission_id in (select id from permissions where code in ('hub.calling.work','hub.calling.manage'));
delete from user_roles where role_id in (select id from roles where code = 'calling_agent');
delete from role_permissions where role_id in (select id from roles where code = 'calling_agent');
delete from roles where code = 'calling_agent';
delete from permissions where code in ('hub.calling.work','hub.calling.manage');
-- online_orders.closed_at / closed_src_at are left in place (harmless, and other screens may start reading them).
commit;
