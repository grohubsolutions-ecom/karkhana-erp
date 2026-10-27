/* ============================================================================
   K193 — Carrefour: a report is never replaced, and any two dates compare
   ----------------------------------------------------------------------------
   1. NO REPLACING. Each file is filed under its own date: one for the back
      date, one for the date after. A shop that already has a report on a
      date refuses another one for that date — always. A wrong upload is
      removed from the upload history first, then uploaded again.
      (p_replace stays in the signature so nothing calling it breaks; it is
      ignored.)
   2. PICK THE OLD REPORT. carrefour_compare takes p_from: the old report is
      the shop's latest report on or before p_from. Blank = the report just
      before the current one, as before.
   Touches only carrefour_* functions. Safe to run twice.
   ========================================================================= */
begin;

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
  if jsonb_array_length(v_taken) > 0 then
    return jsonb_build_object('ok', false, 'already_uploaded', v_taken,
      'message', 'These shops already have a report on this date. A report is never replaced — remove the earlier upload first if it was wrong.');
  end if;

  insert into carrefour_reports (report_date, file_name, note) values (p_date, nullif(trim(coalesce(p_file,'')),''), nullif(trim(coalesce(p_note,'')),''))
  returning id into v_id;

  insert into carrefour_report_lines (report_id, branch_id, report_date, barcode, article_name, item_id, quantity, retail_price)
  select v_id, c.branch_id, p_date, c.barcode, max(c.name), carrefour_match_item(c.barcode), sum(c.qty), max(c.price)
    from _cf c group by c.branch_id, c.barcode;
  get diagnostics v_lines = row_count;

  select count(*) filter (where item_id is null), count(distinct branch_id) into v_unmatched, v_shops
    from carrefour_report_lines where report_id = v_id;

  return jsonb_build_object('ok', true, 'report_id', v_id, 'shops', v_shops, 'lines', v_lines,
    'unmatched_barcodes', v_unmatched, 'replaced', false);
end;
$fn$;

drop function if exists public.carrefour_compare(uuid, date);
drop function if exists public.carrefour_compare(uuid, date, date);
create or replace function public.carrefour_compare(p_branch uuid default null, p_as_of date default null, p_from date default null)
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

revoke all on function public.carrefour_compare(uuid, date, date) from public, anon;
grant execute on function public.carrefour_compare(uuid, date, date) to authenticated, service_role;

commit;
notify pgrst, 'reload schema';
