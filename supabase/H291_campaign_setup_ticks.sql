/* ===========================================================================
   H291 — CAMPAIGN SETUP TICKS, beside the posting ticks            (5 Oct 2026)

   The owner, 5 Oct: Awais gets a second set of per-account ticks — "Campaign
   setup" — on Instagram, Facebook and TikTok, exactly like the "Posted on"
   ticks, and Qaswar sees them too.

   Kept in its OWN table so the posting ticks (hub_article_posts, which already
   holds real rows) are not touched, and so nothing already live changes shape.
   The posted-tick functions are untouched; these are their twins for setup.

     hub_article_campaign_setup   NEW table (one row per account set up)
     hub_article_setup_set        NEW — tick / untick a setup account
     hub_article_setup_posts      NEW — read the setup ticks of an article
     hub_my_progress              + a `setup` map beside the existing `posts`

   Hub tables only. Nothing is dropped. Safe to run again.
   ALREADY APPLIED on the live database (migration h291_campaign_setup_ticks,
   5 Oct 2026). md5 checked. Rollback: H291_rollback.sql.
=========================================================================== */

create table if not exists hub_article_campaign_setup (
  article_id uuid        not null references hub_articles(id) on delete cascade,
  platform   text        not null check (platform in ('instagram', 'facebook', 'tiktok')),
  posted_at  timestamptz not null default now(),
  posted_by  uuid        references app_users(id),
  task_id    uuid        references hub_tasks(id) on delete set null,
  primary key (article_id, platform)
);

alter table hub_article_campaign_setup enable row level security;
revoke all on table hub_article_campaign_setup from anon;
revoke insert, update, delete, truncate, references, trigger on table hub_article_campaign_setup from authenticated;
grant select on table hub_article_campaign_setup to authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                  and tablename='hub_article_campaign_setup' and policyname='hub_setup_read') then
    create policy hub_setup_read on hub_article_campaign_setup for select
      using ((select has_permission('hub.articles.view')) or (select has_permission('hub.articles.manage')));
  end if;
end $$;

/* read the setup ticks: same access as the posting ticks */
create or replace function hub_article_setup_posts(p_article_id uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(p.platform,
           jsonb_build_object('at', p.posted_at, 'by', u.full_name)), '{}'::jsonb)
    from hub_article_campaign_setup p
    left join app_users u on u.id = p.posted_by
   where p.article_id = p_article_id
     and (has_permission('hub.articles.view') or has_permission('hub.articles.manage')
          or exists (select 1 from hub_tasks t
                      where t.article_id = p_article_id and t.assignee = auth.uid()));
$$;

/* tick / untick a setup account — the twin of hub_article_post_set */
create or replace function hub_article_setup_set(p_task_id uuid, p_platform text, p_posted boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  t hub_tasks; v_platform text := lower(btrim(coalesce(p_platform, ''))); v_status text; v_n integer;
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
  select a.status into v_status from hub_articles a where a.id = t.article_id for update;
  if v_status = 'completed' then
    return jsonb_build_object('ok', false, 'error', 'This article is live — its ticks are closed.');
  end if;
  if exists (select 1 from hub_tasks y
              where y.article_id = t.article_id and y.stage = 'social' and y.created_at > t.created_at) then
    return jsonb_build_object('ok', false, 'error', 'A newer attempt of this step exists — reload the page.');
  end if;

  if coalesce(p_posted, false) then
    insert into hub_article_campaign_setup (article_id, platform, posted_by, task_id)
    values (t.article_id, v_platform, auth.uid(), t.id)
    on conflict (article_id, platform) do nothing;
  else
    delete from hub_article_campaign_setup where article_id = t.article_id and platform = v_platform;
  end if;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    insert into hub_article_events (article_id, task_id, kind, actor, detail)
    values (t.article_id, t.id,
            case when coalesce(p_posted, false) then 'setup' else 'unsetup' end, auth.uid(),
            'Campaign set up · ' ||
            case v_platform when 'instagram' then 'Instagram' when 'facebook' then 'Facebook' else 'TikTok' end);
  end if;

  return jsonb_build_object('ok', true, 'changed', v_n > 0, 'setup', hub_article_setup_posts(t.article_id));
end;
$$;

/* hub_my_progress — unchanged except for the new `setup` map beside `posts`. */
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
           'posts', hub_article_social_posts(a.id),
           'setup', hub_article_setup_posts(a.id)
         ) order by a.code), '[]'::jsonb)
    from mine m
    join hub_articles a on a.id = m.article_id;
$$;

revoke all on function hub_article_setup_posts(uuid) from public, anon;
revoke all on function hub_article_setup_set(uuid, text, boolean) from public, anon;
grant execute on function hub_article_setup_posts(uuid) to authenticated, service_role;
grant execute on function hub_article_setup_set(uuid, text, boolean) to authenticated, service_role;
