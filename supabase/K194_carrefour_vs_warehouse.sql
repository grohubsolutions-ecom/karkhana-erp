/* ============================================================================
   K194 — Carrefour against the warehouse: everything we sent vs what is there
   ----------------------------------------------------------------------------
   Per Carrefour shop and article:
     sent        every STR line the warehouse has sent to that shop (party
                 Carrefour, that branch, not voided), up to the shop's report
                 date — all of it, since the first delivery
     in_shop     what Carrefour's report on that date says the shop holds
     report_date which report that is (the shop's latest on or before p_as_of)
   The screen shows sent − in_shop: what has left the shelf (sold), or, if
   negative, stock Carrefour shows that our invoices do not explain.
   Reads khana_* and carrefour_*; writes nothing. Safe to run twice.
   ========================================================================= */
begin;

drop function if exists public.carrefour_vs_warehouse(date);
create or replace function public.carrefour_vs_warehouse(p_as_of date default null)
returns table (
  branch_id uuid, shop text, report_date date, item_id uuid, barcode text, article text,
  sent_qty numeric, in_shop numeric, first_sent date, last_sent date, invoices int)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
declare v_to date := coalesce(p_as_of, (now() at time zone 'Asia/Karachi')::date);
begin
  if not (has_permission('carrefour.view') or has_permission('carrefour.upload')) then
    raise exception 'You do not have permission to see Carrefour reports.';
  end if;

  return query
  with shops as (
    select b.id, b.name,
           (select max(l.report_date) from carrefour_report_lines l where l.branch_id = b.id and l.report_date <= v_to) as rd
      from khana_party_branches b where b.party_id = carrefour_party_id()
  ), rep as (
    select l.branch_id, coalesce(l.item_id::text, 'bc:' || l.barcode) as k, l.item_id, l.barcode, l.article_name, l.quantity
      from carrefour_report_lines l join shops s on s.id = l.branch_id and l.report_date = s.rd
  ), snt as (
    select m.branch_id, m.item_id::text as k, m.item_id, sum(m.quantity) as q,
           min((m.created_at at time zone 'Asia/Karachi')::date) as f,
           max((m.created_at at time zone 'Asia/Karachi')::date) as la,
           count(distinct m.invoice_no)::int as inv
      from khana_stock_movements m join shops s on s.id = m.branch_id
     where m.movement_type = 'OUT' and m.voided_at is null and m.party_id = carrefour_party_id()
       and (m.created_at at time zone 'Asia/Karachi')::date <= coalesce(s.rd, v_to)
     group by m.branch_id, m.item_id
  ), keys as (
    select branch_id, k from rep union select branch_id, k from snt
  )
  select s.id, s.name, s.rd,
         coalesce(r.item_id, t.item_id),
         coalesce(fi.manual_barcode, r.barcode, fi.barcode),
         coalesce(fi.name, r.article_name),
         coalesce(t.q, 0), case when s.rd is null then null else coalesce(r.quantity, 0) end,
         t.f, t.la, coalesce(t.inv, 0)
    from keys kk
    join shops s on s.id = kk.branch_id
    left join rep r on r.branch_id = kk.branch_id and r.k = kk.k
    left join snt t on t.branch_id = kk.branch_id and t.k = kk.k
    left join khana_final_items fi on fi.id = coalesce(r.item_id, t.item_id)
   order by s.name, 6;
end;
$fn$;

revoke all on function public.carrefour_vs_warehouse(date) from public, anon;
grant execute on function public.carrefour_vs_warehouse(date) to authenticated, service_role;

commit;
notify pgrst, 'reload schema';
