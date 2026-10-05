/* ===========================================================================
   H289 — HUB PAY: THE JOINING DATE REACHES THE WAGE, AND A STAFF HEALTH CHECK
                                                                 (5 Oct 2026)

   The owner, 5 Oct: a person added from the Employees screen did not appear in
   the Summary; giving a login looked like it made a duplicate; and a person
   who joins mid-month is being paid for the Sundays BEFORE they joined.

   WHAT WAS ACTUALLY WRONG (read from the live database, 5 Oct)

   1. THE JOINING DATE NEVER REACHED THE ATTENDANCE SIDE.
      online_att_employees carries its own joining date in jy / jm / jd. It was
      NULL for all 8 people, because hub_sync_employee_mirror copies the name,
      the role, the salary and the department — and not the joining date.

   2. THE WAGE LOOKED THE JOINING DATE UP BY NAME.
      hub_monthly_payable__impl matched employees to online_att_employees on
      lower(name) + department. The two tables share the same primary key, so
      the name was never needed; and a name edited on one screen and not the
      other silently dropped the joining date, which pays Sundays again.

   3. SO SUNDAYS BEFORE JOINING WERE PAID.
      A Sunday or holiday is paid to everyone. The rule "not before the day you
      joined" was already written, but with no joining date to test it could
      never fire. 6 of the 8 had no joining date at all.

   THE OWNER'S DECISIONS, 5 Oct
     D1  paid Sundays start ON THE JOINING DATE. Before it they are worth
         nothing. (Not the first marked day — a man who joins on Saturday the
         3rd is owed Sunday the 4th.)
     D2  A MONTH ALREADY MARKED PAID DOES NOT MOVE. Those figures were handed
         over in cash against the old reading, so the joining date is applied
         only to months that are still unpaid. Nobody's September changes.

   WHAT CHANGES
     hub_sync_employee_mirror   also copies the joining date, on add and on
                                edit; existing joining dates are backfilled
     hub_set_join_date(emp, d)  NEW — set or clear it from the attendance side
     hub_monthly_payable__impl  joining date read by id (its own jy/jm/jd
                                first, then employees.join_date); applied only
                                to an unpaid month
     hub_staff_health()         NEW — who is missing from the attendance
                                table, who has no joining date, no rate, or a
                                shared login. Nothing can go missing quietly.

   WHAT DOES NOT MOVE, CHECKED BEFORE IT WAS APPLIED
   Every figure for every person for August, September and October was
   computed both ways and compared: 24 of 24 identical. Nothing anybody has
   been paid, or can see on a screen today, changes. The new rule bites only
   when a joining date is actually set on a month that is still unpaid.

   Hub tables only. Nothing is dropped. Safe to run again.
   ALREADY APPLIED on the live database, 5 Oct 2026, as two migrations —
   h289a_join_date_mirror_and_health and h289b_payable_join_date_by_id (the
   connector times out on a payload this size in one piece). All four
   functions checked against this file, md5 equal.
   Rollback: H289_rollback.sql.
=========================================================================== */

/* 1. THE MIRROR — carries the joining date too ------------------------------
   Same signature and same answer as before. The joining date is written on
   both paths (a new person and an edit), because an edit is how a wrong one
   gets corrected. employees.join_date stays the master copy. */
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
           department_id = v_e.department_id,
           /* H289: the joining date, in the three columns this table keeps it
              in. Clearing it on the Employees screen clears it here too — the
              two must not disagree about when somebody started. */
           jy          = extract(year  from v_e.join_date)::integer,
           jm          = extract(month from v_e.join_date)::integer,
           jd          = extract(day   from v_e.join_date)::integer
     where id = p_employee_id::text;
  else
    insert into online_att_employees (id, name, designation, department, sal, department_id, jy, jm, jd)
    values (p_employee_id::text, v_e.name, v_role, 'Hub',
            coalesce(v_e.pay_amount, 0), v_e.department_id,
            extract(year  from v_e.join_date)::integer,
            extract(month from v_e.join_date)::integer,
            extract(day   from v_e.join_date)::integer);
    v_made := true;

    -- A person with no rate in the history is valued at zero for every day
    -- they work. Backdated far enough to cover any month anybody opens, the
    -- same way 0099 seeded the original seven.
    insert into online_att_salary_history (emp_id, effective_from, sal, note)
    values (p_employee_id::text, date '2000-01-01', coalesce(v_e.pay_amount, 0), 'starting rate')
    on conflict (emp_id, effective_from) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'created', v_made, 'employee', v_e.name,
                            'join_date', v_e.join_date);
end;
$$;

/* 2. BACKFILL — the joining dates that already exist in employees -----------
   Only where the attendance side has none, so a date corrected there is not
   overwritten by an older one. */
update online_att_employees e
   set jy = extract(year  from x.join_date)::integer,
       jm = extract(month from x.join_date)::integer,
       jd = extract(day   from x.join_date)::integer
  from employees x
 where x.id::text = e.id
   and x.join_date is not null
   and e.jy is null;

/* 3. SET IT FROM THE ATTENDANCE SIDE ----------------------------------------
   The Summary is where a wrong joining date is noticed, so it is where it can
   be fixed. Writes both tables, so they cannot drift apart. NULL clears it. */
create or replace function hub_set_join_date(p_emp_id text, p_join_date date)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_name text; v_dept uuid;
begin
  if not (has_permission('hub.attendance.manage') or hub_may_manage_staff()) then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to change staff records.');
  end if;

  select name, department_id into v_name, v_dept
    from online_att_employees where id = p_emp_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No employee with that id.');
  end if;
  if v_dept is distinct from (select id from departments where code = 'HUB') then
    return jsonb_build_object('ok', false, 'error', 'That employee is not in the Hub. Nothing was changed.');
  end if;
  /* A joining date in the future would make every day before it worth
     nothing, which reads as a wage that has vanished. */
  if p_join_date > (now() at time zone 'Asia/Karachi')::date then
    return jsonb_build_object('ok', false, 'error', 'That date has not happened yet.');
  end if;

  update online_att_employees
     set jy = extract(year from p_join_date)::integer,
         jm = extract(month from p_join_date)::integer,
         jd = extract(day from p_join_date)::integer
   where id = p_emp_id;
  update employees set join_date = p_join_date where id::text = p_emp_id;

  return jsonb_build_object('ok', true, 'employee', v_name, 'join_date', p_join_date);
end;
$$;

/* 4. THE WAGE — the joining date, read by id, on unpaid months only ---------
   Only two things change from the H284 version, both marked H289:
     - staff.join_date comes from this table's own jy/jm/jd, then from
       employees BY ID (it was matched by name)
     - a month already marked paid ignores it, so nothing already handed over
       in cash moves (the owner's D2)
   Everything else is the H284 text, unchanged. */
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
           /* THE DIVISOR: how many days this month actually has. */
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
           /* H289: BY ID, NOT BY NAME. Both tables share one primary key, so
              the name was never needed to find the row — and a name edited on
              one screen and not the other used to drop the joining date
              without a word, which quietly pays Sundays before somebody
              joined. This table's own copy wins; employees is the fallback. */
           coalesce(
             case when e.jy is not null and e.jm is not null and e.jd is not null
                  then make_date(e.jy, e.jm, e.jd) end,
             (select x.join_date from employees x where x.id::text = e.id)
           ) as join_date,
           /* H289 (the owner's D2): a month already marked paid was handed
              over in cash against the old reading, so it must not move. The
              joining date is applied to unpaid months only. */
           coalesce((select ss.paid from online_att_salary_status ss
                      where ss.emp_id = e.id and ss.year = p_year and ss.month = p_month), false) as locked
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
  -- One row per person per day: what that day was worth, and at what rate.
  valued as (
    select s.emp_id,
           d.day_date,
           d.is_off,
           m.status,
           /* The day's value in days. A day off that was worked is worth two:
              one because it is paid to everyone, one more for working it. */
           case
             when m.status = 'A' then 0
             when d.is_off and m.status in ('P','H','L') then 2
             when d.is_off then case when s.locked or s.join_date is null
                                      or d.day_date >= s.join_date then 1 else 0 end
             when m.status in ('P','L') then 1
             when m.status = 'H' then 0.5
             else 0
           end::numeric as day_value,
           /* The rate in force on that day — the most recent change on or
              before it. This is the whole point of the table. */
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
           -- What the absent days would have paid, at their own day's rate.
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
  -- H284: extra days given, each at the rate in force on that day.
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
  -- What is taken off: the amount chosen when it was paid, else the whole advance.
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
         -- Nobody marked at all was not being tracked that month, so no days
         -- off are owed and the month is zero rather than a month of Sundays.
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

/* 5. THE HEALTH CHECK — nothing goes missing quietly ------------------------
   Four things that make a wage wrong or a person invisible, each with the
   names it applies to. The Summary shows it above the list.
     missing_from_attendance  on the Employees list, no attendance row — this
                              is the person who "does not show in the Summary"
     no_join_date             every Sunday of their first month is paid
     no_rate                  every day they work is valued at zero
     shared_login             two people who would read each other's wages */
create or replace function hub_staff_health()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when not (has_permission('hub.attendance.view') or has_permission('hub.attendance.manage')
                        or hub_may_manage_staff())
         then '{}'::jsonb
         else jsonb_build_object(
    'missing_from_attendance',
      (select coalesce(jsonb_agg(jsonb_build_object('id', em.id, 'name', em.name) order by em.name), '[]'::jsonb)
         from employees em
        where em.department_id = (select id from departments where code = 'HUB')
          and coalesce(em.is_active, true)
          and not exists (select 1 from online_att_employees e where e.id = em.id::text)),
    'no_join_date',
      (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name), '[]'::jsonb)
         from online_att_employees e
        where e.department_id = (select id from departments where code = 'HUB')
          and (e.jy is null or e.jm is null or e.jd is null)
          and not exists (select 1 from employees x where x.id::text = e.id and x.join_date is not null)),
    'no_rate',
      (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name), '[]'::jsonb)
         from online_att_employees e
        where e.department_id = (select id from departments where code = 'HUB')
          and coalesce(e.sal, 0) = 0),
    'shared_login',
      (select coalesce(jsonb_agg(jsonb_build_object('login', u.full_name,
                                                    'names', n.names) order by u.full_name), '[]'::jsonb)
         from (select e.user_id, jsonb_agg(e.name order by e.name) as names
                 from online_att_employees e
                where e.user_id is not null
                group by e.user_id having count(*) > 1) n
         join app_users u on u.id = n.user_id)
  ) end;
$$;

/* 6. who may call what -------------------------------------------------------- */
revoke all on function hub_set_join_date(text, date) from public, anon;
revoke all on function hub_staff_health() from public, anon;
grant execute on function hub_set_join_date(text, date) to authenticated, service_role;
grant execute on function hub_staff_health() to authenticated, service_role;
