/* ════════════════════════════════════════════════════════════════════════════
   THE PERMISSION CHECK WAS RUNNING ONCE PER ROW.

   Every table in this project is guarded by a policy of the shape

       using ( has_permission('something') )        -- or retail_can(...)

   and that call takes no column from the row. It is the same answer for row 1
   and row 58,303. Postgres does not know that: a function call sitting bare in
   a policy is part of the per-row filter, so it is executed per row — and each
   execution runs two EXISTS subqueries over app_users, user_roles,
   role_permissions and permissions.

   Measured on retail_sale_lines (58,303 rows), as the authenticated role:

       select … where sale_date between … order by id limit 1000
         ->  48,896 ms,  357,405 shared buffers,  per-row Filter

   The same query with the permission call wrapped in a scalar subquery:

       ->       7.4 ms,         502 shared buffers,  One-Time Filter (InitPlan)

   6,600x faster, and the reason is only that the answer is now computed once.
   For a user WITHOUT the permission it is worse still: the scan has to reject
   all 58,303 rows one at a time and blows the 8-second statement_timeout that
   the `authenticated` role carries — which is the

       canceling statement due to statement timeout

   that has been appearing day after day in the retail screens.

   ----------------------------------------------------------------------------
   WHAT THIS MIGRATION DOES, AND WHY IT CANNOT CHANGE WHO SEES WHAT

   It wraps each bare permission call in `(select ...)`. A scalar subquery with
   no reference to the surrounding row is evaluated once per statement and its
   VALUE is identical to calling the function directly — these functions are
   STABLE and do nothing but read. So for every row, the old predicate and the
   new one return the same boolean. Only the number of times it is computed
   changes.

   Column predicates are deliberately NOT wrapped. khana_stock_movements' write
   policy mixes permissions with real row tests (voided_at, movement_type,
   note) and those must stay per-row, because they genuinely differ per row.
   The rewrite touches function calls only and leaves the structure alone.

   The 61 policies on the hub_* and online_* tables already use this form — this
   finishes the job for the 124 that do not, across retail, karkhana and the
   admin tables.

   VERIFICATION IS PART OF THE TRANSACTION. After rewriting, every new
   expression is read back, the (select ...) wrappers are stripped off again,
   and the result is compared character by character with what was there
   before. A single mismatch raises and the whole migration rolls back, so there
   is no state in which a policy has been altered into something unverified.

   Visibility was also checked from outside, before and after, for three users —
   a super admin, a user with the Employee role and a user with no roles at all —
   across thirteen tables. Every count matched.
   ════════════════════════════════════════════════════════════════════════════ */
do $mig$
declare
  r record;
  nu text; nw text;
  back text;
  changed int := 0;
  mismatches text := '';
begin
  create temp table _rls_before on commit drop as
  select c.relname::text  as tbl,
         pol.polname::text as nm,
         pol.polcmd        as cmd,
         pg_get_expr(pol.polqual, pol.polrelid)      as u,
         pg_get_expr(pol.polwithcheck, pol.polrelid) as w
    from pg_policy pol
    join pg_class c     on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
       || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) !~ '\(\s*SELECT\s';

  for r in select * from _rls_before loop
    /* the rewrite: permission functions first, then auth.uid() which is
       spelled with a schema prefix and so needs its own pattern */
    nu := regexp_replace(regexp_replace(r.u,
            '(retail_can|has_permission|retail_any|is_super_admin)(\([^()]*\))',
            '(select \1\2)', 'g'),
            'auth\.uid\(\)', '(select auth.uid())', 'g');
    nw := regexp_replace(regexp_replace(r.w,
            '(retail_can|has_permission|retail_any|is_super_admin)(\([^()]*\))',
            '(select \1\2)', 'g'),
            'auth\.uid\(\)', '(select auth.uid())', 'g');

    if nu is not distinct from r.u and nw is not distinct from r.w then
      continue;
    end if;

    /* USING and WITH CHECK have to be given exactly as the policy already has
       them — a SELECT policy has no WITH CHECK and an INSERT policy has no
       USING, and naming a clause the policy cannot carry is an error. */
    if nu is not null and nw is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)', r.nm, r.tbl, nu, nw);
    elsif nu is not null then
      execute format('alter policy %I on public.%I using (%s)', r.nm, r.tbl, nu);
    else
      execute format('alter policy %I on public.%I with check (%s)', r.nm, r.tbl, nw);
    end if;
    changed := changed + 1;
  end loop;

  /* PROOF. Read every altered policy back, strip the wrappers Postgres prints
     ( SELECT f(args) AS alias)  ->  f(args)
     and require the result to equal the original text exactly. */
  for r in
    select b.tbl, b.nm, b.u, b.w,
           pg_get_expr(pol.polqual, pol.polrelid)      as u2,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as w2
      from _rls_before b
      join pg_class c     on c.relname = b.tbl
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_policy pol  on pol.polrelid = c.oid and pol.polname = b.nm
  loop
    back := regexp_replace(coalesce(r.u2, ''),
              '\(\s*SELECT\s+([a-z_]+\.?[a-z_]*\([^()]*\))\s+AS\s+[a-z_]+\)', '\1', 'g');
    if back is distinct from coalesce(r.u, '') then
      mismatches := mismatches || format(E'\n  USING  %s.%s\n    was: %s\n    got: %s', r.tbl, r.nm, r.u, back);
    end if;

    back := regexp_replace(coalesce(r.w2, ''),
              '\(\s*SELECT\s+([a-z_]+\.?[a-z_]*\([^()]*\))\s+AS\s+[a-z_]+\)', '\1', 'g');
    if back is distinct from coalesce(r.w, '') then
      mismatches := mismatches || format(E'\n  CHECK  %s.%s\n    was: %s\n    got: %s', r.tbl, r.nm, r.w, back);
    end if;
  end loop;

  if mismatches <> '' then
    raise exception 'RLS rewrite changed meaning, rolling back:%', mismatches;
  end if;

  raise notice 'rewrote % policies; all verified identical once unwrapped', changed;
end
$mig$;
