/* ============================================================================
   K192 — Carrefour: shop stock reports, what sold, and what we sent
   ----------------------------------------------------------------------------
   WHAT IT IS FOR

   Carrefour sends a stock report covering its shops — barcode, article,
   quantity on hand, per shop. Each report is uploaded with the DATE it is
   for. From two reports in a row the system can say, per shop and article:

       previous stock   what the shop held at the last report
       sent since       what the warehouse delivered to that shop between the
                        two report dates (the STR lines already in the system)
       current stock    what the shop holds now
       sold             previous + sent since - current

   "Sold" has to count what we sent in between. Previous 100, current 80
   looks like 20 sold — but if 50 were delivered meanwhile, 70 were sold.
   Leaving deliveries out would under-report every shop that was restocked.

   THE SHOPS ARE THE ONES ALREADY THERE. Carrefour is a party in the invoice
   book with its branches (Islamabad WTC, Packages Lahore, …). The report
   uses those same branch rows, so a shop's report and the deliveries to it
   line up without anything being typed twice.

   A shop name in the file that is spelt differently from the branch
   ("CARREFOUR WTC ISB" for "Islamabad WTC") is matched ONCE by a person on
   the upload screen and remembered — the next file goes through on its own.

   THE SAME SHOP AND DATE CANNOT GO IN TWICE. Uploading a report for a shop
   and date that is already recorded is refused, unless the upload says
   "replace": then that shop's lines for that date are swapped for the new
   ones. No silent doubling.

   Touches nothing in online_* (Hub) or retail_* (FS Traders). Reads the
   warehouse (khana_*) but never writes to it.
   Namespace K1xx (Karkhana). One transaction. Safe to run twice.
   ========================================================================= */
begin;

/* ----------------------------------------------------------------------------
   Who may see it, who may upload
   ------------------------------------------------------------------------- */
insert into public.permissions (code, module, description)
select v.code, 'khana', v.description
  from (values
    ('carrefour.view',   'See Carrefour shop stock reports'),
    ('carrefour.upload', 'Upload Carrefour stock reports')) v(code, description)
 where not exists (select 1 from public.permissions p where p.code = v.code);


/* ----------------------------------------------------------------------------
   Tables
   ------------------------------------------------------------------------- */
create table if not exists public.carrefour_reports (
  id           uuid primary key default gen_random_uuid(),
  report_date  date not null,
  file_name    text,
  note         text,
  uploaded_by  uuid default auth.uid(),
  uploaded_at  timestamptz not null default now()
);

create table if not exists public.carrefour_report_lines (
  id           bigserial primary key,
  report_id    uuid not null references public.carrefour_reports(id) on delete cascade,
  branch_id    uuid not null references public.khana_party_branches(id),
  report_date  date not null,                      -- copied from the report, for indexing
  barcode      text not null,                      -- as written in the file
  article_name text,                               -- as written in the file
  item_id      uuid references public.khana_final_items(id) on delete set null,
  quantity     numeric(14,3) not null,
  retail_price numeric(14,2)                       -- Carrefour's price (PP) on that report
);
alter table public.carrefour_report_lines add column if not exists retail_price numeric(14,2);
create index if not exists carrefour_lines_branch_date on public.carrefour_report_lines (branch_id, report_date);
create index if not exists carrefour_lines_item on public.carrefour_report_lines (item_id);

/* Shop names as Carrefour writes them, pointing at our branch. */
create table if not exists public.carrefour_shop_aliases (
  alias_key  text primary key,                     -- lower case, letters and digits only
  alias      text not null,                        -- as first seen
  branch_id  uuid not null references public.khana_party_branches(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.carrefour_reports       enable row level security;
alter table public.carrefour_report_lines  enable row level security;
alter table public.carrefour_shop_aliases  enable row level security;

drop policy if exists carrefour_reports_read on public.carrefour_reports;
create policy carrefour_reports_read on public.carrefour_reports for select
  using (has_permission('carrefour.view') or has_permission('carrefour.upload'));
drop policy if exists carrefour_lines_read on public.carrefour_report_lines;
create policy carrefour_lines_read on public.carrefour_report_lines for select
  using (has_permission('carrefour.view') or has_permission('carrefour.upload'));
drop policy if exists carrefour_aliases_read on public.carrefour_shop_aliases;
create policy carrefour_aliases_read on public.carrefour_shop_aliases for select
  using (has_permission('carrefour.view') or has_permission('carrefour.upload'));
/* No insert/update/delete policies: every write goes through the functions
   below, which check the permission and keep the rules. */

grant select on public.carrefour_reports, public.carrefour_report_lines, public.carrefour_shop_aliases
  to authenticated;
revoke all on public.carrefour_reports, public.carrefour_report_lines, public.carrefour_shop_aliases from anon;


/* ----------------------------------------------------------------------------
   The Carrefour party and its shops
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_party_id()
returns uuid language sql stable security definer set search_path to 'public','pg_temp' as $fn$
  select id from khana_parties where lower(trim(name)) = 'carrefour' order by created_at limit 1;
$fn$;

create or replace function public.carrefour_shops()
returns table (branch_id uuid, name text, last_report date, reports int)
language sql stable security definer set search_path to 'public','pg_temp' as $fn$
  select b.id, b.name,
         (select max(l.report_date) from carrefour_report_lines l where l.branch_id = b.id),
         (select count(distinct l.report_date)::int from carrefour_report_lines l where l.branch_id = b.id)
    from khana_party_branches b
   where b.party_id = carrefour_party_id()
     and coalesce(b.is_active, true)
     and (has_permission('carrefour.view') or has_permission('carrefour.upload'))
   order by b.name;
$fn$;


/* ----------------------------------------------------------------------------
   Carrefour's own shop codes, as they head the columns of its stock report
   (GUJ_S, WTC_S …). Matched once here; changeable on the upload screen.
   LYL is Lyallpur — Faisalabad. Codes Carrefour uses for shops that carry
   none of our goods (PA6, P06–P09) are not matched: their columns are empty,
   and the upload skips an empty shop column instead of asking about it.
   ------------------------------------------------------------------------- */
insert into public.carrefour_shop_aliases (alias_key, alias, branch_id)
select v.k, upper(v.k), b.id
  from (values ('guj','gugranwala'), ('frt','fotresslahore'), ('wtc','islamabadwtc'),
               ('emp','emporiumlahore'), ('pkg','packageslahore'), ('luk','karachilucky1'),
               ('lyl','faislabadmall')) v(k, branch_key)
  join public.khana_party_branches b
    on b.party_id = public.carrefour_party_id()
   and regexp_replace(lower(b.name), '[^a-z0-9]', '', 'g') = v.branch_key
on conflict (alias_key) do nothing;


/* ----------------------------------------------------------------------------
   Which of our shops does a name in the file mean?
   ----------------------------------------------------------------------------
   1. a remembered alias
   2. the branch name itself, spacing and capitals ignored
   3. the branch name contained in the file's name, or the other way round,
      when exactly ONE branch fits ("Carrefour Packages Mall" → Packages
      Lahore is NOT guessed — "packages" is in it, but so it must be unique)
   Anything else comes back null, and the upload screen asks.
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_match_shop(p_name text)
returns uuid language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
declare v_key text := regexp_replace(lower(coalesce(p_name,'')), '[^a-z0-9]', '', 'g');
        v_id uuid; v_n int;
begin
  if v_key = '' then return null; end if;
  select branch_id into v_id from carrefour_shop_aliases where alias_key = v_key;
  if v_id is not null then return v_id; end if;

  select b.id into v_id from khana_party_branches b
   where b.party_id = carrefour_party_id()
     and regexp_replace(lower(b.name), '[^a-z0-9]', '', 'g') = v_key;
  if v_id is not null then return v_id; end if;

  select count(*), min(b.id::text)::uuid into v_n, v_id from khana_party_branches b
   where b.party_id = carrefour_party_id()
     and length(regexp_replace(lower(b.name), '[^a-z0-9]', '', 'g')) >= 5
     and (v_key like '%' || regexp_replace(lower(b.name), '[^a-z0-9]', '', 'g') || '%'
          or regexp_replace(lower(b.name), '[^a-z0-9]', '', 'g') like '%' || v_key || '%');
  if v_n = 1 then return v_id; end if;
  return null;
end;
$fn$;

create or replace function public.set_carrefour_shop_alias(p_alias text, p_branch uuid)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_key text := regexp_replace(lower(coalesce(p_alias,'')), '[^a-z0-9]', '', 'g');
begin
  if not has_permission('carrefour.upload') then
    raise exception 'You do not have permission to upload Carrefour reports.';
  end if;
  if v_key = '' then raise exception 'Which shop name is this?'; end if;
  if not exists (select 1 from khana_party_branches where id = p_branch and party_id = carrefour_party_id()) then
    raise exception 'That is not one of the Carrefour shops.';
  end if;
  insert into carrefour_shop_aliases (alias_key, alias, branch_id) values (v_key, trim(p_alias), p_branch)
  on conflict (alias_key) do update set branch_id = excluded.branch_id;
  return jsonb_build_object('ok', true);
end;
$fn$;


/* ----------------------------------------------------------------------------
   Which warehouse product is a barcode in the file?
   ----------------------------------------------------------------------------
   The printed barcode (2000003127726), our own code (42-000006), or the
   short form Carrefour sometimes prints (3127726) when exactly one product
   ends with it. Nothing else is guessed — an unknown barcode is kept on the
   line as written, with no product, and the report says so.
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_match_item(p_barcode text)
returns uuid language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
declare v_bc text := regexp_replace(coalesce(p_barcode,''), '\s', '', 'g'); v_id uuid; v_n int;
begin
  if v_bc = '' then return null; end if;
  select id into v_id from khana_final_items where manual_barcode = v_bc limit 1;
  if v_id is not null then return v_id; end if;
  select id into v_id from khana_final_items where lower(barcode) = lower(v_bc) limit 1;
  if v_id is not null then return v_id; end if;
  if v_bc ~ '^\d{6,}$' then
    select count(*), min(id::text)::uuid into v_n, v_id from khana_final_items where manual_barcode like '%' || v_bc;
    if v_n = 1 then return v_id; end if;
  end if;
  return null;
end;
$fn$;


/* ----------------------------------------------------------------------------
   Upload
   ----------------------------------------------------------------------------
   p_rows: [{ "shop": "...", "branch_id": null|uuid, "barcode": "...",
              "name": "...", "qty": 12 }, ...]
   branch_id, when given, wins over the shop name (the screen sends it once a
   person has matched an unknown shop).

   Refuses the whole file — nothing is written — when:
     - a row's shop cannot be matched to a Carrefour shop
     - a shop already has a report for that date and p_replace is false
   so the person sees every problem at once and fixes the file or the
   matches, instead of half a report going in.
   ------------------------------------------------------------------------- */
create or replace function public.import_carrefour_report(
  p_date date, p_file text, p_rows jsonb, p_replace boolean default false, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare
  v_id uuid; v_r jsonb; v_branch uuid; v_unknown jsonb := '[]'::jsonb; v_taken jsonb := '[]'::jsonb;
  v_lines int := 0; v_unmatched int := 0; v_shops int;
begin
  if not has_permission('carrefour.upload') then
    raise exception 'You do not have permission to upload Carrefour reports.';
  end if;
  if p_date is null then raise exception 'Which date is this report for?'; end if;
  if p_date > (now() at time zone 'Asia/Karachi')::date then
    raise exception 'The report date is in the future.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no rows to upload.';
  end if;
  if carrefour_party_id() is null then
    raise exception 'There is no party called Carrefour in the invoice book.';
  end if;

  /* Resolve every row's shop first, so all problems are found before writing. */
  create temp table _cf (branch_id uuid, shop text, barcode text, name text, qty numeric, price numeric) on commit drop;
  for v_r in select * from jsonb_array_elements(p_rows) loop
    v_branch := coalesce(nullif(v_r->>'branch_id','')::uuid, carrefour_match_shop(v_r->>'shop'));
    if v_branch is null then
      if not v_unknown @> to_jsonb(array[coalesce(v_r->>'shop','')]) then
        v_unknown := v_unknown || to_jsonb(coalesce(v_r->>'shop',''));
      end if;
      continue;
    end if;
    if nullif(trim(coalesce(v_r->>'barcode','')),'') is null then continue; end if;
    insert into _cf values (v_branch, v_r->>'shop', trim(v_r->>'barcode'), nullif(trim(coalesce(v_r->>'name','')),''),
                            coalesce(nullif(v_r->>'qty','')::numeric, 0), nullif(v_r->>'price','')::numeric);
  end loop;

  if jsonb_array_length(v_unknown) > 0 then
    return jsonb_build_object('ok', false, 'unknown_shops', v_unknown,
      'message', 'Some shop names in the file are not matched to a Carrefour shop yet.');
  end if;

  select coalesce(jsonb_agg(distinct b.name), '[]'::jsonb) into v_taken
    from _cf c join khana_party_branches b on b.id = c.branch_id
   where exists (select 1 from carrefour_report_lines l where l.branch_id = c.branch_id and l.report_date = p_date);
  if jsonb_array_length(v_taken) > 0 and not p_replace then
    return jsonb_build_object('ok', false, 'already_uploaded', v_taken,
      'message', 'These shops already have a report for this date.');
  end if;

  if p_replace then
    delete from carrefour_report_lines l
     where l.report_date = p_date and l.branch_id in (select distinct branch_id from _cf);
    delete from carrefour_reports r where not exists (select 1 from carrefour_report_lines l where l.report_id = r.id);
  end if;

  insert into carrefour_reports (report_date, file_name, note) values (p_date, nullif(trim(coalesce(p_file,'')),''), nullif(trim(coalesce(p_note,'')),''))
  returning id into v_id;

  /* The same barcode twice for one shop in one file is added together —
     one shop holds one quantity of one thing. */
  insert into carrefour_report_lines (report_id, branch_id, report_date, barcode, article_name, item_id, quantity, retail_price)
  select v_id, c.branch_id, p_date, c.barcode, max(c.name), carrefour_match_item(c.barcode), sum(c.qty), max(c.price)
    from _cf c group by c.branch_id, c.barcode;
  get diagnostics v_lines = row_count;

  select count(*) filter (where item_id is null), count(distinct branch_id) into v_unmatched, v_shops
    from carrefour_report_lines where report_id = v_id;

  return jsonb_build_object('ok', true, 'report_id', v_id, 'shops', v_shops, 'lines', v_lines,
    'unmatched_barcodes', v_unmatched, 'replaced', coalesce(jsonb_array_length(v_taken), 0) > 0);
end;
$fn$;

create or replace function public.delete_carrefour_report(p_branch uuid, p_date date)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_n int;
begin
  if not has_permission('carrefour.upload') then
    raise exception 'You do not have permission to change Carrefour reports.';
  end if;
  delete from carrefour_report_lines where branch_id = p_branch and report_date = p_date;
  get diagnostics v_n = row_count;
  delete from carrefour_reports r where not exists (select 1 from carrefour_report_lines l where l.report_id = r.id);
  return jsonb_build_object('ok', true, 'removed', v_n);
end;
$fn$;


/* A whole upload, every shop in it — for a file uploaded by mistake. */
create or replace function public.delete_carrefour_upload(p_report uuid)
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
declare v_n int;
begin
  if not has_permission('carrefour.upload') then
    raise exception 'You do not have permission to change Carrefour reports.';
  end if;
  delete from carrefour_report_lines where report_id = p_report;
  get diagnostics v_n = row_count;
  delete from carrefour_reports where id = p_report;
  return jsonb_build_object('ok', true, 'removed', v_n);
end;
$fn$;

/* Which shops already have a report on a date — the upload screen asks
   before replacing them. */
create or replace function public.carrefour_shops_on(p_date date)
returns table (branch_id uuid, lines int)
language sql stable security definer set search_path to 'public','pg_temp' as $fn$
  select l.branch_id, count(*)::int from carrefour_report_lines l
   where l.report_date = p_date and (has_permission('carrefour.view') or has_permission('carrefour.upload'))
   group by l.branch_id;
$fn$;


/* ----------------------------------------------------------------------------
   The comparison
   ----------------------------------------------------------------------------
   For each shop (or one, p_branch), take its latest report on or before
   p_as_of (today if null) as CURRENT, and its report before that as
   PREVIOUS. Per article:

     prev_qty    on hand at the previous report
     sent_qty    delivered by the warehouse to that shop, dated after the
                 previous report up to and including the current report date
                 (STR lines: party Carrefour, that branch, not voided)
     curr_qty    on hand at the current report
     sold_qty    prev + sent - curr

   An article delivered in the window but absent from both reports still
   shows (sent, and current 0 — it should be on the shelf and is not in the
   report, which is exactly what someone checking wants to see).

   A shop with only ONE report has no previous: prev is null and sold is
   null — nothing can be worked out from a single count.
   ------------------------------------------------------------------------- */
drop function if exists public.carrefour_compare(uuid, date);
create or replace function public.carrefour_compare(p_branch uuid default null, p_as_of date default null)
returns table (
  branch_id uuid, shop text, prev_date date, curr_date date,
  item_id uuid, barcode text, article text,
  prev_qty numeric, sent_qty numeric, curr_qty numeric, sold_qty numeric,
  retail_price numeric, sold_value numeric)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  if not (has_permission('carrefour.view') or has_permission('carrefour.upload')) then
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
           (select max(l.report_date) from carrefour_report_lines l where l.branch_id = d.id and l.report_date < d.cd) as pd
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
         case when d2.pd is null then null else coalesce(p.quantity, 0) + coalesce(s.q, 0) - coalesce(c.quantity, 0) end,
         coalesce(c.retail_price, p.retail_price),
         case when d2.pd is null then null
              else round((coalesce(p.quantity, 0) + coalesce(s.q, 0) - coalesce(c.quantity, 0))
                         * coalesce(c.retail_price, p.retail_price, 0), 2) end
    from keys kk
    join d2 on d2.id = kk.branch_id
    left join cur c on c.branch_id = kk.branch_id and c.k = kk.k
    left join prv p on p.branch_id = kk.branch_id and p.k = kk.k
    left join snt s on s.branch_id = kk.branch_id and s.k = kk.k
    left join khana_final_items fi on fi.id = coalesce(c.item_id, p.item_id, s.item_id)
   order by d2.name, 7;
end;
$fn$;

/* All uploads, newest first — for the history list and to pick dates. */
create or replace function public.carrefour_uploads()
returns table (report_id uuid, report_date date, file_name text, uploaded_at timestamptz,
               uploaded_by text, shops int, lines int, pieces numeric, unmatched int)
language sql stable security definer set search_path to 'public','pg_temp' as $fn$
  select r.id, r.report_date, r.file_name, r.uploaded_at,
         coalesce((select coalesce(nullif(trim(u.full_name),''), u.email) from app_users u where u.id = r.uploaded_by), ''),
         count(distinct l.branch_id)::int, count(l.id)::int, coalesce(sum(l.quantity),0),
         count(l.id) filter (where l.item_id is null)::int
    from carrefour_reports r left join carrefour_report_lines l on l.report_id = r.id
   where has_permission('carrefour.view') or has_permission('carrefour.upload')
   group by r.id order by r.report_date desc, r.uploaded_at desc;
$fn$;

revoke all on function public.carrefour_party_id(), public.carrefour_shops(), public.carrefour_match_shop(text),
  public.set_carrefour_shop_alias(text, uuid), public.carrefour_match_item(text),
  public.import_carrefour_report(date, text, jsonb, boolean, text), public.delete_carrefour_report(uuid, date),
  public.carrefour_compare(uuid, date), public.carrefour_uploads(),
  public.delete_carrefour_upload(uuid), public.carrefour_shops_on(date) from public, anon;
grant execute on function public.carrefour_party_id(), public.carrefour_shops(), public.carrefour_match_shop(text),
  public.set_carrefour_shop_alias(text, uuid), public.carrefour_match_item(text),
  public.import_carrefour_report(date, text, jsonb, boolean, text), public.delete_carrefour_report(uuid, date),
  public.carrefour_compare(uuid, date), public.carrefour_uploads(),
  public.delete_carrefour_upload(uuid), public.carrefour_shops_on(date) to authenticated, service_role;

commit;

/* ============================================================================
   CHECK — as yourself, claims line in the SAME block:

     set local request.jwt.claims =
       '{"sub":"61a35ff9-9703-43e7-a29a-fc7b8303886b","role":"authenticated"}';
     select * from carrefour_shops();
     -> the eight Carrefour shops, no reports yet
   ========================================================================= */
