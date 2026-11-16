-- H320 (16 Nov 2026): HOURS DAY BY DAY — for the employee portal and the
-- Hub employee sheet. Run AFTER H319.
--
-- One row per marked day: time in, time out, the shift, hours worked, hours
-- required, and the plus/minus that day adds to the month's balance. Same
-- rule as H319's hub_monthly_payable.time_balance, so the days add up to it:
--   counted = present, not a Sunday/holiday, has time in AND time out,
--             month is November 2026 or later
--   diff    = worked − shift hours; a day short by no more than the grace
--             (10 min) counts as 0
-- Shown only. Neither plus nor minus changes the salary.
--
--   my_hours_daily(year, month)        — the signed-in employee's own days
--   hub_hours_daily(emp, year, month)  — anyone with Hub attendance rights

create or replace function public.hours_daily__impl(p_emp text, p_year integer, p_month integer)
returns table(day integer, day_date date, status text, time_in text, time_out text,
              shift_name text, shift_start text, shift_end text,
              required_min integer, worked_min integer, diff_min integer,
              counted boolean, note text)
language sql stable security definer set search_path to 'public'
as $$
  with e as (
    select oe.id, oe.department_id from online_att_employees oe where oe.id = p_emp
  ), r as (
    select a.day, make_date(a.year, a.month, a.day) as d,
           upper(btrim(a.status)) as status,
           nullif(btrim(a.time_in), '') as time_in, nullif(btrim(a.time_out), '') as time_out
      from online_att_records a
     where a.emp_id = p_emp and a.year = p_year and a.month = p_month
  ), x as (
    select r.*,
           (extract(dow from r.d) = 0
             or exists (select 1 from online_att_holidays h where h.hdate = to_char(r.d, 'YYYY-MM-DD'))) as is_off,
           sh.name as shift_name, sh.start_time, sh.end_time,
           coalesce(sh.late_grace_minutes, 0) as grace,
           nullif(extract(epoch from (sh.end_time - sh.start_time)) / 60 - coalesce(sh.break_minutes, 0), 0) as req,
           case when r.time_in ~ '^\d{1,2}:\d{2}$' and r.time_out ~ '^\d{1,2}:\d{2}$'
                     and r.time_out::time > r.time_in::time
                then extract(epoch from (r.time_out::time - r.time_in::time)) / 60 end as worked
      from r cross join e
      left join lateral (
        select s.* from att_shifts s
         where s.id = coalesce(
           (select ds.shift_id from att_day_shifts ds where ds.employee_id::text = e.id and ds.att_date = r.d),
           (select es.shift_id from att_employee_settings es where es.employee_id::text = e.id),
           (select dp.default_shift_id from att_department_settings dp where dp.department_id = e.department_id))
      ) sh on true
  ), y as (
    select x.*,
           (make_date(p_year, p_month, 1) >= date '2026-11-01'
             and x.status = 'P' and not x.is_off and x.req > 0 and x.worked is not null) as ok
      from x
  )
  select y.day, y.d, y.status, y.time_in, y.time_out,
         y.shift_name, to_char(y.start_time, 'HH24:MI'), to_char(y.end_time, 'HH24:MI'),
         round(y.req)::integer, round(y.worked)::integer,
         case when not y.ok then null
              when y.worked - y.req < 0 and y.worked - y.req >= -y.grace then 0
              else round(y.worked - y.req)::integer end,
         y.ok,
         case
           when y.ok and y.worked - y.req < 0 and y.worked - y.req >= -y.grace then 'within 10 min grace'
           when y.ok then null
           when make_date(p_year, p_month, 1) < date '2026-11-01' then 'before hours tracking'
           when y.status = 'A' then 'absent'
           when y.status = 'L' then 'leave'
           when y.status = 'H' then 'half day'
           when y.is_off then 'day off'
           when y.req is null then 'no shift set'
           when y.time_in is null then 'no time in'
           when y.time_out is null then 'no time out'
           else 'times not readable'
         end
    from y
   order by y.day;
$$;

create or replace function public.my_hours_daily(p_year integer, p_month integer)
returns table(day integer, day_date date, status text, time_in text, time_out text,
              shift_name text, shift_start text, shift_end text,
              required_min integer, worked_min integer, diff_min integer,
              counted boolean, note text)
language sql stable security definer set search_path to 'public'
as $$
  select * from hours_daily__impl(
    (select e.id::text from online_att_employees e where e.user_id = auth.uid() limit 1),
    p_year, p_month);
$$;

create or replace function public.hub_hours_daily(p_emp text, p_year integer, p_month integer)
returns table(day integer, day_date date, status text, time_in text, time_out text,
              shift_name text, shift_start text, shift_end text,
              required_min integer, worked_min integer, diff_min integer,
              counted boolean, note text)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not (has_permission('hub.attendance.view') or has_permission('hub.attendance.manage')
          or coalesce(auth.role(), '') = 'service_role') then
    return;
  end if;
  return query select * from hours_daily__impl(p_emp, p_year, p_month);
end $$;

revoke all on function public.hours_daily__impl(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hours_daily__impl(text, integer, integer) to service_role;
revoke all on function public.my_hours_daily(integer, integer) from public, anon;
grant execute on function public.my_hours_daily(integer, integer) to authenticated, service_role;
revoke all on function public.hub_hours_daily(text, integer, integer) from public, anon;
grant execute on function public.hub_hours_daily(text, integer, integer) to authenticated, service_role;
