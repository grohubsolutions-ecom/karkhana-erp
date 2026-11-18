"use client";
/* RATES THAT HAVE STOPPED EARNING.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 *
 * The FC DHA rate sheet is a list of barcodes and the rupees each one pays the
 * shop staff. Articles come and go; the barcodes do not. Over a couple of years
 * the sheet fills with codes for things nobody has sold since last summer, and
 * nothing about that is visible — the Commissions grid shows what WAS earned,
 * never what is on the sheet and idle.
 *
 * So the old Grohub app asked the question for you: any barcode on the sheet
 * that has earned nothing in three months got listed, with the option to delete
 * one, delete the ones you tick, or delete the lot. It put that on the
 * DASHBOARD as an amber card and opened the list by itself the first time you
 * signed in — because a cleanup screen nobody opens is a cleanup that never
 * happens.
 *
 * The port had the list and the three delete options already. What it did not
 * have was the part that matters: it waited inside the Commissions screen for
 * somebody to go looking. This is the missing half.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GUARD, AND WHY IT IS NOT OPTIONAL
 *
 * "Has earned nothing in three months" is a lie about a shop that has only been
 * trading for one — every barcode on the sheet would be listed, and the first
 * thing the warning would invite somebody to do is delete the entire rate sheet
 * of a new shop. So the question is only asked once DHA actually has three
 * months of sales behind it. The old app checked exactly this and so does this.
 */
import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import type { Branch } from "@/components/retail/kit";

export type StaleRate = {
  item_code: string;
  commission: number | null;
  last_sold: string | null;
};

/* ── WHICH SHOP IS THE FLAT-RATE SHOP ───────────────────────────────────────
 *
 * THE BUG THIS EXISTS TO PREVENT, because it had already happened.
 *
 *   The rule used to be "any branch whose name or code contains DHA, lowest id
 *   wins". That was correct while Fashion Collection DHA was the only shop in
 *   the company with DHA in its name. Then TOP SHOP DHA was opened — id 6
 *   against Fashion Collection DHA's id 11 — and because 6 sorts first, Top
 *   Shop DHA silently became "the DHA shop".
 *
 *   What that did: every Top Shop DHA line was priced off the Fashion
 *   Collection flat per-barcode sheet, none of its barcodes are on that sheet,
 *   an unlisted barcode earns exactly Rs 0 by design, and the rule also bars
 *   the shop from the bonus. Top Shop DHA earned Rs 0 from 1 July onward while
 *   selling Rs 2.5m — Rs 64,931 of commission that never appeared — and
 *   nothing anywhere said why.
 *
 * THE RULE NOW. The flat per-barcode sheet is FASHION COLLECTION's agreement,
 * so a shop qualifies only if it is BOTH named DHA and a Fashion Collection
 * shop. "Top Shop DHA" is a Top Shop that happens to be in DHA, and is paid the
 * master percentage like every other Top Shop.
 *
 * Still looked up from the data and not hardcoded to id 11 — a hardcoded id
 * breaks the moment the database is migrated. But the test is now two
 * independent signals instead of one, and anything it rejects is named on
 * screen rather than silently dropped. See `findOtherDhaBranches`.
 */
const namedDha = (b: Branch) =>
  /dha/i.test(String(b.name ?? "")) || /dha/i.test(String(b.code ?? ""));

/** Fashion Collection, by chain, by name, or by the FC_ code prefix — any one
 *  of the three, so a missing `chain` alone cannot lose the shop. */
const isFashionCollection = (b: Branch) =>
  /fashion/i.test(String(b.chain ?? "")) ||
  /fashion/i.test(String(b.name ?? "")) ||
  /^fc[\s_-]/i.test(String(b.code ?? ""));

/** The one shop paid from the flat per-barcode sheet, or null if there is none.
 *  Lowest id among the matches, as before, so two Fashion Collection DHA rows
 *  still resolve to one answer. */
export function findDhaBranch(branches: Branch[]): Branch | null {
  return branches
    .filter((b) => namedDha(b) && isFashionCollection(b))
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

/** Shops with DHA in the name that are NOT the flat-sheet shop — Top Shop DHA
 *  and anything like it. Returned so the screen can SAY it is paying them the
 *  master rate, instead of the reader having to guess which DHA is which. */
export function findOtherDhaBranches(branches: Branch[]): Branch[] {
  const chosen = findDhaBranch(branches);
  return branches.filter((b) => namedDha(b) && b.id !== chosen?.id);
}

/* One answer per page load, shared by the Dashboard banner and the Commissions
   screen, so opening both does not ask twice and the two can never show
   different counts. */
let cache: StaleRate[] | null = null;
let promise: Promise<StaleRate[]> | null = null;
/** True when every barcode on the sheet came back stale — see the guard in
 *  fetchStale. The screen prints a warning instead of a delete list. */
let wholeSheet = false;
const subs = new Set<() => void>();

async function fetchStale(dhaId: number): Promise<StaleRate[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const db = supabase;

  /* THE GUARD. If DHA's own history is shorter than the window, every barcode
     would look stale and the warning would be nonsense. */
  const { data: first } = await db.from("retail_sale_lines")
    .select("sale_date").eq("branch_id", dhaId)
    .order("sale_date", { ascending: true }).limit(1).maybeSingle();

  const firstDay = (first as { sale_date?: string } | null)?.sale_date;
  if (!firstDay) { cache = []; subs.forEach((f) => f()); return []; }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);
  if (new Date(firstDay + "T00:00:00") > cutoff) { cache = []; subs.forEach((f) => f()); return []; }

  const [{ data, error }, { count: sheetRows }] = await Promise.all([
    db.rpc("retail_fc_dha_stale_comm", { p_branch_id: dhaId, p_months: 3 }),
    db.from("retail_fc_dha_comm").select("item_code", { count: "exact", head: true }),
  ]);
  /* A permission error is not "nothing stale" — somebody who cannot read the
     rate sheet should see no warning rather than a confident all-clear. */
  const rows = error ? [] : ((data as StaleRate[]) ?? []);

  /* THE SECOND GUARD, AND IT IS NOT HYPOTHETICAL.
   *
   * "Stale" means a barcode on the sheet that the flat-rate shop has not sold
   * for three months. If EVERY barcode on the sheet looks stale, the far more
   * likely explanation is that the sheet is being compared against the wrong
   * shop's sales — not that the whole agreement died at once.
   *
   * That is exactly what happened. findDhaBranch used to resolve to TOP SHOP
   * DHA, so this asked "which of Fashion Collection's barcodes has Top Shop
   * DHA not sold?" — all of them, by definition, because it is a different
   * shop selling different stock. The panel then offered one button to delete
   * them, and retail_fc_dha_comm is now empty.
   *
   * The first guard above did not catch it: it only checks the shop has three
   * months of history, and Top Shop DHA has had sales since 1 July.
   *
   * So: a list covering the entire sheet is treated as a wiring fault, not a
   * cleanup, and nothing is offered for deletion. `wholeSheet` tells the screen
   * to say so rather than silently showing nothing. */
  wholeSheet = (sheetRows ?? 0) > 0 && rows.length >= (sheetRows ?? 0);
  cache = wholeSheet ? [] : rows;
  subs.forEach((f) => f());
  return cache;
}

/** Drop the cache — call after deleting rates so the banner's count follows. */
export function reloadStale(dhaId: number | null) {
  cache = null;
  if (dhaId == null) { subs.forEach((f) => f()); return; }
  promise = fetchStale(dhaId);
  promise.finally(() => { promise = null; });
}

/** The stale list, or null while it is still unknown. */
export function useStaleRates(branches: Branch[]): {
  stale: StaleRate[] | null; dhaId: number | null;
  /** Every barcode on the sheet looked stale, so nothing is offered for
   *  deletion. The screen should say the comparison looks wrong. */
  wholeSheetStale: boolean;
} {
  const dha = findDhaBranch(branches);
  const dhaId = dha ? Number(dha.id) : null;
  const [stale, setStale] = useState<StaleRate[] | null>(() => cache);
  const [whole, setWhole] = useState(() => wholeSheet);

  useEffect(() => {
    if (dhaId == null) return;
    let alive = true;
    const sync = () => { if (alive) { setStale(cache); setWhole(wholeSheet); } };
    subs.add(sync);
    if (cache) sync();
    else {
      promise = promise ?? fetchStale(dhaId);
      promise.then(sync).finally(() => { promise = null; });
    }
    return () => { alive = false; subs.delete(sync); };
  }, [dhaId]);

  return { stale, dhaId, wholeSheetStale: whole };
}

/* ──────────────────────────────────────────────────────────────────────────
   SHOWN ONCE, NOT ON EVERY NAVIGATION

   The old app opened the list by itself the first time and then left you alone
   (`state._fcStaleShown`). A modal that reopens every time you touch the
   Commissions tab is a modal people learn to dismiss without reading, which is
   worse than not having it.

   sessionStorage and not a module flag, so a refresh does not bring it back
   either — and wrapped, because a private window throws on access and a
   cleanup reminder is not worth crashing a screen over.
   ────────────────────────────────────────────────────────────────────────── */
const SEEN = "fsStaleSeen";

export function staleSeen(): boolean {
  try { return window.sessionStorage.getItem(SEEN) === "1"; } catch { return false; }
}
export function markStaleSeen() {
  try { window.sessionStorage.setItem(SEEN, "1"); } catch { /* storage blocked */ }
}
