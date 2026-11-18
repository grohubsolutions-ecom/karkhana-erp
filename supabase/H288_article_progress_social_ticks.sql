/* ===========================================================================
   H288 — HUB ARTICLES: PROGRESS ON EVERY CARD + SOCIAL POSTING TICKS
                                                                 (5 Oct 2026)

   The owner, 5 Oct:
     1. Every employee's article card gets a space at the bottom that confirms
        which steps of the article are finished and what comes next.
     2. Awais's social card gets three ticks — Instagram, Facebook, TikTok.
        Ticked or unticked, nothing more: the tick is his signature that the
        post is up on that platform. Qaswar sees the ticks on his ads card.

   WHAT CHANGES (create-only — no existing function or table is touched)
     hub_article_posts                 NEW table: one row per platform posted,
                                       with who ticked it and when
     hub_article_post_set(task, platform, posted)
                                       NEW — tick / untick. Awais (whoever holds
                                       the latest social task) or the
                                       administration; until the article goes
                                       Live, then the ticks are closed for good
     hub_article_social_posts(article) NEW — the ticks of one article, for
                                       anyone working on it or the
                                       administration
     hub_my_progress()                 NEW — for every article the caller works
                                       on: the five steps (who, where, when),
                                       whether it is Live, and the ticks

   WHY TICKING STAYS OPEN AFTER AWAIS SUBMITS: a post is often scheduled — the
   TikTok one goes up tomorrow. Making Qaswar send the whole step back just to
   record a tick would put a false "attempt 2" on Awais's record. Once the
   article is Live nothing can change.

   Every tick and untick is also written to the article's history
   (hub_article_events: 'posted' / 'unposted', with who), so a tick taken off
   later is still on the record.

   Hub tables only. Nothing existing is changed or removed. Safe to run again.
   ALREADY APPLIED on the live database (migration
   h288_article_progress_social_ticks, 5 Oct 2026; checked against this file).
   Rollback: H288_rollback.sql (SQL editor, after the previous screens are back).
=========================================================================== */

/* 1. the ticks ---------------------------------------------------------------- */
create table if not exists hub_article_posts (
  article_id uuid        not null references hub_articles(id) on delete cascade,
  platform   text        not null check (platform in ('instagram', 'facebook', 'tiktok')),
  posted_at  timestamptz not null default now(),
  posted_by  uuid        references app_users(id),
  task_id    uuid        references hub_tasks(id) on delete set null,
  primary key (article_id, platform)
);

/* Read through the functions below. The table itself: the administration may
   read it (same rule as hub_tasks / hub_articles); nobody writes it except
   hub_article_post_set. New tables are granted to anon and authenticated by
   default here, so that is taken back explicitly. */
alter table hub_article_posts enable row level security;
revoke all on table hub_article_posts from anon;
revoke insert, update, delete, truncate, references, trigger on table hub_article_posts from authenticated;
grant select on table hub_article_posts to authenticated;
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'hub_article_posts'
                    and policyname = 'hub_article_posts_read') then
    create policy hub_article_posts_read on hub_article_posts for select
      using ((select has_permission('hub.articles.view')) or (select has_permission('hub.articles.manage')));
  end if;
end $$;

/* 2. the ticks of one article: {"instagram": {"at": …, "by": "Awais"}, …} ----
   Shown to the administration and to anyone with a task on the article;
   everyone else gets {}. */
create or replace function hub_article_social_posts(p_article_id uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(p.platform,
           jsonb_build_object('at', p.posted_at, 'by', u.full_name)), '{}'::jsonb)
    from hub_article_posts p
    left join app_users u on u.id = p.posted_by
   where p.article_id = p_article_id
     and (has_permission('hub.articles.view') or has_permission('hub.articles.manage')
          or exists (select 1 from hub_tasks t
                      where t.article_id = p_article_id and t.assignee = auth.uid()));
$$;

/* 3. tick / untick ------------------------------------------------------------ */
create or replace function hub_article_post_set(p_task_id uuid, p_platform text, p_posted boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t          hub_tasks;
  v_platform text := lower(btrim(coalesce(p_platform, '')));
  v_status   text;
  v_n        integer;
begin
  if v_platform not in ('instagram', 'facebook', 'tiktok') then
    return jsonb_build_object('ok', false, 'error', 'Pick Instagram, Facebook or TikTok.');
  end if;

  select * into t from hub_tasks where id = p_task_id;
  if t.id is null then
    return jsonb_build_object('ok', false, 'error', 'That task no longer exists.');
  end if;
  if t.stage is distinct from 'social' or t.article_id is null then
    return jsonb_build_object('ok', false, 'error', 'Only the social media step has these ticks.');
  end if;
  if t.assignee is distinct from auth.uid() and not hub_is_boss() then
    return jsonb_build_object('ok', false, 'error', 'That work is not assigned to you.');
  end if;

  /* the same queue as every other change to an article (H286) */
  select a.status into v_status from hub_articles a where a.id = t.article_id for update;
  if v_status = 'completed' then
    return jsonb_build_object('ok', false, 'error', 'This article is live — its ticks are closed.');
  end if;
  /* a page left open on an older attempt of the step */
  if exists (select 1 from hub_tasks y
              where y.article_id = t.article_id and y.stage = 'social' and y.created_at > t.created_at) then
    return jsonb_build_object('ok', false, 'error', 'A newer attempt of this step exists — reload the page.');
  end if;

  if coalesce(p_posted, false) then
    insert into hub_article_posts (article_id, platform, posted_by, task_id)
    values (t.article_id, v_platform, auth.uid(), t.id)
    on conflict (article_id, platform) do nothing;
  else
    delete from hub_article_posts where article_id = t.article_id and platform = v_platform;
  end if;
  get diagnostics v_n = row_count;

  /* pressing the same tick twice changes nothing and writes nothing */
  if v_n > 0 then
    insert into hub_article_events (article_id, task_id, kind, actor, detail)
    values (t.article_id, t.id,
            case when coalesce(p_posted, false) then 'posted' else 'unposted' end,
            auth.uid(),
            case v_platform when 'instagram' then 'Instagram' when 'facebook' then 'Facebook' else 'TikTok' end);
  end if;

  return jsonb_build_object('ok', true, 'changed', v_n > 0,
                            'posts', hub_article_social_posts(t.article_id));
end;
$$;

/* 4. where every article I work on stands -------------------------------------
   Same articles as hub_my_work / hub_my_articles: an open task, or one
   submitted in the last 30 days. Steps in the order the work flows —
   product, video, quality check, social media, ads (Live) — each with the
   person on the latest attempt (or the stage owner if it has not started). */
create or replace function hub_my_progress()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with mine as (
    select distinct t.article_id
      from hub_tasks t
     where t.assignee = auth.uid()
       and t.article_id is not null
       and (t.status = 'open' or t.submitted_at > now() - interval '30 days')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id',   a.id,
           'code',         a.code,
           'status',       a.status,
           'completed_at', a.completed_at,
           'live', case when a.status = 'completed' then
                     (select jsonb_build_object('at', x.submitted_at, 'by', u.full_name,
                                                'note', nullif(btrim(coalesce(x.submit_note, '')), ''))
                        from hub_tasks x
                        left join app_users u on u.id = x.assignee
                       where x.article_id = a.id and x.stage = 'ads'
                       order by x.created_at desc limit 1)
                   end,
           'steps', (select coalesce(jsonb_agg(jsonb_build_object(
                               'stage',        s.stage,
                               'person',       u.full_name,
                               'status',       lt.status,
                               'attempt',      lt.attempt,
                               'opened_at',    lt.opened_at,
                               'submitted_at', lt.submitted_at,
                               'sent_back_by', (select b.full_name from app_users b where b.id = lt.sent_back_by),
                               'mine',         coalesce(lt.assignee = auth.uid(), false)
                             ) order by case s.stage when 'product' then 1 when 'video' then 2 when 'qc' then 3
                                                     when 'social' then 4 when 'ads' then 5 else 9 end,
                                        s.sort_order), '[]'::jsonb)
                       from hub_stage_owners s
                       left join lateral (select x.* from hub_tasks x
                                           where x.article_id = a.id and x.stage = s.stage
                                           order by x.created_at desc limit 1) lt on true
                       left join app_users u on u.id = coalesce(lt.assignee, s.user_id)),
           'posts', hub_article_social_posts(a.id)
         ) order by a.code), '[]'::jsonb)
    from mine m
    join hub_articles a on a.id = m.article_id;
$$;

/* 5. who may call what ---------------------------------------------------------- */
revoke all on function hub_article_social_posts(uuid) from public, anon;
revoke all on function hub_article_post_set(uuid, text, boolean) from public, anon;
revoke all on function hub_my_progress() from public, anon;
grant execute on function hub_article_social_posts(uuid) to authenticated, service_role;
grant execute on function hub_article_post_set(uuid, text, boolean) to authenticated, service_role;
grant execute on function hub_my_progress() to authenticated, service_role;
