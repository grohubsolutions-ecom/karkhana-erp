alter table public.att_devices add column allowed_ip text;
alter table public.att_days add column extra_overtime_minutes integer not null default 0 check (extra_overtime_minutes >= 0), add column extra_overtime_note text;

create table public.att_day_shifts (
  employee_id uuid not null references public.employees(id) on delete cascade,
  att_date date not null,
  shift_id uuid not null references public.att_shifts(id),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (employee_id, att_date)
);

create table public.att_adjustments (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id) on delete cascade,
  adj_date date not null,
  kind text not null check (kind in ('advance','deduction','bonus')),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index att_adjustments_date_idx on public.att_adjustments (adj_date);

alter table public.att_day_shifts enable row level security;
alter table public.att_adjustments enable row level security;
create policy att_day_shifts_all on public.att_day_shifts for all to authenticated using ((select has_permission('employees.manage'))) with check ((select has_permission('employees.manage')));
create policy att_adjustments_all on public.att_adjustments for all to authenticated using ((select has_permission('employees.manage'))) with check ((select has_permission('employees.manage')));

create or replace function public.att_resolved_shift(p_employee_id uuid, p_date date)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select shift_id from public.att_day_shifts where employee_id = p_employee_id and att_date = p_date),
    public.att_resolved_shift(p_employee_id));
$$;

create or replace function public.att_recalculate_day(p_employee_id uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tz constant text := 'Asia/Karachi';
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  e public.employees%rowtype;
  s public.att_employee_settings%rowtype;
  sh public.att_shifts%rowtype;
  v_shift_id uuid;
  v_sched_in timestamptz;
  v_sched_out timestamptz;
  v_sched_minutes integer := 0;
  v_in timestamptz;
  v_out timestamptz;
  v_span integer := 0;
  v_worked integer := 0;
  v_late integer := 0;
  v_early integer := 0;
  v_ot integer := 0;
  v_status text;
  v_is_off boolean;
  v_is_holiday boolean;
begin
  if p_date > v_today then return; end if;
  select * into e from public.employees where id = p_employee_id;
  select * into s from public.att_employee_settings where employee_id = p_employee_id;
  if not found or not coalesce(e.is_active, false) or p_date < s.effective_from or (e.join_date is not null and p_date < e.join_date) then return; end if;
  if exists (select 1 from public.att_days where employee_id = p_employee_id and att_date = p_date and is_manual) then return; end if;

  v_shift_id := public.att_resolved_shift(p_employee_id, p_date);
  if v_shift_id is null then
    insert into public.att_days (employee_id, att_date, status) values (p_employee_id, p_date, 'no_shift')
    on conflict (employee_id, att_date) do update set status = 'no_shift', shift_id = null, scheduled_minutes = 0, first_in = null, last_out = null, worked_minutes = 0, late_minutes = 0, early_minutes = 0, overtime_minutes = 0, updated_at = now();
    return;
  end if;

  select * into sh from public.att_shifts where id = v_shift_id;
  v_sched_in := (p_date + sh.start_time) at time zone v_tz;
  v_sched_out := (p_date + sh.end_time) at time zone v_tz;
  v_sched_minutes := greatest((extract(epoch from (v_sched_out - v_sched_in)) / 60)::integer - sh.break_minutes, 1);

  if s.device_user_id is not null then
    select min(punched_at), max(punched_at) into v_in, v_out
    from public.att_punches
    where device_user_id = s.device_user_id
      and punched_at >= p_date::timestamp at time zone v_tz
      and punched_at < (p_date + 1)::timestamp at time zone v_tz;
  end if;

  if v_in is not null then
    v_span := floor(extract(epoch from (v_out - v_in)) / 60)::integer;
    if v_span >= 5 then v_worked := greatest(v_span - sh.break_minutes, 0); end if;
  end if;

  v_is_off := extract(dow from p_date)::integer = any(sh.off_weekdays);
  v_is_holiday := exists (select 1 from public.online_att_holidays where hdate = to_char(p_date, 'YYYY-MM-DD'));

  if v_is_off or v_is_holiday then
    if v_worked > 0 then
      v_status := 'worked_off';
      if s.overtime_enabled then v_ot := v_worked; end if;
    elsif v_is_holiday then v_status := 'holiday';
    else v_status := 'off';
    end if;
  elsif v_in is null then
    v_status := case when p_date = v_today and v_now < v_sched_out then 'pending' else 'absent' end;
  elsif v_span < 5 then
    if v_in > v_sched_in + make_interval(mins => sh.late_grace_minutes) then
      v_late := ceil(extract(epoch from (v_in - v_sched_in)) / 60)::integer;
    end if;
    v_status := case when p_date = v_today and v_now < v_sched_out + interval '3 hours' then 'in_progress' else 'missing_out' end;
  elsif sh.half_day_minutes is not null and v_worked < sh.half_day_minutes then
    v_status := 'half_day';
  else
    v_status := 'present';
    if v_in > v_sched_in + make_interval(mins => sh.late_grace_minutes) then
      v_late := ceil(extract(epoch from (v_in - v_sched_in)) / 60)::integer;
    end if;
    if v_out < v_sched_out - make_interval(mins => sh.early_grace_minutes) then
      v_early := ceil(extract(epoch from (v_sched_out - v_out)) / 60)::integer;
    end if;
    if s.overtime_enabled and v_out >= v_sched_out + make_interval(mins => sh.overtime_after_minutes) then
      v_ot := floor(extract(epoch from (v_out - v_sched_out)) / 60)::integer;
    end if;
  end if;

  insert into public.att_days (employee_id, att_date, shift_id, scheduled_minutes, first_in, last_out, worked_minutes, late_minutes, early_minutes, overtime_minutes, status)
  values (p_employee_id, p_date, v_shift_id, v_sched_minutes, v_in, case when v_span >= 5 then v_out end, v_worked, v_late, v_early, v_ot, v_status)
  on conflict (employee_id, att_date) do update set
    shift_id = excluded.shift_id,
    scheduled_minutes = excluded.scheduled_minutes,
    first_in = excluded.first_in,
    last_out = excluded.last_out,
    worked_minutes = excluded.worked_minutes,
    late_minutes = excluded.late_minutes,
    early_minutes = excluded.early_minutes,
    overtime_minutes = excluded.overtime_minutes,
    overtime_approved_minutes = least(public.att_days.overtime_approved_minutes, excluded.overtime_minutes),
    status = excluded.status,
    updated_at = now();
end $$;

create or replace function public.att_set_day_status(p_employee_id uuid, p_date date, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_shift uuid; v_minutes integer;
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then raise exception 'Not allowed'; end if;
  if p_status is null then
    delete from public.att_days where employee_id = p_employee_id and att_date = p_date;
    perform public.att_recalculate_day(p_employee_id, p_date);
    return;
  end if;
  if p_status not in ('present','absent','paid_leave') then raise exception 'Unknown status'; end if;
  v_shift := public.att_resolved_shift(p_employee_id, p_date);
  if v_shift is null then raise exception 'Give this person a shift first'; end if;
  select greatest((extract(epoch from (end_time - start_time)) / 60)::integer - break_minutes, 1) into v_minutes from public.att_shifts where id = v_shift;
  insert into public.att_days (employee_id, att_date, shift_id, scheduled_minutes, worked_minutes, status, is_manual, note)
  values (p_employee_id, p_date, v_shift, v_minutes, case when p_status = 'present' then v_minutes else 0 end, p_status, true, p_note)
  on conflict (employee_id, att_date) do update set
    shift_id = excluded.shift_id, scheduled_minutes = excluded.scheduled_minutes, worked_minutes = excluded.worked_minutes,
    late_minutes = 0, early_minutes = 0, overtime_minutes = 0, overtime_approved_minutes = 0,
    status = excluded.status, is_manual = true, note = excluded.note, updated_at = now();
end $$;

create or replace function public.att_device_seen(p_serial text, p_ip text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  update public.att_devices set last_seen_at = now(), last_ip = coalesce(p_ip, last_ip)
  where serial_no = p_serial and is_enabled and (allowed_ip is null or p_ip is null or allowed_ip = p_ip)
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function public.att_add_overtime(p_employee_id uuid, p_date date, p_minutes integer, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then raise exception 'Not allowed'; end if;
  if p_minutes is null or p_minutes < 0 then raise exception 'Enter the overtime'; end if;
  perform public.att_recalculate_day(p_employee_id, p_date);
  update public.att_days set extra_overtime_minutes = p_minutes, extra_overtime_note = p_note, updated_at = now()
  where employee_id = p_employee_id and att_date = p_date and scheduled_minutes > 0;
  if not found then raise exception 'This person has no shift on that date'; end if;
end $$;

create or replace function public.att_set_holiday(p_date date, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then raise exception 'Not allowed'; end if;
  delete from public.online_att_holidays where hdate = to_char(p_date, 'YYYY-MM-DD');
  if nullif(trim(coalesce(p_name, '')), '') is not null then
    insert into public.online_att_holidays (hdate, name) values (to_char(p_date, 'YYYY-MM-DD'), trim(p_name));
  end if;
  perform public.att_recalculate_range_internal(p_date, p_date);
end $$;

create or replace function public.att_daily_wages(p_date date)
returns table (employee_id uuid, code text, name text, department text, status text, first_in timestamptz, last_out timestamptz, worked_minutes integer, amount_due numeric, amount_paid numeric)
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then
    raise exception 'Not allowed';
  end if;
  perform public.att_recalculate_range_internal(p_date, p_date);
  return query
  select e.id, e.code, e.name, d.name, a.status, a.first_in, a.last_out, a.worked_minutes,
    round(case
      when a.status = 'present' then e.pay_amount * (case when s.late_cut_enabled then least(a.worked_minutes / nullif(a.scheduled_minutes, 0)::numeric, 1) else 1 end)
      when a.status = 'half_day' then e.pay_amount / 2
      when a.status = 'paid_leave' then e.pay_amount
      else 0 end
      + case when s.overtime_enabled then (coalesce(a.overtime_approved_minutes, 0) + coalesce(a.extra_overtime_minutes, 0)) * e.pay_amount / nullif(a.scheduled_minutes, 0)::numeric * s.overtime_multiplier else 0 end, 2),
    w.amount
  from public.employees e
  join public.att_employee_settings s on s.employee_id = e.id
  left join public.departments d on d.id = e.department_id
  left join public.att_days a on a.employee_id = e.id and a.att_date = p_date
  left join public.att_wage_payments w on w.employee_id = e.id and w.pay_date = p_date
  where e.is_active and lower(coalesce(e.pay_type, '')) = 'daily'
  order by d.name nulls last, e.name;
end $$;

drop function public.att_month_pay(date);
create or replace function public.att_month_pay(p_month date)
returns table (
  employee_id uuid, code text, name text, department text, pay_type text, base_amount numeric,
  present_days numeric, half_days integer, absent_days integer, paid_leave_days integer, review_days integer,
  late_minutes integer, early_minutes integer, overtime_pending_minutes integer, overtime_approved_minutes integer,
  attendance_cut numeric, overtime_pay numeric, net_pay numeric, wages_paid numeric, advances numeric, deductions numeric, bonuses numeric, note text
) language plpgsql security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  if not (auth.role() = 'service_role' or public.has_permission('employees.manage')) then
    raise exception 'Not allowed';
  end if;
  perform public.att_recalculate_range_internal(v_from, v_to);
  return query
  with base as (
    select e.id, e.code, e.name, d.name as department, lower(coalesce(e.pay_type, '')) as pay_type,
           coalesce(e.pay_amount, 0)::numeric as amount, s.working_days_per_month as wd, s.late_cut_enabled, s.overtime_multiplier,
           e.is_active,
           (select count(*) from generate_series(v_from, least(v_to, greatest(s.effective_from, coalesce(e.join_date, s.effective_from)) - 1), interval '1 day') g(day)
            where not extract(dow from g.day)::integer = any(coalesce(
              (select sh.off_weekdays from public.att_shifts sh where sh.id = public.att_resolved_shift(e.id)),
              '{0}'::integer[]))) as pre_start_days
    from public.employees e
    join public.att_employee_settings s on s.employee_id = e.id
    left join public.departments d on d.id = e.department_id
    where e.is_active or exists (select 1 from public.att_days x where x.employee_id = e.id and x.att_date between v_from and v_to)
  ), day_rows as (
    select b.*, a.status, a.worked_minutes, a.late_minutes, a.early_minutes, a.overtime_minutes, (a.overtime_approved_minutes + a.extra_overtime_minutes) as overtime_paid_minutes, a.overtime_approved_minutes,
           nullif(a.scheduled_minutes, 0)::numeric as sched
    from base b left join public.att_days a on a.employee_id = b.id and a.att_date between v_from and v_to
  ), calc as (
    select r.*,
      case
        when r.pay_type = 'monthly' then
          case when r.status = 'absent' then r.amount / r.wd
               when r.status = 'half_day' then r.amount / r.wd / 2
               when r.status = 'present' and r.late_cut_enabled then (r.late_minutes + r.early_minutes) * r.amount / r.wd / r.sched
               else 0 end
        else 0 end as cut,
      case
        when r.pay_type = 'daily' then
          case when r.status = 'present' then r.amount * (case when r.late_cut_enabled then least(r.worked_minutes / r.sched, 1) else 1 end)
               when r.status = 'half_day' then r.amount / 2
               when r.status = 'paid_leave' then r.amount
               else 0 end
        when r.pay_type = 'hourly' then greatest(r.worked_minutes - r.overtime_minutes, 0) * r.amount / 60
        else 0 end as earned,
      case
        when r.pay_type = 'monthly' then r.overtime_paid_minutes * r.amount / r.wd / r.sched * r.overtime_multiplier
        when r.pay_type = 'daily' then r.overtime_paid_minutes * r.amount / r.sched * r.overtime_multiplier
        when r.pay_type = 'hourly' then r.overtime_paid_minutes * r.amount / 60 * r.overtime_multiplier
        else 0 end as ot_pay
    from day_rows r
  )
  select c.id, c.code, c.name, c.department, c.pay_type, c.amount,
    (count(*) filter (where c.status in ('present','worked_off')) + count(*) filter (where c.status = 'half_day') * 0.5)::numeric,
    (count(*) filter (where c.status = 'half_day'))::integer,
    (count(*) filter (where c.status = 'absent'))::integer,
    (count(*) filter (where c.status = 'paid_leave'))::integer,
    (count(*) filter (where c.status in ('missing_out','no_shift')))::integer,
    coalesce(sum(c.late_minutes), 0)::integer,
    coalesce(sum(c.early_minutes), 0)::integer,
    coalesce(sum(c.overtime_minutes - c.overtime_approved_minutes), 0)::integer,
    coalesce(sum(c.overtime_paid_minutes), 0)::integer,
    round(coalesce(sum(c.cut), 0) + case when c.pay_type = 'monthly' then c.pre_start_days * c.amount / c.wd else 0 end, 2),
    round(coalesce(sum(c.ot_pay), 0), 2),
    case
      when not c.is_active then null
      when c.pay_type = 'monthly' then greatest(round(c.amount - c.pre_start_days * c.amount / c.wd - coalesce(sum(c.cut), 0) + coalesce(sum(c.ot_pay), 0), 2), 0)
      when c.pay_type in ('daily','hourly') then round(coalesce(sum(c.earned), 0) + coalesce(sum(c.ot_pay), 0), 2)
      else null end,
    coalesce((select sum(w.amount) from public.att_wage_payments w where w.employee_id = c.id and w.pay_date between v_from and v_to), 0),
    coalesce((select sum(j.amount) from public.att_adjustments j where j.employee_id = c.id and j.kind = 'advance' and j.adj_date between v_from and v_to), 0),
    coalesce((select sum(j.amount) from public.att_adjustments j where j.employee_id = c.id and j.kind = 'deduction' and j.adj_date between v_from and v_to), 0),
    coalesce((select sum(j.amount) from public.att_adjustments j where j.employee_id = c.id and j.kind = 'bonus' and j.adj_date between v_from and v_to), 0),
    case
      when not c.is_active then 'Left during this month: settle final pay by hand'
      when c.pay_type in ('monthly','daily','hourly') then null
      when c.pay_type in ('piece','piece-rate') then 'Use Karkhana piece-rate earnings'
      else 'Set a pay type' end
  from calc c
  group by c.id, c.code, c.name, c.department, c.pay_type, c.amount, c.wd, c.is_active, c.pre_start_days
  order by c.department nulls last, c.name;
end $$;

revoke all on function public.att_resolved_shift(uuid, date) from public, anon, authenticated;
revoke all on function public.att_recalculate_day(uuid, date) from public, anon, authenticated;
revoke all on function public.att_device_seen(text, text) from public, anon, authenticated;
revoke all on function public.att_add_overtime(uuid, date, integer, text) from public, anon;
revoke all on function public.att_set_holiday(date, text) from public, anon;
revoke all on function public.att_month_pay(date) from public, anon;
grant execute on function public.att_device_seen(text, text) to service_role;
grant execute on function public.att_add_overtime(uuid, date, integer, text) to authenticated, service_role;
grant execute on function public.att_set_holiday(date, text) to authenticated, service_role;
grant execute on function public.att_month_pay(date) to authenticated, service_role;

insert into public.att_department_settings (department_id, default_shift_id)
select d.id, sh.id from public.departments d join public.att_shifts sh on sh.name = 'Labor Full Day'
where d.code in ('MFSU', 'STITCH', 'CLIP', 'IRON', 'QAQC', 'CUT', 'OVERLOCK', 'FLATLOCK', 'SINGLELOCK')
on conflict (department_id) do nothing;

insert into public.att_employee_settings (employee_id)
select e.id from public.employees e where e.is_active
on conflict (employee_id) do nothing;

