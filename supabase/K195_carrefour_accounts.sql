/* ============================================================================
   K195 — Carrefour accounts: terms, deductions, payments, 100-day maturity
   ----------------------------------------------------------------------------
   Carrefour pays for what it SELLS, not for what we deliver. Payment matures
   a set number of days after the sale (100 unless changed on the Terms
   screen), less its margins, rebates and fees.

   WHERE THE SALE COMES FROM
   K192 already works out "sold" from two stock reports in a row. Each pair of
   reports for a shop is one sold period here. The real sale date inside a
   period is not known, so a period is dated on the later report: the day the
   sale became visible. Maturity can only be late by that gap, never early.

   THREE FIGURES THAT MUST NOT BE CONFUSED
     expected deductions  what the terms say Carrefour may take
     actual deductions    the debit notes Carrefour really charged
     unexplained          actual above expected, per kind: the money to dispute

   Permissions: carrefour.accounts.view and .manage are new and are granted to
   no role. Super admins pass has_permission() on their own; anyone else is
   ticked on the Roles screen.

   Touches nothing in online_* (Hub) or retail_* (Shops Sales), and nothing in
   employees or departments. Reads the warehouse (khana_*) but never writes to
   it. One transaction. Safe to run twice.
   ========================================================================= */
begin;

insert into public.permissions (code, module, description)
select v.code, 'carrefour', v.description
  from (values
    ('carrefour.accounts.view',   'See Carrefour invoices, maturity, deductions and payments'),
    ('carrefour.accounts.manage', 'Record Carrefour terms, debit notes and payments')) v(code, description)
 where not exists (select 1 from public.permissions p where p.code = v.code);


/* ---------------------------------------------------------------- tables */
create table if not exists public.carrefour_settings (
  id             boolean primary key default true check (id),
  maturity_days  integer not null default 100 check (maturity_days between 1 and 365),
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now()
);
insert into public.carrefour_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.carrefour_terms (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('front_margin','back_margin','rebate','supply_fee','other')),
  label           text not null check (length(trim(label)) > 0),
  mode            text not null check (mode in ('percent','monthly')),
  rate            numeric(14,4) not null check (rate >= 0),   -- % of sold value, or rupees a month
  effective_from  date not null,
  effective_to    date,
  note            text,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_at      timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  check (mode <> 'percent' or rate <= 100)
);

create table if not exists public.carrefour_debit_notes (
  id           uuid primary key default gen_random_uuid(),
  note_date    date not null,
  reference    text,
  kind         text not null check (kind in ('front_margin','back_margin','rebate','supply_fee','other')),
  amount       numeric(14,2) not null check (amount > 0),
  branch_id    uuid references public.khana_party_branches(id),
  note         text,
  voided_at    timestamptz,
  void_reason  text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_by   uuid,
  updated_at   timestamptz
);
create unique index if not exists carrefour_debit_notes_ref
  on public.carrefour_debit_notes (lower(trim(reference)))
  where voided_at is null and reference is not null and trim(reference) <> '';

create table if not exists public.carrefour_payments (
  id           uuid primary key default gen_random_uuid(),
  paid_on      date not null,
  amount       numeric(14,2) not null check (amount > 0),
  reference    text,
  note         text,
  voided_at    timestamptz,
  void_reason  text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_by   uuid,
  updated_at   timestamptz
);
create unique index if not exists carrefour_payments_ref
  on public.carrefour_payments (lower(trim(reference)))
  where voided_at is null and reference is not null and trim(reference) <> '';

create or replace function public.carrefour_stamp()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$fn$;
revoke all on function public.carrefour_stamp() from public, anon, authenticated;

drop trigger if exists carrefour_settings_stamp on public.carrefour_settings;
create trigger carrefour_settings_stamp before update on public.carrefour_settings
  for each row execute function public.carrefour_stamp();
drop trigger if exists carrefour_terms_stamp on public.carrefour_terms;
create trigger carrefour_terms_stamp before update on public.carrefour_terms
  for each row execute function public.carrefour_stamp();
drop trigger if exists carrefour_debit_notes_stamp on public.carrefour_debit_notes;
create trigger carrefour_debit_notes_stamp before update on public.carrefour_debit_notes
  for each row execute function public.carrefour_stamp();
drop trigger if exists carrefour_payments_stamp on public.carrefour_payments;
create trigger carrefour_payments_stamp before update on public.carrefour_payments
  for each row execute function public.carrefour_stamp();


/* ------------------------------------------------------------------- RLS
   Debit notes and payments are voided, never deleted: a wrong entry is
   corrected or voided and the record of it stays. Terms can be deleted,
   since one entered by mistake is not history. */
alter table public.carrefour_settings    enable row level security;
alter table public.carrefour_terms       enable row level security;
alter table public.carrefour_debit_notes enable row level security;
alter table public.carrefour_payments    enable row level security;

drop policy if exists carrefour_settings_read on public.carrefour_settings;
create policy carrefour_settings_read on public.carrefour_settings for select
  using ((select has_permission('carrefour.accounts.view')) or (select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_settings_update on public.carrefour_settings;
create policy carrefour_settings_update on public.carrefour_settings for update
  using ((select has_permission('carrefour.accounts.manage')))
  with check ((select has_permission('carrefour.accounts.manage')));

drop policy if exists carrefour_terms_read on public.carrefour_terms;
create policy carrefour_terms_read on public.carrefour_terms for select
  using ((select has_permission('carrefour.accounts.view')) or (select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_terms_insert on public.carrefour_terms;
create policy carrefour_terms_insert on public.carrefour_terms for insert
  with check ((select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_terms_update on public.carrefour_terms;
create policy carrefour_terms_update on public.carrefour_terms for update
  using ((select has_permission('carrefour.accounts.manage')))
  with check ((select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_terms_delete on public.carrefour_terms;
create policy carrefour_terms_delete on public.carrefour_terms for delete
  using ((select has_permission('carrefour.accounts.manage')));

drop policy if exists carrefour_notes_read on public.carrefour_debit_notes;
create policy carrefour_notes_read on public.carrefour_debit_notes for select
  using ((select has_permission('carrefour.accounts.view')) or (select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_notes_insert on public.carrefour_debit_notes;
create policy carrefour_notes_insert on public.carrefour_debit_notes for insert
  with check ((select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_notes_update on public.carrefour_debit_notes;
create policy carrefour_notes_update on public.carrefour_debit_notes for update
  using ((select has_permission('carrefour.accounts.manage')))
  with check ((select has_permission('carrefour.accounts.manage')));

drop policy if exists carrefour_pay_read on public.carrefour_payments;
create policy carrefour_pay_read on public.carrefour_payments for select
  using ((select has_permission('carrefour.accounts.view')) or (select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_pay_insert on public.carrefour_payments;
create policy carrefour_pay_insert on public.carrefour_payments for insert
  with check ((select has_permission('carrefour.accounts.manage')));
drop policy if exists carrefour_pay_update on public.carrefour_payments;
create policy carrefour_pay_update on public.carrefour_payments for update
  using ((select has_permission('carrefour.accounts.manage')))
  with check ((select has_permission('carrefour.accounts.manage')));

revoke all on public.carrefour_settings, public.carrefour_terms,
              public.carrefour_debit_notes, public.carrefour_payments from anon;
grant select, update on public.carrefour_settings to authenticated;
grant select, insert, update, delete on public.carrefour_terms to authenticated;
grant select, insert, update on public.carrefour_debit_notes, public.carrefour_payments to authenticated;


/* ----------------------------------------------------------------------------
   carrefour_compare: unchanged except that accounts users may read it too —
   the maturity figures are built from it. Same columns as K193.
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


create or replace function public.carrefour_accounts_guard()
returns void language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
begin
  if not (has_permission('carrefour.accounts.view') or has_permission('carrefour.accounts.manage')) then
    raise exception 'You do not have permission to see Carrefour accounts.';
  end if;
end;
$fn$;


/* ----------------------------------------------------------------------------
   One row per shop per pair of reports in a row: what sold in that period.
   odd_lines counts articles where stock rose by more than we delivered, which
   usually means a barcode that did not match a product (see carrefour_summary).
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_sold_periods()
returns table (branch_id uuid, shop text, from_date date, to_date date,
               pieces numeric, sold_value numeric, odd_lines int)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  perform carrefour_accounts_guard();
  return query
  with r as (
    select x.branch_id as b, x.report_date as d,
           lag(x.report_date) over (partition by x.branch_id order by x.report_date) as p
      from (select distinct l.branch_id, l.report_date from carrefour_report_lines l) x
  )
  select r.b, min(c.shop), r.p, r.d,
         coalesce(sum(c.sold_qty), 0), coalesce(sum(c.sold_value), 0),
         (count(*) filter (where c.sold_qty < 0))::int
    from r
    cross join lateral carrefour_compare(r.b, r.d, r.p) c
   where r.p is not null
   group by r.b, r.p, r.d;
end;
$fn$;


/* ----------------------------------------------------------------------------
   The maturity calendar. Payments go against the oldest amount first.
   Monthly fees are their own rows (shop is null), falling due at month end.
   ------------------------------------------------------------------------- */
create or replace function public.carrefour_maturity()
returns table (branch_id uuid, shop text, from_date date, to_date date, due_date date,
               pieces numeric, gross numeric, deductions numeric, net numeric,
               remaining numeric, status text, odd_lines int)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_days  int;
  v_paid  numeric;
begin
  perform carrefour_accounts_guard();
  select maturity_days into v_days from carrefour_settings where id;
  select coalesce(sum(amount), 0) into v_paid from carrefour_payments where voided_at is null;

  return query
  with sold as (
    select s.branch_id, s.shop, s.from_date, s.to_date, (s.to_date + v_days) as due,
           s.pieces, s.sold_value as gross,
           round(s.sold_value * coalesce((
             select sum(t.rate) from carrefour_terms t
              where t.mode = 'percent' and t.effective_from <= s.to_date
                and (t.effective_to is null or t.effective_to >= s.to_date)), 0) / 100, 2) as ded,
           s.odd_lines
      from carrefour_sold_periods() s
  ), fees as (
    select null::uuid, t.label, m::date, (m + interval '1 month - 1 day')::date,
           (m + interval '1 month - 1 day')::date, 0::numeric, 0::numeric, t.rate, 0
      from carrefour_terms t
     cross join lateral generate_series(date_trunc('month', t.effective_from),
                 date_trunc('month', least(coalesce(t.effective_to, v_today), v_today)),
                 interval '1 month') m
     where t.mode = 'monthly'
  ), rows_ as (
    select * from sold union all select * from fees
  ), walked as (
    select r.*, r.gross - r.ded as net,
           sum(r.gross - r.ded) over (order by r.due, r.branch_id nulls first, r.to_date) as cum
      from rows_ r
  )
  select w.branch_id, w.shop, w.from_date, w.to_date, w.due, w.pieces, w.gross, w.ded, w.net,
         least(greatest(w.net, 0), greatest(w.cum - v_paid, 0)),
         case when w.net <= 0 then 'Deducted'
              when w.cum <= v_paid then 'Paid'
              when w.due < v_today then 'Overdue'
              else 'Upcoming' end,
         w.odd_lines
    from walked w
   order by w.due desc, w.shop;
end;
$fn$;


/* Expected against charged, kind by kind. */
create or replace function public.carrefour_deduction_check()
returns table (kind text, expected numeric, actual numeric, unexplained numeric)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
declare v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform carrefour_accounts_guard();
  return query
  with k(kind) as (values ('front_margin'),('back_margin'),('rebate'),('supply_fee'),('other')),
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
         greatest(round(coalesce(a.a, 0) - coalesce(p.e, 0) - coalesce(f.e, 0), 2), 0)
    from k
    left join pct p on p.kind = k.kind
    left join fix f on f.kind = k.kind
    left join act a on a.kind = k.kind;
end;
$fn$;


/* Every Carrefour invoice, with its lines, read from the warehouse's own
   deliveries. Read only: invoices are changed in the warehouse Invoice Book. */
create or replace function public.carrefour_invoices()
returns table (invoice_no text, on_date date, shop text, delivery_no int,
               pieces numeric, retail numeric, unpriced int, lines jsonb)
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
#variable_conflict use_column
begin
  perform carrefour_accounts_guard();
  return query
  select m.invoice_no,
         min((m.created_at at time zone 'Asia/Karachi')::date),
         string_agg(distinct b.name, ', '),
         min(m.delivery_no)::int,
         sum(m.quantity),
         round(sum(m.quantity * coalesce(i.retail_price, 0)), 2),
         (count(*) filter (where i.retail_price is null))::int,
         jsonb_agg(jsonb_build_object(
           'id', m.id, 'created_at', m.created_at, 'barcode', i.barcode, 'manual_code', i.manual_barcode,
           'name', i.name, 'quantity', m.quantity, 'retail_price', i.retail_price,
           'retail_total', round(m.quantity * coalesce(i.retail_price, 0), 2),
           'voided_at', null, 'void_reason', null, 'branch', b.name, 'delivery_no', m.delivery_no)
           order by m.created_at)
    from khana_stock_movements m
    join khana_final_items i on i.id = m.item_id
    left join khana_party_branches b on b.id = m.branch_id
   where m.party_id = carrefour_party_id() and m.movement_type = 'OUT' and m.voided_at is null
   group by m.invoice_no
   order by 2 desc, 1 desc;
end;
$fn$;


/* Everything the dashboard shows, in one call. */
create or replace function public.carrefour_summary()
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_temp' as $fn$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v jsonb;
begin
  perform carrefour_accounts_guard();
  with latest as (
    select l.* from carrefour_report_lines l
     where l.report_date = (select max(x.report_date) from carrefour_report_lines x where x.branch_id = l.branch_id)
  ), m as (select * from carrefour_maturity()),
  d as (select * from carrefour_deduction_check()),
  paid as (select coalesce(sum(amount), 0) a from carrefour_payments where voided_at is null),
  sent as (
    select coalesce(sum(s.quantity), 0) pcs, coalesce(sum(s.quantity * i.retail_price), 0) val,
           count(distinct s.invoice_no) invs
      from khana_stock_movements s join khana_final_items i on i.id = s.item_id
     where s.party_id = carrefour_party_id() and s.movement_type = 'OUT' and s.voided_at is null
  )
  select jsonb_build_object(
    'today', v_today,
    'maturity_days', (select maturity_days from carrefour_settings where id),
    'terms', (select count(*) from carrefour_terms),
    'reports', (select count(distinct report_date) from carrefour_report_lines),
    'last_report', (select max(report_date) from carrefour_report_lines),
    'sold_periods', (select count(*) from m where m.branch_id is not null),
    'stock_pieces', (select coalesce(sum(quantity), 0) from latest),
    'stock_value', (select coalesce(sum(quantity * retail_price), 0) from latest),
    'lines', (select count(*) from latest),
    'unmatched_lines', (select count(*) from latest where item_id is null),
    'sent_pieces', (select pcs from sent), 'sent_value', (select val from sent), 'invoices', (select invs from sent),
    'gross', (select coalesce(sum(gross), 0) from m),
    'expected', (select coalesce(sum(deductions), 0) from m),
    'net', (select coalesce(sum(net), 0) from m),
    'paid', (select a from paid),
    'debit_notes', (select coalesce(sum(actual), 0) from d),
    'unexplained', (select coalesce(sum(unexplained), 0) from d),
    'overdue', (select coalesce(sum(remaining), 0) from m where due_date < v_today),
    'due_7', (select coalesce(sum(remaining), 0) from m where due_date >= v_today and due_date <= v_today + 7),
    'due_30', (select coalesce(sum(remaining), 0) from m where due_date >= v_today and due_date <= v_today + 30),
    'not_yet_due', (select coalesce(sum(remaining), 0) from m where due_date >= v_today),
    'odd_lines', (select coalesce(sum(odd_lines), 0) from m)
  ) into v;
  return v;
end;
$fn$;

revoke all on function public.carrefour_accounts_guard(), public.carrefour_sold_periods(),
  public.carrefour_maturity(), public.carrefour_deduction_check(),
  public.carrefour_invoices(), public.carrefour_summary() from public, anon;
grant execute on function public.carrefour_accounts_guard(), public.carrefour_sold_periods(),
  public.carrefour_maturity(), public.carrefour_deduction_check(),
  public.carrefour_invoices(), public.carrefour_summary() to authenticated;

commit;
