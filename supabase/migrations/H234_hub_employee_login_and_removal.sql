-- H234_hub_employee_login_and_removal.sql
--
-- TWO FAULTS ON THE HUB EMPLOYEES PAGE, AND THE BOUNDARY THAT KEEPS THIS
-- MIGRATION OFF EVERY OTHER DEPARTMENT.
--
-- ===========================================================================
-- FAULT 1 — A NEW EMPLOYEE EXISTS IN ONE TABLE AND NOT THE OTHER
--
--   The page writes to `employees`. Attendance, advances and salary all read
--   `online_att_employees`, which is the old attendance app's table and still
--   the one every wage screen is built on. 0093 mirrored the original seven
--   across by hand and nothing has mirrored anybody since.
--
--   So somebody added today is real on the employees list and does not exist
--   anywhere a day can be marked or a salary can be paid. Nothing reports it,
--   because nothing is broken — a row is simply missing from a table the page
--   never mentions.
--
--   That is also why giving them a login fails. hub_link_employee_login looks
--   the person up in online_att_employees BY NAME, finds nothing, and answers
--   "No employee by that name in HUB." The account was already created in
--   auth by then, so pressing the button a second time reports that the email
--   is already registered — an error about the email address, for a fault
--   that has nothing to do with the email address.
--
-- FAULT 2 — REMOVE DELETED NOTHING AND SAID NOTHING
--
--   The page ran a plain delete against `employees`. Two ways that ends
--   badly, and it has probably been both:
--
--     * Row-level security refuses it. PostgREST returns 204 with zero rows
--       and NO error, so the page reloads, the person is still listed, and
--       there is nothing on screen to explain it. A refusal that looks
--       identical to a success is worse than a refusal.
--
--     * It succeeds and leaves the wreckage behind: the online_att_employees
--       row, their attendance, their advances, their salary history. The name
--       disappears from the employees list and their days keep being counted.
--
--   Deleting a person is four tables plus, when they have a login, an auth
--   account. One call or none.
--
-- ===========================================================================
-- THE BOUNDARY
--
--   Every function here refuses outright unless the employee's department is
--   HUB. Not "prefers" — refuses, and says so. The Karkhana and FS Traders
--   rows cannot be reached through these functions even by passing their id
--   deliberately, so nothing in this file can affect work going on in those
--   departments.
--
--   Nothing existing is dropped or altered. hub_link_employee_login is left
--   exactly as it is; hub_give_login sits beside it and works from the
--   employee's id rather than their name, because two people called Hamza is
--   an ordinary thing for a company and a fatal thing for a name lookup.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Shared guard. Returns the department code, or null when the id is unknown.
-- Kept separate so the three functions below cannot drift apart on what "is a
-- Hub employee" means.
-- ---------------------------------------------------------------------------
create or replace function hub_dept_of_employee(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select d.code
    from employees e
    join departments d on d.id = e.department_id
   where e.id = p_employee_id;
$function$;

-- Either right is enough. The department's accounts person manages employees;
-- an owner manages users. Both are people who legitimately add and remove
-- staff, and demanding the one code the person happens not to hold is how a
-- correct refusal gets mistaken for a broken button.
create or replace function hub_may_manage_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(has_permission('employees.manage'), false)
      or coalesce(has_permission('users.manage'), false);
$function$;

-- ---------------------------------------------------------------------------
-- 1. MIRROR — put a Hub employee into the attendance table, or bring the copy
--    back into step after an edit.
--
--    The id is carried across as text, exactly as 0093 did it, so one person
--    keeps one identity whichever screen is open.
-- ---------------------------------------------------------------------------
create or replace function hub_sync_employee_mirror(p_employee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

    -- A person with no rate in the history is valued at zero for every day
    -- they work. Backdated far enough to cover any month anybody opens, the
    -- same way 0099 seeded the original seven.
    insert into online_att_salary_history (emp_id, effective_from, sal, note)
    values (p_employee_id::text, date '2000-01-01', coalesce(v_e.pay_amount, 0), 'starting rate')
    on conflict (emp_id, effective_from) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'created', v_made, 'employee', v_e.name);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. GIVE A LOGIN — by id, and only after making sure the attendance row is
--    there, so the link cannot fail for a reason the person cannot see.
--
--    The auth account itself is still created by the create-user edge
--    function, because that needs the service key and the service key stays
--    on Supabase's servers. This attaches what exists.
-- ---------------------------------------------------------------------------
create or replace function hub_give_login(p_employee_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dept  text;
  v_user  uuid;
  v_role  uuid;
  v_name  text;
  v_sync  jsonb;
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

  select name into v_name from employees where id = p_employee_id;

  select id into v_user from app_users where lower(email) = lower(trim(p_email));
  if v_user is null then
    return jsonb_build_object('ok', false,
      'error', 'No account with that email yet. The login has to be created before it can be attached.');
  end if;

  -- One login belongs to one person, or two people read each other's wages.
  if exists (select 1 from employees
              where user_id = v_user and id <> p_employee_id) then
    return jsonb_build_object('ok', false,
      'error', 'That email is already attached to a different employee.');
  end if;

  v_sync := hub_sync_employee_mirror(p_employee_id);
  if not coalesce((v_sync->>'ok')::boolean, false) then
    return v_sync;
  end if;

  update employees             set user_id = v_user where id = p_employee_id;
  update online_att_employees  set user_id = v_user where id = p_employee_id::text;

  select id into v_role from roles where code = 'employee';
  if v_role is not null then
    insert into user_roles (user_id, role_id) values (v_user, v_role)
    on conflict do nothing;
  end if;

  update app_users set must_change_password = true where id = v_user;

  return jsonb_build_object('ok', true, 'employee', v_name, 'email', lower(trim(p_email)),
    'report', v_name || ' can sign in and will be asked to set their own password first.');
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. REMOVE — the person and everything keyed to them, counted so the page
--    can tell a refusal from a success.
--
--    The auth account is NOT deleted here. It cannot be: removing a login
--    needs the service key. The user_id comes back in the answer so the page
--    can ask the create-user function to finish the job, and if that part is
--    refused the person is still gone from the Hub and the page can say the
--    login is the only thing left.
-- ---------------------------------------------------------------------------
create or replace function hub_remove_employee(p_employee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dept  text;
  v_name  text;
  v_user  uuid;
  v_txt   text := p_employee_id::text;
  n_rec   integer := 0;
  n_adv   integer := 0;
  n_sal   integer := 0;
  n_hist  integer := 0;
  n_mir   integer := 0;
  n_emp   integer := 0;
begin
  if not hub_may_manage_staff() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to remove staff.');
  end if;

  v_dept := hub_dept_of_employee(p_employee_id);
  if v_dept is null then
    return jsonb_build_object('ok', false, 'error', 'No employee with that id — nothing to remove.');
  end if;
  if v_dept <> 'HUB' then
    return jsonb_build_object('ok', false,
      'error', 'That employee belongs to ' || v_dept || ', not the Hub. Nothing was removed.');
  end if;

  select name, user_id into v_name, v_user from employees where id = p_employee_id;

  delete from online_att_records        where emp_id = v_txt;  get diagnostics n_rec  = row_count;
  delete from online_att_advances       where emp_id = v_txt;  get diagnostics n_adv  = row_count;
  delete from online_att_salary_status  where emp_id = v_txt;  get diagnostics n_sal  = row_count;
  delete from online_att_salary_history where emp_id = v_txt;  get diagnostics n_hist = row_count;
  delete from online_att_employees      where id     = v_txt;  get diagnostics n_mir  = row_count;
  delete from employees                 where id     = p_employee_id; get diagnostics n_emp = row_count;

  if n_emp = 0 then
    return jsonb_build_object('ok', false,
      'error', 'The employee row would not delete. Something else still refers to it.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'employee', v_name,
    'user_id', v_user,            -- null when they never had a login
    'attendance', n_rec,
    'advances', n_adv,
    'salary_marks', n_sal,
    'rate_history', n_hist,
    'mirror', n_mir,
    'report', v_name || ' removed, with ' || n_rec || ' attendance record(s) and '
              || n_adv || ' advance(s).');
end;
$function$;

grant execute on function hub_dept_of_employee(uuid)   to authenticated;
grant execute on function hub_may_manage_staff()        to authenticated;
grant execute on function hub_sync_employee_mirror(uuid) to authenticated;
grant execute on function hub_give_login(uuid, text)     to authenticated;
grant execute on function hub_remove_employee(uuid)      to authenticated;

-- ---------------------------------------------------------------------------
-- 4. CATCH UP — anybody added to the Hub since 0093 who never got an
--    attendance row. Runs once and finds nothing on every later run.
-- ---------------------------------------------------------------------------
insert into online_att_employees (id, name, designation, department, sal, department_id, user_id)
select e.id::text, e.name, d.name, 'Hub', coalesce(e.pay_amount, 0), e.department_id, e.user_id
  from employees e
  left join designations d on d.id = e.designation_id
 where e.department_id = (select id from departments where code = 'HUB')
   and not exists (select 1 from online_att_employees o where o.id = e.id::text);

insert into online_att_salary_history (emp_id, effective_from, sal, note)
select o.id, date '2000-01-01', coalesce(o.sal, 0), 'starting rate'
  from online_att_employees o
 where o.department_id = (select id from departments where code = 'HUB')
   and not exists (select 1 from online_att_salary_history h where h.emp_id = o.id);

commit;

-- ===========================================================================
-- VERIFY
--
-- Everybody in the Hub, and whether the attendance table knows about them.
-- The right-hand column should say "yes" on every row.
--
--   select e.name,
--          case when o.id is null then 'MISSING' else 'yes' end as in_attendance,
--          case when e.user_id is null then 'no login' else 'has login' end as login
--     from employees e
--     left join online_att_employees o on o.id = e.id::text
--    where e.department_id = (select id from departments where code = 'HUB')
--    order by e.name;
--
-- The boundary, proved rather than promised — pass a Karkhana employee's id
-- and it refuses by name:
--
--   select hub_remove_employee(
--     (select id from employees
--       where department_id <> (select id from departments where code = 'HUB')
--       limit 1));
--
--   -> {"ok": false, "error": "That employee belongs to KRK, not the Hub. Nothing was removed."}
-- ===========================================================================
