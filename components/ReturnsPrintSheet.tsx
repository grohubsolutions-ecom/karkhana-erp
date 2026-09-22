"use client";
/* THE RETURNS BOARD — the printout the team works through with a pencil.
 *
 * THE LAYOUT IS THE OWNER'S OWN DRAWING
 *     All returns (grand total) · Pending RTS (not received) · Date (fills itself)
 *                      PostEx                  |                 OwnEx
 *            LM    ·    TS    ·    TRZ         |       LM    ·    TS    ·    TRZ
 *        each column: that store's returns, newest first
 *        a parcel in hand is struck off
 *   One column per courier-and-store, because that is how parcels arrive: a
 *   courier's bag, sorted by store. Finding #TS3066 means looking down one
 *   column, not reading a mixed list.
 *
 * "RECEIVED" MEANS A PERSON HAS IT
 *   The system also closes a return when a CPR settles it or the 9-day rule
 *   runs out. In the 30 days to 22 Sep that was every closed return — 90 by CPR,
 *   165 aged — and not one confirmed by a person. Striking those off would have
 *   printed a board that was nearly all crossed out while nothing was on the
 *   shelf. hub_returns_board (H239) says who actually confirmed it; only those
 *   are struck off.
 *
 * WHY EVERY RETURN IN THE PERIOD
 *   A CPR-closed return can still be a live sale in Shopify. The sheet is also
 *   the cancel list, so nothing in the period is left off; SC marks the ones
 *   Shopify already has cancelled.
 *
 * WHY A NEW WINDOW, OPENED BEFORE THE DATA ARRIVES
 *   Printing the app itself drags in the sidebar, filters and dark theme. A
 *   window of its own carries only the sheet. It is opened in the tap and filled
 *   afterwards, because phones block a window opened after an await.
 */
import { useState } from "react";
import { Printer, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rangeDates } from "@/lib/dateRange";
import Modal, { btnPrimary, btnGhost, inputCls, Field } from "@/components/Modal";

type R = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; cod_amount: number | null; return_date: string | null;
  customer_name: string | null; city: string | null; phone: string | null;
  reason: string | null; shopify_cancelled: boolean; person_received: boolean;
  closed_how: string | null;
};
type Opts = { from: string | null; to: string | null; courier: string; store: string; onlyPending: boolean };

const PERIODS = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "60d", label: "Last 60 days" },
  { key: "all", label: "All time" },
];
const STORES = ["LM", "TS", "TRZ"];
const STORE_NAME: Record<string, string> = { ALL: "All stores", LM: "Little Minors", TS: "TopShop", TRZ: "Trenzee" };
/* The drawing's own colours: PostEx blue, OwnEx green, pending purple. */
const TONE: Record<string, { fill: string; line: string; ink: string }> = {
  PostEx: { fill: "#E6F1FB", line: "#185FA5", ink: "#0C447C" },
  OwnEx:  { fill: "#E1F5EE", line: "#0F6E56", ink: "#085041" },
  Other:  { fill: "#F1EFE8", line: "#5F5E5A", ink: "#444441" },
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number) => "Rs " + Math.round(n).toLocaleString("en-PK");
const num = (n: number) => Math.round(n).toLocaleString("en-PK");
const dd = (s: string | null) => {
  if (!s) return "—";
  const x = new Date(s + "T00:00:00");
  return isNaN(x.getTime()) ? s : x.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const long = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const short = (t: string | null, n: number) => { const s = (t ?? "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export default function ReturnsPrintButton({ store = "ALL" }: { store?: string }) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<"board" | "list">("board");
  const [period, setPeriod] = useState("7d");
  const [courier, setCourier] = useState("Both");
  const [st, setSt] = useState(store);
  const [onlyPending, setOnlyPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function print() {
    if (!supabase) return;
    setErr("");
    const w = window.open("", "_blank");
    if (!w) { setErr("The browser blocked the print window. Allow pop-ups for this site and press Print again."); return; }
    w.document.write("<p style='font:14px system-ui;padding:24px'>Preparing the returns sheet…</p>");
    setBusy(true);
    try {
      const [from, to] = rangeDates(period);
      /* Paged. "All time" runs to thousands and every request stops at 1,000;
         a board that silently ended at row 1,000 is a checklist with its end
         torn off. */
      const all: R[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.rpc("hub_returns_board", {
          p_from: from, p_to: to,
          p_courier: courier === "Both" ? null : courier,
          p_store: st === "ALL" ? null : st,
        }).range(off, off + 999);
        if (error) {
          throw new Error(/schema cache|does not exist|Could not find the function/i.test(error.message)
            ? "The database function for this sheet (H239) is missing. It was applied on 22 Sep — if this is a new database, run H239 first."
            : error.message);
        }
        all.push(...((data ?? []) as R[]));
        if (!data || data.length < 1000) break;
      }
      const rows = onlyPending ? all.filter((r) => !r.person_received) : all;
      const o: Opts = { from, to, courier, store: st, onlyPending };

      w.document.open();
      w.document.write(layout === "board" ? boardHtml(rows, o) : listHtml(rows, o));
      w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch { /* the sheet stays open to print by hand */ } }, 350);
      setOpen(false);
    } catch (e) {
      w.close();
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const chip = (on: boolean) =>
    `rounded-full border px-3.5 py-2 text-[12.5px] font-semibold transition ${on
      ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
      : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10"}`;

  return (
    <>
      <button onClick={() => { setSt(store); setErr(""); setOpen(true); }}
        className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
        <Printer size={14} /> Print sheet
      </button>

      <Modal open={open} onClose={() => !busy && setOpen(false)}
             title="Print the returns sheet"
             subtitle="Every return in the period — ticked when it arrives, struck off once it is in hand.">
        <div className="grid gap-4">
          <Field label="Layout">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setLayout("board")} className={chip(layout === "board")}>Board — courier × store columns</button>
              <button type="button" onClick={() => setLayout("list")} className={chip(layout === "list")}>Detailed list</button>
            </div>
          </Field>
          <Field label="Returned in">
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((p) => (
                <button key={p.key} type="button" onClick={() => setPeriod(p.key)} className={chip(period === p.key)}>{p.label}</button>
              ))}
            </div>
          </Field>
          <Field label="Courier">
            <div className="flex flex-wrap gap-2">
              {["Both", "PostEx", "OwnEx"].map((c) => (
                <button key={c} type="button" onClick={() => setCourier(c)} className={chip(courier === c)}>{c}</button>
              ))}
            </div>
          </Field>
          <Field label="Store">
            <select className={inputCls} value={st} onChange={(e) => setSt(e.target.value)}>
              {Object.entries(STORE_NAME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <label className="flex items-start gap-2.5 text-[13px] text-ink dark:text-[#e7e2d8]">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
            <span>Only <b>pending RTS</b> — not yet received
              <span className="block text-[12px] text-muted dark:text-[#a89f93]">Leave off to print every return; the ones already received print struck off.</span></span>
          </label>
        </div>

        {err && <div className="mt-3 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className={btnPrimary} disabled={busy} onClick={print}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Print
          </button>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ shared bits */
function headerBits(rows: R[], o: Opts) {
  const pending = rows.filter((r) => !r.person_received).length;
  const cod = rows.reduce((t, r) => t + (Number(r.cod_amount) || 0), 0);
  const notCancelled = rows.filter((r) => !r.shopify_cancelled).length;
  const printed = new Date().toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const period = o.from && o.to ? `${long(o.from)} – ${long(o.to)}` : "All time";
  const scope = `${STORE_NAME[o.store] ?? o.store} · ${o.courier === "Both" ? "PostEx & OwnEx" : o.courier}${o.onlyPending ? " · pending only" : ""}`;
  return { pending, cod, notCancelled, printed, period, scope };
}

const BASE_CSS = `
  @page { size: A4 landscape; margin: 9mm 8mm 11mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10px/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 10px; background: #fff; }
  @media screen { body { max-width: 1140px; margin: 0 auto; } }
  .title { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 7px; }
  .title h1 { font-size: 17px; margin: 0; letter-spacing: -.01em; }
  .title .sub { font-size: 10.5px; color: #444; margin-top: 2px; }
  .strip { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 10px; margin-bottom: 9px; }
  .card { border: 1px solid; border-radius: 7px; padding: 6px 10px; text-align: center; }
  .card .k { font-size: 11px; font-weight: 700; }
  .card .v { font-size: 20px; font-weight: 800; line-height: 1.15; }
  .card .s { font-size: 9.5px; }
  .neutral { background: #F1EFE8; border-color: #5F5E5A; color: #444441; }
  .pend { background: #EEEDFE; border-color: #534AB7; color: #3C3489; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .sign { display: flex; gap: 26px; margin-top: 14px; font-size: 10.5px; }
  .sign div { flex: 1; border-top: 1px solid #000; padding-top: 4px; }
  .key { font-size: 9.5px; color: #333; margin-top: 7px; }
`;

function strip(rows: R[], o: Opts) {
  const h = headerBits(rows, o);
  return `
  <div class="title">
    <div><h1>Returns board</h1><div class="sub">Grohub Solutions · ${esc(h.scope)} · returned ${esc(h.period)}</div></div>
    <div class="sub" style="text-align:right">Newest first in every column</div>
  </div>
  <div class="strip">
    <div class="card neutral"><div class="k">All returns</div><div class="v">${rows.length}</div><div class="s">Grand total · COD ${esc(money(h.cod))}</div></div>
    <div class="card pend"><div class="k">Pending RTS</div><div class="v">${h.pending}</div><div class="s">not received yet · ${h.notCancelled} still live in Shopify</div></div>
    <div class="card neutral"><div class="k">Date</div><div class="v" style="font-size:14px;padding:3px 0">${esc(h.printed)}</div><div class="s">filled in automatically</div></div>
  </div>`;
}

/* -------------------------------------------------------------- the board */
function boardHtml(rows: R[], o: Opts) {
  const couriers = o.courier === "Both" ? ["PostEx", "OwnEx"] : [o.courier];
  // Any courier outside the two is still printed, never silently dropped.
  for (const r of rows) { const c = r.courier || "Other"; if (!couriers.includes(c)) couriers.push(c); }
  const stores = o.store === "ALL" ? [...STORES] : [o.store];
  for (const r of rows) { const s = r.store_code || "—"; if (!stores.includes(s)) stores.push(s); }

  type Col = { courier: string; store: string; list: R[] };
  const cols: Col[] = [];
  for (const c of couriers) for (const s of stores) {
    const list = rows.filter((r) => (r.courier || "Other") === c && (r.store_code || "—") === s)
      .sort((a, b) => String(b.return_date ?? "").localeCompare(String(a.return_date ?? ""))
                   || String(b.order_number ?? "").localeCompare(String(a.order_number ?? "")));
    cols.push({ courier: c, store: s, list });
  }
  const depth = Math.max(0, ...cols.map((c) => c.list.length));
  const tone = (c: string) => TONE[c] ?? TONE.Other;

  const courierRow = couriers.map((c, ci) => {
    const inC = rows.filter((r) => (r.courier || "Other") === c);
    const p = inC.filter((r) => !r.person_received).length;
    const t = tone(c);
    return `<th colspan="${stores.length}" class="courier ${ci > 0 ? "split" : ""}" style="background:${t.fill};border-color:${t.line};color:${t.ink}">
      ${esc(c)} <span class="cnt">· ${p} pending of ${inC.length}</span></th>`;
  }).join("");

  const storeRow = cols.map((col, i) => {
    const t = tone(col.courier);
    const p = col.list.filter((r) => !r.person_received).length;
    const first = i % stores.length === 0 && i > 0;
    return `<th class="store ${first ? "split" : ""}" style="background:${t.fill};color:${t.ink}">
      <div class="sn">${esc(col.store)}</div><div class="sc">${p} pending${col.list.length !== p ? ` · ${col.list.length} total` : ""}</div></th>`;
  }).join("");

  let body = "";
  for (let i = 0; i < depth; i++) {
    body += "<tr>" + cols.map((col, ci) => {
      const r = col.list[i];
      const split = ci % stores.length === 0 && ci > 0 ? " split" : "";
      if (!r) return `<td class="cell empty${split}"></td>`;
      const got = r.person_received;
      return `<td class="cell${got ? " got" : ""}${split}">
        <span class="bx">${got ? "&#10003;" : ""}</span><span class="on">${esc(r.order_number ?? r.tracking_id)}</span>
        <span class="meta">${esc(dd(r.return_date))} · ${esc(num(Number(r.cod_amount) || 0))}${r.shopify_cancelled ? ` · <b>SC</b>` : ""}</span>
      </td>`;
    }).join("") + "</tr>";
  }
  if (!depth) body = `<tr><td class="cell" colspan="${cols.length}" style="text-align:center;padding:24px">No returns in this period.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Returns board</title>
<style>${BASE_CSS}
  th, td { border: 1px solid #9a9892; }
  th.courier { font-size: 13px; padding: 6px 8px; text-align: center; border-width: 1.5px; }
  th.courier .cnt { font-size: 10.5px; font-weight: 600; }
  th.store { padding: 4px 6px; text-align: center; }
  th.store .sn { font-size: 12.5px; font-weight: 800; }
  th.store .sc { font-size: 9.5px; font-weight: 600; }
  table.board { table-layout: fixed; }             /* every store column the same width */
  td.cell { padding: 3px 5px; height: 21px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  td.cell .bx { display: inline-block; width: 11px; height: 11px; border: 1px solid #222; margin-right: 5px; vertical-align: -1px; font-size: 9px; line-height: 10px; text-align: center; }
  td.cell .on { font-weight: 700; font-size: 10.5px; }
  td.cell .meta { color: #555; font-size: 8.5px; margin-left: 4px; }
  td.cell.got { background: #EAF3DE; }
  td.cell.got .on { text-decoration: line-through; color: #27500A; }
  td.cell.got .meta { color: #3B6D11; }
  .split { border-left: 2.5px solid #333 !important; }
</style></head><body>
  ${strip(rows, o)}
  <table class="board">
    <thead><tr>${courierRow}</tr><tr>${storeRow}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="key"><b>&#9744;</b> tick when the parcel arrives &nbsp;·&nbsp; strike the order number through once it is in hand
    &nbsp;·&nbsp; printed struck off = already confirmed received in the system &nbsp;·&nbsp; <b>SC</b> = already cancelled in Shopify (the rest still need cancelling)
    &nbsp;·&nbsp; each entry: order · returned date · COD</div>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div><div>Date</div></div>
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
    const list = groups.get(k)!.slice().sort((a, b) =>
      String(b.return_date ?? "").localeCompare(String(a.return_date ?? "")));
    const p = list.filter((r) => !r.person_received).length;
    const cod = list.reduce((s, r) => s + (Number(r.cod_amount) || 0), 0);
    return `<tbody><tr><td colspan="12" class="grp" style="background:${t.fill};color:${t.ink};border-color:${t.line}">
        <b>${esc(k)}</b> · ${list.length} returns · <b>${p} pending</b> · COD ${esc(money(cod))}</td></tr>
      ${list.map((r) => {
        n += 1; const got = r.person_received;
        return `<tr class="${got ? "got" : ""}">
          <td class="c">${n}</td><td class="bx">${got ? "&#10003;" : ""}</td>
          <td class="b on">${esc(r.order_number ?? "—")}</td><td class="c">${esc(r.store_code ?? "")}</td>
          <td class="mono">${esc(r.tracking_id)}</td><td class="wrap">${esc(r.customer_name ?? "")}</td>
          <td>${esc(short(r.city, 16))}</td><td class="mono">${esc(r.phone ?? "")}</td>
          <td class="r">${esc(num(Number(r.cod_amount) || 0))}</td><td class="c">${esc(dd(r.return_date))}</td>
          <td class="small">${esc(short(r.reason, 28))}</td>
          <td class="c small">${r.shopify_cancelled ? "SC" : "<b>live</b>"}</td>
        </tr>`;
      }).join("")}</tbody>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Returns list</title>
<style>${BASE_CSS}
  th, td { border: 1px solid #000; padding: 3px 5px; white-space: nowrap; vertical-align: middle; }
  thead th { background: #e6e6e6; font-size: 9px; text-transform: uppercase; }
  td.wrap { white-space: normal; } .c { text-align: center; } .r { text-align: right; }
  .b { font-weight: 700; } .mono { font-family: "Courier New", monospace; font-size: 9.5px; }
  .small { font-size: 9px; } .bx { width: 22px; text-align: center; }
  td.grp { padding: 5px 7px; font-size: 11px; border-width: 1.5px; }
  tr.got td { background: #EAF3DE; color: #3B6D11; } tr.got .on { text-decoration: line-through; }
</style></head><body>
  ${strip(rows, o)}
  <table>
    <thead><tr><th>#</th><th class="bx">Rcvd</th><th>Order</th><th>Store</th><th>Tracking</th><th>Customer</th>
      <th>City</th><th>Phone</th><th>COD</th><th>Returned</th><th>Reason</th><th>Shopify</th></tr></thead>
    ${body || `<tbody><tr><td colspan="12" class="c" style="padding:24px">No returns in this period.</td></tr></tbody>`}
  </table>
  <div class="key"><b>Rcvd</b> — tick when the parcel is in hand; struck off = already confirmed. <b>live</b> = still an open sale in Shopify, cancel it. <b>SC</b> = already cancelled in Shopify.</div>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div><div>Date</div></div>
</body></html>`;
}
