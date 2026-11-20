-- N3b (20 Nov 2026): TAKE THE TWO SYNC TABLES OFF THE REALTIME FEED.
--
-- Measured in pg_stat_statements since 12 Aug 2026: Realtime's WAL polling is
-- 499 minutes of database time over 2.6M calls — 43% of everything the database
-- did, more than all staff page loads and all sync jobs combined. Almost all of
-- it is online_orders + online_logistics (~10M writes from the Shopify and
-- courier syncs). Every write is decoded and checked against each open tab.
--
-- The Hub pages that listened (Dashboard, Orders, Logistics, Returns) now
-- refresh themselves every 45 s while on screen (lib/useLiveTables.ts, POLLED),
-- so deploy that frontend first or together.
--
-- Reversible at any time:
--   alter publication supabase_realtime add table public.online_orders, public.online_logistics;
-- karkhana_notifications (the Karkhana bell) stays on the feed.
alter publication supabase_realtime drop table public.online_orders;
alter publication supabase_realtime drop table public.online_logistics;
