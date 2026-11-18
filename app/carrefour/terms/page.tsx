"use client";
/* Agreed terms (K195). Each has an effective date, so a new rate at the annual
   negotiation does not rewrite old periods: end the old term, add the new one. */
import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { KINDS, Notice, Rows, day, inp, kindLabel, rs, today, useLoad } from "@/components/carrefour/kit";

type T = { id: string; kind: string; label: string; mode: string; rate: number; effective_from: string; effective_to: string | null; note: string | null };
const blank = () => ({ id: "", kind: "front_margin", label: "", mode: "percent", rate: "", effective_from: today(), effective_to: "", note: "" });

export default function CarrefourTerms() {
  const { can } = usePermissions();
  const manage = can(["carrefour.accounts.manage"]);
  const ask = useConfirm();
  const { data, err: loadErr, loading, load } = useLoad<T[]>(() => supabase!.from("carrefour_terms").select("*").order("effective_from", { ascending: false }));
  const settings = useLoad<{ maturity_days: number }>(() => supabase!.from("carrefour_settings").select("maturity_days").maybeSingle());
  const [days, setDays] = useState("");
  const [f, setF] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings.data) setDays(String(settings.data.maturity_days)); }, [settings.data]);

  async function saveDays() {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) { setErr("Days must be a whole number from 1 to 365."); return; }
    setErr("");
    const { error } = await supabase!.from("carrefour_settings").update({ maturity_days: d }).eq("id", true);
    if (error) setErr(error.message); else { setSaved(true); setTimeout(() => setSaved(false), 2000); }
  }
  async function save() {
    if (!f) return;
    const rate = Number(f.rate);
    if (!f.label.trim() || f.rate === "" || !(rate >= 0) || !f.effective_from) { setErr("Enter a name, a rate and a start date."); return; }
    if (f.mode === "percent" && rate > 100) { setErr("A percentage cannot be above 100."); return; }
    if (f.effective_to && f.effective_to < f.effective_from) { setErr("The end date is before the start date."); return; }
    setBusy(true); setErr("");
    const row = { kind: f.kind, label: f.label.trim(), mode: f.mode, rate, effective_from: f.effective_from, effective_to: f.effective_to || null, note: f.note.trim() || null };
    const { error } = f.id ? await supabase!.from("carrefour_terms").update(row).eq("id", f.id)
                           : await supabase!.from("carrefour_terms").insert(row);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setF(null); load();
  }
  async function remove(t: T) {
    const ok = await ask({ title: `Delete ${t.label}?`, body: "Past periods will be worked out without it. If the term has simply ended, give it an end date instead.", confirmLabel: "Delete" });
    if (!ok) return;
    const { error } = await supabase!.from("carrefour_terms").delete().eq("id", t.id);
    if (error) setErr(error.message); else load();
  }

  return (
    <div className="pb-10">
      <Topbar title="Terms" subtitle="What Carrefour is allowed to deduct, and when payment matures" />
      <div className="space-y-4 px-6">
        {(err || loadErr) && !f && <Notice tone="danger">{err || loadErr}</Notice>}
        <div className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface p-4 shadow-soft">
          <div className="w-full sm:w-56"><Field label="Days from sale to payment">
            <input type="number" inputMode="numeric" value={days} disabled={!manage} onChange={(e) => setDays(e.target.value)} className={inp} />
          </Field></div>
          {manage && <button onClick={saveDays} className="rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white">{saved ? "Saved" : "Save"}</button>}
        </div>
        {manage && <button onClick={() => { setErr(""); setF(blank()); }} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white"><Plus size={15} /> Add term</button>}
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={data ?? []} rowKey={(t) => t.id} empty="No terms entered yet." cols={[
            { label: "Term", cell: (t) => <span className="font-semibold">{t.label}</span> },
            { label: "Type", cell: (t) => kindLabel(t.kind) },
            { label: "Rate", right: true, cell: (t) => t.mode === "percent" ? `${Number(t.rate)}%` : `${rs(t.rate)} a month` },
            { label: "From", cell: (t) => day(t.effective_from) },
            { label: "To", cell: (t) => t.effective_to ? day(t.effective_to) : "Ongoing" },
            ...(manage ? [{ label: "Change", right: true, cell: (t: T) => (
              <span className="inline-flex gap-1.5">
                <button aria-label="Edit" onClick={() => { setErr(""); setF({ id: t.id, kind: t.kind, label: t.label, mode: t.mode, rate: String(t.rate), effective_from: t.effective_from, effective_to: t.effective_to ?? "", note: t.note ?? "" }); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-line hover:bg-panel"><Pencil size={14} /></button>
                <button aria-label="Delete" onClick={() => remove(t)} className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-[#b42318] hover:bg-danger-soft"><Trash2 size={14} /></button>
              </span>
            ) }] : []),
          ]} />
        )}
      </div>
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit term" : "Add term"}>
        {f && <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={inp}>{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></Field>
          <Field label="Name"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={inp} /></Field>
          <Field label="Charged as"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} className={inp}><option value="percent">Percent of sold value</option><option value="monthly">Fixed rupees a month</option></select></Field>
          <Field label={f.mode === "percent" ? "Rate (%)" : "Amount a month (Rs)"}><input type="number" inputMode="decimal" min="0" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} className={inp} /></Field>
          <Field label="Starts"><input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} className={inp} /></Field>
          <Field label="Ends" hint="Leave empty if it is still running."><input type="date" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} className={inp} /></Field>
          <button onClick={save} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>}
      </Modal>
    </div>
  );
}
