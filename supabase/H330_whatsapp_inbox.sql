-- ============================================================================
-- H330 — WhatsApp inbox in the Hub
--
-- Every WhatsApp message that goes out (order confirmations, dispatch notes,
-- replies typed by staff) and every one that comes in (button taps, text,
-- voice notes, pictures) is one row in online_wa_messages. online_wa_chats is
-- one row per customer number, kept up to date by trigger, so the chat list
-- is a single indexed read instead of a GROUP BY over every message.
--
-- Writers:  wa-meta     (inbound + delivery/read ticks)       service role
--           wa-shopify  (order_confirmation / order_shipped)  service role
--           wa-send     (staff replies, templates, read)      service role,
--                       after checking the caller holds hub.whatsapp.reply
-- Readers:  the Hub inbox, through RLS (hub.whatsapp.view) and Realtime.
--
-- Rollback: supabase/H330_rollback.sql
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. Tables
-------------------------------------------------------------------------------
create table if not exists online_wa_chats (
  phone        text primary key,            -- E.164 digits, no plus: 923001234567
  name         text,                        -- WhatsApp profile name, else Shopify name
  store_code   text,                        -- store of the latest message
  last_text    text,
  last_dir     text,                        -- in | out
  last_status  text,
  last_at      timestamptz,
  last_in_at   timestamptz,                 -- opens the 24-hour reply window
  unread       integer not null default 0,
  pinned       boolean not null default false,
  archived     boolean not null default false,
  order_id     text,
  order_name   text,
  created_at   timestamptz not null default now()
);
create index if not exists online_wa_chats_last_idx on online_wa_chats (last_at desc);

create table if not exists online_wa_messages (
  id            bigserial primary key,
  phone         text not null,
  store_code    text,
  dir           text not null check (dir in ('in', 'out')),
  kind          text not null default 'text',   -- text | template | button | image | audio | video | document | sticker | location | reaction | unsupported
  body          text,
  template      text,
  buttons       jsonb,                          -- quick-reply labels shown under a template
  media_path    text,                           -- object in storage bucket wa-media
  media_mime    text,
  media_name    text,
  reply_to      text,                           -- wa id of the message this answers
  wa_id         text unique,
  status        text,                           -- out: sent | delivered | read | failed   in: received
  error         text,
  order_id      text,
  order_name    text,
  sent_by       uuid,
  sent_by_name  text,
  at            timestamptz not null default now()
);
create index if not exists online_wa_messages_phone_idx on online_wa_messages (phone, at desc);

-------------------------------------------------------------------------------
-- 2. Chat row follows its messages
-------------------------------------------------------------------------------
create or replace function online_wa_chat_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  preview text := coalesce(nullif(new.body, ''),
    case new.kind when 'image' then '📷 Photo' when 'audio' then '🎤 Voice message' when 'video' then '🎥 Video'
                  when 'document' then '📄 ' || coalesce(new.media_name, 'Document') when 'sticker' then 'Sticker'
                  when 'location' then '📍 Location' else '[' || new.kind || ']' end);
begin
  if new.kind = 'reaction' then return new; end if;
  insert into online_wa_chats as c (phone, store_code, last_text, last_dir, last_status, last_at, last_in_at, unread, order_id, order_name)
  values (new.phone, new.store_code, left(preview, 200), new.dir, new.status, new.at,
          case when new.dir = 'in' then new.at end,
          case when new.dir = 'in' then 1 else 0 end, new.order_id, new.order_name)
  on conflict (phone) do update set
    -- A late-arriving older message must not replace the preview of a newer one.
    store_code  = case when new.at >= coalesce(c.last_at, '-infinity') then coalesce(excluded.store_code, c.store_code) else c.store_code end,
    last_text   = case when new.at >= coalesce(c.last_at, '-infinity') then excluded.last_text   else c.last_text end,
    last_dir    = case when new.at >= coalesce(c.last_at, '-infinity') then excluded.last_dir    else c.last_dir end,
    last_status = case when new.at >= coalesce(c.last_at, '-infinity') then excluded.last_status else c.last_status end,
    last_at     = greatest(new.at, coalesce(c.last_at, new.at)),
    last_in_at  = case when new.dir = 'in' then greatest(new.at, coalesce(c.last_in_at, new.at)) else c.last_in_at end,
    unread      = case when new.dir = 'in' then c.unread + 1 else c.unread end,
    archived    = case when new.dir = 'in' then false else c.archived end,
    order_id    = case when new.at >= coalesce(c.last_at, '-infinity') then coalesce(excluded.order_id, c.order_id) else coalesce(c.order_id, excluded.order_id) end,
    order_name  = case when new.at >= coalesce(c.last_at, '-infinity') then coalesce(excluded.order_name, c.order_name) else coalesce(c.order_name, excluded.order_name) end;
  return new;
end $$;

drop trigger if exists online_wa_messages_touch on online_wa_messages;
create trigger online_wa_messages_touch after insert on online_wa_messages
  for each row execute function online_wa_chat_touch();

-- Ticks on the chat list follow the latest message only.
create or replace function online_wa_chat_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    update online_wa_chats set last_status = new.status
     where phone = new.phone and last_at = new.at and last_dir = 'out';
  end if;
  return new;
end $$;

drop trigger if exists online_wa_messages_status on online_wa_messages;
create trigger online_wa_messages_status after update of status on online_wa_messages
  for each row execute function online_wa_chat_status();

-------------------------------------------------------------------------------
-- 3. Permissions
-------------------------------------------------------------------------------
insert into permissions (code, module, description) values
  ('hub.whatsapp.view',  'hub', 'Open the WhatsApp inbox and read customer chats'),
  ('hub.whatsapp.reply', 'hub', 'Reply to customers on WhatsApp and send templates')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
 where r.name in ('Super Administrator', 'Administrator') and p.code in ('hub.whatsapp.view', 'hub.whatsapp.reply')
   and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);

-------------------------------------------------------------------------------
-- 4. Row security — read only, and only with the inbox key
-------------------------------------------------------------------------------
alter table online_wa_chats    enable row level security;
alter table online_wa_messages enable row level security;

drop policy if exists wa_chats_read on online_wa_chats;
create policy wa_chats_read on online_wa_chats for select to authenticated
  using ((select has_permission('hub.whatsapp.view')));

drop policy if exists wa_messages_read on online_wa_messages;
create policy wa_messages_read on online_wa_messages for select to authenticated
  using ((select has_permission('hub.whatsapp.view')));

-- Live updates for the inbox. Realtime applies the policies above.
do $$ begin
  begin alter publication supabase_realtime add table online_wa_messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table online_wa_chats;    exception when duplicate_object then null; end;
end $$;

-------------------------------------------------------------------------------
-- 5. Media bucket — pictures, voice notes, documents customers send
-------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('wa-media', 'wa-media', false, 104857600)
on conflict (id) do nothing;

drop policy if exists wa_media_read on storage.objects;
create policy wa_media_read on storage.objects for select to authenticated
  using (bucket_id = 'wa-media' and (select has_permission('hub.whatsapp.view')));

-------------------------------------------------------------------------------
-- 6. Small actions from the inbox
-------------------------------------------------------------------------------
create or replace function hub_wa_mark_read(p_phone text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('hub.whatsapp.view') then raise exception 'not allowed'; end if;
  update online_wa_chats set unread = 0 where phone = p_phone and unread <> 0;
end $$;

create or replace function hub_wa_chat_flag(p_phone text, p_pinned boolean default null, p_archived boolean default null, p_unread boolean default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('hub.whatsapp.view') then raise exception 'not allowed'; end if;
  update online_wa_chats set
    pinned   = coalesce(p_pinned, pinned),
    archived = coalesce(p_archived, archived),
    unread   = case when p_unread is true then greatest(unread, 1) when p_unread is false then 0 else unread end
   where phone = p_phone;
end $$;

/* The customer behind a number: every LM / TS / TRZ order on it, newest first,
   with the parcel state, so staff answer "where is my parcel" without leaving
   the chat. Matched on the last 10 digits — Shopify numbers come in every shape. */
create or replace function hub_wa_customer(p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  tail text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  res jsonb;
begin
  if not has_permission('hub.whatsapp.view') then return jsonb_build_object('ok', false, 'error', 'not allowed'); end if;
  if length(tail) < 10 then return jsonb_build_object('ok', true, 'orders', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object(
      'order_number', o.order_number, 'store_code', o.store_code, 'customer_name', o.customer_name,
      'city', o.city, 'address', o.address, 'amount', o.amount, 'product', o.product,
      'created_at', coalesce(o.shopify_created_at, o.created_at),
      'fulfillment_status', o.fulfillment_status, 'cancelled', o.cancelled_at is not null,
      'archived', o.closed_at is not null, 'tags', o.tags,
      'tracking_id', l.tracking_id, 'courier', l.courier, 'delivery_status', l.delivery_status
    ) x
    from online_orders o
    left join lateral (
      select lg.tracking_id, lg.courier, lg.delivery_status from online_logistics lg
       where lg.order_number = o.order_number and lg.store_code = o.store_code order by lg.id desc limit 1
    ) l on true
    where right(regexp_replace(coalesce(o.phone_e164, o.phone, ''), '\D', '', 'g'), 10) = tail
    order by coalesce(o.shopify_created_at, o.created_at) desc
    limit 15
  ) s;
  return jsonb_build_object('ok', true, 'orders', res);
end $$;

grant execute on function hub_wa_mark_read(text) to authenticated;
grant execute on function hub_wa_chat_flag(text, boolean, boolean, boolean) to authenticated;
grant execute on function hub_wa_customer(text) to authenticated;

-------------------------------------------------------------------------------
-- 7. Bring in the replies already received
-------------------------------------------------------------------------------
insert into online_wa_messages (phone, store_code, dir, kind, body, wa_id, status, order_id, at)
select e.phone, e.store_code, 'in',
       case when e.status in ('confirm', 'cancel') then 'button' else 'text' end,
       e.body, e.wa_message_id, 'received', e.shopify_order_id, e.created_at
  from online_wa_events e
 where e.kind = 'reply' and e.phone is not null and e.wa_message_id is not null
on conflict (wa_id) do nothing;
