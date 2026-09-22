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
import { Printer, Loader2, FileSpreadsheet, FileDown } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rangeDates } from "@/lib/dateRange";
import Modal, { btnPrimary, btnGhost, inputCls, Field } from "@/components/Modal";
import { exportExcel, exportPDF, type ExportTable } from "@/lib/export";
import { downloadBoardExcel, downloadBoardPdf } from "@/lib/returnsBoardExport";

type R = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; return_date: string | null;
  cod_amount?: number | null; customer_name?: string | null; city?: string | null; phone?: string | null;
  reason?: string | null; shopify_cancelled?: boolean; person_received?: boolean;
};
type Scope = "pending" | "period";
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

  async function fetchRows(from: string | null, to: string | null): Promise<R[]> {
    const all: R[] = [];
    /* Paged: every request stops at 1,000 rows, and a checklist that silently
       ended there would be a checklist with its end torn off. */
    for (let off = 0; ; off += 1000) {
      let data: unknown[] | null; let error: { message: string } | null;
      if (scope === "pending") {
        // The Pending tab's own filter, so paper and screen always agree.
        let q = supabase!.from("v_returns_all")
          .select("tracking_id,order_number,store_code,courier,return_date,cod_amount,customer_name,city,phone,courier_reason_text,order_cancelled_at")
          .eq("needs_chasing", true)
          .order("return_date", { ascending: false, nullsFirst: false })
          .range(off, off + 999);
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
      const [from, to] = scope === "pending" ? [null, null] : rangeDates(period);
      const rows = await fetchRows(from, to);
      const o: Opts = { scope, from, to, courier, store: st };
      w.document.open();
      w.document.write(layout === "board" ? boardHtml(rows, o) : listHtml(rows, o));
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
      const [from, to] = scope === "pending" ? [null, null] : rangeDates(period);
      const rows = await fetchRows(from, to);
      const o: Opts = { scope, from, to, courier, store: st };
      if (layout === "board") {
        if (kind === "xlsx") downloadBoardExcel(rows, o); else downloadBoardPdf(rows, o);
      } else {
        const sorted = rows.slice().sort((a, b) =>
          String(a.courier ?? "").localeCompare(String(b.courier ?? ""))
          || String(b.return_date ?? "").localeCompare(String(a.return_date ?? "")));
        const table: ExportTable = {
          title: scope === "pending" ? "Pending returns" : "Returns",
          headers: ["#", "Courier", "Store", "Order", "Returned", "Tracking", "Customer", "City", "Phone", "COD"],
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
      <button onClick={() => { setSt(store); setErr(""); setOpen(true); }}
        className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
        <Printer size={14} /> Print / download
      </button>

      <Modal open={open} onClose={() => !busy && setOpen(false)}
             title="Print pending returns"
             subtitle="PostEx and OwnEx side by side, split by store — order number and date, newest first.">
        <div className="grid gap-4">
          <Field label="What to print">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setScope("pending")} className={chip(scope === "pending")}>Pending returns</button>
              <button type="button" onClick={() => setScope("period")} className={chip(scope === "period")}>All returns in a period</button>
            </div>
          </Field>
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
const BASE_CSS = `
  @page { size: A4 landscape; margin: 9mm 8mm 11mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10px/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 10px; background: #fff; }
  @media screen { body { max-width: 1140px; margin: 0 auto; } }
  .head { display: flex; justify-content: space-between; align-items: stretch; gap: 10px; margin-bottom: 9px; }
  .head h1 { font-size: 18px; margin: 0; }
  .head .sub { font-size: 10.5px; color: #444; margin-top: 3px; }
  .card { border: 1px solid #5F5E5A; background: #F1EFE8; border-radius: 7px; padding: 5px 14px; text-align: center; min-width: 150px; }
  .card .k { font-size: 10px; font-weight: 700; color: #444441; }
  .card .v { font-size: 17px; font-weight: 800; line-height: 1.2; }
  .card.pend { background: #EEEDFE; border-color: #534AB7; color: #3C3489; }
  .card.pend .k { color: #3C3489; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .sign { display: flex; gap: 26px; margin-top: 14px; font-size: 10.5px; }
  .sign div { flex: 1; border-top: 1px solid #000; padding-top: 4px; }
  .key { font-size: 9.5px; color: #333; margin-top: 7px; }
`;

function head(rows: R[], o: Opts) {
  const printed = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const title = o.scope === "pending" ? "Pending returns" : "Returns";
  const what = o.scope === "pending"
    ? "Not yet received or cancelled — the same list as the Pending tab"
    : `Returned ${o.from && o.to ? `${long(o.from)} – ${long(o.to)}` : "at any time"}`;
  const scope = `${STORE_NAME[o.store] ?? o.store} · ${o.courier === "Both" ? "PostEx & OwnEx" : o.courier}`;
  const count = o.scope === "pending" ? rows.length : rows.filter((r) => !r.person_received).length;
  return `
  <div class="head">
    <div><h1>${esc(title)}</h1><div class="sub">Grohub Solutions · ${esc(scope)}</div><div class="sub">${esc(what)}</div></div>
    <div style="display:flex;gap:10px">
      <div class="card pend"><div class="k">${o.scope === "pending" ? "PENDING" : "PENDING OF " + rows.length}</div><div class="v">${count}</div></div>
      <div class="card"><div class="k">PRINTED ON</div><div class="v" style="font-size:13px">${esc(printed)}</div><div class="k" style="font-weight:400">${esc(time)}</div></div>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- the board */
function boardHtml(rows: R[], o: Opts) {
  const couriers = o.courier === "Both" ? ["PostEx", "OwnEx"] : [o.courier];
  // A courier or store outside the usual set is still printed, never dropped.
  for (const r of rows) { const c = r.courier || "Other"; if (!couriers.includes(c)) couriers.push(c); }
  const stores = o.store === "ALL" ? [...STORES] : [o.store];
  for (const r of rows) { const s = r.store_code || "—"; if (!stores.includes(s)) stores.push(s); }

  type Col = { courier: string; store: string; list: R[] };
  const cols: Col[] = [];
  for (const c of couriers) for (const s of stores) {
    cols.push({
      courier: c, store: s,
      list: rows.filter((r) => (r.courier || "Other") === c && (r.store_code || "—") === s)
        .sort((a, b) => String(b.return_date ?? "").localeCompare(String(a.return_date ?? ""))
                     || String(b.order_number ?? "").localeCompare(String(a.order_number ?? ""))),
    });
  }
  const depth = Math.max(0, ...cols.map((c) => c.list.length));
  const tone = (c: string) => TONE[c] ?? TONE.Other;
  const isPend = (r: R) => o.scope === "pending" || !r.person_received;

  const courierRow = `<th rowspan="2" class="seq">#</th>` + couriers.map((c) => {
    const inC = rows.filter((r) => (r.courier || "Other") === c);
    const t = tone(c);
    return `<th colspan="${stores.length}" class="courier split" style="background:${t.fill};border-color:${t.line};color:${t.ink}">
      ${esc(c)} <span class="cnt">· ${inC.filter(isPend).length}${o.scope === "period" ? ` pending of ${inC.length}` : " pending"}</span></th>`;
  }).join("");

  const storeRow = cols.map((col, i) => {
    const t = tone(col.courier);
    const first = i % stores.length === 0;
    return `<th class="store${first ? " split" : ""}" style="background:${t.fill};color:${t.ink}">
      <div class="sn">${esc(STORE_NAME[col.store] ?? col.store)}</div><div class="sc">${col.list.filter(isPend).length}</div></th>`;
  }).join("");

  let body = "";
  for (let i = 0; i < depth; i++) {
    body += `<tr><td class="seq">${i + 1}</td>` + cols.map((col, ci) => {
      const r = col.list[i];
      const split = ci % stores.length === 0 ? " split" : "";
      if (!r) return `<td class="cell${split}"></td>`;
      const got = !isPend(r);
      return `<td class="cell${got ? " got" : ""}${split}">
        <span class="bx">${got ? "&#10003;" : ""}</span><span class="on">${esc(r.order_number ?? r.tracking_id)}</span><span class="dt">${esc(dd(r.return_date))}</span>
      </td>`;
    }).join("") + "</tr>";
  }
  if (!depth) body = `<tr><td class="cell" colspan="${cols.length + 1}" style="text-align:center;padding:24px">No pending returns. Nothing to chase.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${o.scope === "pending" ? "Pending returns" : "Returns"}</title>
<style>${BASE_CSS}
  table.board { table-layout: fixed; }
  th, td { border: 1px solid #9a9892; }
  th.seq, td.seq { width: 30px; text-align: center; background: #F1EFE8; font-weight: 700; color: #444; }
  th.courier { font-size: 14px; padding: 6px 8px; text-align: center; border-width: 1.5px; }
  th.courier .cnt { font-size: 11px; font-weight: 600; }
  th.store { padding: 4px 6px; text-align: center; }
  th.store .sn { font-size: 11.5px; font-weight: 800; }
  th.store .sc { font-size: 10px; font-weight: 600; }
  td.cell { padding: 4px 6px; height: 24px; white-space: nowrap; overflow: hidden; vertical-align: middle; }
  td.cell .bx { display: inline-block; width: 11px; height: 11px; border: 1px solid #222; margin-right: 6px; vertical-align: -1px; font-size: 9px; line-height: 10px; text-align: center; }
  td.cell .on { font-weight: 700; font-size: 11.5px; }
  td.cell .dt { color: #555; font-size: 9.5px; margin-left: 6px; }
  td.cell.got { background: #EAF3DE; }
  td.cell.got .on { text-decoration: line-through; color: #27500A; }
  .split { border-left: 2.5px solid #333 !important; }
</style></head><body>
  ${head(rows, o)}
  <table class="board">
    <thead><tr>${courierRow}</tr><tr>${storeRow}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="key"><b>&#9744;</b> tick when the parcel arrives &nbsp;·&nbsp; strike the order through once it is in hand and cancelled in Shopify
    &nbsp;·&nbsp; each column newest first &nbsp;·&nbsp; date = the day the courier returned it</div>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div></div>
</body></html>`;
}

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
        <b>${esc(k)}</b> · ${list.length} return${list.length === 1 ? "" : "s"}</td></tr>
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
  ${head(rows, o)}
  <table>
    <thead><tr><th>#</th><th class="bx">&#9744;</th><th>Order</th><th>Store</th><th>Returned</th><th>Tracking</th><th>Customer</th>
      <th>City</th><th>Phone</th><th>COD</th></tr></thead>
    ${body || `<tbody><tr><td colspan="10" class="c" style="padding:24px">No returns to print.</td></tr></tbody>`}
  </table>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div></div>
</body></html>`;
}
