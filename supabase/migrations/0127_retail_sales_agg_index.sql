-- ════════════════════════════════════════════════════════════════════════════
-- WHY THE DEPARTMENT STARTED TIMING OUT  (diagnosed 9 Oct 2026)
--
-- Symptom: "Couldn't load: canceling statement due to statement timeout",
-- getting worse every day, worst on FS Traders.
--
-- MEASURED on the live database at 58,303 sale lines. The four slowest
-- statements in the entire project were all the same shape:
--
--   select … from retail_sale_lines
--    where sale_date between $1 and $2
--    order by id asc limit 1000 offset $4
--
--   worst 7,563 ms · mean 4,639 ms · 16 calls
--   worst 7,504 ms · mean 3,551 ms · 17 calls
--   worst 7,406 ms · mean 3,248 ms · 11 calls
--   worst 7,404 ms · mean 5,237 ms ·  4 calls
--
-- against `authenticated`'s statement_timeout of 8 s. For comparison, the
-- roll-up RPC from 0125 averaged 126 ms over 55 calls — the server-side path was
-- never the problem.
--
-- THE CAUSE IS OFFSET. It does not skip rows, it READS them and discards them:
--
--   one page at offset 55,000   307 ms   scans and throws away 56,000 rows
--   the same page by key          8 ms   index range scan, 1,000 rows read
--
-- and reading a whole range costs the SUM of every page, so it grows with the
-- square of the table: ~1.7 million row visits to return 58,000 rows of data.
-- That is why it got worse daily rather than all at once. Under real
-- concurrency, with a cold cache, 307 ms becomes 7,500 ms.
--
-- THE APP-SIDE FIX is keyset paging — `where id > $last order by id limit 1000`
-- — which rides the primary key and costs the same for page 60 as for page 1.
-- See fetchKeyset in components/retail/kit.tsx. It needs no index: the primary
-- key already serves it.
--
-- THIS MIGRATION adds the one index the server-side path wants, and 0128 adds
-- the fuller aggregate function that lets three screens stop reading lines
-- altogether.
-- ════════════════════════════════════════════════════════════════════════════

-- The aggregate groups by (branch_id, sale_date, item_code). With only
-- (branch_id, sale_date) Postgres gets the first two presorted and sorts within
-- each day; with item_code it groups straight off the index.
create index if not exists retail_sale_lines_branch_date_item_idx
  on retail_sale_lines (branch_id, sale_date, item_code);

analyze retail_sale_lines;
