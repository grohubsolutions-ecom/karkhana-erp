-- H236_roster_edit_and_merge.sql
--
-- EDIT A PERSON ON THE HUB ATTENDANCE ROSTER, AND MERGE A DUPLICATE INTO THE
-- PERSON IT DUPLICATES.
--
-- WHY A MERGE AND NOT A DELETE
--   There are two Kashifs on the roster: the one typed into the attendance
--   screen's own "Add employee" box ("Kashif", department IT), whose days have
--   been marked since, and "Muhammad Kashif Latif", who is the same man. The
--   days belong to the person; the duplicate row is only where they happened to
--   be written down.
--
--   Removing either row throws those days away with it. What is wanted is to
--   move everything the duplicate holds onto the survivor and then remove the
--   empty duplicate — which is a merge.
--
-- WHAT MOVES, AND WHAT WINS WHEN BOTH HAVE SOMETHING
--   attendance days   move. A day marked on BOTH is kept as the survivor has it
--                     and the duplicate's mark for that day is dropped — they
--                     are the same man on the same day, and the survivor is the
--                     record going forward. The count dropped is reported.
--   advances          all move. Money handed over is never dropped.
--   paid/unpaid marks move; the survivor's mark wins for a month both have.
--   rate history      the SURVIVOR's is kept and the duplicate's is discarded,
--                     so every day — including the moved ones — is valued at
--                     the survivor's salary. The preview shows both salaries
--                     before anything happens, so this is never a surprise.
--   login             moves across if only the duplicate had one.
--
-- PREVIEW FIRST
--   Called with p_commit = false it changes nothing and returns exactly what a
--   real merge would do. The page shows that and asks before committing.
--
-- THE BOUNDARY
--   Both ids must be on the Hub attendance roster, or it refuses. A central
--   `employees` record is only ever deleted or updated when it is in the HUB
--   department. Karkhana and FS Traders records are unreachable from here.
--
-- Safe to run more than once. Requires H234 (hub_may_manage_staff).

begin;

-- ---------------------------------------------------------------------------
-- Is this roster id also a Hub `employees` row? Returns the uuid, or null.
-- A roster id typed in on the attendance screen looks like 'emp-1787…' and is
-- tested before it is cast, because casting it raises.
-- ---------------------------------------------------------------------------
create or replace function hub_roster_hub_uuid(p_id text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v uuid;
begin
  if p_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  select e.id into v
    from employees e
   where e.id = p_id::uuid
     and e.department_id = (select id from departments where code = 'HUB');
  return v;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1. AFTER AN EDIT — the page saves the roster row itself, then calls this to
--    do the two things it cannot do from the browser:
--
--      * record a salary change in the rate history, from the date given, so
--        days before it keep the old rate and months already paid never move
--        (the history table is read-only to the browser)
--      * carry the new name, phone, role and salary onto the Hub employees
--        record, when there is one, so the two screens do not disagree — and
--        so the next save on the Hub employees page does not copy the old
--        values straight back over this edit
-- ---------------------------------------------------------------------------
create or replace function hub_after_roster_edit(
  p_id        text,
  p_old_sal   numeric,
  p_pay_from  date default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_o      record;
  v_hub    uuid;
  v_role   uuid;
  v_rate   boolean := false;
  v_synced boolean := false;
begin
  if not hub_may_manage_staff() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to manage staff.');
  end if;

  select * into v_o from online_att_employees where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Nobody on the Hub attendance roster has that id.');
  end if;

  if coalesce(v_o.sal, 0) > 0 and coalesce(v_o.sal, 0) <> coalesce(p_old_sal, 0) then
    insert into online_att_salary_history (emp_id, effective_from, sal, note)
    values (p_id, coalesce(p_pay_from, current_date), round(v_o.sal)::int,
            case when coalesce(p_old_sal, 0) > 0
                 then 'changed from ' || round(p_old_sal)::int else 'rate set' end)
    on conflict (emp_id, effective_from)
    do update set sal = excluded.sal, note = excluded.note;
    v_rate := true;
  end if;

  v_hub := hub_roster_hub_uuid(p_id);
  if v_hub is not null then
    if nullif(trim(coalesce(v_o.designation, '')), '') is not null then
      select id into v_role from designations where lower(name) = lower(trim(v_o.designation)) limit 1;
      if v_role is null then
        insert into designations (name) values (trim(v_o.designation)) returning id into v_role;
      end if;
    end if;

    update employees
       set name           = v_o.name,
           phone          = v_o.phone,
           pay_amount     = v_o.sal,
           designation_id = coalesce(v_role, designation_id)
     where id = v_hub;
    v_synced := true;
  end if;

  return jsonb_build_object('ok', true, 'rate_recorded', v_rate, 'hub_record_updated', v_synced);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. MERGE — move everything from p_from onto p_into, then remove p_from.
-- ---------------------------------------------------------------------------
create or replace function hub_merge_att_employee(
  p_from   text,
  p_into   text,
  p_commit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_f       record;
  v_t       record;
  v_fhub    uuid;
  n_days    integer;  n_clash   integer;
  n_adv     integer;  n_adv_amt numeric;
  n_marks   integer;  n_mclash  integer;
  v_login   boolean;
begin
  if not hub_may_manage_staff() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to manage staff.');
  end if;
  if p_from = p_into then
    return jsonb_build_object('ok', false, 'error', 'Pick a different person to merge into.');
  end if;

  select * into v_f from online_att_employees where id = p_from;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'The duplicate is not on the Hub attendance roster.');
  end if;
  select * into v_t from online_att_employees where id = p_into;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'The person to keep is not on the Hub attendance roster.');
  end if;

  -- What would happen. Counted the same way whether or not it is committed,
  -- so the preview is the merge and not an estimate of it.
  select count(*) into n_days  from online_att_records f where f.emp_id = p_from;
  select count(*) into n_clash from online_att_records f
   where f.emp_id = p_from
     and exists (select 1 from online_att_records t
                  where t.emp_id = p_into and t.year = f.year and t.month = f.month and t.day = f.day);
  select count(*), coalesce(sum(amount), 0) into n_adv, n_adv_amt
    from online_att_advances where emp_id = p_from;
  select count(*) into n_marks from online_att_salary_status where emp_id = p_from;
  select count(*) into n_mclash from online_att_salary_status f
   where f.emp_id = p_from
     and exists (select 1 from online_att_salary_status t
                  where t.emp_id = p_into and t.year = f.year and t.month = f.month);
  v_login := v_f.user_id is not null and v_t.user_id is null;

  if not p_commit then
    return jsonb_build_object(
      'ok', true, 'preview', true,
      'from_name', v_f.name, 'into_name', v_t.name,
      'from_sal', v_f.sal, 'into_sal', v_t.sal,
      'days', n_days - n_clash, 'days_dropped', n_clash,
      'advances', n_adv, 'advance_amount', n_adv_amt,
      'marks', n_marks - n_mclash,
      'login_moves', v_login);
  end if;

  -- ---- attendance ---------------------------------------------------------
  delete from online_att_records f
   where f.emp_id = p_from
     and exists (select 1 from online_att_records t
                  where t.emp_id = p_into and t.year = f.year and t.month = f.month and t.day = f.day);
  -- The id is rebuilt in the format the Mark Attendance box writes, so the
  -- next time somebody marks one of these days it updates this row instead of
  -- adding a second one beside it.
  update online_att_records
     set emp_id = p_into,
         id     = p_into || '-' || year || '-' || month || '-' || day
   where emp_id = p_from;

  -- ---- advances: every one moves ------------------------------------------
  update online_att_advances set emp_id = p_into where emp_id = p_from;

  -- ---- paid / unpaid marks ------------------------------------------------
  delete from online_att_salary_status f
   where f.emp_id = p_from
     and exists (select 1 from online_att_salary_status t
                  where t.emp_id = p_into and t.year = f.year and t.month = f.month);
  update online_att_salary_status
     set emp_id = p_into,
         id     = p_into || '-' || year || '-' || month
   where emp_id = p_from;

  -- ---- rate history: the survivor's stands --------------------------------
  delete from online_att_salary_history where emp_id = p_from;
  -- A survivor with no rate at all would be valued at zero for every day,
  -- the moved ones included. Give them their own salary from the start.
  insert into online_att_salary_history (emp_id, effective_from, sal, note)
  select p_into, date '2000-01-01', round(coalesce(v_t.sal, 0))::int, 'starting rate'
   where not exists (select 1 from online_att_salary_history where emp_id = p_into);

  -- ---- login ---------------------------------------------------------------
  if v_login then
    update online_att_employees set user_id = null      where id = p_from;
    update online_att_employees set user_id = v_f.user_id where id = p_into;
    if hub_roster_hub_uuid(p_from) is not null then
      update employees set user_id = null where id = hub_roster_hub_uuid(p_from);
    end if;
    if hub_roster_hub_uuid(p_into) is not null then
      update employees set user_id = v_f.user_id where id = hub_roster_hub_uuid(p_into);
    end if;
  end if;

  -- ---- the empty duplicate goes -------------------------------------------
  v_fhub := hub_roster_hub_uuid(p_from);
  delete from online_att_employees where id = p_from;
  if v_fhub is not null then
    delete from employees where id = v_fhub;
  end if;

  return jsonb_build_object(
    'ok', true, 'preview', false,
    'report', (n_days - n_clash) || ' attendance day(s) and ' || n_adv || ' advance(s) moved from '
              || v_f.name || ' to ' || v_t.name || '. ' || v_f.name || ' has been removed.'
              || case when n_clash > 0
                      then ' ' || n_clash || ' day(s) were already marked on ' || v_t.name
                           || ' and kept as they were.' else '' end
              || case when v_login then ' Their login moved across too.' else '' end);
end;
$function$;

grant execute on function hub_roster_hub_uuid(text)                       to authenticated;
grant execute on function hub_after_roster_edit(text, numeric, date)      to authenticated;
grant execute on function hub_merge_att_employee(text, text, boolean)     to authenticated;

commit;

-- ===========================================================================
-- VERIFY — the two Kashifs, and how many days each holds. Run before and
-- after the merge; afterwards there is one row and it holds the total.
--
--   select o.id, o.name, o.department, o.sal,
--          (select count(*) from online_att_records r where r.emp_id = o.id) as days,
--          (select count(*) from online_att_advances a where a.emp_id = o.id) as advances
--     from online_att_employees o
--    where o.name ilike '%kashif%';
-- ===========================================================================
