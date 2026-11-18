-- K198 — Daily Wage Desk (supervisor portal)
-- Karkhana department only. Reads/writes att_* tables and the Karkhana permission catalogue.
-- Does NOT touch online_* (Hub) or retail_* (Shops Sales) tables.
-- Shared tables touched: permissions (+1 row), roles (+1 row), role_permissions (+2 rows). employees/departments: read only.

begin;

create or replace function public.att_daily_wages_internal(p_date date)
returns table(employee_id uuid, code text, name text, department text, status text, first_in timestamptz, last_out timestamptz, worked_minutes integer, shift_minutes integer, overtime_minutes integer, daily_wage numeric, amount_due numeric, amount_paid numeric)
language sql stable security definer set search_path to 'public'
as $$
  select e.id, e.code, e.name, d.name, a.status, a.first_in, a.last_out,
    coalesce(a.worked_minutes, 0),
    coalesce(a.scheduled_minutes, 0),
    case when s.overtime_enabled then coalesce(a.overtime_approved_minutes, 0) + coalesce(a.extra_overtime_minutes, 0) else 0 end,
    coalesce(e.pay_amount, 0)::numeric,
    round(case
      when a.status = 'paid_leave' then e.pay_amount
      when a.status = 'present' and a.is_manual then e.pay_amount
      when not s.late_cut_enabled and a.first_in is not null then e.pay_amount
      when a.last_out is null or coalesce(a.scheduled_minutes, 0) = 0 then 0
      else e.pay_amount * least(a.worked_minutes::numeric / a.scheduled_minutes, 1)
    end
    + case when s.overtime_enabled and coalesce(a.scheduled_minutes, 0) > 0 and a.status not in ('absent', 'pending', 'no_shift')
        then (coalesce(a.overtime_approved_minutes, 0) + coalesce(a.extra_overtime_minutes, 0)) * e.pay_amount / a.scheduled_minutes * s.overtime_multiplier
        else 0 end, 0),
    w.amount
  from public.employees e
  join public.att_employee_settings s on s.employee_id = e.id
  left join public.departments d on d.id = e.department_id
  left join public.att_days a on a.employee_id = e.id and a.att_date = p_date
  left join public.att_wage_payments w on w.employee_id = e.id and w.pay_date = p_date
  where e.is_active and lower(coalesce(e.pay_type, '')) = 'daily'
  order by d.name nulls last, e.name;
$$;
revoke all on function public.att_daily_wages_internal(date) from public, anon, authenticated;

create or replace function public.att_daily_wages(p_date date)
returns table(employee_id uuid, code text, name text, department text, status text, first_in timestamptz, last_out timestamptz, worked_minutes integer, shift_minutes integer, overtime_minutes integer, daily_wage numeric, amount_due numeric, amount_paid numeric)
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then
    raise exception 'Not allowed';
  end if;
  perform public.att_recalculate_range_internal(p_date, p_date);
  return query select * from public.att_daily_wages_internal(p_date);
end $$;

create or replace function public.kk_wage_desk_dept_ids()
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  with recursive t as (
    select id from public.departments where code in ('KARKHANA', 'LABOR') or kind = 'section'
    union
    select d.id from public.departments d join t on d.parent_id = t.id
  )
  select id from t;
$$;
revoke all on function public.kk_wage_desk_dept_ids() from public, anon, authenticated;

insert into public.permissions (code, module, description)
values ('wages.desk', 'payroll', 'Daily wage desk: see Karkhana daily-wage workers, their check in/out and pay them in cash')
on conflict (code) do nothing;

do $$
declare v_role uuid;
begin
  select id into v_role from public.roles where code = 'kk_wage_supervisor';
  if v_role is null then
    insert into public.roles (code, name, description, is_system)
    values ('kk_wage_supervisor', 'Wage Supervisor', 'Sees only Karkhana daily-wage workers: check in/out, wage earned today, and records the cash paid', false)
    returning id into v_role;
    insert into public.karkhana_roles (role_id, locked) values (v_role, 'preset');
  end if;
  insert into public.role_permissions (role_id, permission_id)
    select v_role, p.id from public.permissions p where p.code = 'wages.desk'
  on conflict do nothing;
  insert into public.role_permissions (role_id, permission_id)
    select r.id, p.id from public.roles r cross join public.permissions p
     where r.code = 'kk_admin' and p.code = 'wages.desk'
  on conflict do nothing;
end $$;

create or replace function public.karkhana_permission_catalogue()
returns table(code text, grp text, label text, sort integer)
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$
  select c.code, c.grp, c.label, c.sort
  from (values
    ('khana.view',         'Warehouse', 'See the warehouse — stock, products and their history', 10),
    ('khana.stock.in',     'Warehouse', 'Stock in — New GRN', 11),
    ('khana.stock.out',    'Warehouse', 'Stock out — STR', 12),
    ('khana.return',       'Warehouse', 'GR out — goods back to the supplier', 13),
    ('khana.products.add', 'Warehouse', 'Add new products', 14),
    ('khana.reports',      'Warehouse', 'Warehouse reports and graph', 15),
    ('khana.manage',       'Warehouse', 'Full control — edit, rename, delete, void, correct stock', 16),
    ('inventory.view',     'Factory', 'See raw material, New GRN and stock', 20),
    ('grn.create',         'Factory', 'Record material GRN and GR out', 21),
    ('inventory.issue',    'Factory', 'Issue material to the floor', 22),
    ('inventory.return',   'Factory', 'Record material returns', 23),
    ('inventory.sort',     'Factory', 'Sort bulk material', 24),
    ('inventory.transfer', 'Factory', 'Move material between locations', 25),
    ('inventory.adjust',   'Factory', 'Correct material stock, void GRNs', 26),
    ('finished.view',      'Factory', 'See finished garment stock', 27),
    ('finished.adjust',    'Factory', 'Correct finished stock by hand', 28),
    ('materials.manage',   'Factory', 'Manage material groups, sizes and units', 29),
    ('production.view',    'Production', 'See production, articles and machine process', 30),
    ('production.entry',   'Production', 'Enter production, factory STR, add articles', 31),
    ('production.manage',  'Production', 'Manage production orders and articles', 32),
    ('process.view',       'Production', 'See process work and what is owed', 33),
    ('process.manage',     'Production', 'Record machine process, manage factory staff', 34),
    ('process.pay',        'Production', 'Mark piece-rate wages as paid', 35),
    ('rates.manage',       'Production', 'Set purchase and piece rates', 36),
    ('payroll.view',       'Staff & payroll', 'See staff earnings and payroll', 40),
    ('payroll.manage',     'Staff & payroll', 'Run payroll', 41),
    ('wages.desk',         'Staff & payroll', 'Daily wage desk — Karkhana daily-wage workers only: check in/out and pay cash', 42),
    ('suppliers.manage',   'Payments', 'Manage suppliers', 50),
    ('payments.manage',    'Payments', 'Record supplier payments', 51),
    ('grn.approve',        'Approvals', 'Approve GRNs', 60),
    ('inventory.approve',  'Approvals', 'Approve stock movements', 61),
    ('production.approve', 'Approvals', 'Approve production entries', 62),
    ('reports.view',       'Reports', 'Dashboard and reports', 70),
    ('reports.export',     'Reports', 'Export reports', 71),
    ('karkhana.admin',     'Team', 'Karkhana admin — add people, give logins, set job roles', 90)
  ) as c(code, grp, label, sort)
  join public.permissions p on p.code = c.code
  order by c.sort;
$$;

create or replace function public.kk_wage_desk(p_date date)
returns table(
  employee_id uuid, code text, name text, designation text, section text, phone text,
  status text, first_in timestamptz, last_out timestamptz,
  worked_minutes integer, shift_minutes integer, overtime_minutes integer,
  daily_wage numeric, amount_due numeric, is_running boolean,
  amount_paid numeric, paid_note text, paid_at timestamptz, paid_by_name text,
  can_pay boolean
)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_admin boolean := public.has_permission('karkhana.admin') or public.has_permission('employees.manage');
  v_emp uuid;
begin
  if not public.has_permission('wages.desk') then
    raise exception 'Not allowed';
  end if;
  if p_date is null or p_date > v_today then
    raise exception 'Pick today or an earlier date.';
  end if;

  for v_emp in
    select e.id from public.employees e
    join public.att_employee_settings s on s.employee_id = e.id
    where e.is_active and lower(coalesce(e.pay_type, '')) = 'daily'
      and e.department_id in (select public.kk_wage_desk_dept_ids())
  loop
    perform public.att_recalculate_range_internal(p_date, p_date, v_emp);
  end loop;

  return query
  select w.employee_id, w.code, w.name, dg.name, w.department, e.phone,
    w.status, w.first_in, w.last_out,
    case when w.first_in is not null and w.last_out is null and p_date = v_today
         then greatest(0, floor(extract(epoch from (now() - w.first_in)) / 60))::int
         else w.worked_minutes end,
    w.shift_minutes, w.overtime_minutes, w.daily_wage,
    case when w.first_in is not null and w.last_out is null and p_date = v_today
         then round(case when not s.late_cut_enabled or w.shift_minutes = 0 then w.daily_wage
                         else w.daily_wage * least(extract(epoch from (now() - w.first_in)) / 60 / w.shift_minutes, 1) end, 0)
         else w.amount_due end,
    (w.first_in is not null and w.last_out is null and p_date = v_today),
    w.amount_paid, wp.note, wp.created_at, pu.full_name,
    (v_admin or p_date >= v_today - 7)
  from public.att_daily_wages_internal(p_date) w
  join public.employees e on e.id = w.employee_id
  join public.att_employee_settings s on s.employee_id = w.employee_id
  left join public.designations dg on dg.id = e.designation_id
  left join public.att_wage_payments wp on wp.employee_id = w.employee_id and wp.pay_date = p_date
  left join public.app_users pu on pu.id = wp.paid_by
  where e.department_id in (select public.kk_wage_desk_dept_ids())
  order by (w.first_in is null), w.first_in, w.name;
end $$;

create or replace function public.kk_wage_desk_guard(p_employee_id uuid, p_date date)
returns void
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  if not public.has_permission('wages.desk') then
    raise exception 'Not allowed';
  end if;
  if not exists (
    select 1 from public.employees e
    join public.att_employee_settings s on s.employee_id = e.id
    where e.id = p_employee_id and e.is_active and lower(coalesce(e.pay_type, '')) = 'daily'
      and e.department_id in (select public.kk_wage_desk_dept_ids())
  ) then
    raise exception 'This worker is not on the Karkhana daily wage desk.';
  end if;
  if p_date is null or p_date > v_today then
    raise exception 'You cannot pay for a future date.';
  end if;
  if p_date < v_today - 7 and not (public.has_permission('karkhana.admin') or public.has_permission('employees.manage')) then
    raise exception 'Payments older than 7 days can only be changed by an admin.';
  end if;
end $$;
revoke all on function public.kk_wage_desk_guard(uuid, date) from public, anon, authenticated;

create or replace function public.kk_wage_desk_pay(p_employee_id uuid, p_date date, p_amount numeric, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.kk_wage_desk_guard(p_employee_id, p_date);
  if p_amount is null or p_amount < 0 then
    raise exception 'Enter the cash amount paid.';
  end if;
  if p_amount > 100000 then
    raise exception 'That amount looks wrong for one day. Check it again.';
  end if;
  insert into public.att_wage_payments (employee_id, pay_date, amount, note, paid_by)
  values (p_employee_id, p_date, round(p_amount, 0), nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (employee_id, pay_date) do update
    set amount = excluded.amount, note = excluded.note, paid_by = excluded.paid_by;
end $$;

create or replace function public.kk_wage_desk_unpay(p_employee_id uuid, p_date date)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.kk_wage_desk_guard(p_employee_id, p_date);
  delete from public.att_wage_payments where employee_id = p_employee_id and pay_date = p_date;
end $$;

revoke all on function public.kk_wage_desk(date) from public, anon;
revoke all on function public.kk_wage_desk_pay(uuid, date, numeric, text) from public, anon;
revoke all on function public.kk_wage_desk_unpay(uuid, date) from public, anon;
grant execute on function public.kk_wage_desk(date) to authenticated;
grant execute on function public.kk_wage_desk_pay(uuid, date, numeric, text) to authenticated;
grant execute on function public.kk_wage_desk_unpay(uuid, date) to authenticated;

commit;

-- Verify after running (should return 3 functions, 1 role with 1 permission, and 10 workers for an admin):
-- select proname from pg_proc where proname in ('kk_wage_desk','kk_wage_desk_pay','kk_wage_desk_unpay');
-- select r.name, p.code from roles r join role_permissions rp on rp.role_id=r.id join permissions p on p.id=rp.permission_id where r.code='kk_wage_supervisor';
