"use client";
/* Debit notes (K195): what Carrefour actually deducted, set against the terms.
   A wrong entry can be edited or voided; voided notes stay on record. */
import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { KINDS, Notice, Rows, day, inp, kindLabel, rs, today, useLoad } from "@/components/carrefour/kit";

type N = { id: string; note_date: string; reference: string | null; kind: string; amount: number; branch_id: string | null; note: string | null };
type Check = { kind: string; expected: number; actual: number; unexplained: number };
type Shop = { branch_id: string; name: string };
const blank = () => ({ id: "", note_date: today(), reference: "", kind: "back_margin", amount: "", branch_id: "", note: "" });

export default function CarrefourDebitNotes() {
  const { can } = usePermissions();
  const manage = can(["carrefour.accounts.manage"]);
  const ask = useConfirm();
  const notes = useLoad<N[]>(() => supabase!.from("carrefour_debit_notes").select("*").is("voided_at", null).order("note_date", { ascending: false }));
  const check = useLoad<Check[]>(() => supabase!.rpc("carrefour_deduction_check"));
  const shops = useLoad<Shop[]>(() => supabase!.rpc("carrefour_shops"));
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const shopName = (id: string | null) => (shops.data ?? []).find((s) => s.branch_id === id)?.name ?? "All shops";
  const reload = () => { notes.load(); check.load(); };

  async function save() {
    if (!f) return;
    const amount = Number(f.amount);
    if (!(amount > 0) || !f.note_date) { setErr("Enter a date and an amount above zero."); return; }
    setBusy(true); setErr("");
    const row = { note_date: f.note_date, reference: f.reference.trim() || null, kind: f.kind, amount, branch_id: f.branch_id || null, note: f.note.trim() || null };
    const { error } = f.id ? await supabase!.from("carrefour_debit_notes").update(row).eq("id", f.id)
                           : await supabase!.from("carrefour_debit_notes").insert(row);
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "A debit note with this reference is already recorded." : error.message); return; }
    setF(null); reload();
  }
  async function voidIt(n: N) {
    const ok = await ask({ title: `Void debit note for ${rs(n.amount)}?`, body: "It stops counting, and stays on record.", confirmLabel: "Void" });
    if (!ok) return;
    const { error } = await supabase!.from("carrefour_debit_notes").update({ voided_at: new Date().toISOString() }).eq("id", n.id);
    if (error) setErr(error.message); else reload();
  }

  return (
    <div className="pb-10">
      <Topbar title="Debit notes" subtitle="What Carrefour deducted, checked against your terms" />
      <div className="space-y-4 px-6">
        {(err || notes.err || check.err) && !f && <Notice tone="danger">{err || notes.err || check.err}</Notice>}
        <Rows rows={(check.data ?? []).filter((c) => c.expected > 0 || c.actual > 0)} rowKey={(c) => c.kind}
          empty="No terms or debit notes yet." cols={[
          { label: "Deduction", cell: (c) => <span className="font-semibold">{kindLabel(c.kind)}</span> },
          { label: "Expected", right: true, cell: (c) => rs(c.expected) },
          { label: "Charged", right: true, cell: (c) => rs(c.actual) },
          { label: "Unexplained", right: true, cell: (c) => <span className={c.unexplained > 0 ? "font-bold text-[#b42318]" : ""}>{rs(c.unexplained)}</span> },
        ]} />
        {manage && (
          <button onClick={() => { setErr(""); setF(blank()); }} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Plus size={15} /> Add debit note</button>
        )}
        {notes.loading && !notes.data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={notes.data ?? []} rowKey={(n) => n.id} empty="No debit notes recorded." cols={[
            { label: "Date", cell: (n) => day(n.note_date) },
            { label: "Reference", cell: (n) => n.reference ?? "—" },
            { label: "Type", cell: (n) => kindLabel(n.kind) },
            { label: "Shop", cell: (n) => shopName(n.branch_id) },
            { label: "Amount", right: true, cell: (n) => <span className="font-semibold">{rs(n.amount)}</span> },
            ...(manage ? [{ label: "Change", right: true, cell: (n: N) => (
              <span className="inline-flex gap-1.5">
                <button aria-label="Edit" onClick={() => { setErr(""); setF({ id: n.id, note_date: n.note_date, reference: n.reference ?? "", kind: n.kind, amount: String(n.amount), branch_id: n.branch_id ?? "", note: n.note ?? "" }); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-line hover:bg-panel"><Pencil size={14} /></button>
                <button aria-label="Void" onClick={() => voidIt(n)} className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-[#b42318] hover:bg-danger-soft"><Trash2 size={14} /></button>
              </span>
            ) }] : []),
          ]} />
        )}
      </div>
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit debit note" : "Add debit note"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Date"><input type="date" value={f.note_date} onChange={(e) => setF({ ...f, note_date: e.target.value })} className={inp} /></Field>
          <Field label="Reference" hint="Carrefour's debit note number. The same number cannot be entered twice."><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} className={inp} /></Field>
          <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={inp}>{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></Field>
          <Field label="Amount (Rs)"><input type="number" inputMode="decimal" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={inp} /></Field>
          <Field label="Shop"><select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })} className={inp}><option value="">All shops</option>{(shops.data ?? []).map((s) => <option key={s.branch_id} value={s.branch_id}>{s.name}</option>)}</select></Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={inp} /></Field>
          <button onClick={save} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>
    </div>
  );
}
