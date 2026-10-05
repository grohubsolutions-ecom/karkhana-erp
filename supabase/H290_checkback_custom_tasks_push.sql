/* ===========================================================================
   H290 — CHECK-BACK FOR EVERYONE, CUSTOM TASKS, AND MOBILE PUSH (groundwork)
                                                                 (5 Oct 2026)

   The owner, 5 Oct:
     1. The checkpoint ("send a finished step back") that Qaswar has — give it
        to Hamza Mukhtar (product), Hamza Khan (video) and Awais (social) too.
     2. A "Custom task" button in Qaswar's work: pick any employee, write an
        article name, an inventory code, a name, the details and a deadline,
        and it is sent straight to that person.
     3. The bell should ring the phone too (the push pieces that live in the
        database; the rest is in the zip and needs a deploy — see the README).

   WHAT CHANGES (nothing is dropped; every function keeps its signature)
     hub_task_checkpoint   product / video / social can send back too, not only
                           ads; the step you are on is never a target of itself
     hub_my_checkpoints    returns the checkpoint rows for a product / video /
                           social / ads card (it was ads only)
     hub_tasks             + custom_article, inventory_code, due_date (a custom
                           task carries these; every other task leaves them null)
     hub_create_custom_task   NEW — the Custom task form
     hub_custom_task_people   NEW — the employee dropdown for that form
     hub_push_subscriptions   NEW table — one row per phone/browser signed up
     hub_push_subscribe / hub_push_unsubscribe   NEW — save / drop a phone

   QC keeps its own existing send-back to product (hub_task_send_back) — it is
   untouched, so the four checkpoint stages are product, video, social and ads.

   Hub tables only. Safe to run again.
   ALREADY APPLIED on the live database, 5 Oct 2026 (migrations
   h290a_checkback_everyone, h290b_custom_tasks, h290c_push_subscriptions;
   split because the connector times out on one large payload). md5 checked.
   Rollback: H290_rollback.sql.
=========================================================================== */

/* 1. CHECK-BACK FOR PRODUCT / VIDEO / SOCIAL / ADS --------------------------
   The same function Qaswar used, opened to the other stages. The only change
   from H286 is the guard: any of the four may call it, and nobody can send
   their own step back to themselves. Everything after is identical. */
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
  /* H290: product, video, social and ads can all send a finished step back.
     QC has its own send-back to product and is not one of these. */
  if t.stage is null or t.stage not in ('product', 'video', 'social', 'ads') or t.article_id is null then
    return jsonb_build_object('ok', false, 'error', 'This step cannot send an article back.');
  end if;
  /* One article, one queue: take the article row first so two presses wait in
     line, then re-read the task under the lock. */
  perform 1 from hub_articles where id = t.article_id for update;
  select * into t from hub_tasks where id = p_task_id for update;
  if t.assignee is distinct from auth.uid() and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'That work is not assigned to you.');
  end if;
  if t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'This step is finished — you can no longer send anything back from it.');
  end if;
  if p_stage is null or p_stage not in ('product', 'video', 'qc', 'social') then
    return jsonb_build_object('ok', false, 'error',
      'Pick the step to send back: product, video, quality check or social media.');
  end if;
  /* H290: you cannot send your own step back to yourself. */
  if p_stage = t.stage then
    return jsonb_build_object('ok', false, 'error', 'That is your own step.');
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
  /* H290: the sender's own name, whichever stage they are on. */
  v_says := 'Sent back by ' || coalesce(v_actor, 'a teammate') || coalesce(': ' || v_note, ' (no note)');

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
    coalesce(v_actor, 'A teammate') || coalesce(': ' || v_note, ' sent it back without a note.'),
    t.article_id, v_new);

  perform hub_notify(a.created_by, 'returned',
      v_code || ' sent back to ' || coalesce(v_person, 'nobody'),
      coalesce(v_actor, 'A teammate') || ' · ' || hub_stage_name(p_stage) || coalesce(' · ' || v_note, ''),
      t.article_id, v_new)
    from hub_articles a
   where a.id = t.article_id and a.created_by is distinct from auth.uid();

  return jsonb_build_object('ok', true, 'new_task', v_new, 'person', v_person, 'stage', p_stage);
end;
$$;

/* 2. THE CHECKPOINT ROWS — for every stage that can send back ---------------
   H286 returned these for the ads card only. Now a product, video or social
   card gets them too, each listing the OTHER content steps (never its own).
   Only the ads card uses waiting_for (for Live); the rest get an empty list. */
create or replace function hub_my_checkpoints()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id', t.article_id,
           'task_id',    t.id,
           'waiting_for',
             case when t.stage <> 'ads' then '[]'::jsonb else
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
                           and x2.status = 'open') q) q2) end,
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
               /* the content steps, never the caller's own, never ads */
               where s.stage in ('product', 'video', 'qc', 'social')
                 and s.stage <> t.stage)
         ) order by t.opened_at desc), '[]'::jsonb)
    from hub_tasks t
   where t.assignee = auth.uid()
     and t.stage in ('product', 'video', 'social', 'ads')
     and t.status = 'open'
     and t.article_id is not null;
$$;

/* 3. CUSTOM TASKS -----------------------------------------------------------
   A plain task (no article) carrying the extra things the owner listed. The
   columns are additive; every existing task leaves them null. */
alter table hub_tasks add column if not exists custom_article text;
alter table hub_tasks add column if not exists inventory_code text;
alter table hub_tasks add column if not exists due_date date;

/* Who may create one: the ads stage owner (Qaswar) or an administrator. */
create or replace function hub_can_make_custom_task()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select hub_is_boss()
      or auth.uid() = (select user_id from hub_stage_owners where stage = 'ads');
$$;

/* The dropdown: every Hub person with a login, except the caller. Available to
   whoever may make a custom task, so Qaswar can see it without the manage
   right that hub_people needs. */
create or replace function hub_custom_task_people()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when not hub_can_make_custom_task() then '[]'::jsonb
  else coalesce((select jsonb_agg(jsonb_build_object(
           'id', e.user_id, 'name', e.name, 'designation', e.designation) order by e.name)
         from online_att_employees e
        where e.department_id = (select id from departments where code = 'HUB')
          and e.user_id is not null
          and e.user_id <> auth.uid()), '[]'::jsonb) end;
$$;

create or replace function hub_create_custom_task(
  p_assignee uuid, p_article_name text, p_inventory_code text,
  p_name text, p_details text, p_deadline date default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_task uuid; v_title text; v_detail text; v_who text; v_me text;
  v_article text := nullif(btrim(coalesce(p_article_name, '')), '');
  v_inv     text := nullif(btrim(coalesce(p_inventory_code, '')), '');
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
begin
  if not hub_can_make_custom_task() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to send a task.');
  end if;
  if p_assignee is null then
    return jsonb_build_object('ok', false, 'error', 'Pick the person to send it to.');
  end if;
  if p_assignee = auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'You cannot send a task to yourself.');
  end if;
  if not exists (select 1 from online_att_employees e
                  where e.user_id = p_assignee
                    and e.department_id = (select id from departments where code = 'HUB')) then
    return jsonb_build_object('ok', false, 'error', 'That person is not in the Hub.');
  end if;
  if v_details is null then
    return jsonb_build_object('ok', false, 'error', 'Write the required data — what has to be done.');
  end if;
  if p_deadline is not null and p_deadline < (now() at time zone 'Asia/Karachi')::date then
    return jsonb_build_object('ok', false, 'error', 'That deadline has already passed.');
  end if;

  select full_name into v_who from app_users where id = p_assignee;
  select full_name into v_me  from app_users where id = auth.uid();
  v_title := coalesce(nullif(btrim(p_name), ''), v_article, 'Task from ' || coalesce(v_me, 'the office'));

  /* The detail the person reads, built without literal newlines in this file
     (CRLF-safe). The columns above hold the same facts for the record. */
  v_detail := concat_ws(E'\n',
    case when v_article is not null then 'Article: ' || v_article end,
    case when v_inv     is not null then 'Inventory code: ' || v_inv end,
    case when p_deadline is not null then 'Deadline: ' || to_char(p_deadline, 'DD Mon YYYY') end,
    '', v_details);

  insert into hub_tasks (title, detail, assignee, created_by, custom_article, inventory_code, due_date)
  values (v_title, v_detail, p_assignee, auth.uid(), v_article, v_inv, p_deadline)
  returning id into v_task;

  perform hub_notify(p_assignee, 'assigned',
    coalesce(v_me, 'The office') || ' sent you a task' || coalesce(' — ' || v_article, ''),
    coalesce(nullif(btrim(p_name), '') || ' · ', '') || v_details
      || coalesce(E'\nDeadline: ' || to_char(p_deadline, 'DD Mon'), ''),
    null, v_task);

  return jsonb_build_object('ok', true, 'id', v_task, 'person', v_who);
end;
$$;

/* 4. MOBILE PUSH — the part that lives in the database -----------------------
   One row per phone/browser a person has signed up. The sending itself is an
   edge function (send-push) plus the trigger in H290_push_trigger.sql, run
   after that function is deployed and its VAPID keys are set. See the README. */
create table if not exists hub_push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists hub_push_subscriptions_user on hub_push_subscriptions (user_id);

alter table hub_push_subscriptions enable row level security;
revoke all on table hub_push_subscriptions from anon;
revoke insert, update, delete, truncate, references, trigger on table hub_push_subscriptions from authenticated;
grant select on table hub_push_subscriptions to authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                  and tablename='hub_push_subscriptions' and policyname='hub_push_own') then
    create policy hub_push_own on hub_push_subscriptions for select
      using (user_id = (select auth.uid()));
  end if;
end $$;

create or replace function hub_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in first.');
  end if;
  if coalesce(btrim(p_endpoint), '') = '' or coalesce(btrim(p_p256dh), '') = '' or coalesce(btrim(p_auth), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'The subscription is incomplete.');
  end if;
  insert into hub_push_subscriptions (user_id, endpoint, p256dh, auth, ua)
  values (auth.uid(), btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth), p_ua)
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh,
         auth = excluded.auth, ua = excluded.ua, last_seen = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function hub_push_unsubscribe(p_endpoint text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  delete from hub_push_subscriptions
   where endpoint = btrim(p_endpoint) and user_id = auth.uid();
  return jsonb_build_object('ok', true);
end;
$$;

/* 5. who may call what -------------------------------------------------------- */
revoke all on function hub_can_make_custom_task() from public, anon;
revoke all on function hub_custom_task_people() from public, anon;
revoke all on function hub_create_custom_task(uuid, text, text, text, text, date) from public, anon;
revoke all on function hub_push_subscribe(text, text, text, text) from public, anon;
revoke all on function hub_push_unsubscribe(text) from public, anon;
grant execute on function hub_can_make_custom_task() to authenticated, service_role;
grant execute on function hub_custom_task_people() to authenticated, service_role;
grant execute on function hub_create_custom_task(uuid, text, text, text, text, date) to authenticated, service_role;
grant execute on function hub_push_subscribe(text, text, text, text) to authenticated, service_role;
grant execute on function hub_push_unsubscribe(text) to authenticated, service_role;
