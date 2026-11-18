/* H291 ROLLBACK — remove the Campaign setup ticks. Put the previous screens
   back first, then run this. Restores hub_my_progress to its H290 form (no
   `setup` key) and removes the setup table + functions. The posting ticks
   (hub_article_posts) are untouched. Hub tables only. */
drop function if exists hub_article_setup_set(uuid, text, boolean);
drop function if exists hub_article_setup_posts(uuid);
drop table if exists hub_article_campaign_setup;
/* hub_my_progress back to H290 (no setup key) */
create or replace function hub_my_progress()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with mine as (
    select distinct t.article_id from hub_tasks t
     where t.assignee = auth.uid() and t.article_id is not null
       and (t.status = 'open' or t.submitted_at > now() - interval '30 days'))
  select coalesce(jsonb_agg(jsonb_build_object(
           'article_id', a.id, 'code', a.code, 'status', a.status, 'completed_at', a.completed_at,
           'live', case when a.status='completed' then
                     (select jsonb_build_object('at',x.submitted_at,'by',u.full_name,'note',nullif(btrim(coalesce(x.submit_note,'')),''))
                        from hub_tasks x left join app_users u on u.id=x.assignee
                       where x.article_id=a.id and x.stage='ads' order by x.created_at desc limit 1) end,
           'steps', (select coalesce(jsonb_agg(jsonb_build_object(
                       'stage',s.stage,'person',u.full_name,'status',lt.status,'attempt',lt.attempt,
                       'opened_at',lt.opened_at,'submitted_at',lt.submitted_at,
                       'sent_back_by',(select b.full_name from app_users b where b.id=lt.sent_back_by),
                       'mine',coalesce(lt.assignee=auth.uid(),false))
                       order by case s.stage when 'product' then 1 when 'video' then 2 when 'qc' then 3
                                             when 'social' then 4 when 'ads' then 5 else 9 end, s.sort_order), '[]'::jsonb)
                       from hub_stage_owners s
                       left join lateral (select x.* from hub_tasks x where x.article_id=a.id and x.stage=s.stage
                                           order by x.created_at desc limit 1) lt on true
                       left join app_users u on u.id=coalesce(lt.assignee,s.user_id)),
           'posts', hub_article_social_posts(a.id)
         ) order by a.code), '[]'::jsonb)
    from mine m join hub_articles a on a.id=m.article_id;
$$;
