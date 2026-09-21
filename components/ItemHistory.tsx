"use client";
/* ITEM HISTORY — every stock-in and stock-out of one warehouse product.
 *
 * Shared by New GRN (shown under the form once a barcode is found) and by
 * Products (opened by clicking a product's name), so the two can never tell
 * different stories about the same item.
 *
 * The balance is worked out oldest-first — it is a running total, and a
 * running total only means something in the order things happened — then
 * shown newest-first, because the latest movement is what gets looked for.
 * Voided movements are listed when asked for but never counted: they did not
 * happen.
 *
 * Every product's movements were checked against its stock figure when this
 * was written and all of them agreed to the piece. If that ever stops being
 * true, the panel says so rather than showing two numbers that quietly
 * disagree.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Download, Printer, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { exportCSV, exportExcel, exportPDF, printTable, type ExportTable } from "@/lib/export";

type Mv = { id: string; movement_no: string | null; movement_type: "IN" | "OUT";
            quantity: number; note: string | null; created_at: string;
            voided_at: string | null; void_reason: string | null;
            invoice_no: string | null; delivery_no: number | null;
            party: string | null; branch: string | null;
            edited_at: string | null; original_quantity: number | null };
type Row = Mv & { after: number | null };

type Props = {
  barcode: string;
  name: string;
  manual?: string | null;
  /* The stock figure the screen is showing, if it has one — used only to
     check the history adds up to it. */
  stockNow?: number | null;
  /* Change it to make the panel reload, e.g. after recording a movement. */
  reloadKey?: number;
  /* Draw its own card. Off inside a pop-up, which is already a card. */
  framed?: boolean;
};

const n = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const when = (v: string) => new Date(v).toLocaleString("en-PK", {
  day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
/* The local calendar day (YYYY-MM-DD). Slicing the stored timestamp would give
   the UTC day, and Karachi is five hours ahead — a 1 AM entry would land on
   the day before. */
const day = (v: string) => new Date(v).toLocaleDateString("en-CA");
const pill = "rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none";

/* What a movement was, in words: who it went to, or why it came in. */
function detail(m: Mv) {
  if (m.voided_at) return `voided — ${m.void_reason ?? ""}`;
  if (m.movement_type === "OUT" && (m.party || m.invoice_no))
    return `${m.party ?? ""}${m.branch ? " · " + m.branch : ""}${m.invoice_no ? " · inv " + m.invoice_no : ""}`;
  return m.note ?? "";
}

export default function ItemHistory({ barcode, name, manual, stockNow, reloadKey = 0, framed = true }: Props) {
  const [rows, setRows] = useState<Mv[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState<"all" | "IN" | "OUT">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showVoided, setShowVoided] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !barcode) { setLoading(false); return; }
    setLoading(true); setErr("");
    /* Its own query, not the screen's list: that list is capped at the most
       recent movements across every product, so an item's older history
       would fall off the end of it. */
    const { data, error } = await supabase.from("v_khana_movements")
      .select("id,movement_no,movement_type,quantity,note,created_at,voided_at,void_reason,invoice_no,delivery_no,party,branch,edited_at,original_quantity")
      .eq("barcode", barcode)
      .order("created_at", { ascending: true })
      .limit(5000);
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setRows((data as Mv[]) ?? []);
  }, [barcode]);
  useEffect(() => { load(); }, [load, reloadKey]);

  /* Running balance, oldest first, voided rows skipped. Backdated entries are
     all stamped at noon, so several can share one exact moment; among those,
     stock coming in is counted before stock going out — otherwise the order
     is a coin toss and the balance can dip below zero for no real reason. */
  const withBalance = useMemo<Row[]>(() => {
    let bal = 0;
    const ordered = [...rows].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
      || (a.movement_type === b.movement_type ? 0 : a.movement_type === "IN" ? -1 : 1)
      || (a.movement_no ?? "").localeCompare(b.movement_no ?? ""));
    return ordered.map((m) => {
      if (m.voided_at) return { ...m, after: null };
      bal += (m.movement_type === "IN" ? 1 : -1) * Number(m.quantity);
      return { ...m, after: bal };
    });
  }, [rows]);

  const live = rows.filter((m) => !m.voided_at);
  const totIn = live.filter((m) => m.movement_type === "IN").reduce((a, m) => a + Number(m.quantity), 0);
  const totOut = live.filter((m) => m.movement_type === "OUT").reduce((a, m) => a + Number(m.quantity), 0);
  const inHand = totIn - totOut;
  const mismatch = stockNow != null && !loading && !err && Math.abs(Number(stockNow) - inHand) > 0.0005;

  const view = useMemo(() => [...withBalance].reverse().filter((m) =>
    (showVoided || !m.voided_at)
    && (kind === "all" || m.movement_type === kind)
    && (!from || day(m.created_at) >= from)
    && (!to || day(m.created_at) <= to)
  ), [withBalance, showVoided, kind, from, to]);

  const vIn = view.filter((m) => !m.voided_at && m.movement_type === "IN").reduce((a, m) => a + Number(m.quantity), 0);
  const vOut = view.filter((m) => !m.voided_at && m.movement_type === "OUT").reduce((a, m) => a + Number(m.quantity), 0);
  const voidedCount = rows.length - live.length;
  const filtered = kind !== "all" || !!from || !!to;

  const table = (): ExportTable => ({
    title: `History - ${name} (${barcode})`,
    headers: ["Date", "In / Out", "Document", "Qty", "Balance after", "Details"],
    rows: view.map((m) => [when(m.created_at), m.movement_type === "IN" ? "In" : "Out",
      m.movement_no ?? "", (m.movement_type === "IN" ? "+" : "-") + n(Number(m.quantity)),
      m.after == null ? "" : n(m.after), detail(m)]),
  });

  return (
    <div className={framed ? "rounded-card border border-line bg-surface p-4" : ""}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[14px] font-extrabold text-ink">
          {name}
          <span className="ml-2 font-mono text-[12px] font-semibold text-ink/60">{barcode}</span>
          {manual && <span className="ml-2 font-mono text-[12px] font-normal text-muted">printed {manual}</span>}
        </p>
        <p className="text-[12px] text-hint">
          {live.length} movement{live.length === 1 ? "" : "s"}
          {live.length > 0 && <> · first {new Date(live[0].created_at).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" })}</>}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-xl2 bg-success-soft px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">Total in</p>
          <p className="mt-0.5 text-[20px] font-extrabold leading-none tnum text-ink">{n(totIn)}</p>
        </div>
        <div className="rounded-xl2 bg-salmon-soft px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">Total out</p>
          <p className="mt-0.5 text-[20px] font-extrabold leading-none tnum text-ink">{n(totOut)}</p>
        </div>
        <div className="rounded-xl2 bg-periwinkle-soft px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">In hand</p>
          <p className="mt-0.5 text-[20px] font-extrabold leading-none tnum text-ink">{n(inHand)}</p>
        </div>
      </div>

      {withBalance.some((m) => m.after != null && m.after < 0) && (
        <p className="mt-2 rounded-xl2 bg-danger-soft px-3 py-2 text-[12px] font-medium text-ink">
          At some point this went below zero — stock left before its stock-in was recorded. The red balance
          below shows where. Usually one of the entries carries a later date than it should.
        </p>
      )}

      {mismatch && (
        <p className="mt-2 rounded-xl2 bg-amber-soft px-3 py-2 text-[12px] font-medium text-ink">
          The stock figure says {n(Number(stockNow))}, but these movements add up to {n(inHand)}. Something changed the
          stock without a movement — worth checking before trusting either number.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {(["all", "IN", "OUT"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${kind === k ? "bg-ink text-white" : "border border-line text-ink/65 hover:bg-panel"}`}>
            {k === "all" ? "All" : k === "IN" ? "Stock in" : "Stock out"}
          </button>
        ))}
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={pill} title="From" />
        <span className="text-[12px] text-hint">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={pill} title="To" />
        {voidedCount > 0 && (
          <button onClick={() => setShowVoided((v) => !v)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${showVoided ? "bg-ink text-white" : "border border-line text-ink/65 hover:bg-panel"}`}>
            {showVoided ? "Hide" : "Show"} voided ({voidedCount})
          </button>
        )}
        {filtered && (
          <button onClick={() => { setKind("all"); setFrom(""); setTo(""); }}
            className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/60 hover:bg-panel">Clear</button>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button onClick={() => exportCSV(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Download size={13} /> CSV</button>
          <button onClick={() => exportExcel(table())} className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel">Excel</button>
          <button onClick={() => exportPDF(table())} className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel">PDF</button>
          <button onClick={() => printTable(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Printer size={13} /> Print</button>
        </span>
      </div>

      {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
      {loading && <p className="mt-3 flex items-center gap-2 text-[12.5px] text-hint"><Loader2 size={14} className="animate-spin" /> Loading history…</p>}

      {!loading && !err && (
        <div className="mt-3 overflow-hidden rounded-xl2 border border-line">
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className="px-3 py-2 font-bold">Date</th>
                <th className="px-3 py-2 font-bold">In / Out</th>
                <th className="px-3 py-2 font-bold">Document</th>
                <th className="px-3 py-2 text-right font-bold">Qty</th>
                <th className="px-3 py-2 text-right font-bold">Balance</th>
                <th className="px-3 py-2 font-bold">Details</th>
              </tr></thead>
              <tbody>
                {view.map((m) => (
                  <tr key={m.id} className={`border-b border-line/60 last:border-0 ${m.voided_at ? "opacity-45" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{when(m.created_at)}</td>
                    <td className="px-3 py-2">
                      {m.movement_type === "IN"
                        ? <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-bold text-[#166534]"><ArrowDownToLine size={11} /> In</span>
                        : <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-salmon-soft px-2 py-0.5 text-[11px] font-bold text-ink/80"><ArrowUpFromLine size={11} /> Out</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-ink/70">
                      {m.movement_no ?? "—"}
                      {m.movement_type === "OUT" && m.delivery_no != null && <span className="ml-1.5 font-sans font-bold">#{m.delivery_no}</span>}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right tnum font-bold ${m.movement_type === "IN" ? "text-[#166534]" : "text-ink"}`}>
                      {m.movement_type === "IN" ? "+" : "−"}{n(Number(m.quantity))}
                    </td>
                    {/* Below zero means stock left before its arrival was recorded —
                        usually an entry made with a later date than it should
                        have. Shown, not hidden: it is the thing to go and fix. */}
                    <td className={`whitespace-nowrap px-3 py-2 text-right tnum ${m.after != null && m.after < 0 ? "font-bold text-danger" : "text-ink/80"}`}
                      title={m.after != null && m.after < 0 ? "Went below zero: this left before its stock-in was recorded. Check the dates." : undefined}>
                      {m.after == null ? "—" : n(m.after)}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-ink/70">
                      {m.edited_at && !m.voided_at && <span className="mr-1 text-hint">edited · was {n(Number(m.original_quantity ?? 0))} ·</span>}
                      {detail(m) || <span className="text-hint">—</span>}
                    </td>
                  </tr>
                ))}
                {view.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-[12.5px] text-muted">
                    {rows.length === 0 ? "No stock has moved in or out of this item yet." : "Nothing matches these filters."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered && view.length > 0 && (
            <p className="border-t border-line bg-panel/40 px-3 py-2 text-[12px] text-ink/75">
              Showing {view.length} · in <b className="tnum">{n(vIn)}</b> · out <b className="tnum">{n(vOut)}</b>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
