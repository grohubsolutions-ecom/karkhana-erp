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

/** FC DHA, found by name rather than by a hardcoded id — the same rule the
 *  Commissions screen uses. The old app hardcoded `11`, which was DHA's primary
 *  key in the old database and means nothing in this one. */
export function findDhaBranch(branches: Branch[]): Branch | null {
  return branches
    .filter((b) => /dha/i.test(String(b.name ?? "")) || /dha/i.test(String(b.code ?? "")))
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

/* One answer per page load, shared by the Dashboard banner and the Commissions
   screen, so opening both does not ask twice and the two can never show
   different counts. */
let cache: StaleRate[] | null = null;
let promise: Promise<StaleRate[]> | null = null;
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

  const { data, error } = await db.rpc("retail_fc_dha_stale_comm", { p_branch_id: dhaId, p_months: 3 });
  /* A permission error is not "nothing stale" — somebody who cannot read the
     rate sheet should see no warning rather than a confident all-clear. */
  cache = error ? [] : ((data as StaleRate[]) ?? []);
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
export function useStaleRates(branches: Branch[]): { stale: StaleRate[] | null; dhaId: number | null } {
  const dha = findDhaBranch(branches);
  const dhaId = dha ? Number(dha.id) : null;
  const [stale, setStale] = useState<StaleRate[] | null>(() => cache);

  useEffect(() => {
    if (dhaId == null) return;
    let alive = true;
    const sync = () => { if (alive) setStale(cache); };
    subs.add(sync);
    if (cache) sync();
    else {
      promise = promise ?? fetchStale(dhaId);
      promise.then(sync).finally(() => { promise = null; });
    }
    return () => { alive = false; subs.delete(sync); };
  }, [dhaId]);

  return { stale, dhaId };
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
