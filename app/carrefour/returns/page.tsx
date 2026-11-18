"use client";
/* RETURNS (K196). Pending: Carrefour has asked us to lift the stock back.
   Delivered: it has come back, with the return paper. Delivered stock comes
   off the sold figures, so it is never counted as a sale. */
import { useMemo, useState } from "react";
import { FileText, Loader2, Plus } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { Notice, Rows, Stat, day, inp, qty, rs, today, useLoad } from "@/components/carrefour/kit";
import LineEditor, { useArticles, type Line } from "@/components/carrefour/lines";
import { openDoc, uploadDoc } from "@/components/carrefour/docs";

type RLine = { barcode: string; description: string | null; qty: number; price: number };
type Ret = { id: string; return_no: string | null; status: string; branch_id: string; shop: string; return_date: string; reason: string;
  delivered_on: string | null; file_path: string | null; file_name: string | null; note: string | null; pieces: number; amount: number; lines: RLine[] };
type Shop = { branch_id: string; name: string };
const REASONS: Record<string, string> = { summer: "Summer stock", aging: "Aging stock", dp: "DP", no_sale: "Not selling", other: "Other" };
const blank = () => ({ id: "", return_no: "", branch_id: "", return_date: today(), reason: "summer", note: "", file: null as File | null, lines: [] as Line[] });
const btn = "flex items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink";
const save = "flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50";

export default function CarrefourReturns() {
  const { can } = usePermissions();
  const manage = can(["carrefour.orders.manage"]);
  const ask = useConfirm();
  const { data, err: loadErr, loading, load } = useLoad<Ret[]>(() => supabase!.rpc("carrefour_return_list"));
  const shops = useLoad<Shop[]>(() => supabase!.rpc("carrefour_shops"));
  const arts = useArticles();
  const [tab, setTab] = useState("pending");
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [openId, setOpenId] = useState("");
  const [dl, setDl] = useState<{ date: string; file: File | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const all = useMemo(() => data ?? [], [data]);
  const rows = all.filter((r) => r.status === tab);
  const cur = all.find((r) => r.id === openId) ?? null;
  const tot = (s: string) => all.filter((r) => r.status === s).reduce((a, r) => a + Number(r.amount), 0);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : "Could not save."); }
    setBusy(false);
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(name, args);
    if (error) throw new Error(error.code === "23505" ? "A return with this paper number is already recorded." : error.message);
  };
  function saveRet() {
    if (!f) return;
    run(async () => {
      const up = f.file ? await uploadDoc(f.file, "return") : null;
      await rpc("carrefour_save_return", { p: { id: f.id || null, return_no: f.return_no, branch_id: f.branch_id, return_date: f.return_date, reason: f.reason, note: f.note,
        file_path: up?.path ?? null, file_name: up?.name ?? null,
        lines: f.lines.filter((l) => l.barcode.trim()).map((l) => ({ ...l, qty: Number(l.qty), price: Number(l.price) || 0 })) } });
      setF(null); arts.load();
    });
  }
  function saveDl() {
    if (!cur || !dl) return;
    run(async () => {
      const up = dl.file ? await uploadDoc(dl.file, "return") : null;
      await rpc("carrefour_return_delivered", { p_id: cur.id, p_date: dl.date || null, p_path: up?.path ?? null, p_name: up?.name ?? null, p_undo: false });
      setDl(null);
    });
  }
  async function voidIt(r: Ret) {
    const ok = await ask({ title: `Void this return of ${rs(r.amount)}?`, body: "It stops counting, and stays on record.", confirmLabel: "Void" });
    if (ok) run(async () => { await rpc("carrefour_void_return", { p_id: r.id, p_reason: null }); setOpenId(""); });
  }

  return (
    <div className="pb-10">
      <Topbar title="Returns" subtitle="Stock coming back from Carrefour" />
      <div className="space-y-4 px-6">
        {(err || loadErr) && !f && !dl && <Notice tone="danger">{err || loadErr}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat label="Returns pending" value={rs(tot("pending"))} />
          <Stat label="Returns delivered" value={rs(tot("delivered"))} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[["pending", "Returns pending"], ["delivered", "Returns delivered"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${tab === k ? "bg-ink text-white" : "border border-line bg-surface text-muted"}`}>{l} ({all.filter((r) => r.status === k).length})</button>
          ))}
          {manage && <button onClick={() => { setErr(""); setF(blank()); }} className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Plus size={15} /> Add return</button>}
        </div>
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={rows} rowKey={(r) => r.id} empty="Nothing here." cols={[
            { label: "Date", cell: (r) => <button onClick={() => { setErr(""); setOpenId(r.id); }} className="font-semibold underline">{day(r.return_date)}</button> },
            { label: "Shop", cell: (r) => r.shop },
            { label: "Paper", cell: (r) => r.return_no ?? "—" },
            { label: "Reason", cell: (r) => REASONS[r.reason] ?? r.reason },
            { label: "Pieces", right: true, cell: (r) => qty(r.pieces) },
            { label: "Value", right: true, cell: (r) => rs(r.amount) },
          ]} />
        )}
      </div>

      <Modal open={!!cur && !dl} onClose={() => setOpenId("")} wide title={cur ? `Return · ${cur.shop}` : ""} subtitle={cur ? `${day(cur.return_date)} · ${qty(cur.pieces)} pcs · ${rs(cur.amount)}` : undefined}>
        {cur && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          {cur.delivered_on && <p className="text-[13px]">Came back on <b>{day(cur.delivered_on)}</b></p>}
          <Rows rows={cur.lines} rowKey={(l) => l.barcode} empty="No lines." cols={[
            { label: "Barcode", cell: (l) => <span className="font-mono">{l.barcode}</span> },
            { label: "Item", cell: (l) => l.description ?? "—" },
            { label: "Qty", right: true, cell: (l) => qty(l.qty) },
            { label: "Price", right: true, cell: (l) => qty(l.price) },
            { label: "Value", right: true, cell: (l) => rs(Number(l.qty) * Number(l.price)) },
          ]} />
          <div className="flex flex-wrap gap-2">
            {cur.file_path && <button className={btn} onClick={() => openDoc(cur.file_path!).catch((e) => setErr(e.message))}><FileText size={14} /> Return paper</button>}
            {manage && cur.status === "pending" && <button className={btn} onClick={() => { setErr(""); setDl({ date: today(), file: null }); }}>Mark delivered</button>}
            {manage && cur.status === "delivered" && <button className={btn} onClick={() => run(() => rpc("carrefour_return_delivered", { p_id: cur.id, p_date: null, p_path: null, p_name: null, p_undo: true }))}>Back to pending</button>}
            {manage && <button className={btn} onClick={() => { setErr(""); setOpenId(""); setF({ id: cur.id, return_no: cur.return_no ?? "", branch_id: cur.branch_id, return_date: cur.return_date, reason: cur.reason, note: cur.note ?? "", file: null, lines: cur.lines.map((l) => ({ barcode: l.barcode, description: l.description ?? "", qty: String(l.qty), price: String(l.price) })) }); }}>Edit</button>}
            {manage && <button className={`${btn} text-[#b42318]`} onClick={() => voidIt(cur)}>Void</button>}
          </div>
        </div>}
      </Modal>

      <Modal open={!!dl} onClose={() => setDl(null)} title="Return delivered">
        {dl && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Date it came back"><input type="date" value={dl.date} onChange={(e) => setDl({ ...dl, date: e.target.value })} className={inp} /></Field>
          <Field label="Return paper"><input type="file" accept="application/pdf,image/*" onChange={(e) => setDl({ ...dl, file: e.target.files?.[0] ?? null })} className={inp} /></Field>
          <button disabled={busy} className={save} onClick={saveDl}>{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>

      <Modal open={!!f} onClose={() => setF(null)} wide title={f?.id ? "Edit return" : "Add return"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Shop"><select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })} className={inp}><option value="">Choose</option>{(shops.data ?? []).map((s) => <option key={s.branch_id} value={s.branch_id}>{s.name}</option>)}</select></Field>
            <Field label="Return date"><input type="date" value={f.return_date} onChange={(e) => setF({ ...f, return_date: e.target.value })} className={inp} /></Field>
            <Field label="Return paper number"><input value={f.return_no} onChange={(e) => setF({ ...f, return_no: e.target.value })} className={inp} /></Field>
            <Field label="Reason"><select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className={inp}>{Object.entries(REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <Field label="Return paper"><input type="file" accept="application/pdf,image/*" onChange={(e) => setF({ ...f, file: e.target.files?.[0] ?? null })} className={inp} /></Field>
          <LineEditor lines={f.lines} onChange={(lines) => setF({ ...f, lines })} articles={arts.data ?? []} />
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={inp} /></Field>
          <button disabled={busy} className={save} onClick={saveRet}>{busy && <Loader2 size={14} className="animate-spin" />} Save return</button>
        </div>}
      </Modal>
    </div>
  );
}
