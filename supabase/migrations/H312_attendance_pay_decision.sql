create table public.att_pay_final (
  employee_id uuid not null references public.employees(id) on delete cascade,
  pay_month date not null check (pay_month = date_trunc('month', pay_month)::date),
  amount numeric(12,2) not null check (amount >= 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (employee_id, pay_month)
);
alter table public.att_pay_final enable row level security;
create policy att_pay_final_all on public.att_pay_final for all to authenticated
  using ((select has_permission('employees.manage'))) with check ((select has_permission('employees.manage')));

create or replace function public.att_month_hours(p_month date)
returns table (employee_id uuid, required_minutes integer, attended_minutes integer, working_days integer, total_salary numeric, obtained_salary numeric, final_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then
    raise exception 'Not allowed';
  end if;
  return query
  with people as (
    select e.id, lower(coalesce(e.pay_type, '')) as pay_type, coalesce(e.pay_amount, 0)::numeric as amount
    from public.employees e
    join public.att_employee_settings s on s.employee_id = e.id
    where e.is_active or exists (select 1 from public.att_days x where x.employee_id = e.id and x.att_date between v_from and v_to)
  ), plan as (
    select p.id, count(*)::integer as days, sum(greatest((extract(epoch from (sh.end_time - sh.start_time)) / 60)::integer - sh.break_minutes, 1))::integer as minutes
    from people p
    cross join generate_series(v_from, v_to, interval '1 day') g(day)
    join public.att_shifts sh on sh.id = public.att_resolved_shift(p.id, g.day::date)
    where not extract(dow from g.day)::integer = any(sh.off_weekdays)
      and not exists (select 1 from public.online_att_holidays h where h.hdate = to_char(g.day, 'YYYY-MM-DD'))
    group by p.id
  ), done as (
    select a.employee_id as id, sum(case
      when a.status = 'paid_leave' or (a.status = 'present' and a.is_manual) then a.scheduled_minutes
      when a.status in ('present', 'half_day') then least(a.worked_minutes, a.scheduled_minutes)
      else 0 end)::integer as minutes
    from public.att_days a
    where a.att_date between v_from and v_to
    group by a.employee_id
  ), totals as (
    select p.id, coalesce(pl.minutes, 0) as req, coalesce(d.minutes, 0) as att, coalesce(pl.days, 0) as days,
      case p.pay_type
        when 'monthly' then p.amount
        when 'daily' then p.amount * coalesce(pl.days, 0)
        when 'hourly' then round(p.amount * coalesce(pl.minutes, 0) / 60.0, 2)
        else null end as total
    from people p
    left join plan pl on pl.id = p.id
    left join done d on d.id = p.id
  )
  select t.id, t.req, t.att, t.days, t.total,
    case when t.total is null or t.req = 0 then null else round(t.total * t.att / t.req, 2) end,
    f.amount
  from totals t
  left join public.att_pay_final f on f.employee_id = t.id and f.pay_month = v_from;
end $$;

revoke all on function public.att_month_hours(date) from public, anon;
grant execute on function public.att_month_hours(date) to authenticated, service_role;
