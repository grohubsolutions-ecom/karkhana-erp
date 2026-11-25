-- K200_hub_daraz.sql
--
-- DARAZ INSIDE THE HUB, FED BY FILES.
--
-- Daraz's Open API costs money, so nothing here talks to Daraz. Two exports
-- from Seller Center are uploaded instead:
--
--   1. ORDERS export (Orders → Manage Orders → Export) — one row per ORDER ITEM.
--      Upserted on order_item_id, so re-uploading a newer export simply moves
--      each item to its latest status.
--   2. ACCOUNT STATEMENT / TRANSACTIONS export (Finance → Account Statements →
--      Export) — one row per fee or credit. Keyed on a hash built in the
--      browser from the line's own fields (never paid status), so the same
--      statement uploaded twice adds nothing, and a later export flips
--      "Not paid" lines to "Paid" in place.
--
-- Daraz delivers its own parcels and pays out by statement, so these tables
-- are deliberately separate from online_orders / online_logistics: the Shopify
-- sync, courier syncs, CPR matching and write-backs never see a Daraz row.
--
-- Permissions: hub.daraz.view (read) and hub.daraz.manage (upload).
-- Safe to run more than once.

begin;

-- ── permissions & role ────────────────────────────────────────────────────
insert into permissions (code, module, description) values
  ('hub.daraz.view',   'hub', 'View Daraz orders, statements and payouts'),
  ('hub.daraz.manage', 'hub', 'Upload Daraz order and statement exports')
on conflict (code) do nothing;

insert into roles (code, name, description, is_system)
values ('daraz_manager', 'Daraz Manager', 'Runs the Daraz store inside the Hub: orders, statements, payouts', false)
on conflict do nothing;

-- Daraz Manager gets both; Administrator / Super Administrator (anyone who
-- already manages users or roles) get them too, as with 0090.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
 where p.code in ('hub.daraz.view', 'hub.daraz.manage')
   and (r.code = 'daraz_manager' or exists (
        select 1 from role_permissions rp join permissions ap on ap.id = rp.permission_id
         where rp.role_id = r.id and ap.code in ('users.manage', 'roles.manage')))
on conflict do nothing;

-- ── status grouping ───────────────────────────────────────────────────────
create or replace function daraz_status_group(p text)
returns text language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then 'Pending'
    when lower(p) ~ 'cancel'                                          then 'Cancelled'
    when lower(p) ~ '(return|fail|back to seller|lost|damage|refus)'   then 'Returned'
    when lower(p) ~ '(deliver|confirmed|complete)'                     then 'Delivered'
    when lower(p) ~ '(shipped|transit|out for|handed|dispatch)'        then 'Shipped'
    else 'Pending'
  end
$$;

-- ── tables ────────────────────────────────────────────────────────────────
create table if not exists daraz_imports (
  id           bigserial primary key,
  kind         text not null check (kind in ('orders', 'statement')),
  file_name    text,
  row_count    int  not null default 0,
  inserted     int  not null default 0,
  updated      int  not null default 0,
  imported_by  uuid default auth.uid(),
  imported_at  timestamptz not null default now()
);

create table if not exists daraz_order_items (
  order_item_id     text primary key,
  order_number      text not null,
  created_at_dz     timestamptz,
  order_date        date,
  updated_at_dz     timestamptz,
  seller_sku        text,
  shop_sku          text,
  item_name         text,
  variation         text,
  unit_price        numeric(12,2) not null default 0,
  paid_price        numeric(12,2) not null default 0,
  seller_discount   numeric(12,2) not null default 0,
  shipping_fee      numeric(12,2) not null default 0,
  customer_name     text,
  phone             text,
  city              text,
  address           text,
  payment_method    text,
  shipping_provider text,
  tracking_code     text,
  status            text,
  status_group      text generated always as (daraz_status_group(status)) stored,
  reason            text,
  raw               jsonb,
  import_id         bigint references daraz_imports(id) on delete set null,
  first_seen_at     timestamptz not null default now(),
  imported_at       timestamptz not null default now()
);
create index if not exists daraz_items_order_idx  on daraz_order_items (order_number);
create index if not exists daraz_items_date_idx   on daraz_order_items (order_date);
create index if not exists daraz_items_status_idx on daraz_order_items (status_group);

create table if not exists daraz_statement_lines (
  line_key        text primary key,
  txn_date        date,
  txn_type        text,
  fee_name        text,
  txn_number      text,
  details         text,
  seller_sku      text,
  amount          numeric(12,2) not null default 0,
  vat             numeric(12,2),
  wht             numeric(12,2),
  statement       text,
  paid_status     text,
  is_paid         boolean generated always as (lower(btrim(coalesce(paid_status, ''))) in ('paid', 'yes', 'settled', 'released')) stored,
  order_number    text,
  order_item_id   text,
  item_status     text,
  reference       text,
  raw             jsonb,
  import_id       bigint references daraz_imports(id) on delete set null,
  imported_at     timestamptz not null default now()
);
create index if not exists daraz_lines_order_idx on daraz_statement_lines (order_number);
create index if not exists daraz_lines_date_idx  on daraz_statement_lines (txn_date);

-- ── RLS: read with view/manage, write only through the functions below ───
alter table daraz_imports         enable row level security;
alter table daraz_order_items     enable row level security;
alter table daraz_statement_lines enable row level security;

do $$ begin
  drop policy if exists daraz_imports_read on daraz_imports;
  drop policy if exists daraz_items_read   on daraz_order_items;
  drop policy if exists daraz_lines_read   on daraz_statement_lines;
end $$;
create policy daraz_imports_read on daraz_imports for select to authenticated
  using ((select has_permission('hub.daraz.view')) or (select has_permission('hub.daraz.manage')));
create policy daraz_items_read on daraz_order_items for select to authenticated
  using ((select has_permission('hub.daraz.view')) or (select has_permission('hub.daraz.manage')));
create policy daraz_lines_read on daraz_statement_lines for select to authenticated
  using ((select has_permission('hub.daraz.view')) or (select has_permission('hub.daraz.manage')));

-- ── per-order view: items rolled up + what the statement says about it ───
create or replace view daraz_orders_v with (security_invoker = true) as
with items as (
  select order_number,
         min(order_date)                          as order_date,
         min(created_at_dz)                       as created_at_dz,
         max(updated_at_dz)                       as updated_at_dz,
         max(customer_name)                       as customer_name,
         max(phone)                               as phone,
         max(city)                                as city,
         max(payment_method)                      as payment_method,
         max(shipping_provider)                   as shipping_provider,
         max(tracking_code)                       as tracking_code,
         count(*)                                 as items,
         sum(unit_price)                          as item_value,
         -- cancelled items are not sales; an all-cancelled order still shows what it was
         coalesce(sum(paid_price) filter (where status_group <> 'Cancelled'), sum(paid_price)) as paid_value,
         sum(seller_discount)                     as seller_discount,
         string_agg(distinct coalesce(seller_sku, item_name), ', ') as skus,
         case when bool_or(status_group = 'Pending')   then 'Pending'
              when bool_or(status_group = 'Shipped')   then 'Shipped'
              when bool_or(status_group = 'Delivered') then 'Delivered'
              when bool_or(status_group = 'Returned')  then 'Returned'
              else 'Cancelled' end                as status_group,
         string_agg(distinct status, ', ')        as status,
         max(reason)                              as reason
    from daraz_order_items group by order_number
), money as (
  select order_number,
         count(*)                                                        as lines,
         sum(amount)                                                     as net,
         sum(amount) filter (where amount > 0 and fee_name ~* 'item price') as sales_credit,
         sum(amount) filter (where amount < 0 and fee_name ~* 'reversal')   as reversals,
         sum(amount) filter (where amount < 0 and fee_name !~* 'reversal')  as fees,
         sum(amount) filter (where is_paid)                              as paid_net,
         sum(amount) filter (where not is_paid)                          as unpaid_net,
         bool_and(is_paid)                                               as all_paid,
         bool_or(is_paid)                                                as any_paid,
         max(statement)                                                  as statement,
         max(txn_date)                                                   as last_txn
    from daraz_statement_lines where order_number is not null group by order_number
)
select i.*,
       coalesce(m.lines, 0)        as statement_lines,
       coalesce(m.net, 0)          as net_payout,
       coalesce(m.sales_credit, 0) as sales_credit,
       coalesce(m.fees, 0)         as fees,
       coalesce(m.reversals, 0)    as reversals,
       coalesce(m.paid_net, 0)     as paid_net,
       coalesce(m.unpaid_net, 0)   as unpaid_net,
       m.statement, m.last_txn,
       case when m.lines is null then 'Not in statement'
            when m.all_paid       then 'Paid'
            when m.any_paid       then 'Part paid'
            else 'In statement · unpaid' end as settlement
  from items i left join money m using (order_number);

-- ── import: orders ────────────────────────────────────────────────────────
create or replace function daraz_import_orders(p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_import bigint; v_ins int := 0; v_upd int := 0; v_total int;
begin
  if not has_permission('hub.daraz.manage') then
    raise exception 'You do not have permission to upload Daraz files';
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  if v_total = 0 then raise exception 'The file has no order rows'; end if;

  insert into daraz_imports (kind, file_name, row_count) values ('orders', p_file, v_total) returning id into v_import;

  with src as (
    select * from jsonb_to_recordset(p_rows) as r(
      order_item_id text, order_number text, created_at_dz timestamptz, updated_at_dz timestamptz,
      seller_sku text, shop_sku text, item_name text, variation text,
      unit_price numeric, paid_price numeric, seller_discount numeric, shipping_fee numeric,
      customer_name text, phone text, city text, address text, payment_method text,
      shipping_provider text, tracking_code text, status text, reason text, raw jsonb)
    where nullif(btrim(order_item_id), '') is not null and nullif(btrim(order_number), '') is not null
  ), up as (
    insert into daraz_order_items as t (
      order_item_id, order_number, created_at_dz, order_date, updated_at_dz, seller_sku, shop_sku,
      item_name, variation, unit_price, paid_price, seller_discount, shipping_fee, customer_name,
      phone, city, address, payment_method, shipping_provider, tracking_code, status, reason, raw, import_id)
    select order_item_id, order_number, created_at_dz, (created_at_dz at time zone 'Asia/Karachi')::date,
           updated_at_dz, seller_sku, shop_sku, item_name, variation,
           coalesce(unit_price, 0), coalesce(paid_price, 0), coalesce(seller_discount, 0), coalesce(shipping_fee, 0),
           customer_name, phone, city, address, payment_method, shipping_provider, tracking_code, status, reason, raw, v_import
      from (select distinct on (order_item_id) * from src order by order_item_id, updated_at_dz desc nulls last) s
    on conflict (order_item_id) do update set
      order_number      = excluded.order_number,
      created_at_dz     = coalesce(excluded.created_at_dz, t.created_at_dz),
      order_date        = coalesce(excluded.order_date, t.order_date),
      updated_at_dz     = coalesce(excluded.updated_at_dz, t.updated_at_dz),
      seller_sku        = coalesce(excluded.seller_sku, t.seller_sku),
      shop_sku          = coalesce(excluded.shop_sku, t.shop_sku),
      item_name         = coalesce(excluded.item_name, t.item_name),
      variation         = coalesce(excluded.variation, t.variation),
      unit_price        = excluded.unit_price,
      paid_price        = excluded.paid_price,
      seller_discount   = excluded.seller_discount,
      shipping_fee      = excluded.shipping_fee,
      customer_name     = coalesce(excluded.customer_name, t.customer_name),
      phone             = coalesce(excluded.phone, t.phone),
      city              = coalesce(excluded.city, t.city),
      address           = coalesce(excluded.address, t.address),
      payment_method    = coalesce(excluded.payment_method, t.payment_method),
      shipping_provider = coalesce(excluded.shipping_provider, t.shipping_provider),
      tracking_code     = coalesce(excluded.tracking_code, t.tracking_code),
      -- an older export must not drag an item back to an earlier status
      status            = case when t.updated_at_dz is not null and excluded.updated_at_dz is not null
                                and excluded.updated_at_dz < t.updated_at_dz then t.status
                               else coalesce(excluded.status, t.status) end,
      reason            = coalesce(excluded.reason, t.reason),
      raw               = excluded.raw,
      import_id         = excluded.import_id,
      imported_at       = now()
    returning (xmax = 0) as is_new
  )
  select count(*) filter (where is_new), count(*) filter (where not is_new) into v_ins, v_upd from up;

  update daraz_imports set inserted = v_ins, updated = v_upd where id = v_import;
  return jsonb_build_object('import_id', v_import, 'rows', v_total, 'inserted', v_ins, 'updated', v_upd,
                            'skipped', v_total - v_ins - v_upd);
end $$;

-- ── import: account statement ─────────────────────────────────────────────
create or replace function daraz_import_statement(p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_import bigint; v_ins int := 0; v_upd int := 0; v_total int;
begin
  if not has_permission('hub.daraz.manage') then
    raise exception 'You do not have permission to upload Daraz files';
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  if v_total = 0 then raise exception 'The file has no statement rows'; end if;

  insert into daraz_imports (kind, file_name, row_count) values ('statement', p_file, v_total) returning id into v_import;

  with src as (
    select * from jsonb_to_recordset(p_rows) as r(
      line_key text, txn_date date, txn_type text, fee_name text, txn_number text, details text,
      seller_sku text, amount numeric, vat numeric, wht numeric, statement text, paid_status text,
      order_number text, order_item_id text, item_status text, reference text, raw jsonb)
    where nullif(btrim(line_key), '') is not null
  ), up as (
    insert into daraz_statement_lines as t (
      line_key, txn_date, txn_type, fee_name, txn_number, details, seller_sku, amount, vat, wht,
      statement, paid_status, order_number, order_item_id, item_status, reference, raw, import_id)
    select distinct on (line_key)
           line_key, txn_date, txn_type, fee_name, txn_number, details, seller_sku, coalesce(amount, 0), vat, wht,
           statement, paid_status, nullif(btrim(order_number), ''), nullif(btrim(order_item_id), ''),
           item_status, reference, raw, v_import
      from src
    on conflict (line_key) do update set
      paid_status = coalesce(excluded.paid_status, t.paid_status),
      statement   = coalesce(excluded.statement, t.statement),
      item_status = coalesce(excluded.item_status, t.item_status),
      raw         = excluded.raw,
      import_id   = excluded.import_id,
      imported_at = now()
    returning (xmax = 0) as is_new
  )
  select count(*) filter (where is_new), count(*) filter (where not is_new) into v_ins, v_upd from up;

  update daraz_imports set inserted = v_ins, updated = v_upd where id = v_import;
  return jsonb_build_object('import_id', v_import, 'rows', v_total, 'inserted', v_ins, 'updated', v_upd,
                            'skipped', v_total - v_ins - v_upd);
end $$;

-- ── figures (security invoker: RLS decides what is counted) ───────────────
create or replace function daraz_summary(p_from date, p_to date)
returns table (
  orders bigint, items bigint, gross numeric, avg_order numeric,
  pending bigint, shipped bigint, delivered bigint, cancelled bigint, returned bigint,
  delivered_value numeric, delivery_rate numeric,
  net_payout numeric, sales_credit numeric, fees numeric, reversals numeric,
  paid_net numeric, unpaid_net numeric,
  awaiting_count bigint, awaiting_value numeric
) language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*), coalesce(sum(o.items), 0), coalesce(sum(o.paid_value), 0),
         coalesce(round(avg(o.paid_value), 0), 0),
         count(*) filter (where o.status_group = 'Pending'),
         count(*) filter (where o.status_group = 'Shipped'),
         count(*) filter (where o.status_group = 'Delivered'),
         count(*) filter (where o.status_group = 'Cancelled'),
         count(*) filter (where o.status_group = 'Returned'),
         coalesce(sum(o.paid_value) filter (where o.status_group = 'Delivered'), 0),
         case when count(*) filter (where o.status_group in ('Delivered', 'Returned')) = 0 then 0
              else round(100.0 * count(*) filter (where o.status_group = 'Delivered')
                   / count(*) filter (where o.status_group in ('Delivered', 'Returned')), 1) end,
         coalesce(sum(o.net_payout), 0), coalesce(sum(o.sales_credit), 0),
         coalesce(sum(o.fees), 0), coalesce(sum(o.reversals), 0),
         coalesce(sum(o.paid_net), 0), coalesce(sum(o.unpaid_net), 0),
         count(*) filter (where o.status_group = 'Delivered' and o.settlement = 'Not in statement'),
         coalesce(sum(o.paid_value) filter (where o.status_group = 'Delivered' and o.settlement = 'Not in statement'), 0)
    from daraz_orders_v o
   where (p_from is null or o.order_date >= p_from) and (p_to is null or o.order_date <= p_to)
$$;

create or replace function daraz_fee_breakdown(p_from date, p_to date)
returns table (fee_name text, lines bigint, amount numeric, paid numeric, unpaid numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(nullif(btrim(l.fee_name), ''), coalesce(l.txn_type, 'Other')),
         count(*), sum(l.amount),
         coalesce(sum(l.amount) filter (where l.is_paid), 0),
         coalesce(sum(l.amount) filter (where not l.is_paid), 0)
    from daraz_statement_lines l
   where (p_from is null or l.txn_date >= p_from) and (p_to is null or l.txn_date <= p_to)
   group by 1 order by abs(sum(l.amount)) desc
$$;

create or replace function daraz_statements(p_from date, p_to date)
returns table (statement text, first_txn date, last_txn date, lines bigint, orders bigint,
               credits numeric, debits numeric, net numeric, paid boolean)
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(nullif(btrim(l.statement), ''), 'No statement period'),
         min(l.txn_date), max(l.txn_date), count(*), count(distinct l.order_number),
         coalesce(sum(l.amount) filter (where l.amount > 0), 0),
         coalesce(sum(l.amount) filter (where l.amount < 0), 0),
         sum(l.amount), bool_and(l.is_paid)
    from daraz_statement_lines l
   where (p_from is null or l.txn_date >= p_from) and (p_to is null or l.txn_date <= p_to)
   group by 1 order by max(l.txn_date) desc nulls last
$$;

grant select on daraz_orders_v to authenticated;
grant execute on function daraz_import_orders(text, jsonb), daraz_import_statement(text, jsonb),
  daraz_summary(date, date), daraz_fee_breakdown(date, date), daraz_statements(date, date) to authenticated;
revoke execute on function daraz_import_orders(text, jsonb), daraz_import_statement(text, jsonb) from anon, public;

commit;

-- Give Gohar the Daraz role (keeps his Employee role):
insert into user_roles (user_id, role_id)
select u.id, r.id from app_users u, roles r
 where u.email = '4k.gohar@gmail.com' and r.code = 'daraz_manager'
on conflict do nothing;
