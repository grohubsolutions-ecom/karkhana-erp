/* ===========================================================================
   H286 ROLLBACK — only if checkpoints / Live must be switched off.

   Order: put the previous screens back first (or in the same deploy), then
   run this. The new screens call hub_task_checkpoint / hub_task_go_live,
   which this file leaves in place.

   Puts back hub_task_submit, hub_task_reopen, hub_my_articles and
   hub_article_detail exactly as they were before H286 (read from the live
   database on 2 Oct 2026). After this the ads stage submits as before and an
   article closes when the last of the five submits.

   Left in place on purpose (harmless once the old screens are back): the
   columns hub_tasks.sent_back_by / sent_back_note, the unique index
   hub_tasks_one_open_per_stage, and the functions hub_stage_name,
   hub_task_checkpoint, hub_task_go_live, hub_my_checkpoints. To remove those
   too, run in the SQL editor:
     drop function if exists hub_my_checkpoints();
     drop function if exists hub_task_go_live(uuid, text, timestamptz);
     drop function if exists hub_task_checkpoint(uuid, text, text);
     drop function if exists hub_stage_name(text);
     drop index if exists hub_tasks_one_open_per_stage;
   Hub tables only.
=========================================================================== */

create or replace function hub_task_submit(p_task_id uuid, p_note text, p_done_on timestamptz default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_code text; v_held text; v_when timestamptz;
  v_on_behalf boolean; v_actor text; v_person text; r record; v_qc hub_tasks;
begin
  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'That task no longer exists.'); end if;
  if t.assignee <> auth.uid() and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'That work is not assigned to you.');
  end if;
  if t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'That work has already been submitted.');
  end if;
  if coalesce(btrim(p_note), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Write what was done before submitting.');
  end if;
  if p_done_on is not null and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'Only an administrator can set the date.');
  end if;
  if p_done_on is not null and p_done_on > now() then
    return jsonb_build_object('ok', false, 'error', 'That date has not happened yet.');
  end if;

  v_when      := coalesce(p_done_on, now());
  v_on_behalf := (t.assignee <> auth.uid());
  select full_name into v_actor  from app_users where id = auth.uid();
  select full_name into v_person from app_users where id = t.assignee;

  update hub_tasks
     set status = 'submitted', submitted_at = v_when,
         submit_note = btrim(p_note), submitted_by = auth.uid()
   where id = p_task_id;

  v_held := hub_fmt_interval(greatest(v_when - t.opened_at, interval '0'));

  insert into hub_article_events (article_id, task_id, kind, detail)
  values (t.article_id, t.id, 'submitted',
          coalesce(t.stage, 'task')
          || case when v_on_behalf then ' · recorded by ' || v_actor || ' for ' || v_person
                  else ' · held ' || v_held end
          || case when p_done_on is not null
                  then ' · done ' || to_char(v_when, 'DD Mon YYYY') else '' end);

  if t.article_id is null then
    if v_on_behalf then
      perform hub_notify(t.assignee, 'submitted', 'Marked done for you: ' || t.title,
        v_actor || ' recorded: ' || btrim(p_note), null, t.id);
    else
      perform hub_notify(t.created_by, 'submitted', 'Task done: ' || t.title,
        btrim(p_note) || ' · held ' || v_held, null, t.id);
    end if;
    return jsonb_build_object('ok', true, 'completed_article', false, 'on_behalf', v_on_behalf);
  end if;

  select code into v_code from hub_articles where id = t.article_id;

  if not v_on_behalf then
    perform hub_notify(a.created_by, 'submitted',
        v_code || ' — ' || coalesce(t.stage,'task') || ' submitted',
        v_person || ': ' || btrim(p_note) || ' · held ' || v_held, t.article_id, t.id)
      from hub_articles a where a.id = t.article_id;
  else
    perform hub_notify(t.assignee, 'submitted',
      v_code || ' — marked done for you', v_actor || ' recorded: ' || btrim(p_note),
      t.article_id, t.id);
  end if;

  -- THE CHAIN, identical either way
  if t.stage = 'product' then
    select * into v_qc from hub_tasks
     where article_id = t.article_id and stage = 'qc'
     order by created_at desc limit 1;

    if v_qc.id is not null and v_qc.status = 'open' then
      /* H271: the check is already running in parallel — tell him the
         upload is in. His clock is not touched. */
      perform hub_notify(v_qc.assignee, 'assigned',
        v_code || ' — product is uploaded', v_person || ': ' || btrim(p_note),
        t.article_id, v_qc.id);

    elsif v_qc.id is not null and v_qc.status = 'submitted' then
      /* H271: the check finished first; the product was the last thing
         ads and social were waiting for. Open them once, never twice. */
      if not exists (select 1 from hub_tasks x where x.article_id = t.article_id and x.stage = 'ads') then
        perform hub_open_stage(t.article_id, 'ads');
      end if;
      if not exists (select 1 from hub_tasks x where x.article_id = t.article_id and x.stage = 'social') then
        perform hub_open_stage(t.article_id, 'social');
      end if;

    else
      -- no check yet, or the check sent it back: open the check as before
      perform hub_open_stage(t.article_id, 'qc', t.attempt);
    end if;

  elsif t.stage = 'qc' then
    if hub_product_ready(t.article_id) then
      perform hub_open_stage(t.article_id, 'ads');
      perform hub_open_stage(t.article_id, 'social');
    else
      /* H271: check done before the upload — ads and social wait for it. */
      insert into hub_article_events (article_id, task_id, kind, detail)
      values (t.article_id, t.id, 'note',
              'quality check done first · ads and social open when '
              || coalesce(hub_product_holder(t.article_id), 'the product stage')
              || ' submits the product');
    end if;

  elsif t.stage = 'video' then
    for r in select t2.id from hub_tasks t2
              where t2.article_id = t.article_id and t2.stage in ('ads','social') and t2.status = 'open'
    loop
      update hub_tasks set detail = coalesce(detail,'') || E'\n\nVideo ready: ' || btrim(p_note)
       where id = r.id;
    end loop;
    for r in select s.user_id from hub_stage_owners s where s.stage in ('ads','social')
    loop
      perform hub_notify(r.user_id, 'assigned',
        v_code || ' — the video is ready', btrim(p_note), t.article_id, null);
    end loop;
  end if;

  return jsonb_build_object('ok', true,
    'completed_article', hub_check_complete(t.article_id), 'on_behalf', v_on_behalf);
end;
$$;

create or replace function hub_my_articles()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with mine as (
    select t.article_id, bool_or(t.stage = 'ads') as holds_ads
      from hub_tasks t
     where t.assignee = auth.uid()
       and t.article_id is not null
       and (t.status = 'open' or t.submitted_at > now() - interval '30 days')
     group by t.article_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id',   a.id,
           'code',         a.code,
           'name',         coalesce(a.final_name, a.rough_name),
           'final_name',   a.final_name,
           'retail_price', a.retail_price,
           'brief',        nullif(btrim(coalesce(a.brief, '')), ''),
           /* the single first, then the packs from smallest up — the same
              ladder the admin sees, without the cost column */
           'packs', (select coalesce(jsonb_agg(x.j order by x.units, x.label), '[]'::jsonb)
                       from (select 1 as units, 'Single' as label,
                                    jsonb_build_object('label', 'Single', 'units', 1, 'price', a.retail_price) as j
                              where a.retail_price is not null
                             union all
                             select p.units, p.label,
                                    jsonb_build_object('label', p.label, 'units', p.units, 'price', p.retail_price)
                               from hub_article_packs p
                              where p.article_id = a.id) x),
           'ads_budget',   case when m.holds_ads then a.ads_budget end,
           'ads_basis',    case when m.holds_ads then a.ads_basis end,
           'comments', (select coalesce(jsonb_agg(c.j order by c.at nulls last, c.task_id), '[]'::jsonb)
                          from (select t.id as task_id, t.submitted_at as at,
                                       jsonb_build_object(
                                         'task_id', t.id, 'stage', t.stage, 'title', t.title,
                                         'by', coalesce(u.full_name, 'Someone'),
                                         'mine', t.assignee = auth.uid(),
                                         'at', t.submitted_at, 'kind', 'done',
                                         'note', btrim(t.submit_note),
                                         'recorded_by', case when t.submitted_by is not null and t.submitted_by <> t.assignee
                                                             then (select b.full_name from app_users b where b.id = t.submitted_by) end) as j
                                  from hub_tasks t
                                  left join app_users u on u.id = t.assignee
                                 where t.article_id = a.id
                                   and t.submitted_at is not null
                                   and nullif(btrim(coalesce(t.submit_note, '')), '') is not null
                                union all
                                select t.id, ev.at,
                                       jsonb_build_object(
                                         'task_id', t.id, 'stage', t.stage, 'title', t.title,
                                         'by', coalesce(u.full_name, 'Someone'),
                                         'mine', t.assignee = auth.uid(),
                                         'at', ev.at, 'kind', 'sent_back',
                                         'note', btrim(t.returned_note), 'recorded_by', null)
                                  from hub_tasks t
                                  left join app_users u on u.id = t.assignee
                                  left join lateral (select max(e.at) as at from hub_article_events e
                                                      where e.task_id = t.id and e.kind = 'sent_back') ev on true
                                 where t.article_id = a.id
                                   and t.status = 'returned'
                                   and nullif(btrim(coalesce(t.returned_note, '')), '') is not null) c)
         ) order by a.code), '[]'::jsonb)
    from mine m
    join hub_articles a on a.id = m.article_id;
$$;

create or replace function hub_article_detail(p_article_id uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'article', (select to_jsonb(a) - 'created_by' || jsonb_build_object(
                   'created_by_name', (select full_name from app_users u where u.id = a.created_by),
                   'ads_spent',        coalesce((select sum(x.amount) from hub_ads_expenses x where x.article_id=a.id and x.status='approved'),0),
                   'ads_spent_period', hub_ads_spent_in_period(a.id, a.ads_basis),
                   'ads_pending',      coalesce((select sum(x.amount) from hub_ads_expenses x where x.article_id=a.id and x.status='pending'),0),
                   'period_label', case a.ads_basis when 'daily' then 'today'
                                                    when 'monthly' then to_char(current_date,'FMMonth')
                                                    else 'in total' end,
                   'age', hub_fmt_interval(coalesce(a.completed_at, now()) - a.created_at))
                  from hub_articles a where a.id = p_article_id),
    'packs', (select coalesce(jsonb_agg(jsonb_build_object(
                   'pack_id', p.pack_id, 'label', p.label, 'units', p.units,
                   'exact_cost', p.exact_cost, 'retail_price', p.retail_price,
                   'is_single', p.is_single,
                   'margin', case when coalesce(p.retail_price,0) > 0 and p.exact_cost is not null
                                  then round((p.retail_price - p.exact_cost) * 100 / p.retail_price, 1) end,
                   'per_unit', case when p.units > 0 and p.retail_price is not null
                                    then round(p.retail_price / p.units, 0) end
                 ) order by p.units, p.label), '[]'::jsonb)
                 from (
                   select null::uuid as pack_id, 'Single'::text as label, 1 as units,
                          a.exact_cost, a.retail_price, true as is_single
                     from hub_articles a where a.id = p_article_id
                   union all
                   select k.id, k.label, k.units, k.exact_cost, k.retail_price, false
                     from hub_article_packs k where k.article_id = p_article_id
                 ) p),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object(
                   'stage', s.stage, 'label', s.label, 'sort_order', s.sort_order,
                   'person', u.full_name, 'task_id', lt.id, 'status', lt.status,
                   'attempt', lt.attempt, 'opened_at', lt.opened_at,
                   'submitted_at', lt.submitted_at, 'submit_note', lt.submit_note,
                   'returned_note', lt.returned_note,
                   'submitted_by_name', (select full_name from app_users b where b.id = lt.submitted_by),
                   'on_behalf', (lt.submitted_by is not null and lt.submitted_by <> lt.assignee),
                   'held', hub_fmt_interval(greatest(coalesce(lt.submitted_at, now()) - lt.opened_at, interval '0'))
                 ) order by s.sort_order), '[]'::jsonb)
                 from hub_stage_owners s
                 left join lateral (select * from hub_tasks t where t.article_id=p_article_id and t.stage=s.stage
                                     order by t.created_at desc limit 1) lt on true
                 left join app_users u on u.id = coalesce(lt.assignee, s.user_id)),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                   'kind', e.kind, 'detail', e.detail, 'at', e.at,
                   'actor', (select full_name from app_users u where u.id = e.actor)
                 ) order by e.at), '[]'::jsonb)
                 from hub_article_events e where e.article_id = p_article_id),
    'ads', (select coalesce(jsonb_agg(to_jsonb(x) order by x.spent_on desc), '[]'::jsonb)
              from hub_ads_expenses x where x.article_id = p_article_id)
  )
  where has_permission('hub.articles.view') or has_permission('hub.articles.manage');
$$;

create or replace function hub_task_reopen(p_task_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_code text; v_actor text; v_person text;
  v_why text; v_was_complete boolean := false;
begin
  if not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'Only an administrator can undo a submission.');
  end if;

  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then
    return jsonb_build_object('ok', false, 'error', 'That task no longer exists.');
  end if;
  if t.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'error', 'That work is not submitted, so there is nothing to undo.');
  end if;

  v_why := coalesce(nullif(btrim(p_reason), ''), 'marked done by mistake');
  select full_name into v_actor  from app_users where id = auth.uid();
  select full_name into v_person from app_users where id = t.assignee;

  update hub_tasks
     set status = 'open', submitted_at = null, submit_note = null, submitted_by = null,
         returned_note = v_why
   where id = p_task_id;

  /* opened_at is NOT reset. The man has genuinely had this since it was first
     given to him, and restarting his clock would hide that. */

  if t.article_id is not null then
    select code into v_code from hub_articles where id = t.article_id;

    /* If the wrong submission was the one that finished the article, the
       article is not finished. */
    update hub_articles set status = 'in_progress', completed_at = null
     where id = t.article_id and status = 'completed';
    v_was_complete := found;

    insert into hub_article_events (article_id, task_id, kind, detail)
    values (t.article_id, t.id, 'reopened',
            coalesce(t.stage, 'task') || ' · undone by ' || v_actor
            || ' · back with ' || v_person || ' · ' || v_why);

    perform hub_notify(t.assignee, 'returned',
      v_code || ' — back with you',
      v_actor || ' undid the record: ' || v_why, t.article_id, t.id);
  else
    insert into hub_article_events (article_id, task_id, kind, detail)
    values (null, t.id, 'reopened',
            'task · undone by ' || v_actor || ' · back with ' || v_person || ' · ' || v_why);

    perform hub_notify(t.assignee, 'returned',
      'Back with you: ' || t.title,
      v_actor || ' undid the record: ' || v_why, null, t.id);
  end if;

  return jsonb_build_object('ok', true, 'person', v_person,
                            'article_reopened', v_was_complete);
end;
$$;
