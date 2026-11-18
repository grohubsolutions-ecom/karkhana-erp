-- H235_remove_from_attendance_roster.sql
--
-- REMOVE SOMEBODY FROM THE HUB ATTENDANCE ROSTER.
--
-- H234 gave the Hub employees page a working Remove, and drew its boundary
-- around the HUB department. That is the right boundary for that page, and the
-- wrong one for the attendance screen, because of how people get onto it.
--
-- TWO DOORS INTO THE SAME LIST
--   The attendance screen's own "Add employee" box writes a single row straight
--   into online_att_employees, with a text id like 'emp-1787912684762' and a
--   free-text department typed by hand. It never creates an `employees` record
--   and never picks a real department — "IT" on that list is a string somebody
--   typed, not a department the system knows about.
--
--   So Kashif is on the attendance roster and is not a Hub employee, is not a
--   Karkhana employee, and is not in the employees table at all. H234 refuses
--   him, correctly, and there is no other button anywhere that reaches him. He
--   cannot be removed, which is not a policy — it is a gap.
--
-- THE BOUNDARY THAT FITS THIS SCREEN
--   Being ON the Hub attendance roster. If there is no online_att_employees row
--   with that id, this refuses. Karkhana's and FS Traders' people are not on
--   that roster and cannot be reached through here, whatever id is passed.
--
--   The central `employees` record is deleted only when that person is in the
--   HUB department, so the two screens stay in step. Anybody else keeps their
--   staff record — it belongs to Administration, not to this screen — and the
--   answer says so plainly rather than quietly leaving it behind.
--
-- Safe to run more than once. Requires H234 (it reuses hub_may_manage_staff).

begin;

create or replace function hub_remove_att_employee(p_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name   text;
  v_dept   text;      -- the free text on the roster row
  v_uuid   uuid;
  v_hub    uuid;
  v_central text := 'none';   -- what happened to the employees record
  n_rec    integer := 0;
  n_adv    integer := 0;
  n_sal    integer := 0;
  n_hist   integer := 0;
  n_ros    integer := 0;
begin
  if not hub_may_manage_staff() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to remove staff.');
  end if;

  select name, department into v_name, v_dept
    from online_att_employees where id = p_id;
  if v_name is null then
    return jsonb_build_object('ok', false,
      'error', 'Nobody on the Hub attendance roster has that id. Nothing was removed.');
  end if;

  select id into v_hub from departments where code = 'HUB';

  /* The roster id is text. A person imported from the employees table carries
     a uuid in it; a person typed straight into this screen carries something
     like 'emp-1787912684762'. Casting that to uuid raises, so it is tested
     before it is cast rather than after it has thrown. */
  if p_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_uuid := p_id::uuid;
    if exists (select 1 from employees where id = v_uuid and department_id = v_hub) then
      delete from employees where id = v_uuid;
      v_central := 'removed';
    elsif exists (select 1 from employees where id = v_uuid) then
      -- Another department's staff record. Not this screen's to delete.
      v_central := 'kept';
    end if;
  end if;

  delete from online_att_records        where emp_id = p_id;  get diagnostics n_rec  = row_count;
  delete from online_att_advances       where emp_id = p_id;  get diagnostics n_adv  = row_count;
  delete from online_att_salary_status  where emp_id = p_id;  get diagnostics n_sal  = row_count;
  delete from online_att_salary_history where emp_id = p_id;  get diagnostics n_hist = row_count;
  delete from online_att_employees      where id     = p_id;  get diagnostics n_ros  = row_count;

  if n_ros = 0 then
    return jsonb_build_object('ok', false,
      'error', 'The roster row would not delete. Something else still refers to it.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'employee', v_name,
    'department', v_dept,
    'central_record', v_central,   -- removed | kept | none
    'attendance', n_rec,
    'advances', n_adv,
    'salary_marks', n_sal,
    'rate_history', n_hist,
    'report', v_name || ' removed from the attendance roster, with '
              || n_rec || ' attendance record(s) and ' || n_adv || ' advance(s).'
              || case v_central
                   when 'kept' then ' Their staff record in ' || coalesce(v_dept, 'another department')
                                     || ' was left alone — that one belongs to Administration.'
                   when 'removed' then ' Their Hub employee record went with them.'
                   else '' end);
end;
$function$;

grant execute on function hub_remove_att_employee(text) to authenticated;

commit;

-- ===========================================================================
-- VERIFY
--
-- Who is on the roster, and whether they have a staff record behind them:
--
--   select o.name, o.department,
--          case when o.id ~ '^[0-9a-f-]{36}$' and e.id is not null
--               then 'has an employees record' else 'roster only' end as kind
--     from online_att_employees o
--     left join employees e
--            on o.id ~ '^[0-9a-f-]{36}$' and e.id = nullif(o.id, '')::uuid
--    order by o.name;
--
-- The boundary, proved: an id that is not on the roster is refused.
--
--   select hub_remove_att_employee('not-a-real-id');
--   -> {"ok": false, "error": "Nobody on the Hub attendance roster has that id..."}
-- ===========================================================================
