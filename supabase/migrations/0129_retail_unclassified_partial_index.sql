/* THE BACKLOG INDEX.
 *
 * The Non-cash screen opens by asking "which sale lines are still untagged?".
 * With no index that is a sequential scan of every line ever imported — 1,324 ms
 * at 58,303 rows, to return nothing, on every single visit to the screen. That
 * is the stall people feel moving from Cash Book to Non-cash, and it gets worse
 * with every upload.
 *
 * A PARTIAL index is the right shape here, not a plain one on payment_method:
 * the interesting rows are the ones nobody has classified yet, which is a
 * handful after an upload and zero once the day is tidied. So the index holds
 * only those rows and is empty most of the time — a few kilobytes, and no write
 * cost at all on the 58,000 lines that are already tagged.
 *
 * The predicate covers NULL as well as the literal, because both mean "nobody
 * has said what this was" and the screen must not be able to see one and miss
 * the other. Postgres will only use a partial index when it can prove the
 * query's WHERE implies the index's, so the two have to stay written the same
 * way — app/retail/payments/page.tsx carries the matching .or() filter.
 *
 * branch_id leads so the per-shop view is a straight range scan; id trails so
 * the keyset cursor (id > n order by id) is served from the index too.
 *
 * Measured, same query, before and after:
 *     1,324.811 ms  ·  2,130 buffers  ·  Seq Scan, 58,303 rows discarded
 *         0.145 ms  ·      1 buffer   ·  Index Only Scan, 0 heap fetches
 */
create index if not exists retail_sale_lines_unclassified_idx
  on public.retail_sale_lines (branch_id, id)
  where payment_method is null or payment_method = 'unclassified';
