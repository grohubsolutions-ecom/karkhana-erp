/* ===========================================================================
   H289 ROLLBACK — only if the joining-date rule must be switched off.

   Order: put the previous screens back first (the Summary calls
   hub_set_join_date and hub_staff_health; the old one never does), then run
   this in the Supabase SQL editor.

   This restores hub_sync_employee_mirror and hub_monthly_payable__impl to
   exactly what they were before H289 (read from the live database, 5 Oct
   2026), and removes the two new functions.

   The joining dates already written into online_att_employees.jy/jm/jd are
   LEFT IN PLACE: employees.join_date is their master copy and the old mirror
   simply ignores them. To clear them as well, the last statement is there —
   it is commented out because it throws away information the office typed in.

   Hub tables only.
=========================================================================== */

drop function if exists hub_staff_health();
drop function if exists hub_set_join_date(text, date);

/* the mirror, as it was before H289: no joining date */
create or replace function hub_sync_employee_mirror(p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_dept  text;
  v_e     record;
  v_role  text;
  v_made  boolean := false;
begin
  if not hub_may_manage_staff() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to manage staff.');
  end if;

  v_dept := hub_dept_of_employee(p_employee_id);
  if v_dept is null then
    return jsonb_build_object('ok', false, 'error', 'No employee with that id.');
  end if;
  if v_dept <> 'HUB' then
    return jsonb_build_object('ok', false,
      'error', 'That employee belongs to ' || v_dept || ', not the Hub. Nothing was changed.');
  end if;

  select e.*, d.name as role_name into v_e
    from employees e left join designations d on d.id = e.designation_id
   where e.id = p_employee_id;

  v_role := v_e.role_name;

  if exists (select 1 from online_att_employees where id = p_employee_id::text) then
    update online_att_employees
       set name        = v_e.name,
           designation = coalesce(v_role, designation),
           sal         = coalesce(v_e.pay_amount, sal),
           department_id = v_e.department_id
     where id = p_employee_id::text;
  else
    insert into online_att_employees (id, name, designation, department, sal, department_id)
    values (p_employee_id::text, v_e.name, v_role, 'Hub',
            coalesce(v_e.pay_amount, 0), v_e.department_id);
    v_made := true;

    insert into online_att_salary_history (emp_id, effective_from, sal, note)
    values (p_employee_id::text, date '2000-01-01', coalesce(v_e.pay_amount, 0), 'starting rate')
    on conflict (emp_id, effective_from) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'created', v_made, 'employee', v_e.name);
end;
$$;

/* the wage, as it was before H289: joining date matched by name, and applied
   to every month including ones already paid */
create or replace function hub_monthly_payable__impl(p_year integer, p_month integer, p_department text default 'HUB'::text)
returns table(emp_id text, name text, designation text, salary numeric, present integer, half integer,
              absent integer, leave_days integer, absent_deduction numeric, paid_off integer,
              extra_days integer, counted_days numeric, gross numeric, advances numeric, payable numeric,
              is_paid boolean, given_days numeric, given_pay numeric, advance_cut numeric, carried numeric)
language sql stable security definer set search_path to 'public' as $$
  with bounds as (
    select make_date(p_year, p_month, 1) as first_day,
           least((make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
                 current_date) as up_to,
           extract(day from (make_date(p_year, p_month, 1)
                             + interval '1 month - 1 day'))::numeric as month_days
  ),
  days as (
    select d::date                                   as day_date,
           to_char(d, 'YYYY-MM-DD')                  as day,
           (extract(dow from d) = 0
             or exists (select 1 from online_att_holidays h
                         where h.hdate = to_char(d, 'YYYY-MM-DD'))) as is_off
      from bounds b, generate_series(b.first_day, b.up_to, interval '1 day') d
  ),
  staff as (
    select e.id::text as emp_id, e.name, e.designation,
           coalesce(e.sal, 0)::numeric as salary,
           (select x.join_date from employees x
             where lower(x.name) = lower(e.name)
               and x.department_id = e.department_id limit 1) as join_date
      from online_att_employees e
     where p_department is null
        or e.department_id = (select id from departments where code = p_department)
  ),
  marked as (
    select r.emp_id,
           to_char(make_date(r.year, r.month, r.day), 'YYYY-MM-DD') as day,
           upper(btrim(r.status)) as status
      from online_att_records r
     where r.year = p_year and r.month = p_month
  ),
  valued as (
    select s.emp_id,
           d.day_date,
           d.is_off,
           m.status,
           case
             when m.status = 'A' then 0
             when d.is_off and m.status in ('P','H','L') then 2
             when d.is_off then case when s.join_date is null
                                      or d.day_date >= s.join_date then 1 else 0 end
             when m.status in ('P','L') then 1
             when m.status = 'H' then 0.5
             else 0
           end::numeric as day_value,
           coalesce((select h.sal from online_att_salary_history h
                      where h.emp_id = s.emp_id and h.effective_from <= d.day_date
                      order by h.effective_from desc limit 1), s.salary)::numeric as rate
      from staff s
      cross join days d
      left join marked m on m.emp_id = s.emp_id and m.day = d.day
  ),
  tally as (
    select v.emp_id,
           count(*) filter (where v.status in ('P','L') and not v.is_off)      as present,
           count(*) filter (where v.status = 'H' and not v.is_off)             as half,
           count(*) filter (where v.status = 'A')                              as absent,
           count(*) filter (where v.status = 'L')                              as leave_days,
           count(*) filter (where v.is_off and v.day_value > 0)                as paid_off,
           count(*) filter (where v.is_off and v.status in ('P','H','L'))      as extra_days,
           sum(v.day_value)                                                    as counted_days,
           sum(v.day_value * v.rate / (select month_days from bounds))          as gross,
           sum(case when v.status = 'A' then v.rate / (select month_days from bounds) else 0 end) as absent_deduction,
           count(*) filter (where v.status is not null)                        as marked_days
      from valued v
     group by v.emp_id
  ),
  adv as (
    select a.emp_id, coalesce(sum(a.amount), 0)::numeric as advances
      from online_att_advances a
     where a.deduct_year = p_year and a.deduct_month = p_month
     group by a.emp_id
  ),
  given as (
    select x.emp_id,
           sum(x.portion)::numeric as given_days,
           sum(x.portion * coalesce((select h.sal from online_att_salary_history h
                                      where h.emp_id = x.emp_id and h.effective_from <= x.day
                                      order by h.effective_from desc limit 1), s.salary)
               / (select month_days from bounds)) as given_pay
      from online_att_extra_days x
      join staff s on s.emp_id = x.emp_id
     where x.day >= (select first_day from bounds)
       and x.day < (select first_day from bounds) + interval '1 month'
     group by x.emp_id
  ),
  pay as (
    select s.emp_id,
           coalesce(ss.paid, false) as is_paid,
           coalesce(a.advances, 0) as advances,
           case when coalesce(ss.paid, false) then coalesce(ss.advance_cut, coalesce(a.advances, 0))
                else coalesce(a.advances, 0) end::numeric as advance_cut,
           case when coalesce(ss.paid, false) then coalesce(ss.carried, 0) else 0 end::numeric as carried
      from staff s
      left join adv a on a.emp_id = s.emp_id
      left join online_att_salary_status ss
             on ss.emp_id = s.emp_id and ss.year = p_year and ss.month = p_month
  )
  select s.emp_id, s.name, s.designation, s.salary,
         t.present::integer, t.half::integer, t.absent::integer, t.leave_days::integer,
         round(t.absent_deduction)::numeric,
         case when t.marked_days = 0 then 0 else t.paid_off end::integer,
         t.extra_days::integer,
         (case when t.marked_days = 0 then 0 else t.counted_days end) + coalesce(g.given_days, 0),
         round((case when t.marked_days = 0 then 0 else t.gross end) + coalesce(g.given_pay, 0)),
         p.advances,
         round((case when t.marked_days = 0 then 0 else t.gross end) + coalesce(g.given_pay, 0) - p.advance_cut),
         p.is_paid,
         coalesce(g.given_days, 0),
         round(coalesce(g.given_pay, 0)),
         p.advance_cut,
         p.carried
    from staff s
    join tally t on t.emp_id = s.emp_id
    join pay p on p.emp_id = s.emp_id
    left join given g on g.emp_id = s.emp_id
   order by s.name;
$$;

/* Only if the joining dates themselves must go too. They are information the
   office typed in, so this is left switched off:
     update online_att_employees set jy = null, jm = null, jd = null
      where department_id = (select id from departments where code = 'HUB');
*/
