-- H296 — ADVANCE RETURN (owner, 19 Oct 2026)
-- Applied live as migration `h296_advance_return`. Hub tables only.
--
-- "In the advances I want an option: advance return — what employees give
--  back — and their payment updated as well."
--
-- HOW IT WORKS
--   A return is a row in online_att_advances with a NEGATIVE amount, in the
--   month whose advance it comes off. Every pay figure already sums that
--   column — hub_monthly_payable__impl (advances, advance cut, payable) and
--   hub_salary_mark_paid (advance due, what carries forward) — so the month's
--   advance drops by what was returned and the payable rises by exactly the
--   same amount. The pay engine itself is not touched.
--
-- GUARDS
--   * Recorded, changed and removed only through the functions below, which
--     need hub.attendance.manage — the same as Paid and Give extra day.
--   * Never in a month already marked paid: that month's pay is closed.
--   * Never more than is left of that month's advance. A month's advances can
--     never total below zero, whatever writes the table (trigger below), so a
--     return can never turn into extra pay, and undoing Paid cannot take away
--     a carried-forward advance that has already been partly returned.
--   * No zero rows.

alter table public.online_att_advances
  add constraint online_att_advances_amount_nonzero check (amount <> 0);

/* ------------------------------------------------------------------ */
/* A month's advance never below zero                                  */
/* ------------------------------------------------------------------ */
create or replace function public.hub_att_advance_net_check()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_emp   text;
  v_y     integer;
  v_m     integer;
  v_given bigint;
  v_ret   bigint;
  v_name  text;
  i       integer;
begin
  /* A note, a date or the settled flag: the month's total cannot change. */
  if tg_op = 'UPDATE'
     and new.emp_id is not distinct from old.emp_id
     and new.deduct_year is not distinct from old.deduct_year
     and new.deduct_month is not distinct from old.deduct_month
     and new.amount is not distinct from old.amount then
    return null;
  end if;

  for i in 1..2 loop
    if i = 1 then
      if tg_op = 'DELETE' then continue; end if;
      v_emp := new.emp_id; v_y := new.deduct_year; v_m := new.deduct_month;
    else
      if tg_op = 'INSERT' then continue; end if;
      if tg_op = 'UPDATE'
         and old.emp_id is not distinct from new.emp_id
         and old.deduct_year is not distinct from new.deduct_year
         and old.deduct_month is not distinct from new.deduct_month then
        continue;
      end if;
      v_emp := old.emp_id; v_y := old.deduct_year; v_m := old.deduct_month;
    end if;

    select coalesce(sum(amount) filter (where amount > 0), 0),
           coalesce(-sum(amount) filter (where amount < 0), 0)
      into v_given, v_ret
      from online_att_advances
     where emp_id = v_emp and deduct_year = v_y and deduct_month = v_m;

    if v_ret > v_given then
      select name into v_name from online_att_employees where id = v_emp;
      raise exception 'Rs % has been returned against %''s % advance, but only Rs % of advance is in that month. Remove or reduce the return first.',
        to_char(v_ret, 'FM999,999,999'), coalesce(v_name, 'this person'),
        to_char(make_date(v_y, v_m, 1), 'FMMonth YYYY'), to_char(v_given, 'FM999,999,999');
    end if;
  end loop;
  return null;
end $$;

create or replace trigger trg_online_att_advances_net
  after insert or update or delete on public.online_att_advances
  for each row execute function public.hub_att_advance_net_check();

/* ------------------------------------------------------------------ */
/* Record a return                                                     */
/* ------------------------------------------------------------------ */
create or replace function public.hub_advance_return(
  p_emp    text,
  p_year   integer,
  p_month  integer,
  p_amount integer,
  p_date   text default null,
  p_note   text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_date  date;
  v_name  text;
  v_mon   text;
  v_left  integer;
  v_note  text;
  v_id    text;
  v_pay   numeric;
begin
  if not has_permission('hub.attendance.manage') then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to record advance returns.');
  end if;
  if p_year is null or p_month is null or p_month not between 1 and 12 or p_year not between 2020 and 2100 then
    return jsonb_build_object('ok', false, 'error', 'Pick the month the advance is in.');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Write how much was returned — more than zero.');
  end if;
  if nullif(btrim(coalesce(p_date, '')), '') is null then
    v_date := v_today;
  elsif btrim(p_date) !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'error', 'The date is not a real date.');
  else
    begin
      v_date := btrim(p_date)::date;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'The date is not a real date.');
    end;
  end if;
  if v_date > v_today then
    return jsonb_build_object('ok', false, 'error', 'The date cannot be in the future.');
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(v_note) > 300 then
    return jsonb_build_object('ok', false, 'error', 'Keep the note under 300 characters.');
  end if;

  select name into v_name from online_att_employees where id = p_emp;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'That person is not on the Hub attendance roster.');
  end if;
  v_mon := to_char(make_date(p_year, p_month, 1), 'FMMonth YYYY');

  /* The same lock as Paid: a return and a payment for one person's month
     cannot cross. */
  perform pg_advisory_xact_lock(hashtext('hub_pay:' || p_emp || ':' || p_year || ':' || p_month));
  if exists (select 1 from online_att_salary_status
              where emp_id = p_emp and year = p_year and month = p_month and paid) then
    return jsonb_build_object('ok', false, 'error',
      v_mon || ' is already marked paid for ' || v_name || ', so its advance is closed. Undo Paid for '
      || v_mon || ' first if the return belongs there.');
  end if;

  select coalesce(sum(amount), 0)::integer into v_left
    from online_att_advances
   where emp_id = p_emp and deduct_year = p_year and deduct_month = p_month;
  if v_left <= 0 then
    return jsonb_build_object('ok', false, 'error', v_name || ' has no advance left in ' || v_mon || ' to return.');
  end if;
  if p_amount > v_left then
    return jsonb_build_object('ok', false, 'error',
      'Only Rs ' || to_char(v_left, 'FM999,999,999') || ' of ' || v_name || '''s advance is left in '
      || v_mon || ' — that is the most that can be returned.');
  end if;

  v_id := 'ret_' || substr(md5(random()::text || clock_timestamp()::text || p_emp), 1, 12);
  insert into online_att_advances (id, emp_id, amount, date, note, deduct_month, deduct_year, settled)
  values (v_id, p_emp, -p_amount, to_char(v_date, 'YYYY-MM-DD'), coalesce(v_note, 'Advance returned'),
          p_month, p_year, false);

  select m.payable into v_pay
    from hub_monthly_payable__impl(p_year, p_month, null) m where m.emp_id = p_emp;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'returned', p_amount, 'before', v_left, 'after', v_left - p_amount,
    'payable', coalesce(v_pay, 0), 'month', v_mon,
    'report', v_name || ' returned Rs ' || to_char(p_amount, 'FM999,999,999') || '. Advance in ' || v_mon
              || ' is now Rs ' || to_char(v_left - p_amount, 'FM999,999,999') || ', so ' || v_mon
              || ' pay goes up by Rs ' || to_char(p_amount, 'FM999,999,999') || '.');
end $$;

/* ------------------------------------------------------------------ */
/* Change a return entered wrongly (amount, date, note)                */
/* ------------------------------------------------------------------ */
create or replace function public.hub_advance_return_edit(
  p_id     text,
  p_amount integer,
  p_date   text default null,
  p_note   text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  r       record;
  v_date  date;
  v_name  text;
  v_mon   text;
  v_room  integer;
  v_note  text;
  v_pay   numeric;
begin
  if not has_permission('hub.attendance.manage') then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to change advance returns.');
  end if;
  select id, emp_id, amount, deduct_year, deduct_month into r from online_att_advances where id = p_id;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'That return is no longer there — refresh the list.');
  end if;
  if r.amount >= 0 then
    return jsonb_build_object('ok', false, 'error', 'Only an advance return can be changed here.');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Write how much was returned — more than zero.');
  end if;
  if nullif(btrim(coalesce(p_date, '')), '') is null then
    v_date := v_today;
  elsif btrim(p_date) !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'error', 'The date is not a real date.');
  else
    begin
      v_date := btrim(p_date)::date;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'The date is not a real date.');
    end;
  end if;
  if v_date > v_today then
    return jsonb_build_object('ok', false, 'error', 'The date cannot be in the future.');
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(v_note) > 300 then
    return jsonb_build_object('ok', false, 'error', 'Keep the note under 300 characters.');
  end if;

  perform pg_advisory_xact_lock(hashtext('hub_pay:' || r.emp_id || ':' || r.deduct_year || ':' || r.deduct_month));
  select id, emp_id, amount, deduct_year, deduct_month into r from online_att_advances where id = p_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'That return is no longer there — refresh the list.');
  end if;
  select name into v_name from online_att_employees where id = r.emp_id;
  v_name := coalesce(v_name, 'This person');
  v_mon := to_char(make_date(r.deduct_year, r.deduct_month, 1), 'FMMonth YYYY');
  if exists (select 1 from online_att_salary_status
              where emp_id = r.emp_id and year = r.deduct_year and month = r.deduct_month and paid) then
    return jsonb_build_object('ok', false, 'error',
      v_mon || ' is already marked paid for ' || v_name || ', so this return is closed. Undo Paid for ' || v_mon || ' first.');
  end if;

  /* What the month's advance comes to with this return taken out. */
  select (coalesce(sum(amount), 0) - r.amount)::integer into v_room
    from online_att_advances
   where emp_id = r.emp_id and deduct_year = r.deduct_year and deduct_month = r.deduct_month;
  if p_amount > v_room then
    return jsonb_build_object('ok', false, 'error',
      'Only Rs ' || to_char(v_room, 'FM999,999,999') || ' of advance is in ' || v_mon
      || ' before this return — that is the most it can be.');
  end if;

  update online_att_advances
     set amount = -p_amount, date = to_char(v_date, 'YYYY-MM-DD'), note = coalesce(v_note, 'Advance returned')
   where id = r.id;

  select m.payable into v_pay
    from hub_monthly_payable__impl(r.deduct_year, r.deduct_month, null) m where m.emp_id = r.emp_id;

  return jsonb_build_object(
    'ok', true, 'id', r.id, 'returned', p_amount, 'after', v_room - p_amount,
    'payable', coalesce(v_pay, 0), 'month', v_mon,
    'report', v_name || '''s return is now Rs ' || to_char(p_amount, 'FM999,999,999') || '. Advance in '
              || v_mon || ' is Rs ' || to_char(v_room - p_amount, 'FM999,999,999') || '.');
end $$;

/* ------------------------------------------------------------------ */
/* Remove a return entered by mistake                                  */
/* ------------------------------------------------------------------ */
create or replace function public.hub_advance_return_remove(p_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r      record;
  v_name text;
  v_mon  text;
  v_left integer;
begin
  if not has_permission('hub.attendance.manage') then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to remove advance returns.');
  end if;
  select id, emp_id, amount, deduct_year, deduct_month into r from online_att_advances where id = p_id;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'That return is no longer there — refresh the list.');
  end if;
  if r.amount >= 0 then
    return jsonb_build_object('ok', false, 'error', 'Only an advance return can be removed here.');
  end if;

  perform pg_advisory_xact_lock(hashtext('hub_pay:' || r.emp_id || ':' || r.deduct_year || ':' || r.deduct_month));
  select id, emp_id, amount, deduct_year, deduct_month into r from online_att_advances where id = p_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'That return is no longer there — refresh the list.');
  end if;
  select name into v_name from online_att_employees where id = r.emp_id;
  v_name := coalesce(v_name, 'This person');
  v_mon := to_char(make_date(r.deduct_year, r.deduct_month, 1), 'FMMonth YYYY');
  if exists (select 1 from online_att_salary_status
              where emp_id = r.emp_id and year = r.deduct_year and month = r.deduct_month and paid) then
    return jsonb_build_object('ok', false, 'error',
      v_mon || ' is already marked paid for ' || v_name || ', so this return is closed. Undo Paid for ' || v_mon || ' first.');
  end if;

  delete from online_att_advances where id = r.id;

  select coalesce(sum(amount), 0)::integer into v_left
    from online_att_advances
   where emp_id = r.emp_id and deduct_year = r.deduct_year and deduct_month = r.deduct_month;

  return jsonb_build_object(
    'ok', true, 'id', r.id, 'removed', -r.amount, 'after', v_left, 'month', v_mon,
    'report', 'Return of Rs ' || to_char(-r.amount, 'FM999,999,999') || ' taken off. ' || v_name
              || '''s advance in ' || v_mon || ' is back to Rs ' || to_char(v_left, 'FM999,999,999')
              || ', so ' || v_mon || ' pay goes down by Rs ' || to_char(-r.amount, 'FM999,999,999') || '.');
end $$;

/* ------------------------------------------------------------------ */
/* What can be returned: each person's unpaid months with advance left */
/* ------------------------------------------------------------------ */
create or replace function public.hub_advance_outstanding()
returns table(emp_id text, name text, year integer, month integer, given integer, returned integer, outstanding integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select a.emp_id, e.name, a.deduct_year, a.deduct_month,
         coalesce(sum(a.amount) filter (where a.amount > 0), 0)::integer,
         coalesce(-sum(a.amount) filter (where a.amount < 0), 0)::integer,
         coalesce(sum(a.amount), 0)::integer
    from online_att_advances a
    join online_att_employees e on e.id = a.emp_id
   where (select has_permission('hub.attendance.manage'))
     and not exists (select 1 from online_att_salary_status s
                      where s.emp_id = a.emp_id and s.year = a.deduct_year
                        and s.month = a.deduct_month and s.paid)
   group by a.emp_id, e.name, a.deduct_year, a.deduct_month
  having coalesce(sum(a.amount), 0) > 0
   order by e.name, a.deduct_year, a.deduct_month;
$$;

/* ------------------------------------------------------------------ */
/* Who may call what                                                   */
/* ------------------------------------------------------------------ */
revoke all on function public.hub_att_advance_net_check() from public, anon, authenticated;
revoke all on function public.hub_advance_return(text, integer, integer, integer, text, text) from public, anon;
revoke all on function public.hub_advance_return_edit(text, integer, text, text) from public, anon;
revoke all on function public.hub_advance_return_remove(text) from public, anon;
revoke all on function public.hub_advance_outstanding() from public, anon;
grant execute on function public.hub_advance_return(text, integer, integer, integer, text, text) to authenticated, service_role;
grant execute on function public.hub_advance_return_edit(text, integer, text, text) to authenticated, service_role;
grant execute on function public.hub_advance_return_remove(text) to authenticated, service_role;
grant execute on function public.hub_advance_outstanding() to authenticated, service_role;

comment on function public.hub_advance_return(text, integer, integer, integer, text, text) is
  'H296: record money an employee gives back against a month''s advance (a negative row in online_att_advances). That month''s payable rises by the same amount. Needs hub.attendance.manage; refuses a paid month and more than is left.';
comment on function public.hub_att_advance_net_check() is
  'H296: a month''s advances (gifts minus returns) can never total below zero, whatever writes online_att_advances.';
