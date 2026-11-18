/* ===========================================================================
   H293 — HAMZA MUKHTAR CREATES AN ARTICLE FROM HIS OWN PORTAL   (7 Oct 2026)

   The owner, 7 Oct: the product owner (Hamza Mukhtar) may start an article
   himself, the way the administration does — not only the admin.

   HOW IT DIFFERS FROM THE ADMIN CREATE (hub_article_create, unchanged):
   he gives only the NAME and an optional brief. The cost, the retail price and
   the ad budget stay with the administration — the product stage never sees the
   cost, and the article simply shows "No price set yet" until the office fills
   it in. Everything else is identical: it opens Product (to him), Video and
   Quality check, and it is a normal article the office sees and prices.

     hub_can_make_article()        NEW — true for the product owner or an admin
     hub_article_create_own(name, brief)  NEW — the portal's "New article"

   The admin's full create (with cost/price/budget) is left exactly as it was.
   Hub tables only. Nothing is dropped. Safe to run again.
   ALREADY APPLIED on the live database (migration h293_product_creates_article,
   7 Oct 2026). md5 checked. Rollback: H293_rollback.sql.
=========================================================================== */

/* Who may start an article: the product stage owner (Hamza Mukhtar) or an
   administrator. Used to show the "New article" button. */
create or replace function hub_can_make_article()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select hub_is_boss()
      or auth.uid() = (select user_id from hub_stage_owners where stage = 'product');
$$;

create or replace function hub_article_create_own(p_rough_name text, p_brief text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_code text;
begin
  if not hub_can_make_article() then
    return jsonb_build_object('ok', false, 'error', 'You are not allowed to create an article.');
  end if;
  if coalesce(btrim(p_rough_name), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'The article needs a name to start with.');
  end if;

  /* Cost, price and budget are left for the administration. created_by is set,
     so whoever starts it is told when it is completed. */
  insert into hub_articles (rough_name, brief, ads_basis, created_by)
  values (btrim(p_rough_name), nullif(btrim(p_brief), ''), 'total', auth.uid())
  returning id, code into v_id, v_code;

  insert into hub_article_events (article_id, kind, actor, detail)
  values (v_id, 'created', auth.uid(), btrim(p_rough_name));

  /* Same three stages the admin create opens — the product goes to its owner. */
  perform hub_open_stage(v_id, 'product');
  perform hub_open_stage(v_id, 'video');
  perform hub_open_stage(v_id, 'qc');

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end;
$$;

revoke all on function hub_can_make_article() from public, anon;
revoke all on function hub_article_create_own(text, text) from public, anon;
grant execute on function hub_can_make_article() to authenticated, service_role;
grant execute on function hub_article_create_own(text, text) to authenticated, service_role;
