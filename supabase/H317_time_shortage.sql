-- H317 (16 Nov 2026): TIME SHORTAGE on the Monthly Summary.
--
-- Every present day is checked against the person's shift:
--   late  = time in  − shift start   (counted only when more than late grace)
--   early = shift end − time out     (counted only when more than early grace,
--                                     and only when a time out was recorded)
-- Shift used for a day: that day's override (att_day_shifts) → the person's
-- own shift (att_employee_settings) → the department default
-- (att_department_settings). Hub today = Hub Day Shift 09:00–17:00, 10 min
-- grace; Ahmad 14:00–17:00 and Kashif 16:00–18:00 keep their own.
--
-- Money: short minutes × (day rate ÷ shift minutes). It is taken off Earned,
-- so Payable, Mark Paid and the employee's own screen all agree.
-- Only from November 2026 — months already paid keep their figures.
-- Half days, leave and days off are not checked.
--
-- Two new columns at the END of the row: short_minutes, short_deduction.
-- my_monthly_payable, hub_salary_mark_paid and hub_advance_return(_edit) read
-- named columns, so they keep working unchanged.

drop function if exists public.hub_monthly_payable(integer, integer, text);
drop function if exists public.hub_monthly_payable__impl(integer, integer, text);

create function public.hub_monthly_payable__impl(p_year integer, p_month integer, p_department text default 'HUB'::text)
 returns table(emp_id text, name text, designation text, salary numeric, present integer, half integer, absent integer, leave_days integer, absent_deduction numeric, paid_off integer, extra_days integer, counted_days numeric, gross numeric, advances numeric, payable numeric, is_paid boolean, given_days numeric, given_pay numeric, advance_cut numeric, carried numeric, short_minutes integer, short_deduction numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  /* From Oct 2026: day rate = salary / 30 (flat), regular paid days capped at 30.
     Before Oct 2026: salary / calendar days, unchanged, so paid months keep their figures.
     From Nov 2026: time shortage (H317) is taken off earned. */
  with bounds as (
    select make_date(p_year, p_month, 1) as first_day,
           least((make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date, current_date) as up_to,
           case when make_date(p_year, p_month, 1) >= date '2026-10-01' then 30::numeric
                else extract(day from (make_date(p_year, p_month, 1) + interval '1 month - 1 day'))::numeric end as month_days,
           (make_date(p_year, p_month, 1) >= date '2026-10-01') as cap_on,
           (make_date(p_year, p_month, 1) >= date '2026-11-01') as short_on
  ),
  days as (
    select d::date as day_date, to_char(d, 'YYYY-MM-DD') as day,
           (extract(dow from d) = 0
             or exists (select 1 from online_att_holidays h where h.hdate = to_char(d, 'YYYY-MM-DD'))) as is_off
      from bounds b, generate_series(b.first_day, b.up_to, interval '1 day') d
  ),
  staff as (
    select e.id::text as emp_id, e.name, e.designation, e.department_id,
           coalesce(e.sal, 0)::numeric as salary,
           coalesce(
             case when e.jy is not null and e.jm is not null and e.jd is not null
                  then make_date(e.jy, e.jm, e.jd) end,
             (select x.join_date from employees x where x.id::text = e.id)
           ) as join_date,
           coalesce((select ss.paid from online_att_salary_status ss
                      where ss.emp_id = e.id and ss.year = p_year and ss.month = p_month), false) as locked
      from online_att_employees e
     where p_department is null
        or e.department_id = (select id from departments where code = p_department)
  ),
  marked as (
    select r.emp_id, to_char(make_date(r.year, r.month, r.day), 'YYYY-MM-DD') as day,
           upper(btrim(r.status)) as status, r.time_in, r.time_out
      from online_att_records r where r.year = p_year and r.month = p_month
  ),
  valued as (
    select s.emp_id, d.day_date, d.is_off, m.status, m.time_in, m.time_out, s.department_id,
           case
             when m.status = 'A' then 0
             when d.is_off and m.status in ('P','H','L') then 2
             when d.is_off then case when s.locked or s.join_date is null
                                      or d.day_date >= s.join_date then 1 else 0 end
             when m.status in ('P','L') then 1
             when m.status = 'H' then 0.5
             else 0
           end::numeric as day_value,
           coalesce((select h.sal from online_att_salary_history h
                      where h.emp_id = s.emp_id and h.effective_from <= d.day_date
                      order by h.effective_from desc limit 1), s.salary)::numeric as rate
      from staff s cross join days d
      left join marked m on m.emp_id = s.emp_id and m.day = d.day
  ),
  /* H317: minutes short on each present working day, against that day's shift. */
  shorted as (
    select v.emp_id, v.rate, sh.shift_min,
           (case when v.time_in ~ '^\d{1,2}:\d{2}$'
                  and extract(epoch from (v.time_in::time - sh.start_time)) / 60 > sh.late_grace_minutes
                 then extract(epoch from (v.time_in::time - sh.start_time)) / 60 else 0 end
          + case when v.time_out ~ '^\d{1,2}:\d{2}$'
                  and extract(epoch from (sh.end_time - v.time_out::time)) / 60 > sh.early_grace_minutes
                 then extract(epoch from (sh.end_time - v.time_out::time)) / 60 else 0 end) as short_min
      from valued v
      cross join bounds b
      join lateral (
        select x.start_time, x.end_time,
               coalesce(x.late_grace_minutes, 0) as late_grace_minutes,
               coalesce(x.early_grace_minutes, 0) as early_grace_minutes,
               nullif(extract(epoch from (x.end_time - x.start_time)) / 60 - coalesce(x.break_minutes, 0), 0) as shift_min
          from att_shifts x
         where x.id = coalesce(
           (select ds.shift_id from att_day_shifts ds where ds.employee_id::text = v.emp_id and ds.att_date = v.day_date),
           (select es.shift_id from att_employee_settings es where es.employee_id::text = v.emp_id),
           (select dp.default_shift_id from att_department_settings dp where dp.department_id = v.department_id))
      ) sh on true
     where b.short_on and v.status = 'P' and not v.is_off and sh.shift_min > 0
  ),
  short_tally as (
    select x.emp_id, sum(x.short_min) as short_min,
           sum(x.short_min * x.rate / (select month_days from bounds) / x.shift_min) as short_amt
      from shorted x group by x.emp_id
  ),
  tally as (
    select v.emp_id,
           count(*) filter (where v.status in ('P','L') and not v.is_off) as present,
           count(*) filter (where v.status = 'H' and not v.is_off) as half,
           count(*) filter (where v.status = 'A') as absent,
           count(*) filter (where v.status = 'L') as leave_days,
           count(*) filter (where v.is_off and v.day_value > 0) as paid_off,
           count(*) filter (where v.is_off and v.status in ('P','H','L')) as extra_days,
           sum(least(v.day_value, 1)) as base_days,
           sum(least(v.day_value, 1) * v.rate) as base_amt,
           sum(greatest(v.day_value - 1, 0)) as bonus_days,
           sum(greatest(v.day_value - 1, 0) * v.rate) as bonus_amt,
           sum(case when v.status = 'A' then v.rate / (select month_days from bounds) else 0 end) as absent_deduction,
           count(*) filter (where v.status is not null) as marked_days
      from valued v group by v.emp_id
  ),
  tally2 as (
    select t.*,
           (case when b.cap_on and t.base_days > 30 then 30 else t.base_days end) + t.bonus_days as counted_days,
           (t.base_amt * (case when b.cap_on and t.base_days > 30 then 30 / t.base_days else 1 end)
             + t.bonus_amt) / b.month_days as gross
      from tally t, bounds b
  ),
  adv as (
    select a.emp_id, coalesce(sum(a.amount), 0)::numeric as advances
      from online_att_advances a
     where a.deduct_year = p_year and a.deduct_month = p_month group by a.emp_id
  ),
  given as (
    select x.emp_id, sum(x.portion)::numeric as given_days,
           sum(x.portion * coalesce((select h.sal from online_att_salary_history h
                                      where h.emp_id = x.emp_id and h.effective_from <= x.day
                                      order by h.effective_from desc limit 1), s.salary)
               / (select month_days from bounds)) as given_pay
      from online_att_extra_days x join staff s on s.emp_id = x.emp_id
     where x.day >= (select first_day from bounds)
       and x.day < (select first_day from bounds) + interval '1 month'
     group by x.emp_id
  ),
  pay as (
    select s.emp_id, coalesce(ss.paid, false) as is_paid, coalesce(a.advances, 0) as advances,
           case when coalesce(ss.paid, false) then coalesce(ss.advance_cut, coalesce(a.advances, 0))
                else coalesce(a.advances, 0) end::numeric as advance_cut,
           case when coalesce(ss.paid, false) then coalesce(ss.carried, 0) else 0 end::numeric as carried
      from staff s left join adv a on a.emp_id = s.emp_id
      left join online_att_salary_status ss on ss.emp_id = s.emp_id and ss.year = p_year and ss.month = p_month
  )
  select s.emp_id, s.name, s.designation, s.salary,
         t.present::integer, t.half::integer, t.absent::integer, t.leave_days::integer,
         round(t.absent_deduction)::numeric,
         case when t.marked_days = 0 then 0 else t.paid_off end::integer,
         t.extra_days::integer,
         (case when t.marked_days = 0 then 0 else t.counted_days end) + coalesce(g.given_days, 0),
         round((case when t.marked_days = 0 then 0 else t.gross end) + coalesce(g.given_pay, 0)
               - round(coalesce(st.short_amt, 0))),
         p.advances,
         round((case when t.marked_days = 0 then 0 else t.gross end) + coalesce(g.given_pay, 0)
               - round(coalesce(st.short_amt, 0)) - p.advance_cut),
         p.is_paid, coalesce(g.given_days, 0), round(coalesce(g.given_pay, 0)), p.advance_cut, p.carried,
         round(coalesce(st.short_min, 0))::integer,
         round(coalesce(st.short_amt, 0))::numeric
    from staff s join tally2 t on t.emp_id = s.emp_id join pay p on p.emp_id = s.emp_id
    left join given g on g.emp_id = s.emp_id
    left join short_tally st on st.emp_id = s.emp_id
   order by s.name;
$function$;

create function public.hub_monthly_payable(p_year integer, p_month integer, p_department text default 'HUB'::text)
 returns table(emp_id text, name text, designation text, salary numeric, present integer, half integer, absent integer, leave_days integer, absent_deduction numeric, paid_off integer, extra_days integer, counted_days numeric, gross numeric, advances numeric, payable numeric, is_paid boolean, given_days numeric, given_pay numeric, advance_cut numeric, carried numeric, short_minutes integer, short_deduction numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not (has_permission('hub.attendance.view') or has_permission('hub.attendance.manage')
          or coalesce(auth.role(), '') = 'service_role') then
    return;
  end if;
  return query select * from hub_monthly_payable__impl(p_year, p_month, p_department);
end $function$;

revoke all on function public.hub_monthly_payable__impl(integer, integer, text) from public, anon, authenticated;
grant execute on function public.hub_monthly_payable__impl(integer, integer, text) to service_role;
revoke all on function public.hub_monthly_payable(integer, integer, text) from public, anon;
grant execute on function public.hub_monthly_payable(integer, integer, text) to authenticated, service_role;
