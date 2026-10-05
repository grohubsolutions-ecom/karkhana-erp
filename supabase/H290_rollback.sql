/* ===========================================================================
   H290 ROLLBACK — put the check-back back to ads-only and remove custom tasks
   and push. Put the previous MyWork.tsx / app/me screens back first, then run
   this in the SQL editor.

   It restores hub_task_checkpoint and hub_my_checkpoints to the H286 (ads-only)
   versions, drops the custom-task and push functions, the push trigger and the
   push table. The additive hub_tasks columns (custom_article, inventory_code,
   due_date) are left in place — they are harmless and hold real data.
   Hub tables only.
=========================================================================== */

drop trigger if exists trg_hub_push_on_notify on hub_notifications;
drop function if exists hub_push_on_notify();
drop function if exists hub_push_subscribe(text, text, text, text);
drop function if exists hub_push_unsubscribe(text);
drop table if exists hub_push_subscriptions;
drop function if exists hub_create_custom_task(uuid, text, text, text, text, date);
drop function if exists hub_custom_task_people();
drop function if exists hub_can_make_custom_task();

/* hub_task_checkpoint — back to ads-only (H286) */
create or replace function hub_task_checkpoint(p_task_id uuid, p_stage text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_last hub_tasks; v_owner uuid; v_label text; v_code text;
  v_actor text; v_person text; v_note text; v_says text; v_new uuid;
begin
  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then
    return jsonb_build_object('ok', false, 'error', 'That task no longer exists.');
  end if;
  if t.stage is distinct from 'ads' or t.article_id is null then
    return jsonb_build_object('ok', false, 'error', 'Only the ads stage can send an article back from here.');
  end if;
  perform 1 from hub_articles where id = t.article_id for update;
  select * into t from hub_tasks where id = p_task_id for update;
  if t.assignee is distinct from auth.uid() and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'That work is not assigned to you.');
  end if;
  if t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'This article is live — nothing can be sent back.');
  end if;
  if p_stage is null or p_stage not in ('product', 'video', 'qc', 'social') then
    return jsonb_build_object('ok', false, 'error',
      'Pick the step to send back: product, video, quality check or social media.');
  end if;

  select * into v_last from hub_tasks
   where article_id = t.article_id and stage = p_stage
   order by created_at desc limit 1
   for update;
  select user_id, label into v_owner, v_label from hub_stage_owners where stage = p_stage;
  select full_name into v_person from app_users where id = coalesce(v_owner, v_last.assignee);

  if v_last.id is null then
    return jsonb_build_object('ok', false, 'error', hub_stage_name(p_stage) || ' has not started on this article.');
  end if;
  if v_last.status = 'open'
     or exists (select 1 from hub_tasks x
                 where x.article_id = t.article_id and x.stage = p_stage and x.status = 'open') then
    return jsonb_build_object('ok', false, 'error',
      'Already back with ' || coalesce(v_person, 'them') || ' — wait for the fix.');
  end if;
  if v_last.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'error', hub_stage_name(p_stage) || ' is not finished yet.');
  end if;
  if v_owner is null then
    return jsonb_build_object('ok', false, 'error',
      'Nobody owns the ' || hub_stage_name(p_stage) || ' step — set an owner first.');
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  select full_name into v_actor from app_users where id = auth.uid();
  select code into v_code from hub_articles where id = t.article_id;
  v_says := 'Sent back by ' || coalesce(v_actor, 'the ads stage') || coalesce(': ' || v_note, ' (no note)');

  insert into hub_tasks (article_id, stage, title, detail, assignee, attempt,
                         returned_note, sent_back_by, sent_back_note)
  values (t.article_id, p_stage, v_label, v_says, v_owner, coalesce(v_last.attempt, 1) + 1,
          v_says, auth.uid(), v_note)
  returning id into v_new;

  insert into hub_article_events (article_id, task_id, kind, detail)
  values (t.article_id, v_new, 'opened', v_label);
  insert into hub_article_events (article_id, task_id, kind, detail)
  values (t.article_id, v_new, 'sent_back',
          hub_stage_name(p_stage) || ' → ' || coalesce(v_person, 'nobody')
          || coalesce(' · ' || v_note, ' · no note'));

  perform hub_notify(v_owner, 'returned', v_code || ' — sent back to you',
    coalesce(v_actor, 'The ads stage') || coalesce(': ' || v_note, ' sent it back without a note.'),
    t.article_id, v_new);

  perform hub_notify(a.created_by, 'returned',
      v_code || ' sent back to ' || coalesce(v_person, 'nobody'),
      coalesce(v_actor, 'The ads stage') || ' · ' || hub_stage_name(p_stage) || coalesce(' · ' || v_note, ''),
      t.article_id, v_new)
    from hub_articles a
   where a.id = t.article_id and a.created_by is distinct from auth.uid();

  return jsonb_build_object('ok', true, 'new_task', v_new, 'person', v_person, 'stage', p_stage);
end;
$$;

/* hub_my_checkpoints — back to ads-only (H286) */
create or replace function hub_my_checkpoints()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id', t.article_id,
           'task_id',    t.id,
           'waiting_for',
             (select coalesce(jsonb_agg(w order by so), '[]'::jsonb)
                from (select distinct so, w from (
                        select s.sort_order as so,
                               coalesce(u.full_name, 'nobody') || ' (' || hub_stage_name(s.stage) || ')' as w
                          from hub_stage_owners s
                          left join lateral (select x.status, x.assignee from hub_tasks x
                                              where x.article_id = t.article_id and x.stage = s.stage
                                              order by x.created_at desc limit 1) lt on true
                          left join app_users u on u.id = coalesce(lt.assignee, s.user_id)
                         where s.stage <> 'ads'
                           and lt.status is distinct from 'submitted'
                        union all
                        select coalesce(s2.sort_order, 100),
                               coalesce(u2.full_name, 'nobody') || ' (' || hub_stage_name(x2.stage) || ')'
                          from hub_tasks x2
                          left join hub_stage_owners s2 on s2.stage = x2.stage
                          left join app_users u2 on u2.id = x2.assignee
                         where x2.article_id = t.article_id
                           and x2.id <> t.id
                           and x2.status = 'open') q) q2),
           'steps',
             (select coalesce(jsonb_agg(jsonb_build_object(
                       'stage',          s.stage,
                       'name',           hub_stage_name(s.stage),
                       'person',         u.full_name,
                       'status',         lt.status,
                       'attempt',        lt.attempt,
                       'opened_at',      lt.opened_at,
                       'submitted_at',   lt.submitted_at,
                       'sent_back_by',   (select b.full_name from app_users b where b.id = lt.sent_back_by),
                       'sent_back_note', lt.sent_back_note,
                       'can_send_back',  coalesce(lt.status = 'submitted', false)
                     ) order by s.sort_order), '[]'::jsonb)
                from hub_stage_owners s
                left join lateral (select x.* from hub_tasks x
                                    where x.article_id = t.article_id and x.stage = s.stage
                                    order by x.created_at desc limit 1) lt on true
                left join app_users u on u.id = coalesce(lt.assignee, s.user_id)
               where s.stage <> 'ads')
         ) order by t.opened_at desc), '[]'::jsonb)
    from hub_tasks t
   where t.assignee = auth.uid()
     and t.stage = 'ads'
     and t.status = 'open'
     and t.article_id is not null;
$$;
