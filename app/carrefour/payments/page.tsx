"use client";
/* Payments from Carrefour (K195). They go against the oldest matured amount
   first. A wrong entry can be edited or voided; voided ones stay on record. */
import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { Notice, Rows, Stat, day, inp, rs, today, useLoad } from "@/components/carrefour/kit";

type P = { id: string; paid_on: string; amount: number; reference: string | null; note: string | null };
const blank = () => ({ id: "", paid_on: today(), amount: "", reference: "", note: "" });

export default function CarrefourPayments() {
  const { can } = usePermissions();
  const manage = can(["carrefour.accounts.manage"]);
  const ask = useConfirm();
  const { data, err: loadErr, loading, load } = useLoad<P[]>(() => supabase!.from("carrefour_payments").select("*").is("voided_at", null).order("paid_on", { ascending: false }));
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!f) return;
    const amount = Number(f.amount);
    if (!(amount > 0) || !f.paid_on) { setErr("Enter a date and an amount above zero."); return; }
    setBusy(true); setErr("");
    const row = { paid_on: f.paid_on, amount, reference: f.reference.trim() || null, note: f.note.trim() || null };
    const { error } = f.id ? await supabase!.from("carrefour_payments").update(row).eq("id", f.id)
                           : await supabase!.from("carrefour_payments").insert(row);
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "A payment with this reference is already recorded." : error.message); return; }
    setF(null); load();
  }
  async function voidIt(p: P) {
    const ok = await ask({ title: `Void payment of ${rs(p.amount)}?`, body: "It stops counting, and stays on record.", confirmLabel: "Void" });
    if (!ok) return;
    const { error } = await supabase!.from("carrefour_payments").update({ voided_at: new Date().toISOString() }).eq("id", p.id);
    if (error) setErr(error.message); else load();
  }

  return (
    <div className="pb-10">
      <Topbar title="Payments" subtitle="Money received from Carrefour" />
      <div className="space-y-4 px-6">
        {(err || loadErr) && !f && <Notice tone="danger">{err || loadErr}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total received" value={rs((data ?? []).reduce((a, p) => a + Number(p.amount), 0))} tone="good" />
        </div>
        {manage && <button onClick={() => { setErr(""); setF(blank()); }} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Plus size={15} /> Add payment</button>}
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={data ?? []} rowKey={(p) => p.id} empty="No payments recorded." cols={[
            { label: "Date", cell: (p) => day(p.paid_on) },
            { label: "Reference", cell: (p) => p.reference ?? "—" },
            { label: "Note", cell: (p) => p.note ?? "—" },
            { label: "Amount", right: true, cell: (p) => <span className="font-semibold">{rs(p.amount)}</span> },
            ...(manage ? [{ label: "Change", right: true, cell: (p: P) => (
              <span className="inline-flex gap-1.5">
                <button aria-label="Edit" onClick={() => { setErr(""); setF({ id: p.id, paid_on: p.paid_on, amount: String(p.amount), reference: p.reference ?? "", note: p.note ?? "" }); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-line hover:bg-panel"><Pencil size={14} /></button>
                <button aria-label="Void" onClick={() => voidIt(p)} className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-[#b42318] hover:bg-danger-soft"><Trash2 size={14} /></button>
              </span>
            ) }] : []),
          ]} />
        )}
      </div>
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit payment" : "Add payment"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Date received"><input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} className={inp} /></Field>
          <Field label="Amount (Rs)"><input type="number" inputMode="decimal" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={inp} /></Field>
          <Field label="Reference" hint="Bank or remittance number. The same number cannot be entered twice."><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} className={inp} /></Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={inp} /></Field>
          <button onClick={save} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>
    </div>
  );
}
