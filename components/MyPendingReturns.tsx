"use client";
/* PENDING RETURNS, IN THE EMPLOYEE PORTAL.
 *
 * WHY IT IS HERE
 *   Abdul Rehman chases the returns. Until now the sheet could only be printed
 *   from the Hub's Returns page, which he cannot open — so he had to ask
 *   somebody else to print his own worklist. This is that one job, in the
 *   portal he already signs into, and nothing else: no Logistics, no money, no
 *   customer details.
 *
 * WHAT HE CAN SEE
 *   Order number, store, courier, tracking and the date it came back — the one
 *   list, from my_pending_returns(). The function is the boundary: it returns
 *   pending returns to a holder of 'returns.print' and an empty list to anybody
 *   else, so this page cannot be talked into showing more than it should.
 *
 *   The same rows the Pending tab counts, so his sheet and the office screen
 *   can never disagree, and the printed board is the same board — one renderer
 *   in lib/returnsBoardExport, used by both.
 *
 *   Only parcels the courier has marked as a return (owner, 19 Oct 2026). The
 *   stuck-at-courier list was merged in here for part of 19 Oct and taken out
 *   again: an "Attempted" parcel is not a return and must not be on his sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { Printer, Loader2, FileSpreadsheet, FileDown, RefreshCw, Undo2, AlertTriangle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { downloadBoardExcel, downloadBoardPdf, boardHtml, type BoardOpts, type PrintRow } from "@/lib/returnsBoardExport";

type Row = { tracking_id: string; order_number: string | null; store_code: string | null; courier: string | null; return_date: string | null };

const STORE_NAME: Record<string, string> = { LM: "Little Minors", TS: "TopShop", TRZ: "Trenzee" };
const TONE: Record<string, string> = {
  PostEx: "border-[#185FA5]/30 bg-[#E6F1FB] text-[#0C447C]",
  OwnEx: "border-[#0F6E56]/30 bg-[#E1F5EE] text-[#085041]",
  Other: "border-line bg-panel text-ink",
};
const dd = (s: string | null) => {
  if (!s) return "—";
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const OPTS: BoardOpts = { scope: "pending", from: null, to: null, courier: "Both", store: "ALL" };

export default function MyPendingReturns() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "print" | "xlsx" | "pdf">("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("my_pending_returns");
    if (error) setErr(error.message);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  function print() {
    /* Opened in the tap, before anything else — a phone blocks a window opened
       later. The rows are already here, so there is nothing to wait for. */
    const w = window.open("", "_blank");
    if (!w) { setErr("The browser blocked the print window. Allow pop-ups for this site and press Print again."); return; }
    setBusy("print");
    w.document.write(boardHtml(rows as PrintRow[], OPTS));
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* it stays open to print by hand */ } setBusy(""); }, 350);
  }
  function download(kind: "xlsx" | "pdf") {
    setBusy(kind);
    try {
      if (kind === "xlsx") downloadBoardExcel(rows, OPTS); else downloadBoardPdf(rows, OPTS);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }

  const couriers = ["PostEx", "OwnEx"];
  for (const r of rows) { const c = r.courier || "Other"; if (!couriers.includes(c)) couriers.push(c); }
  const btn = "flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink transition active:bg-panel disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-white";

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 dark:border-white/10 sm:px-5">
          <div>
            <h2 className="flex items-center gap-2 text-[13px] font-bold text-ink dark:text-[#f4f1ea]">
              <Undo2 size={15} /> Pending Returns
            </h2>
            <p className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">
              Coming back from the courier and not yet cancelled in Shopify. When a parcel arrives, cancel it in Shopify and tag it RTS — it leaves this list by itself.
            </p>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-extrabold leading-none tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : rows.length}</span>
            <span className="text-[12px] font-semibold text-muted dark:text-[#a89f93]">pending</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3 dark:border-white/10 sm:px-5">
          <button onClick={print} disabled={!!busy || loading || !rows.length}
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-ink px-5 text-[13px] font-semibold text-white transition active:opacity-90 disabled:opacity-50 dark:bg-white dark:text-[#141414]">
            {busy === "print" ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />} Print sheet
          </button>
          <button onClick={() => download("xlsx")} disabled={!!busy || loading || !rows.length} className={btn}>
            {busy === "xlsx" ? <Loader2 size={15} className="animate-spin" /> : <FileSpreadsheet size={15} />} Excel
          </button>
          <button onClick={() => download("pdf")} disabled={!!busy || loading || !rows.length} className={btn}>
            {busy === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />} PDF
          </button>
          <button onClick={load} disabled={loading} className={btn}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {err && (
          <div className="mx-4 my-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[12.5px] text-red-800 sm:mx-5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{err}</span>
          </div>
        )}

        {loading ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">
            <Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…
          </p>
        ) : rows.length === 0 && !err ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">
            Nothing pending. Every return has been accounted for.
          </p>
        ) : (
          /* One block per courier, then per store — the order the board prints
             in, so the screen and the paper read the same way round. */
          <div className="divide-y divide-line dark:divide-white/[0.06]">
            {couriers.map((c) => {
              const mine = rows.filter((r) => (r.courier || "Other") === c);
              if (!mine.length) return null;
              const stores = ["LM", "TS", "TRZ"];
              for (const r of mine) { const s = r.store_code || "—"; if (!stores.includes(s)) stores.push(s); }
              return (
                <div key={c} className="px-4 py-3 sm:px-5">
                  <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12.5px] font-bold ${TONE[c] ?? TONE.Other}`}>
                    {c} · {mine.length}
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {stores.map((s) => {
                      const list = mine.filter((r) => (r.store_code || "—") === s);
                      return (
                        <div key={s}>
                          <div className="text-[12px] font-bold text-ink dark:text-[#e7e2d8]">
                            {STORE_NAME[s] ?? s} <span className="font-semibold text-muted dark:text-[#a89f93]">· {list.length}</span>
                          </div>
                          <ul className="mt-1.5 space-y-1">
                            {list.length === 0 ? <li className="text-[12px] text-hint dark:text-[#8a8175]">—</li>
                              : list.map((r) => (
                                <li key={r.tracking_id} className="flex items-baseline justify-between gap-2 rounded-xl2 border border-line px-2.5 py-1.5 text-[12.5px] dark:border-white/10">
                                  <span className="font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? r.tracking_id}</span>
                                  <span className="shrink-0 text-[11.5px] text-muted dark:text-[#a89f93]">{dd(r.return_date)}</span>
                                </li>
                              ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="px-1 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
        The printed sheet carries the same list: PostEx and OwnEx side by side, each split by store,
        in order-number order, with a box against every order to tick as the parcel arrives.
      </p>
    </div>
  );
}
