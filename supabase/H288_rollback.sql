/* ===========================================================================
   H288 ROLLBACK — only if the progress panel and the social ticks must go.

   Order: put the previous screens back first (MyWork.tsx and the article page
   from HUB-CHECKPOINTS-LIVE-v1), then run this in the Supabase SQL editor.
   The new screens call these functions; the old ones never do.

   H288 changed nothing that existed before it, so removing what it added is
   the whole rollback. The ticks recorded so far are deleted with the table;
   the history lines ('posted' / 'unposted') stay in hub_article_events.
   Hub tables only.
=========================================================================== */

drop function if exists hub_my_progress();
drop function if exists hub_article_post_set(uuid, text, boolean);
drop function if exists hub_article_social_posts(uuid);
drop table if exists hub_article_posts;
