drop function if exists public.att_daily_wages(date);

create function public.att_daily_wages(p_date date)
returns table (employee_id uuid, code text, name text, department text, status text, first_in timestamptz, last_out timestamptz,
  worked_minutes integer, shift_minutes integer, overtime_minutes integer, daily_wage numeric, amount_due numeric, amount_paid numeric)
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then
    raise exception 'Not allowed';
  end if;
  perform public.att_recalculate_range_internal(p_date, p_date);
  return query
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
end $$;

revoke all on function public.att_daily_wages(date) from public, anon;
grant execute on function public.att_daily_wages(date) to authenticated, service_role;
