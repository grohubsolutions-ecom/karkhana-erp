"use client";
/* THE PENDING RETURNS BOARD — the printout the team works through with a pencil.
 *
 * WHAT IT PRINTS BY DEFAULT: EXACTLY THE PENDING TAB
 *   The same returns the Pending card counts (needs_chasing) — 4 on one day,
 *   55 on another — and nothing else. No date window: a pending return is
 *   pending however old it is, and the sheet has to match the number on screen.
 *
 *   The first version printed every return of the last 7 days instead, which
 *   put 83 rows on paper when the screen said 4. That is still available as an
 *   option ("All returns in a period"), but it is not what the button is for.
 *
 * ONLY WHAT THE COURIER HAS MARKED AS A RETURN (owner, 19 Oct 2026)
 *   A parcel reaches this sheet when PostEx or OwnEx turns its status into a
 *   return — not before. "Attempted", refused, held or not moving is still out
 *   with the courier: those are on "Stuck at courier", which prints on a sheet
 *   of its own. Printing them on the pending sheet (tried on 19 Oct and taken
 *   out the same day) put attempted parcels like #LM16871 under a "Pending
 *   returns" heading, which is exactly the confusion this sheet must not cause.
 *
 * THE LAYOUT IS THE OWNER'S OWN DRAWING
 *     Date printed (fills itself) · pending total
 *     #  |        PostEx         |         OwnEx
 *        |  LM  ·  TS  ·  TRZ    |   LM  ·  TS  ·  TRZ
 *     1  | ☐ order  date ...
 *   Each store column holds only the order number and its return date, newest
 *   first. The # column numbers the rows so a count can be read off the paper.
 *
 * WHY A NEW WINDOW, OPENED BEFORE THE DATA ARRIVES
 *   Printing the app drags in the sidebar and filters. A window of its own
 *   carries only the sheet. It is opened in the tap and filled afterwards,
 *   because phones block a window opened after an await.
 */
import { useState } from "react";
import { Printer, Loader2, FileSpreadsheet, FileDown, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rangeDates } from "@/lib/dateRange";
import Modal, { btnPrimary, btnGhost, inputCls, Field } from "@/components/Modal";
import { exportExcel, exportPDF, type ExportTable } from "@/lib/export";
import { downloadBoardExcel, downloadBoardPdf, boardHtml, boardHead, BASE_CSS } from "@/lib/returnsBoardExport";

type R = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; return_date: string | null;
  cod_amount?: number | null; customer_name?: string | null; city?: string | null; phone?: string | null;
  reason?: string | null; shopify_cancelled?: boolean; person_received?: boolean;
};
/* A courier whose status feed has stopped answering (hub_courier_sync_health).
   While one is down, its returns cannot reach this sheet — say so before printing. */
type FeedIssue = { courier: string; ok: boolean; last_ok_at: string | null; problem: string | null };
type Scope = "pending" | "period" | "stuck";
type Opts = { scope: Scope; from: string | null; to: string | null; courier: string; store: string };

const PERIODS = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "60d", label: "Last 60 days" },
  { key: "all", label: "All time" },
];
const STORES = ["LM", "TS", "TRZ"];
const STORE_NAME: Record<string, string> = { ALL: "All stores", LM: "Little Minors", TS: "TopShop", TRZ: "Trenzee" };
/* The drawing's own colours: PostEx blue, OwnEx green. */
const TONE: Record<string, { fill: string; line: string; ink: string }> = {
  PostEx: { fill: "#E6F1FB", line: "#185FA5", ink: "#0C447C" },
  OwnEx:  { fill: "#E1F5EE", line: "#0F6E56", ink: "#085041" },
  Other:  { fill: "#F1EFE8", line: "#5F5E5A", ink: "#444441" },
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const num = (n: number) => Math.round(n).toLocaleString("en-PK");
const dd = (s: string | null) => {
  if (!s) return "—";
  const x = new Date(s + "T00:00:00");
  return isNaN(x.getTime()) ? s : x.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const long = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const short = (t: string | null | undefined, n: number) => { const s = (t ?? "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export default function ReturnsPrintButton({ store = "ALL" }: { store?: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("pending");
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [period, setPeriod] = useState("7d");
  const [courier, setCourier] = useState("Both");
  const [st, setSt] = useState(store);
  const [busy, setBusy] = useState<"" | "print" | "xlsx" | "pdf">("");
  const [err, setErr] = useState("");
  const [feeds, setFeeds] = useState<FeedIssue[]>([]);

  /* Read when the dialog opens. Failing to read it is not a reason to block a
     print, so an error here just shows nothing. */
  async function checkFeeds() {
    if (!supabase) return;
    const { data } = await supabase.rpc("hub_courier_sync_health");
    setFeeds(((data ?? []) as FeedIssue[]).filter((f) => !f.ok));
  }

  async function fetchRows(which: Scope, from: string | null, to: string | null): Promise<R[]> {
    const all: R[] = [];
    const cols = "tracking_id,order_number,store_code,courier,return_date,cod_amount,customer_name,city,phone,courier_reason_text,order_cancelled_at";
    /* Paged: every request stops at 1,000 rows, and a checklist that silently
       ended there would be a checklist with its end torn off. */
    for (let off = 0; ; off += 1000) {
      let data: unknown[] | null; let error: { message: string } | null;
      if (which === "pending" || which === "stuck") {
        /* Pending reads the Pending tab's own flag, so paper and screen agree:
           courier-marked returns only. Stuck reads its own live view
           (v_returns_stuck) — the same parcels the "Stuck at courier" tab shows,
           on their own sheet. Both views carry the same columns, so the one
           board draws either. */
        let q = supabase!.from(which === "stuck" ? "v_returns_stuck" : "v_returns_all")
          .select(cols)
          .order("return_date", { ascending: which === "stuck", nullsFirst: false })
          .range(off, off + 999);
        if (which === "pending") q = q.eq("needs_chasing", true);
        if (courier !== "Both") q = q.eq("courier", courier);
        if (st !== "ALL") q = q.eq("store_code", st);
        ({ data, error } = await q);
        data = (data ?? []).map((x) => {
          const r = x as Record<string, unknown>;
          return { ...r, reason: r.courier_reason_text, shopify_cancelled: !!r.order_cancelled_at, person_received: false } as R;
        });
      } else {
        ({ data, error } = await supabase!.rpc("hub_returns_board", {
          p_from: from, p_to: to,
          p_courier: courier === "Both" ? null : courier,
          p_store: st === "ALL" ? null : st,
        }).range(off, off + 999));
      }
      if (error) throw new Error(error.message);
      all.push(...((data ?? []) as R[]));
      if (!data || data.length < 1000) break;
    }
    return all;
  }

  async function print() {
    if (!supabase) return;
    setErr("");
    const w = window.open("", "_blank");
    if (!w) { setErr("The browser blocked the print window. Allow pop-ups for this site and press Print again."); return; }
    w.document.write("<p style='font:14px system-ui;padding:24px'>Preparing the returns sheet…</p>");
    setBusy("print");
    try {
      const [from, to] = scope === "period" ? rangeDates(period) : [null, null];
      const o: Opts = { scope, from, to, courier, store: st };
      const rows = await fetchRows(scope, from, to);
      const doc = layout === "board" ? boardHtml(rows, o) : listHtml(rows, o);
      w.document.open();
      w.document.write(doc);
      w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch { /* the sheet stays open to print by hand */ } }, 350);
      setOpen(false);
    } catch (e) {
      w.close();
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  /* DOWNLOADS — the same rows as the printout, as a file to keep or send.
     The board comes out as the board (merged courier and store headings,
     order and date in every column). The detailed list goes through the
     app's standard exporter, which already writes ruled Excel and PDF tables. */
  async function download(kind: "xlsx" | "pdf") {
    if (!supabase) return;
    setErr(""); setBusy(kind);
    try {
      const [from, to] = scope === "period" ? rangeDates(period) : [null, null];
      const rows = await fetchRows(scope, from, to);
      const o: Opts = { scope, from, to, courier, store: st };
      if (layout === "board") {
        if (kind === "xlsx") downloadBoardExcel(rows, o); else downloadBoardPdf(rows, o);
      } else {
        const sorted = rows.slice().sort((a, b) =>
          String(a.courier ?? "").localeCompare(String(b.courier ?? ""))
          || String(b.return_date ?? "").localeCompare(String(a.return_date ?? "")));
        const table: ExportTable = {
          title: scope === "pending" ? "Pending returns" : scope === "stuck" ? "Stuck at courier" : "Returns",
          headers: ["#", "Courier", "Store", "Order", scope === "stuck" ? "Dispatched" : "Returned", "Tracking", "Customer", "City", "Phone", "COD"],
          rows: sorted.map((r, i) => [i + 1, r.courier ?? "", r.store_code ?? "", r.order_number ?? "",
            r.return_date ?? "", r.tracking_id, r.customer_name ?? "", r.city ?? "", r.phone ?? "",
            Number(r.cod_amount) || 0]),
        };
        if (kind === "xlsx") exportExcel(table); else exportPDF(table);
      }
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  const chip = (on: boolean) =>
    `rounded-full border px-3.5 py-2 text-[12.5px] font-semibold transition ${on
      ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
      : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10"}`;

  return (
    <>
      <button onClick={() => { setSt(store); setErr(""); setOpen(true); checkFeeds(); }}
        className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
        <Printer size={14} /> Print / download
      </button>

      <Modal open={open} onClose={() => !busy && setOpen(false)}
             title="Print returns"
             subtitle="PostEx and OwnEx side by side, split by store — order number and date, in order-number order.">
        <div className="grid gap-4">
          <Field label="What to print">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setScope("pending")} className={chip(scope === "pending")}>Pending returns</button>
              <button type="button" onClick={() => setScope("stuck")} className={chip(scope === "stuck")}>Stuck at courier</button>
              <button type="button" onClick={() => setScope("period")} className={chip(scope === "period")}>All returns in a period</button>
            </div>
          </Field>
          <p className="-mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
            {scope === "pending"
              ? "Only parcels PostEx or OwnEx have marked as a return — the same list as the Pending tab. Parcels still with the courier (attempted, refused, not moving) are not returns yet; print those with “Stuck at courier”."
              : scope === "stuck"
              ? "Parcels still marked in transit but not moving — a failed attempt, or no update for 15+ days. Chase the courier (OwnEx especially)."
              : "Every return in the chosen window; received ones are struck through."}
          </p>
          {feeds.length > 0 && (
            /* A dead courier feed means that courier's returns cannot reach this
               sheet at all — the 10–19 Oct OwnEx gap. Say it where it matters. */
            <div className="flex gap-2 rounded-card border border-amber-300 bg-amber-50 p-3 text-[12.5px] text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>
                {feeds.map((f) => `${f.courier} status updates are not coming through${f.last_ok_at ? ` (last good ${new Date(f.last_ok_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}`).join(" · ")}.
                {" "}This sheet may be missing their returns. Tell Kashif.
              </span>
            </div>
          )}
          {scope === "period" && (
            <Field label="Returned in">
              <div className="flex flex-wrap gap-2">
                {PERIODS.map((p) => (
                  <button key={p.key} type="button" onClick={() => setPeriod(p.key)} className={chip(period === p.key)}>{p.label}</button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Layout">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setLayout("board")} className={chip(layout === "board")}>Board</button>
              <button type="button" onClick={() => setLayout("list")} className={chip(layout === "list")}>Detailed list</button>
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Courier">
              <select className={inputCls} value={courier} onChange={(e) => setCourier(e.target.value)}>
                {["Both", "PostEx", "OwnEx"].map((c) => <option key={c} value={c}>{c === "Both" ? "PostEx & OwnEx" : c}</option>)}
              </select>
            </Field>
            <Field label="Store">
              <select className={inputCls} value={st} onChange={(e) => setSt(e.target.value)}>
                {Object.entries(STORE_NAME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>
        </div>

        {err && <div className="mt-3 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">{err}</div>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className={btnGhost} disabled={!!busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className={btnGhost} disabled={!!busy} onClick={() => download("xlsx")}>
            {busy === "xlsx" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Excel
          </button>
          <button className={btnGhost} disabled={!!busy} onClick={() => download("pdf")}>
            {busy === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} PDF
          </button>
          <button className={btnPrimary} disabled={!!busy} onClick={print}>
            {busy === "print" ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Print
          </button>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ shared bits */
/* ----------------------------------------------------- the detailed list */
function listHtml(rows: R[], o: Opts) {
  const order = ["PostEx", "OwnEx"];
  const groups = new Map<string, R[]>();
  for (const r of rows) { const k = r.courier || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const keys = [...groups.keys()].sort((a, b) =>
    (order.indexOf(a) < 0 ? 9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 9 : order.indexOf(b)));
  let n = 0;
  const body = keys.map((k) => {
    const t = TONE[k] ?? TONE.Other;
    const list = groups.get(k)!.slice().sort((a, b) => String(b.return_date ?? "").localeCompare(String(a.return_date ?? "")));
    return `<tbody><tr><td colspan="10" class="grp" style="background:${t.fill};color:${t.ink};border-color:${t.line}">
        <b>${esc(k)}</b> · ${list.length} ${o.scope === "stuck" ? `parcel${list.length === 1 ? "" : "s"}` : `return${list.length === 1 ? "" : "s"}`}</td></tr>
      ${list.map((r) => {
        n += 1; const got = o.scope === "period" && !!r.person_received;
        return `<tr class="${got ? "got" : ""}">
          <td class="c">${n}</td><td class="bx">${got ? "&#10003;" : ""}</td>
          <td class="b on">${esc(r.order_number ?? "—")}</td><td class="c">${esc(r.store_code ?? "")}</td>
          <td class="c">${esc(dd(r.return_date))}</td><td class="mono">${esc(r.tracking_id)}</td>
          <td class="wrap">${esc(r.customer_name ?? "")}</td><td>${esc(short(r.city, 16))}</td>
          <td class="mono">${esc(r.phone ?? "")}</td><td class="r">${esc(num(Number(r.cod_amount) || 0))}</td>
        </tr>`;
      }).join("")}</tbody>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Returns list</title>
<style>${BASE_CSS}
  th, td { border: 1px solid #000; padding: 4px 6px; white-space: nowrap; vertical-align: middle; }
  thead th { background: #e6e6e6; font-size: 9px; text-transform: uppercase; }
  td.wrap { white-space: normal; } .c { text-align: center; } .r { text-align: right; }
  .b { font-weight: 700; } .mono { font-family: "Courier New", monospace; font-size: 9.5px; }
  .bx { width: 22px; text-align: center; }
  td.grp { padding: 5px 7px; font-size: 11px; border-width: 1.5px; }
  tr.got td { background: #EAF3DE; color: #3B6D11; } tr.got .on { text-decoration: line-through; }
</style></head><body>
  ${boardHead(rows, o)}
  <table>
    <thead><tr><th>#</th><th class="bx">&#9744;</th><th>Order</th><th>Store</th><th>${o.scope === "stuck" ? "Dispatched" : "Returned"}</th><th>Tracking</th><th>Customer</th>
      <th>City</th><th>Phone</th><th>COD</th></tr></thead>
    ${body || `<tbody><tr><td colspan="10" class="c" style="padding:24px">No returns to print.</td></tr></tbody>`}
  </table>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div></div>
</body></html>`;
}
