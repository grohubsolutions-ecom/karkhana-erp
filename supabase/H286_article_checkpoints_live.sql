/* ===========================================================================
   H286 — HUB ARTICLES: CHECKPOINTS AND THE LIVE BUTTON          (2 Oct 2026)

   The owner, 2 Oct: Qaswar (ads, the campaign manager, the last man in the
   chain) gets a checkpoint for every earlier person — he can send the article
   back to Product, Video, QC or Social with an optional note — and his Submit
   becomes LIVE, with an optional final comment. Live means the article is
   finished and closed for good.
     Example: the video was one clip; it should have been two combined. Qaswar
     sends Video back to Hamza Khan with that note, Hamza Khan fixes it, the
     article comes straight back to Qaswar, he presses Live.

   Decisions (owner, 2 Oct):
     D1  after a fix the article comes straight back to Qaswar
     D2  Live opens only when product, video, QC and social are all done;
         only an administrator can undo a Live (the existing Undo,
         hub_task_reopen, which already reopens a completed article)
     D4  ads and social keep opening together, as today

   WHAT CHANGES
     hub_tasks.sent_back_by / sent_back_note  who sent this task back + the note
     hub_stage_name(stage)                    'qc' -> 'Quality check', for messages
     hub_task_checkpoint(task, stage, note)   NEW — send a finished step back
     hub_task_go_live(task, note, done_on)    NEW — the Live button
     hub_my_checkpoints()                     NEW — Qaswar's checkpoint rows
     hub_task_submit   the ads stage follows the Live rule (old screens and the
                       administration's "mark done" land there too); a QC
                       resubmission no longer reopens social; whoever sent a
                       step back is told when the fix is in
     hub_task_reopen   (h286b) only the latest attempt of a step can be undone;
                       undoing any other step after Live undoes the Live too
     hub_my_articles   the team's notes include send-backs and Live
     hub_article_detail  stage rows show who sent a step back, and the note
     hub_tasks_one_open_per_stage  (h286b) one open task per step per article
   QC's own send-back to Product (hub_task_send_back) is unchanged; Awais
   still has none. This reverses, for Qaswar only, the earlier rule that the
   ads stage could not send an article back.

   h286b (same day, after an independent review of h286): every function that
   moves an article's tasks takes the article row first (one queue, no
   deadlocks); a task with no assignee can no longer slip past the permission
   check (NULL <> uid is NULL); Live also waits for any older attempt still
   open; a video fix tells whoever still has ads or social open; the final
   comment reaches the administration.

   ALREADY APPLIED on the live database (migrations h286_article_checkpoints_live
   and h286b_checkpoints_hardening, 2 Oct 2026; every function checked against
   this file). Nothing is dropped. Hub tables only. Safe to run again. Do not
   run older SQL files after this one: they write older versions of
   hub_task_submit / hub_task_reopen / hub_my_articles / hub_article_detail back.
   Rollback: H286_rollback.sql puts back hub_task_submit, hub_task_reopen,
   hub_my_articles and hub_article_detail exactly as they were before this file.
=========================================================================== */

/* 1. who sent a task back, and what they said ------------------------------ */
alter table hub_tasks add column if not exists sent_back_by uuid references app_users(id);
alter table hub_tasks add column if not exists sent_back_note text;

/* 2. one name per stage for messages ----------------------------------------- */
create or replace function hub_stage_name(p_stage text)
returns text language sql immutable set search_path to 'public' as $$
  select case p_stage
           when 'product' then 'Product'
           when 'video'   then 'Video'
           when 'qc'      then 'Quality check'
           when 'social'  then 'Social media'
           when 'ads'     then 'Ads'
           else coalesce(p_stage, 'Task')
         end;
$$;

/* 3. CHECKPOINT — send a finished step back ----------------------------------
   Only from an OPEN ads task (before Live), only by Qaswar or the
   administration, only to a step whose latest task is submitted. The step
   reopens for its owner as the next attempt with the note on top; Qaswar's
   ads task stays open and Live waits until the fix is submitted. */
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
  /* One article, one queue: every function that moves an article's tasks
     takes the article row first, so two presses — or Qaswar and the
     administration at once — wait in line instead of in a circle. The task
     is read again after the lock, as it is now. */
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

  /* Opened here rather than through hub_open_stage so the person is told
     "sent back to you" with the note, not "new work". Same columns and the
     same 'opened' history line as hub_open_stage writes. The detail starts
     "Sent back by" — the convention the work panel already reads. */
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

/* 4. LIVE — the ads stage's only way to finish --------------------------------
   Optional final comment. Refused while any other step is not done — the
   latest task of every other stage must be submitted, and no other task on
   the article may still be open (an older attempt left open by an
   out-of-date page counts too) (D2). Closes the article for everyone through
   hub_check_complete. Undo: the administration's Undo on the Ads row
   (hub_task_reopen). */
create or replace function hub_task_go_live(p_task_id uuid, p_note text default null,
                                            p_done_on timestamptz default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_wait text; v_note text; v_when timestamptz; v_on_behalf boolean;
  v_actor text; v_person text; v_code text; v_held text; r record;
begin
  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then
    return jsonb_build_object('ok', false, 'error', 'That task no longer exists.');
  end if;
  if t.stage is distinct from 'ads' or t.article_id is null then
    return jsonb_build_object('ok', false, 'error', 'Only the ads stage has a Live button.');
  end if;
  perform 1 from hub_articles where id = t.article_id for update;   -- one queue per article
  select * into t from hub_tasks where id = p_task_id for update;
  if t.assignee is distinct from auth.uid() and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'That work is not assigned to you.');
  end if;
  if t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'This article is already live.');
  end if;
  if p_done_on is not null and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'Only an administrator can set the date.');
  end if;
  if p_done_on is not null and p_done_on > now() then
    return jsonb_build_object('ok', false, 'error', 'That date has not happened yet.');
  end if;

  select string_agg(w, ', ' order by so)
    into v_wait
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
               and x2.status = 'open') q) q2;
  if v_wait is not null then
    return jsonb_build_object('ok', false, 'error',
      'Live opens when everyone else is done. Waiting for ' || v_wait || '.');
  end if;

  v_note      := nullif(btrim(coalesce(p_note, '')), '');
  v_when      := coalesce(p_done_on, now());
  v_on_behalf := (t.assignee is distinct from auth.uid());
  select full_name into v_actor  from app_users where id = auth.uid();
  select full_name into v_person from app_users where id = t.assignee;
  select code into v_code from hub_articles where id = t.article_id;
  v_held := hub_fmt_interval(greatest(v_when - t.opened_at, interval '0'));

  update hub_tasks
     set status = 'submitted', submitted_at = v_when, submit_note = v_note, submitted_by = auth.uid()
   where id = t.id;

  insert into hub_article_events (article_id, task_id, kind, detail)
  values (t.article_id, t.id, 'live',
          case when v_on_behalf then 'recorded by ' || v_actor || ' for ' || v_person
               else 'held ' || v_held end
          || case when p_done_on is not null then ' · done ' || to_char(v_when, 'DD Mon YYYY') else '' end
          || coalesce(' · ' || v_note, ''));

  /* everyone who worked on it hears it went live */
  for r in select distinct lt.assignee
             from hub_stage_owners s
             join lateral (select x.assignee from hub_tasks x
                            where x.article_id = t.article_id and x.stage = s.stage
                            order by x.created_at desc limit 1) lt on true
            where s.stage <> 'ads'
              and lt.assignee is distinct from auth.uid()
  loop
    perform hub_notify(r.assignee, 'completed', v_code || ' is live',
      coalesce(v_person, 'Ads') || ' went live' || coalesce(': ' || v_note, '.'), t.article_id, t.id);
  end loop;
  if v_on_behalf then
    perform hub_notify(t.assignee, 'completed', v_code || ' — marked live for you',
      v_actor || ' recorded it' || coalesce(': ' || v_note, '.'), t.article_id, t.id);
  end if;
  /* h286b: the administration hears "Completed" from hub_check_complete; a
     final comment is the one thing that note does not carry, so it is sent
     on its own — only when there is one, so there is no double ping. */
  if v_note is not null then
    perform hub_notify(a.created_by, 'completed', v_code || ' is live',
        coalesce(v_person, 'Ads') || ': ' || v_note, t.article_id, t.id)
      from hub_articles a
     where a.id = t.article_id and a.created_by is distinct from auth.uid();
  end if;

  return jsonb_build_object('ok', true,
    'completed_article', hub_check_complete(t.article_id), 'on_behalf', v_on_behalf);
end;
$$;

/* 5. Qaswar's checkpoint rows, one call for all his open ads cards ----------- */
create or replace function hub_my_checkpoints()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id', t.article_id,
           'task_id',    t.id,
           /* the same rule Live checks: every other step's latest task done,
              and nothing else on the article still open */
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

/* 6. SUBMIT — same inputs and outputs as before; the changes are marked H286 -- */
create or replace function hub_task_submit(p_task_id uuid, p_note text, p_done_on timestamptz default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_code text; v_held text; v_when timestamptz;
  v_on_behalf boolean; v_actor text; v_person text; r record; v_qc hub_tasks;
begin
  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'That task no longer exists.'); end if;

  /* H286: the ads stage has no plain Submit any more — finishing it IS Live,
     with Live's rule (everyone else done, comment optional). Old screens
     that still call this, and the administration's "mark done for", land
     in the same place. */
  if t.stage = 'ads' and t.article_id is not null then
    return hub_task_go_live(p_task_id, p_note, p_done_on);
  end if;

  /* H286: one queue per article (the article row first, then this task), so
     the person's Submit and the administration's "Record it" cannot both
     run the chain, and nothing waits on anything in a circle. */
  if t.article_id is not null then
    perform 1 from hub_articles where id = t.article_id for update;
  end if;
  select * into t from hub_tasks where id = p_task_id for update;

  if t.assignee is distinct from auth.uid() and not hub_is_boss() then
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
  v_on_behalf := (t.assignee is distinct from auth.uid());
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
      /* H286: once, never twice — the same guard the product branch has.
         Without it a QC fix sent back from the ads card (or a resubmission
         after an undo) opened a fresh social task for work already done. */
      if not exists (select 1 from hub_tasks x where x.article_id = t.article_id and x.stage = 'ads') then
        perform hub_open_stage(t.article_id, 'ads');
      end if;
      if not exists (select 1 from hub_tasks x where x.article_id = t.article_id and x.stage = 'social') then
        perform hub_open_stage(t.article_id, 'social');
      end if;
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
    if t.sent_back_by is null then
      for r in select s.user_id from hub_stage_owners s where s.stage in ('ads','social')
      loop
        perform hub_notify(r.user_id, 'assigned',
          v_code || ' — the video is ready', btrim(p_note), t.article_id, null);
      end loop;
    else
      /* H286: a fix sent back through a checkpoint. Whoever sent it hears
         "fixed" below; anyone else who still has ads or social open hears
         the new video is ready. */
      for r in select distinct t2.assignee from hub_tasks t2
                where t2.article_id = t.article_id and t2.stage in ('ads','social') and t2.status = 'open'
                  and t2.assignee is distinct from t.sent_back_by
      loop
        perform hub_notify(r.assignee, 'assigned',
          v_code || ' — the video is ready', btrim(p_note), t.article_id, null);
      end loop;
    end if;
  end if;

  /* H286: a step that came back through a checkpoint — tell whoever sent it
     back that the fix is in. */
  if t.sent_back_by is not null and t.sent_back_by is distinct from auth.uid() then
    perform hub_notify(t.sent_back_by, 'submitted',
      v_code || ' — ' || coalesce(v_person, 'the fix') || ' fixed ' || hub_stage_name(t.stage),
      btrim(p_note), t.article_id, t.id);
  end if;

  return jsonb_build_object('ok', true,
    'completed_article', hub_check_complete(t.article_id), 'on_behalf', v_on_behalf);
end;
$$;

/* 7. UNDO (the administration) — same inputs and outputs; h286b changes ------
   Only the latest attempt of a step can be undone, and undoing any other
   step after Live undoes the Live too: Live is the only way an article
   finishes, so a fix must come back past the ads stage again. */
create or replace function hub_task_reopen(p_task_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_code text; v_actor text; v_person text;
  v_why text; v_was_complete boolean := false; v_ads hub_tasks; v_ads_person text;
begin
  if not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'Only an administrator can undo a submission.');
  end if;

  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then
    return jsonb_build_object('ok', false, 'error', 'That task no longer exists.');
  end if;
  /* H286: the same queue as submit, checkpoint and Live — the article row
     first, then the task, read again as it is now. */
  if t.article_id is not null then
    perform 1 from hub_articles where id = t.article_id for update;
  end if;
  select * into t from hub_tasks where id = p_task_id for update;
  if t.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'error', 'That work is not submitted, so there is nothing to undo.');
  end if;
  /* H286: an older attempt reopened beside a newer one would leave two
     copies of the same work open — the page it was pressed on was out of
     date. */
  if t.article_id is not null and exists (
       select 1 from hub_tasks y
        where y.article_id = t.article_id and y.stage = t.stage and y.created_at > t.created_at) then
    return jsonb_build_object('ok', false, 'error',
      'A newer attempt of this step exists — reload the page and undo that one.');
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

    /* H286: Live undone with it. */
    if t.stage is distinct from 'ads' then
      select * into v_ads from hub_tasks y
       where y.article_id = t.article_id and y.stage = 'ads'
       order by y.created_at desc limit 1
       for update;
      if v_ads.id is not null and v_ads.status = 'submitted' then
        update hub_tasks
           set status = 'open', submitted_at = null, submit_note = null, submitted_by = null,
               returned_note = 'Live undone: ' || hub_stage_name(t.stage) || ' was reopened by '
                               || coalesce(v_actor, 'the administration') || ' — ' || v_why
         where id = v_ads.id;
        select full_name into v_ads_person from app_users where id = v_ads.assignee;
        insert into hub_article_events (article_id, task_id, kind, detail)
        values (t.article_id, v_ads.id, 'reopened',
                'ads · Live undone because ' || hub_stage_name(t.stage) || ' was reopened · back with '
                || coalesce(v_ads_person, 'nobody'));
        perform hub_notify(v_ads.assignee, 'returned', v_code || ' — Live undone',
          coalesce(v_actor, 'The administration') || ' reopened ' || hub_stage_name(t.stage) || ': ' || v_why
          || '. Press Live again once it is fixed.', t.article_id, v_ads.id);
      end if;
    end if;
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

/* 8. what the team wrote — now with send-backs from the ads card and Live ---- */
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
                          from (
                                /* done notes; the ads stage's is its Live (H286: shown
                                   even with no final comment) */
                                select t.id as task_id, t.submitted_at as at,
                                       jsonb_build_object(
                                         'task_id', t.id, 'stage', t.stage, 'title', t.title,
                                         'by', coalesce(u.full_name, 'Someone'),
                                         'mine', t.assignee = auth.uid(),
                                         'at', t.submitted_at,
                                         'kind', case when t.stage = 'ads' then 'live' else 'done' end,
                                         'note', coalesce(btrim(t.submit_note), ''),
                                         'recorded_by', case when t.submitted_by is not null and t.submitted_by <> t.assignee
                                                             then (select b.full_name from app_users b where b.id = t.submitted_by) end) as j
                                  from hub_tasks t
                                  left join app_users u on u.id = t.assignee
                                 where t.article_id = a.id
                                   and t.submitted_at is not null
                                   and (nullif(btrim(coalesce(t.submit_note, '')), '') is not null or t.stage = 'ads')
                                union all
                                /* the quality check sending product back */
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
                                   and nullif(btrim(coalesce(t.returned_note, '')), '') is not null
                                union all
                                /* H286: a checkpoint from the ads card — by = who sent it,
                                   to = who it went back to */
                                select t.id, t.opened_at,
                                       jsonb_build_object(
                                         'task_id', t.id, 'stage', t.stage, 'title', t.title,
                                         'by', coalesce(b.full_name, 'Someone'),
                                         'to', coalesce(u.full_name, 'Someone'),
                                         'mine', t.sent_back_by = auth.uid(),
                                         'at', t.opened_at, 'kind', 'checkpoint',
                                         'note', coalesce(t.sent_back_note, ''), 'recorded_by', null)
                                  from hub_tasks t
                                  left join app_users u on u.id = t.assignee
                                  left join app_users b on b.id = t.sent_back_by
                                 where t.article_id = a.id
                                   and t.sent_back_by is not null) c)
         ) order by a.code), '[]'::jsonb)
    from mine m
    join hub_articles a on a.id = m.article_id;
$$;

/* 9. the article page — stage rows carry who sent a step back --------------- */
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
                   'held', hub_fmt_interval(greatest(coalesce(lt.submitted_at, now()) - lt.opened_at, interval '0')),
                   /* H286 */
                   'sent_back_by_name', (select full_name from app_users c where c.id = lt.sent_back_by),
                   'sent_back_note', lt.sent_back_note
                 ) order by s.sort_order), '[]'::jsonb)
                 from hub_stage_owners s
                 left join lateral (select * from hub_tasks t where t.article_id=p_article_id and t.stage=s.stage
                                     order by t.created_at desc limit 1) lt on true
                 left join app_users u on u.id = coalesce(lt.assignee, s.user_id)),
    /* H286: e.id breaks ties — a checkpoint writes "opened" and "sent back"
       in the same instant, and they must read in the order they happened */
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                   'kind', e.kind, 'detail', e.detail, 'at', e.at,
                   'actor', (select full_name from app_users u where u.id = e.actor)
                 ) order by e.at, e.id), '[]'::jsonb)
                 from hub_article_events e where e.article_id = p_article_id),
    'ads', (select coalesce(jsonb_agg(to_jsonb(x) order by x.spent_on desc), '[]'::jsonb)
              from hub_ads_expenses x where x.article_id = p_article_id)
  )
  where has_permission('hub.articles.view') or has_permission('hub.articles.manage');
$$;


/* 10. one open task per step per article (h286b) ---------------------------
   The last guard against two copies of the same work — two presses racing,
   an out-of-date page. 0 such pairs on 2 Oct, so it applies cleanly; an
   attempt to open a second copy now fails instead of slipping in. */
create unique index if not exists hub_tasks_one_open_per_stage
  on hub_tasks (article_id, stage) where status = 'open' and article_id is not null;

/* 11. who may call what -------------------------------------------------------
   The replaced functions keep their grants (CREATE OR REPLACE does not touch
   them). The new ones are signed-in only; each checks the person inside. */
revoke all on function hub_stage_name(text) from public, anon;
revoke all on function hub_task_checkpoint(uuid, text, text) from public, anon;
revoke all on function hub_task_go_live(uuid, text, timestamptz) from public, anon;
revoke all on function hub_my_checkpoints() from public, anon;
grant execute on function hub_stage_name(text) to authenticated, service_role;
grant execute on function hub_task_checkpoint(uuid, text, text) to authenticated, service_role;
grant execute on function hub_task_go_live(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function hub_my_checkpoints() to authenticated, service_role;
