"use client";
/* ORDERS (K196). All orders, or one store's, by status. LPO comes in -> invoice -> delivered -> receiving
   number. The status is worked out by the database from what has been
   recorded; nobody sets it by hand. */
import { useMemo, useState } from "react";
import { Download, FileText, Loader2, Printer, Upload } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { exportExcel } from "@/lib/export";
import { Notice, Rows, Stat, day, inp, qty, rs, today, useLoad } from "@/components/carrefour/kit";
import LineEditor, { lineTotals, useArticles, type Line } from "@/components/carrefour/lines";
import { openDoc, printCarrefourInvoice, uploadDoc } from "@/components/carrefour/docs";

type OLine = { id: number; barcode: string; description: string | null; qty: number; price: number; received_qty: number | null };
type Order = { id: string; lpo_no: string; status: string; branch_id: string; shop: string; lpo_date: string | null;
  delivery_date: string | null; file_path: string | null; file_name: string | null; note: string | null; invoice_no: string | null;
  invoice_date: string | null; receiving_no: string | null; receiving_date: string | null; receiving_path: string | null;
  receiving_name: string | null; cancel_reason: string | null; pieces: number; gross: number; received: number | null;
  received_value: number | null; lines: OLine[] };
type Shop = { branch_id: string; name: string };

const TABS = [{ k: "all", l: "All orders" }, { k: "open", l: "Open" }, { k: "pending", l: "Pending" }, { k: "delivered", l: "Delivered" }, { k: "cancelled", l: "Cancelled" }];
const blank = () => ({ id: "", lpo_no: "", branch_id: "", lpo_date: today(), delivery_date: "", note: "", file: null as File | null, lines: [{ barcode: "", description: "", qty: "", price: "" }] as Line[] });
const btn = "flex items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink";
const TONE: Record<string, string> = {
  open: "bg-periwinkle-soft text-[#1e3a8a]", pending: "bg-amber-soft text-[#7c4a03]",
  delivered: "bg-success-soft text-[#166534]", cancelled: "bg-panel text-muted",
};
const LABEL: Record<string, string> = { open: "Open", pending: "Pending", delivered: "Delivered", cancelled: "Cancelled" };
/* Carrefour's shops as people say them, not as the warehouse spelt them. */
const STORE: Record<string, string> = { "Fotress Lahore": "Fortress", "Emporium lahore": "Emporium", "Packages Lahore": "Packages",
  "Islamabad WTC": "Islamabad", "Karachi Lucky 1": "Lucky One", "Faislabad Mall": "Lyallpur", "GUGRANWALA": "Gujranwala", "Karachi Dolmen Mall": "Dolmen" };
const store = (n: string) => STORE[n] ?? n;
const save = "flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50";

export default function CarrefourOrders() {
  const { can } = usePermissions();
  const manage = can(["carrefour.orders.manage"]);
  const ask = useConfirm();
  const { data, err: loadErr, loading, load } = useLoad<Order[]>(() => supabase!.rpc("carrefour_orders"));
  const shops = useLoad<Shop[]>(() => supabase!.rpc("carrefour_shops"));
  const arts = useArticles();
  const [tab, setTab] = useState("all");
  const [shop, setShop] = useState("");
  const [q, setQ] = useState("");
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [openId, setOpenId] = useState("");
  const [inv, setInv] = useState<{ no: string; date: string } | null>(null);
  const [rcv, setRcv] = useState<{ no: string; date: string; file: File | null; lines: Record<number, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const all = useMemo(() => data ?? [], [data]);
  const inShop = useMemo(() => all.filter((o) => !shop || o.branch_id === shop), [all, shop]);
  const count = (k: string) => (k === "all" ? inShop.length : inShop.filter((o) => o.status === k).length);
  const late = (o: Order) => (o.status === "open" || o.status === "pending") && !!o.delivery_date && o.delivery_date < today();
  const stores = useMemo(() => {
    const m = new Map<string, { id: string; name: string; rows: Order[] }>();
    all.forEach((o) => { if (!m.has(o.branch_id)) m.set(o.branch_id, { id: o.branch_id, name: store(o.shop), rows: [] }); m.get(o.branch_id)!.rows.push(o); });
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [all]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return inShop.filter((o) => (tab === "all" || o.status === tab) && (!t || o.lpo_no.toLowerCase().includes(t) || o.shop.toLowerCase().includes(t)
      || (o.invoice_no ?? "").toLowerCase().includes(t) || o.lines.some((l) => l.barcode.includes(t))));
  }, [inShop, tab, q]);
  const cur = all.find((o) => o.id === openId) ?? null;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : "Could not save."); }
    setBusy(false);
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(name, args);
    if (error) throw new Error(error.message);
  };

  function pickFile(file: File | null) {
    if (!f) return;
    const m = file?.name.match(/(\d{8})/);   // Carrefour names them Order-24021035.pdf
    setF({ ...f, file, lpo_no: f.lpo_no || (m ? m[1] : "") });
  }
  function saveLpo() {
    if (!f) return;
    const lines = f.lines.filter((l) => l.barcode.trim());
    run(async () => {
      const up = f.file ? await uploadDoc(f.file, "lpo") : null;
      await rpc("carrefour_save_lpo", { p: { id: f.id || null, lpo_no: f.lpo_no, branch_id: f.branch_id, lpo_date: f.lpo_date, delivery_date: f.delivery_date,
        note: f.note, file_path: up?.path ?? null, file_name: up?.name ?? null,
        lines: lines.map((l) => ({ ...l, qty: Number(l.qty), price: Number(l.price) || 0 })) } });
      setF(null); arts.load();
    });
  }
  function saveRcv() {
    if (!cur || !rcv) return;
    run(async () => {
      const up = rcv.file ? await uploadDoc(rcv.file, "receiving") : null;
      await rpc("carrefour_set_receiving", { p_id: cur.id, p_no: rcv.no, p_date: rcv.date || null, p_path: up?.path ?? null, p_name: up?.name ?? null,
        p_lines: cur.lines.map((l) => ({ id: l.id, received_qty: Number(rcv.lines[l.id] ?? l.qty) })) });
      setRcv(null);
    });
  }
  async function cancel(o: Order) {
    const ok = await ask({ title: `Cancel LPO ${o.lpo_no}?`, body: "It moves to Cancelled and can be brought back.", confirmLabel: "Cancel LPO" });
    if (ok) run(() => rpc("carrefour_cancel_lpo", { p_id: o.id, p_reason: null, p_undo: false }));
  }
  const edit = (o: Order) => { setErr(""); setOpenId(""); setF({ id: o.id, lpo_no: o.lpo_no, branch_id: o.branch_id, lpo_date: o.lpo_date ?? "", delivery_date: o.delivery_date ?? "", note: o.note ?? "", file: null,
    lines: o.lines.map((l) => ({ barcode: l.barcode, description: l.description ?? "", qty: String(l.qty), price: String(l.price) })) }); };
  const short = (o: Order) => (o.received == null ? 0 : Number(o.pieces) - Number(o.received));
  const noItems = rows.filter((o) => !o.lines.length).length;
  function saveXls() {
    exportExcel({ title: "Carrefour orders", headers: ["LPO", "Store", "Status", "LPO date", "Delivery date", "Pieces", "Gross", "Invoice", "Receiving"],
      rows: rows.map((o) => [o.lpo_no, store(o.shop), LABEL[o.status], o.lpo_date, o.delivery_date, o.pieces, o.gross, o.invoice_no, o.receiving_no]) });
  }
  const doc = (p: string) => openDoc(p).catch((e) => setErr(e.message));

  return (
    <div className="pb-10">
      <Topbar title="Orders" subtitle="All Carrefour LPOs, by store and status" />
      <div className="space-y-4 px-6">
        {(err || loadErr) && !f && !rcv && !inv && <Notice tone="danger">{err || loadErr}</Notice>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Open" value={qty(count("open"))} />
          <Stat label="Pending delivery" value={qty(count("pending"))} />
          <Stat label="Delivered" value={qty(count("delivered"))} />
          <Stat label="Past delivery date" value={qty(inShop.filter(late).length)} tone={inShop.some(late) ? "danger" : undefined} />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-bold text-ink">By store</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <button onClick={() => setShop("")} className={`rounded-xl2 border p-3 text-left ${!shop ? "border-ink bg-surface" : "border-line bg-surface"}`}>
              <span className="block text-[13.5px] font-bold text-ink">All stores</span>
              <span className="text-[12px] text-muted">{all.length} orders</span>
            </button>
            {stores.map((x) => (
              <button key={x.id} onClick={() => setShop(x.id)} className={`rounded-xl2 border p-3 text-left ${shop === x.id ? "border-ink bg-surface" : "border-line bg-surface"}`}>
                <span className="block text-[13.5px] font-bold text-ink">{x.name}</span>
                <span className="text-[12px] text-muted">{x.rows.length} orders · {x.rows.filter((o) => o.status === "open").length} open</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${tab === t.k ? "bg-ink text-white" : "border border-line bg-surface text-muted"}`}>{t.l} ({count(t.k)})</button>
          ))}
          <button onClick={saveXls} disabled={!rows.length} className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"><Download size={14} /> Excel</button>
          {manage && <button onClick={() => { setErr(""); setF(blank()); }} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Upload size={15} /> Upload LPO</button>}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search LPO, invoice, store or barcode" className={inp} />
        {noItems > 0 && <Notice>{noItems} of these orders have no items entered yet, so their pieces and value show as zero. Open an order and choose Edit LPO to add them.</Notice>}
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={rows} rowKey={(o) => o.id} empty="No orders here." cols={[
            { label: "LPO", cell: (o) => <button onClick={() => { setErr(""); setOpenId(o.id); }} className="font-mono font-semibold underline">{o.lpo_no}</button> },
            { label: "Store", cell: (o) => store(o.shop) },
            { label: "LPO date", cell: (o) => day(o.lpo_date) },
            { label: "Delivery date", cell: (o) => <span className={late(o) ? "font-bold text-[#b42318]" : ""}>{day(o.delivery_date)}</span> },
            { label: "Status", cell: (o) => <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${TONE[o.status]}`}>{LABEL[o.status]}</span> },
            { label: "Pieces", right: true, cell: (o) => (o.lines.length ? qty(o.pieces) : "—") },
            { label: "Gross", right: true, cell: (o) => (o.lines.length ? rs(o.gross) : "—") },
            { label: "Invoice", cell: (o) => o.invoice_no ?? "—" },
            { label: "Receiving", cell: (o) => o.receiving_no ?? "—" },
          ]} />
        )}
      </div>

      <Modal open={!!cur && !inv && !rcv} onClose={() => setOpenId("")} wide title={cur ? `LPO ${cur.lpo_no}` : ""} subtitle={cur ? `${store(cur.shop)} · ${LABEL[cur.status]}` : undefined}>
        {cur && <div className="space-y-3 text-[13px]">
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="grid grid-cols-2 gap-2">
            <p><span className="text-muted">LPO date</span><br />{day(cur.lpo_date)}</p>
            <p><span className="text-muted">Delivery date</span><br />{day(cur.delivery_date)}</p>
            <p><span className="text-muted">Gross</span><br /><b>{qty(cur.pieces)} pcs · {rs(cur.gross)}</b></p>
            <p><span className="text-muted">Invoice</span><br />{cur.invoice_no ? `${cur.invoice_no} · ${day(cur.invoice_date)}` : "Not made"}</p>
            {cur.receiving_no && <>
              <p><span className="text-muted">Receiving</span><br />{cur.receiving_no} · {day(cur.receiving_date)}</p>
              <p><span className="text-muted">Received</span><br /><b className={short(cur) > 0 ? "text-[#b42318]" : ""}>{qty(cur.received)} pcs · {rs(cur.received_value)}</b>{short(cur) > 0 ? ` (${qty(short(cur))} short)` : ""}</p>
            </>}
          </div>
          <Rows rows={cur.lines} rowKey={(l) => String(l.id)} empty="No lines." cols={[
            { label: "Barcode", cell: (l) => <span className="font-mono">{l.barcode}</span> },
            { label: "Item", cell: (l) => l.description ?? "—" },
            { label: "Qty", right: true, cell: (l) => qty(l.qty) },
            { label: "Price", right: true, cell: (l) => qty(l.price) },
            { label: "Amount", right: true, cell: (l) => rs(Number(l.qty) * Number(l.price)) },
            { label: "Received", right: true, cell: (l) => (l.received_qty == null ? "—" : qty(l.received_qty)) },
          ]} />
          <div className="flex flex-wrap gap-2">
            {cur.file_path && <button className={btn} onClick={() => doc(cur.file_path!)}><FileText size={14} /> LPO PDF</button>}
            {cur.receiving_path && <button className={btn} onClick={() => doc(cur.receiving_path!)}><FileText size={14} /> Receiving proof</button>}
            {cur.invoice_no && <button className={btn} onClick={() => printCarrefourInvoice({ ...cur, shop: store(cur.shop) })}><Printer size={14} /> Print invoice</button>}
            {manage && cur.status !== "cancelled" && <>
              <button className={btn} onClick={() => { setErr(""); setInv({ no: cur.invoice_no ?? "", date: cur.invoice_date ?? today() }); }}>{cur.invoice_no ? "Edit invoice" : "Make invoice"}</button>
              {cur.invoice_no && <button className={btn} onClick={() => { setErr(""); setRcv({ no: cur.receiving_no ?? "", date: cur.receiving_date ?? today(), file: null, lines: Object.fromEntries(cur.lines.map((l) => [l.id, String(l.received_qty ?? l.qty)])) }); }}>{cur.receiving_no ? "Edit receiving" : "Enter receiving"}</button>}
              <button className={btn} onClick={() => edit(cur)}>Edit LPO</button>
              {!cur.receiving_no && <button className={`${btn} text-[#b42318]`} onClick={() => cancel(cur)}>Cancel LPO</button>}
            </>}
            {manage && cur.status === "cancelled" && <button className={btn} onClick={() => run(() => rpc("carrefour_cancel_lpo", { p_id: cur.id, p_reason: null, p_undo: true }))}>Bring back</button>}
          </div>
        </div>}
      </Modal>

      <Modal open={!!inv} onClose={() => setInv(null)} title="Invoice" subtitle={cur ? `LPO ${cur.lpo_no} · ${rs(cur.gross)}` : undefined}>
        {inv && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Invoice number"><input value={inv.no} onChange={(e) => setInv({ ...inv, no: e.target.value })} className={inp} /></Field>
          <Field label="Invoice date"><input type="date" value={inv.date} onChange={(e) => setInv({ ...inv, date: e.target.value })} className={inp} /></Field>
          <button disabled={busy} className={save} onClick={() => run(async () => { await rpc("carrefour_set_invoice", { p_id: cur!.id, p_no: inv.no, p_date: inv.date || null }); setInv(null); })}>{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>

      <Modal open={!!rcv} onClose={() => setRcv(null)} wide title="Receiving" subtitle="The receiving number is your proof of delivery">
        {rcv && cur && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Receiving number"><input value={rcv.no} onChange={(e) => setRcv({ ...rcv, no: e.target.value })} className={inp} /></Field>
          <Field label="Receiving date"><input type="date" value={rcv.date} onChange={(e) => setRcv({ ...rcv, date: e.target.value })} className={inp} /></Field>
          <Field label="Receiving paper"><input type="file" accept="application/pdf,image/*" onChange={(e) => setRcv({ ...rcv, file: e.target.files?.[0] ?? null })} className={inp} /></Field>
          <p className="text-[12.5px] font-semibold text-ink">Pieces received</p>
          {cur.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-3 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{l.description ?? l.barcode} <span className="text-muted">of {qty(l.qty)}</span></span>
              <input aria-label={`Received ${l.barcode}`} type="number" inputMode="decimal" value={rcv.lines[l.id] ?? ""} onChange={(e) => setRcv({ ...rcv, lines: { ...rcv.lines, [l.id]: e.target.value } })} className={`${inp} w-24`} />
            </div>
          ))}
          <button disabled={busy} className={save} onClick={saveRcv}>{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>

      <Modal open={!!f} onClose={() => setF(null)} wide title={f?.id ? "Edit LPO" : "Upload LPO"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="LPO file" hint="PDF or photo. It stays attached to this order."><input type="file" accept="application/pdf,image/*" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} className={inp} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="LPO number"><input value={f.lpo_no} onChange={(e) => setF({ ...f, lpo_no: e.target.value })} className={`${inp} font-mono`} /></Field>
            <Field label="Store"><select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })} className={inp}><option value="">Choose</option>{(shops.data ?? []).map((s) => <option key={s.branch_id} value={s.branch_id}>{store(s.name)}</option>)}</select></Field>
            <Field label="LPO date"><input type="date" value={f.lpo_date} onChange={(e) => setF({ ...f, lpo_date: e.target.value })} className={inp} /></Field>
            <Field label="Delivery date"><input type="date" value={f.delivery_date} onChange={(e) => setF({ ...f, delivery_date: e.target.value })} className={inp} /></Field>
          </div>
          <LineEditor lines={f.lines} onChange={(lines) => setF({ ...f, lines })} articles={arts.data ?? []} />
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={inp} /></Field>
          <button disabled={busy || lineTotals(f.lines).pieces <= 0} className={save} onClick={saveLpo}>{busy && <Loader2 size={14} className="animate-spin" />} Save LPO</button>
        </div>}
      </Modal>
    </div>
  );
}
