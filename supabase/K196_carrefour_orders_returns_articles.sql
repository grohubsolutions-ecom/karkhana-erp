/* ============================================================================
   K196 — Carrefour: the whole flow, with the barcode at the centre
   ----------------------------------------------------------------------------
   article + sample pass/reject -> LPO uploaded -> invoice -> delivered ->
   receiving number (100 sent, 98 received) -> sold -> matures -> or returned.

   ORDER STATUS IS WORKED OUT, NEVER TYPED, so it cannot disagree with the record:
     open       LPO received, no invoice yet
     pending    invoiced, no receiving number yet
     delivered  receiving number recorded
     cancelled  cancelled

   RETURNED STOCK IS NOT A SALE. K192 worked out sold as previous + sent -
   current, so stock lifted back looked sold. carrefour_compare now takes off
   returns delivered back to us in that period.

   Touches nothing in online_* or retail_*, employees or departments. Reads
   khana_* and never writes to it. Safe to run twice.
   ========================================================================= */
begin;

insert into public.permissions (code, module, description)
select v.code, 'carrefour', v.description
  from (values
    ('carrefour.orders.view',   'See Carrefour LPOs, returns and articles'),
    ('carrefour.orders.manage', 'Upload LPOs, invoices, receivings, returns and articles')) v(code, description)
 where not exists (select 1 from public.permissions p where p.code = v.code);

alter table public.carrefour_terms drop constraint if exists carrefour_terms_kind_check;
alter table public.carrefour_terms add constraint carrefour_terms_kind_check
  check (kind in ('front_margin','back_margin','rebate','supply_fee','margin_support','other'));
alter table public.carrefour_debit_notes drop constraint if exists carrefour_debit_notes_kind_check;
alter table public.carrefour_debit_notes add constraint carrefour_debit_notes_kind_check
  check (kind in ('front_margin','back_margin','rebate','supply_fee','margin_support','other'));

create or replace function public.carrefour_orders_guard()
returns void language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
begin
  if not (has_permission('carrefour.orders.view') or has_permission('carrefour.orders.manage')
          or has_permission('carrefour.accounts.view') or has_permission('carrefour.accounts.manage')) then
    raise exception 'You do not have permission to see Carrefour orders.';
  end if;
end;
$fn$;

create or replace function public.carrefour_orders_write_guard()
returns void language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
begin
  if not has_permission('carrefour.orders.manage') then
    raise exception 'You do not have permission to change Carrefour orders.';
  end if;
end;
$fn$;

/* ---------------------------------------------------------------- articles */
create table if not exists public.carrefour_articles (
  id            uuid primary key default gen_random_uuid(),
  barcode       text not null unique,
  item_no       text,
  name          text not null,
  section       text,
  item_id       uuid references public.khana_final_items(id) on delete set null,
  cp            numeric(14,2) check (cp >= 0),
  sp            numeric(14,2) check (sp >= 0),
  margin_pct    numeric(7,2) generated always as
                  (case when sp > 0 and cp is not null then round((sp - cp) / sp * 100, 2) end) stored,
  margin_kind   text not null default 'regular' check (margin_kind in ('regular','pg')),
  sample_status text not null default 'pending' check (sample_status in ('pending','pass','reject')),
  sample_date   date,
  sample_note   text,
  is_active     boolean not null default true,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_by    uuid,
  updated_at    timestamptz
);

drop trigger if exists carrefour_articles_stamp on public.carrefour_articles;
create trigger carrefour_articles_stamp before update on public.carrefour_articles
  for each row execute function public.carrefour_stamp();

/* Every barcode Carrefour already stocks. They are on its shelves, so their
   samples passed. PP on the report is the price Carrefour buys at. */
insert into public.carrefour_articles (barcode, name, item_id, cp, sample_status)
select distinct on (l.barcode) l.barcode, coalesce(l.article_name, l.barcode), l.item_id, l.retail_price, 'pass'
  from public.carrefour_report_lines l
 order by l.barcode, l.report_date desc
on conflict (barcode) do nothing;

/* A full barcode, or the short form Carrefour writes in emails (3127726) when
   exactly one article ends with it. */
create or replace function public.carrefour_article_for(p_barcode text)
returns uuid language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
declare v_bc text := regexp_replace(coalesce(p_barcode,''), '\s', '', 'g'); v_id uuid; v_n int;
begin
  if v_bc = '' then return null; end if;
  select id into v_id from carrefour_articles where barcode = v_bc;
  if v_id is not null then return v_id; end if;
  if v_bc ~ '^\d{6,}$' then
    select count(*), min(id::text)::uuid into v_n, v_id from carrefour_articles where barcode like '%' || v_bc;
    if v_n = 1 then return v_id; end if;
  end if;
  return null;
end;
$fn$;

/* Finds the article, creating it when the barcode is new. */
create or replace function public.carrefour_ensure_article(p_barcode text, p_name text, p_price numeric)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_bc text := regexp_replace(coalesce(p_barcode,''), '\s', '', 'g'); v_id uuid;
begin
  if v_bc = '' then raise exception 'A line has no barcode.'; end if;
  v_id := carrefour_article_for(v_bc);
  if v_id is null then
    insert into carrefour_articles (barcode, name, item_id, cp)
    values (v_bc, coalesce(nullif(trim(p_name),''), v_bc), carrefour_match_item(v_bc), p_price)
    returning id into v_id;
  end if;
  return v_id;
end;
$fn$;
revoke all on function public.carrefour_ensure_article(text,text,numeric) from public, anon, authenticated;

/* -------------------------------------------------------------------- LPOs */
create table if not exists public.carrefour_lpos (
  id             uuid primary key default gen_random_uuid(),
  lpo_no         text not null unique,
  branch_id      uuid not null references public.khana_party_branches(id),
  lpo_date       date,
  delivery_date  date,
  file_path      text,
  file_name      text,
  note           text,
  invoice_no     text,
  invoice_date   date,
  receiving_no   text,
  receiving_date date,
  receiving_path text,
  receiving_name text,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_by     uuid,
  updated_at     timestamptz
);
drop trigger if exists carrefour_lpos_stamp on public.carrefour_lpos;
create trigger carrefour_lpos_stamp before update on public.carrefour_lpos
  for each row execute function public.carrefour_stamp();

create table if not exists public.carrefour_lpo_lines (
  id           bigserial primary key,
  lpo_id       uuid not null references public.carrefour_lpos(id) on delete cascade,
  article_id   uuid not null references public.carrefour_articles(id),
  barcode      text not null,
  description  text,
  qty          numeric(14,3) not null check (qty > 0),
  price        numeric(14,2) not null check (price >= 0),
  received_qty numeric(14,3) check (received_qty >= 0)
);
create index if not exists carrefour_lpo_lines_lpo on public.carrefour_lpo_lines (lpo_id);

/* ----------------------------------------------------------------- returns */
create table if not exists public.carrefour_returns (
  id            uuid primary key default gen_random_uuid(),
  return_no     text,
  branch_id     uuid not null references public.khana_party_branches(id),
  return_date   date not null,
  reason        text not null default 'summer' check (reason in ('summer','aging','dp','no_sale','other')),
  status        text not null default 'pending' check (status in ('pending','delivered')),
  delivered_on  date,
  file_path     text,
  file_name     text,
  note          text,
  voided_at     timestamptz,
  void_reason   text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_by    uuid,
  updated_at    timestamptz
);
create unique index if not exists carrefour_returns_no
  on public.carrefour_returns (lower(trim(return_no)))
  where voided_at is null and return_no is not null and trim(return_no) <> '';
drop trigger if exists carrefour_returns_stamp on public.carrefour_returns;
create trigger carrefour_returns_stamp before update on public.carrefour_returns
  for each row execute function public.carrefour_stamp();

create table if not exists public.carrefour_return_lines (
  id          bigserial primary key,
  return_id   uuid not null references public.carrefour_returns(id) on delete cascade,
  article_id  uuid not null references public.carrefour_articles(id),
  item_id     uuid,
  barcode     text not null,
  description text,
  qty         numeric(14,3) not null check (qty > 0),
  price       numeric(14,2) not null check (price >= 0)
);
create index if not exists carrefour_return_lines_ret on public.carrefour_return_lines (return_id);

/* --------------------------------------------------------------------- RLS */
alter table public.carrefour_articles     enable row level security;
alter table public.carrefour_lpos         enable row level security;
alter table public.carrefour_lpo_lines    enable row level security;
alter table public.carrefour_returns      enable row level security;
alter table public.carrefour_return_lines enable row level security;

drop policy if exists carrefour_articles_read on public.carrefour_articles;
create policy carrefour_articles_read on public.carrefour_articles for select using (
  (select has_permission('carrefour.orders.view')) or (select has_permission('carrefour.orders.manage'))
  or (select has_permission('carrefour.accounts.view')) or (select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_articles_insert on public.carrefour_articles;
create policy carrefour_articles_insert on public.carrefour_articles for insert
  with check ((select has_permission('carrefour.orders.manage')));
drop policy if exists carrefour_articles_update on public.carrefour_articles;
create policy carrefour_articles_update on public.carrefour_articles for update
  using ((select has_permission('carrefour.orders.manage')))
  with check ((select has_permission('carrefour.orders.manage')));

revoke all on public.carrefour_articles, public.carrefour_lpos, public.carrefour_lpo_lines,
              public.carrefour_returns, public.carrefour_return_lines from anon;
grant select, insert, update on public.carrefour_articles to authenticated;
/* LPOs and returns: no table access. Everything goes through the functions. */

/* ---------------------------------------------------- saved file storage */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('carrefour-docs', 'carrefour-docs', false, 15728640,
        array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists carrefour_docs_read on storage.objects;
create policy carrefour_docs_read on storage.objects for select to authenticated using (
  bucket_id = 'carrefour-docs' and (public.has_permission('carrefour.orders.view')
    or public.has_permission('carrefour.orders.manage') or public.has_permission('carrefour.accounts.view')
    or public.has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_docs_write on storage.objects;
create policy carrefour_docs_write on storage.objects for insert to authenticated
  with check (bucket_id = 'carrefour-docs' and public.has_permission('carrefour.orders.manage'));

/* ------------------------------------------------------- order functions */
create or replace function public.carrefour_orders()
returns table (id uuid, lpo_no text, status text, branch_id uuid, shop text, lpo_date date,
               delivery_date date, file_path text, file_name text, note text, invoice_no text,
               invoice_date date, receiving_no text, receiving_date date, receiving_path text,
               receiving_name text, cancel_reason text, pieces numeric, gross numeric,
               received numeric, received_value numeric, lines jsonb)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  perform carrefour_orders_guard();
  return query
  select o.id, o.lpo_no,
         case when o.cancelled_at is not null then 'cancelled'
              when o.receiving_no is not null then 'delivered'
              when o.invoice_no is not null then 'pending' else 'open' end,
         o.branch_id, b.name, o.lpo_date, o.delivery_date, o.file_path, o.file_name, o.note,
         o.invoice_no, o.invoice_date, o.receiving_no, o.receiving_date, o.receiving_path,
         o.receiving_name, o.cancel_reason,
         coalesce(l.pieces, 0), coalesce(l.gross, 0), l.received, l.received_value,
         coalesce(l.lines, '[]'::jsonb)
    from carrefour_lpos o
    join khana_party_branches b on b.id = o.branch_id
    left join lateral (
      select sum(x.qty) pieces, round(sum(x.qty * x.price), 2) gross, sum(x.received_qty) received,
             round(sum(x.received_qty * x.price), 2) received_value,
             jsonb_agg(jsonb_build_object('id', x.id, 'barcode', x.barcode, 'description', x.description,
               'qty', x.qty, 'price', x.price, 'received_qty', x.received_qty) order by x.id) lines
        from carrefour_lpo_lines x where x.lpo_id = o.id
    ) l on true
   order by o.created_at desc;
end;
$fn$;

/* p: { id?, lpo_no, branch_id, lpo_date, delivery_date, file_path, file_name, note,
        lines: [{ barcode, description, qty, price }] } */
create or replace function public.carrefour_save_lpo(p jsonb)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_id uuid := nullif(p->>'id','')::uuid; v_no text := trim(coalesce(p->>'lpo_no','')); v_branch uuid := nullif(p->>'branch_id','')::uuid;
        v_old jsonb; l jsonb; v_art uuid; v_bc text;
begin
  perform carrefour_orders_write_guard();
  if v_no = '' then raise exception 'Enter the LPO number.'; end if;
  if not exists (select 1 from khana_party_branches where id = v_branch and party_id = carrefour_party_id()) then
    raise exception 'Choose a Carrefour shop.';
  end if;
  if jsonb_array_length(coalesce(p->'lines','[]')) = 0 then raise exception 'Add at least one line.'; end if;
  if exists (select 1 from carrefour_lpos where lpo_no = v_no and id is distinct from v_id) then
    raise exception 'LPO % is already uploaded.', v_no;
  end if;
  if v_id is null then
    insert into carrefour_lpos (lpo_no, branch_id, lpo_date, delivery_date, file_path, file_name, note)
    values (v_no, v_branch, nullif(p->>'lpo_date','')::date, nullif(p->>'delivery_date','')::date,
            nullif(p->>'file_path',''), nullif(p->>'file_name',''), nullif(trim(coalesce(p->>'note','')),''))
    returning id into v_id;
  else
    update carrefour_lpos set lpo_no = v_no, branch_id = v_branch,
      lpo_date = nullif(p->>'lpo_date','')::date, delivery_date = nullif(p->>'delivery_date','')::date,
      file_path = coalesce(nullif(p->>'file_path',''), file_path), file_name = coalesce(nullif(p->>'file_name',''), file_name),
      note = nullif(trim(coalesce(p->>'note','')),'')
    where id = v_id;
    if not found then raise exception 'That LPO no longer exists.'; end if;
    select coalesce(jsonb_object_agg(barcode, received_qty), '{}') into v_old
      from carrefour_lpo_lines where lpo_id = v_id and received_qty is not null;
    delete from carrefour_lpo_lines where lpo_id = v_id;
  end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'Barcode % has no quantity.', l->>'barcode'; end if;
    v_art := carrefour_ensure_article(l->>'barcode', l->>'description', (l->>'price')::numeric);
    select barcode into v_bc from carrefour_articles where id = v_art;
    insert into carrefour_lpo_lines (lpo_id, article_id, barcode, description, qty, price, received_qty)
    values (v_id, v_art, v_bc, nullif(trim(coalesce(l->>'description','')),''), (l->>'qty')::numeric,
            coalesce((l->>'price')::numeric, 0), (v_old->>v_bc)::numeric);
  end loop;
  return v_id;
end;
$fn$;

create or replace function public.carrefour_set_invoice(p_id uuid, p_no text, p_date date)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  perform carrefour_orders_write_guard();
  update carrefour_lpos set invoice_no = nullif(trim(coalesce(p_no,'')),''), invoice_date = p_date where id = p_id;
end;
$fn$;

/* p_lines: [{ id, received_qty }] */
create or replace function public.carrefour_set_receiving(p_id uuid, p_no text, p_date date, p_path text, p_name text, p_lines jsonb)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare l jsonb;
begin
  perform carrefour_orders_write_guard();
  if trim(coalesce(p_no,'')) = '' then raise exception 'Enter the receiving number.'; end if;
  if p_date is null then raise exception 'Enter the receiving date.'; end if;
  if exists (select 1 from carrefour_lpos where id = p_id and cancelled_at is not null) then
    raise exception 'This LPO is cancelled.';
  end if;
  update carrefour_lpos set receiving_no = trim(p_no), receiving_date = p_date,
    receiving_path = coalesce(nullif(p_path,''), receiving_path), receiving_name = coalesce(nullif(p_name,''), receiving_name)
  where id = p_id;
  for l in select * from jsonb_array_elements(coalesce(p_lines,'[]')) loop
    update carrefour_lpo_lines set received_qty = (l->>'received_qty')::numeric
     where id = (l->>'id')::bigint and lpo_id = p_id;
  end loop;
end;
$fn$;

create or replace function public.carrefour_cancel_lpo(p_id uuid, p_reason text, p_undo boolean default false)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  perform carrefour_orders_write_guard();
  if p_undo then
    update carrefour_lpos set cancelled_at = null, cancel_reason = null where id = p_id;
  else
    if exists (select 1 from carrefour_lpos where id = p_id and receiving_no is not null) then
      raise exception 'This LPO has a receiving number, so it was delivered.';
    end if;
    update carrefour_lpos set cancelled_at = now(), cancel_reason = nullif(trim(coalesce(p_reason,'')),'') where id = p_id;
  end if;
end;
$fn$;

/* ------------------------------------------------------ return functions */
create or replace function public.carrefour_return_list()
returns table (id uuid, return_no text, status text, branch_id uuid, shop text, return_date date,
               reason text, delivered_on date, file_path text, file_name text, note text,
               pieces numeric, amount numeric, lines jsonb)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  perform carrefour_orders_guard();
  return query
  select r.id, r.return_no, r.status, r.branch_id, b.name, r.return_date, r.reason, r.delivered_on,
         r.file_path, r.file_name, r.note, coalesce(l.pieces, 0), coalesce(l.amount, 0), coalesce(l.lines, '[]'::jsonb)
    from carrefour_returns r
    join khana_party_branches b on b.id = r.branch_id
    left join lateral (
      select sum(x.qty) pieces, round(sum(x.qty * x.price), 2) amount,
             jsonb_agg(jsonb_build_object('barcode', x.barcode, 'description', x.description,
               'qty', x.qty, 'price', x.price) order by x.id) lines
        from carrefour_return_lines x where x.return_id = r.id
    ) l on true
   where r.voided_at is null
   order by r.return_date desc, r.created_at desc;
end;
$fn$;

create or replace function public.carrefour_save_return(p jsonb)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_id uuid := nullif(p->>'id','')::uuid; v_branch uuid := nullif(p->>'branch_id','')::uuid; l jsonb; v_art uuid; v_bc text; v_item uuid;
begin
  perform carrefour_orders_write_guard();
  if not exists (select 1 from khana_party_branches where id = v_branch and party_id = carrefour_party_id()) then
    raise exception 'Choose a Carrefour shop.';
  end if;
  if nullif(p->>'return_date','') is null then raise exception 'Enter the return date.'; end if;
  if jsonb_array_length(coalesce(p->'lines','[]')) = 0 then raise exception 'Add at least one line.'; end if;
  if v_id is null then
    insert into carrefour_returns (return_no, branch_id, return_date, reason, file_path, file_name, note)
    values (nullif(trim(coalesce(p->>'return_no','')),''), v_branch, (p->>'return_date')::date, coalesce(p->>'reason','summer'),
            nullif(p->>'file_path',''), nullif(p->>'file_name',''), nullif(trim(coalesce(p->>'note','')),''))
    returning id into v_id;
  else
    update carrefour_returns set return_no = nullif(trim(coalesce(p->>'return_no','')),''), branch_id = v_branch,
      return_date = (p->>'return_date')::date, reason = coalesce(p->>'reason','summer'),
      file_path = coalesce(nullif(p->>'file_path',''), file_path), file_name = coalesce(nullif(p->>'file_name',''), file_name),
      note = nullif(trim(coalesce(p->>'note','')),'')
    where id = v_id;
    if not found then raise exception 'That return no longer exists.'; end if;
    delete from carrefour_return_lines where return_id = v_id;
  end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'Barcode % has no quantity.', l->>'barcode'; end if;
    v_art := carrefour_ensure_article(l->>'barcode', l->>'description', (l->>'price')::numeric);
    select barcode, item_id into v_bc, v_item from carrefour_articles where id = v_art;
    insert into carrefour_return_lines (return_id, article_id, item_id, barcode, description, qty, price)
    values (v_id, v_art, coalesce(v_item, carrefour_match_item(v_bc)), v_bc, nullif(trim(coalesce(l->>'description','')),''),
            (l->>'qty')::numeric, coalesce((l->>'price')::numeric, 0));
  end loop;
  return v_id;
end;
$fn$;

create or replace function public.carrefour_return_delivered(p_id uuid, p_date date, p_path text, p_name text, p_undo boolean default false)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  perform carrefour_orders_write_guard();
  if p_undo then
    update carrefour_returns set status = 'pending', delivered_on = null where id = p_id;
  else
    if p_date is null then raise exception 'Enter the date it came back.'; end if;
    update carrefour_returns set status = 'delivered', delivered_on = p_date,
      file_path = coalesce(nullif(p_path,''), file_path), file_name = coalesce(nullif(p_name,''), file_name)
    where id = p_id;
  end if;
end;
$fn$;

create or replace function public.carrefour_void_return(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  perform carrefour_orders_write_guard();
  update carrefour_returns set voided_at = now(), void_reason = nullif(trim(coalesce(p_reason,'')),'') where id = p_id;
end;
$fn$;

create or replace function public.carrefour_orders_summary()
returns jsonb language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
declare v jsonb;
begin
  perform carrefour_orders_guard();
  with o as (select * from carrefour_orders()), r as (select * from carrefour_return_list())
  select jsonb_build_object(
    'open', (select count(*) from o where status = 'open'),
    'open_value', (select coalesce(sum(gross), 0) from o where status = 'open'),
    'pending', (select count(*) from o where status = 'pending'),
    'pending_value', (select coalesce(sum(gross), 0) from o where status = 'pending'),
    'delivered', (select count(*) from o where status = 'delivered'),
    'delivered_value', (select coalesce(sum(received_value), 0) from o where status = 'delivered'),
    'short_pieces', (select coalesce(sum(pieces - received), 0) from o where status = 'delivered'),
    'short_value', (select coalesce(sum(gross - received_value), 0) from o where status = 'delivered'),
    'cancelled', (select count(*) from o where status = 'cancelled'),
    'returns_pending', (select count(*) from r where status = 'pending'),
    'returns_pending_value', (select coalesce(sum(amount), 0) from r where status = 'pending'),
    'returns_delivered', (select count(*) from r where status = 'delivered'),
    'returns_delivered_value', (select coalesce(sum(amount), 0) from r where status = 'delivered')
  ) into v;
  return v;
end;
$fn$;

/* ----------------------------------------------------------------------------
   carrefour_compare: as K195, with returns delivered back taken off sold.
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_compare(p_branch uuid default null, p_as_of date default null, p_from date default null)
returns table (
  branch_id uuid, shop text, prev_date date, curr_date date,
  item_id uuid, barcode text, article text,
  prev_qty numeric, sent_qty numeric, curr_qty numeric, sold_qty numeric,
  retail_price numeric, sold_value numeric)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  if not (has_permission('carrefour.view') or has_permission('carrefour.upload')
          or has_permission('carrefour.accounts.view') or has_permission('carrefour.accounts.manage')) then
    raise exception 'You do not have permission to see Carrefour reports.';
  end if;

  return query
  with shops as (
    select b.id, b.name from khana_party_branches b
     where b.party_id = carrefour_party_id() and (p_branch is null or b.id = p_branch)
  ), dates as (
    select s.id, s.name,
           (select max(l.report_date) from carrefour_report_lines l
             where l.branch_id = s.id and l.report_date <= coalesce(p_as_of, (now() at time zone 'Asia/Karachi')::date)) as cd
      from shops s
  ), d2 as (
    select d.id, d.name, d.cd,
           (select max(l.report_date) from carrefour_report_lines l
             where l.branch_id = d.id and l.report_date < d.cd
               and (p_from is null or l.report_date <= p_from)) as pd
      from dates d where d.cd is not null
  ), cur as (
    select l.branch_id, coalesce(l.item_id::text, 'bc:' || l.barcode) as k, l.item_id, l.barcode, l.article_name, l.quantity, l.retail_price
      from carrefour_report_lines l join d2 on d2.id = l.branch_id and l.report_date = d2.cd
  ), prv as (
    select l.branch_id, coalesce(l.item_id::text, 'bc:' || l.barcode) as k, l.item_id, l.barcode, l.article_name, l.quantity, l.retail_price
      from carrefour_report_lines l join d2 on d2.id = l.branch_id and l.report_date = d2.pd
  ), snt as (
    select m.branch_id, m.item_id::text as k, m.item_id, sum(m.quantity) as q
      from khana_stock_movements m join d2 on d2.id = m.branch_id
     where m.movement_type = 'OUT' and m.voided_at is null and m.party_id = carrefour_party_id()
       and (m.created_at at time zone 'Asia/Karachi')::date <= d2.cd
       and (d2.pd is null or (m.created_at at time zone 'Asia/Karachi')::date > d2.pd)
     group by m.branch_id, m.item_id
  ), ret as (
    select h.branch_id, coalesce(x.item_id::text, 'bc:' || x.barcode) as k, sum(x.qty) as q
      from carrefour_return_lines x
      join carrefour_returns h on h.id = x.return_id
      join d2 on d2.id = h.branch_id
     where h.status = 'delivered' and h.voided_at is null
       and h.delivered_on <= d2.cd and (d2.pd is null or h.delivered_on > d2.pd)
     group by 1, 2
  ), keys as (
    select branch_id, k from cur union select branch_id, k from prv
    union select branch_id, k from snt where exists (select 1 from d2 where d2.id = snt.branch_id and d2.pd is not null)
  )
  select d2.id, d2.name, d2.pd, d2.cd,
         coalesce(c.item_id, p.item_id, s.item_id),
         coalesce(fi.manual_barcode, c.barcode, p.barcode, fi.barcode),
         coalesce(fi.name, c.article_name, p.article_name),
         case when d2.pd is null then null else coalesce(p.quantity, 0) end,
         case when d2.pd is null then null else coalesce(s.q, 0) end,
         coalesce(c.quantity, 0),
         case when d2.pd is null then null else coalesce(p.quantity, 0) + coalesce(s.q, 0) - coalesce(c.quantity, 0) - coalesce(r.q, 0) end,
         coalesce(c.retail_price, p.retail_price),
         case when d2.pd is null then null
              else round((coalesce(p.quantity, 0) + coalesce(s.q, 0) - coalesce(c.quantity, 0) - coalesce(r.q, 0))
                         * coalesce(c.retail_price, p.retail_price, 0), 2) end
    from keys kk
    join d2 on d2.id = kk.branch_id
    left join cur c on c.branch_id = kk.branch_id and c.k = kk.k
    left join prv p on p.branch_id = kk.branch_id and p.k = kk.k
    left join snt s on s.branch_id = kk.branch_id and s.k = kk.k
    left join ret r on r.branch_id = kk.branch_id and r.k = kk.k
    left join khana_final_items fi on fi.id = coalesce(c.item_id, p.item_id, s.item_id)
   order by d2.name, 7;
end;
$fn$;

/* carrefour_check_kinds: deduction check gets the new kind */
create or replace function public.carrefour_deduction_check()
returns table (kind text, expected numeric, actual numeric, unexplained numeric)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
declare v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform carrefour_accounts_guard();
  return query
  with k(kind) as (values ('front_margin'),('back_margin'),('rebate'),('supply_fee'),('margin_support'),('other')),
  pct as (
    select t.kind, sum(s.sold_value * t.rate / 100) as e
      from carrefour_terms t join carrefour_sold_periods() s
        on t.effective_from <= s.to_date and (t.effective_to is null or t.effective_to >= s.to_date)
     where t.mode = 'percent' group by 1
  ), fix as (
    select t.kind, sum(t.rate * (
             (extract(year from age(date_trunc('month', least(coalesce(t.effective_to, v_today), v_today)),
                                    date_trunc('month', t.effective_from))) * 12
              + extract(month from age(date_trunc('month', least(coalesce(t.effective_to, v_today), v_today)),
                                       date_trunc('month', t.effective_from)))) + 1)) as e
      from carrefour_terms t where t.mode = 'monthly' and t.effective_from <= v_today group by 1
  ), act as (
    select n.kind, sum(n.amount) as a from carrefour_debit_notes n where n.voided_at is null group by 1
  )
  select k.kind,
         round(coalesce(p.e, 0) + coalesce(f.e, 0), 2),
         coalesce(a.a, 0),
         case when k.kind = 'margin_support' then 0
              else greatest(round(coalesce(a.a, 0) - coalesce(p.e, 0) - coalesce(f.e, 0), 2), 0) end
    from k
    left join pct p on p.kind = k.kind
    left join fix f on f.kind = k.kind
    left join act a on a.kind = k.kind;
end;
$fn$;

revoke all on function public.carrefour_orders_guard(), public.carrefour_orders_write_guard(),
  public.carrefour_article_for(text), public.carrefour_orders(), public.carrefour_save_lpo(jsonb),
  public.carrefour_set_invoice(uuid,text,date), public.carrefour_set_receiving(uuid,text,date,text,text,jsonb),
  public.carrefour_cancel_lpo(uuid,text,boolean), public.carrefour_return_list(), public.carrefour_save_return(jsonb),
  public.carrefour_return_delivered(uuid,date,text,text,boolean), public.carrefour_void_return(uuid,text),
  public.carrefour_orders_summary() from public, anon;
grant execute on function public.carrefour_orders_guard(), public.carrefour_orders_write_guard(),
  public.carrefour_article_for(text), public.carrefour_orders(), public.carrefour_save_lpo(jsonb),
  public.carrefour_set_invoice(uuid,text,date), public.carrefour_set_receiving(uuid,text,date,text,text,jsonb),
  public.carrefour_cancel_lpo(uuid,text,boolean), public.carrefour_return_list(), public.carrefour_save_return(jsonb),
  public.carrefour_return_delivered(uuid,date,text,text,boolean), public.carrefour_void_return(uuid,text),
  public.carrefour_orders_summary() to authenticated;

commit;
