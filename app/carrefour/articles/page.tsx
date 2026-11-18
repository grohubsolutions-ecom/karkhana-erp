"use client";
/* ARTICLES (K196). The barcode is the key everywhere: Karkhana, the warehouse
   and Carrefour. Each carries its own margin, and its sample result. Margin is
   on the selling price: buy at 400, sell at 600 is 33.33%. */
import { useMemo, useState } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { exportExcel } from "@/lib/export";
import { Notice, Rows, Stat, day, inp, qty, today, useLoad } from "@/components/carrefour/kit";

type A = { id: string; barcode: string; item_no: string | null; name: string; section: string | null; item_id: string | null;
  cp: number | null; sp: number | null; margin_pct: number | null; margin_kind: string; sample_status: string; sample_date: string | null; sample_note: string | null };
const blank = () => ({ id: "", barcode: "", item_no: "", name: "", section: "", cp: "", sp: "", margin_kind: "regular", sample_status: "pending", sample_date: today(), sample_note: "" });
const SAMPLE: Record<string, { l: string; t: string }> = {
  pending: { l: "Sample pending", t: "bg-amber-soft text-[#7c4a03]" },
  pass: { l: "Pass", t: "bg-success-soft text-[#166534]" },
  reject: { l: "Reject", t: "bg-danger-soft text-[#b42318]" },
};

export default function CarrefourArticles() {
  const { can } = usePermissions();
  const manage = can(["carrefour.orders.manage"]);
  const { data, err: loadErr, loading, load } = useLoad<A[]>(() => supabase!.from("carrefour_articles").select("*").order("name").limit(5000));
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("all");
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all.filter((a) => (only === "all" || a.sample_status === only || (only === "nosp" && a.sp == null))
      && (!t || a.barcode.includes(t) || a.name.toLowerCase().includes(t) || (a.item_no ?? "").includes(t)));
  }, [all, q, only]);
  const cp = Number(f?.cp), sp = Number(f?.sp);
  const margin = sp > 0 && f?.cp !== "" ? ((sp - cp) / sp) * 100 : null;

  async function saveIt() {
    if (!f) return;
    if (!f.barcode.trim() || !f.name.trim()) { setErr("Enter the barcode and name."); return; }
    setBusy(true); setErr("");
    const row = { barcode: f.barcode.replace(/\s/g, ""), item_no: f.item_no.trim() || null, name: f.name.trim(), section: f.section.trim() || null,
      cp: f.cp === "" ? null : Number(f.cp), sp: f.sp === "" ? null : Number(f.sp), margin_kind: f.margin_kind, sample_status: f.sample_status,
      sample_date: f.sample_date || null, sample_note: f.sample_note.trim() || null };
    const { error } = f.id ? await supabase!.from("carrefour_articles").update(row).eq("id", f.id) : await supabase!.from("carrefour_articles").insert(row);
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "This barcode is already in the list." : error.message); return; }
    setF(null); load();
  }
  function save() {
    exportExcel({ title: "Carrefour articles", headers: ["Barcode", "Item no", "Article", "CP", "SP", "Margin %", "Type", "Sample"],
      rows: rows.map((a) => [a.barcode, a.item_no, a.name, a.cp, a.sp, a.margin_pct, a.margin_kind.toUpperCase(), a.sample_status]) });
  }

  return (
    <div className="pb-10">
      <Topbar title="Articles & margins" subtitle="One barcode across Karkhana, warehouse and Carrefour" />
      <div className="space-y-4 px-6">
        {(err || loadErr) && !f && <Notice tone="danger">{err || loadErr}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Articles" value={qty(all.length)} />
          <Stat label="Samples pending" value={qty(all.filter((a) => a.sample_status === "pending").length)} />
          <Stat label="No selling price" value={qty(all.filter((a) => a.sp == null).length)} note="Margin cannot be worked out" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[["all", "All"], ["pending", "Sample pending"], ["pass", "Pass"], ["reject", "Reject"], ["nosp", "No SP"]].map(([k, l]) => (
            <button key={k} onClick={() => setOnly(k)} className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${only === k ? "bg-ink text-white" : "border border-line bg-surface text-muted"}`}>{l}</button>
          ))}
          <button onClick={save} disabled={!rows.length} className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"><Download size={14} /> Excel</button>
          {manage && <button onClick={() => { setErr(""); setF(blank()); }} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Plus size={15} /> Add article</button>}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search barcode, item or name" className={inp} />
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={rows} rowKey={(a) => a.id} empty="No articles found." cols={[
            { label: "Barcode", cell: (a) => manage
              ? <button onClick={() => { setErr(""); setF({ id: a.id, barcode: a.barcode, item_no: a.item_no ?? "", name: a.name, section: a.section ?? "", cp: a.cp == null ? "" : String(a.cp), sp: a.sp == null ? "" : String(a.sp), margin_kind: a.margin_kind, sample_status: a.sample_status, sample_date: a.sample_date ?? today(), sample_note: a.sample_note ?? "" }); }} className="font-mono font-semibold underline">{a.barcode}</button>
              : <span className="font-mono">{a.barcode}</span> },
            { label: "Article", cell: (a) => a.name },
            { label: "CP", right: true, cell: (a) => (a.cp == null ? "—" : qty(a.cp)) },
            { label: "SP", right: true, cell: (a) => (a.sp == null ? "—" : qty(a.sp)) },
            { label: "Margin", right: true, cell: (a) => (a.margin_pct == null ? "—" : `${a.margin_pct}%${a.margin_kind === "pg" ? " PG" : ""}`) },
            { label: "Warehouse", cell: (a) => (a.item_id ? "Linked" : "Not linked") },
            { label: "Sample", cell: (a) => <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${SAMPLE[a.sample_status].t}`}>{SAMPLE[a.sample_status].l}{a.sample_date && a.sample_status !== "pending" ? ` · ${day(a.sample_date)}` : ""}</span> },
          ]} />
        )}
      </div>
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit article" : "Add article"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Barcode"><input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} className={`${inp} font-mono`} /></Field>
          <Field label="Article name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inp} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Item no"><input value={f.item_no} onChange={(e) => setF({ ...f, item_no: e.target.value })} className={inp} /></Field>
            <Field label="Section"><input value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} className={inp} /></Field>
            <Field label="Carrefour buys at (CP)"><input type="number" inputMode="decimal" value={f.cp} onChange={(e) => setF({ ...f, cp: e.target.value })} className={inp} /></Field>
            <Field label="Carrefour sells at (SP)"><input type="number" inputMode="decimal" value={f.sp} onChange={(e) => setF({ ...f, sp: e.target.value })} className={inp} /></Field>
          </div>
          <p className="text-[13px] font-bold text-ink">Margin: {margin == null ? "—" : `${margin.toFixed(2)}%`}</p>
          <Field label="Margin type"><select value={f.margin_kind} onChange={(e) => setF({ ...f, margin_kind: e.target.value })} className={inp}><option value="regular">Regular</option><option value="pg">PG</option></select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sample"><select value={f.sample_status} onChange={(e) => setF({ ...f, sample_status: e.target.value })} className={inp}><option value="pending">Pending</option><option value="pass">Pass</option><option value="reject">Reject</option></select></Field>
            <Field label="Sample date"><input type="date" value={f.sample_date} onChange={(e) => setF({ ...f, sample_date: e.target.value })} className={inp} /></Field>
          </div>
          <Field label="Sample note"><input value={f.sample_note} onChange={(e) => setF({ ...f, sample_note: e.target.value })} className={inp} /></Field>
          <button onClick={saveIt} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>
    </div>
  );
}
