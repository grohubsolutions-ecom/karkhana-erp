/* H293 ROLLBACK — remove the product-owner article create. Put the previous
   MyWork.tsx back first, then run this. The admin's hub_article_create is
   untouched. Hub tables only. */
drop function if exists hub_article_create_own(text, text);
drop function if exists hub_can_make_article();
