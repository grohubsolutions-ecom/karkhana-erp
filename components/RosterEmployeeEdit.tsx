"use client";
/* Edit somebody on the Hub attendance roster — and, when they turn out to be a
 * duplicate of somebody else, move their attendance onto that person.
 *
 * WHY MERGE LIVES HERE
 *   A duplicate is discovered while looking at a person: "this Kashif is the
 *   same man as Muhammad Kashif Latif". So the move starts from the duplicate's
 *   own edit box. The duplicate is always the one that goes; the one picked in
 *   the list is always the one that stays. Stating that in the button label
 *   rather than in a help paragraph is what stops it being done backwards.
 *
 * PREVIEW, THEN COMMIT
 *   The database answers "what would happen" before anything happens: how many
 *   days move, how many clash, how much in advances, and both salaries. The
 *   salaries matter — every moved day is paid at the survivor's rate, and if
 *   the two rows had different salaries that changes money, which somebody
 *   should see before pressing the button, not after.
 */
import { useEffect, useState } from "react";
import { Loader2, ArrowRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";

export type RosterEmp = {
  id: string; name: string; designation?: string | null; department?: string | null;
  sal?: number | null; wd?: number | null; phone?: string | null; dtime?: string | null;
};

type Preview = {
  from_name: string; into_name: string; from_sal: number | null; into_sal: number | null;
  days: number; days_dropped: number; advances: number; advance_amount: number;
  marks: number; login_moves: boolean;
};

const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");

const needsMigration = (m: string) =>
  /schema cache|does not exist|Could not find the function/i.test(m)
    ? "This needs migration H236, which has not been run on the database yet. Open Supabase → SQL editor and run H236_roster_edit_and_merge.sql, then try again."
    : null;

export default function RosterEmployeeEdit({
  emp, all, onClose, onDone,
}: {
  emp: RosterEmp | null;
  all: RosterEmp[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [f, setF] = useState({ name: "", designation: "", department: "", phone: "", sal: "", wd: "", dtime: "", pay_from: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [into, setInto] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!emp) return;
    setF({
      name: emp.name ?? "", designation: emp.designation ?? "", department: emp.department ?? "",
      phone: emp.phone ?? "", sal: emp.sal == null ? "" : String(emp.sal),
      wd: emp.wd == null ? "" : String(emp.wd), dtime: emp.dtime ?? "", pay_from: "",
    });
    setErr(""); setInto(""); setPreview(null);
  }, [emp]);

  async function save() {
    if (!supabase || !emp) return;
    if (!f.name.trim()) { setErr("A name is required."); return; }
    setBusy(true); setErr("");

    /* .select() on the update, because a row-level-security refusal on an
       update comes back as success with zero rows. Without it the box closes,
       nothing has changed, and nothing says so. */
    const { data, error } = await supabase.from("online_att_employees").update({
      name: f.name.trim(),
      designation: f.designation.trim() || null,
      department: f.department.trim() || null,
      phone: f.phone.trim() || null,
      sal: f.sal === "" ? 0 : Number(f.sal),
      wd: f.wd === "" ? 26 : Number(f.wd),
      ...(f.dtime ? { dtime: f.dtime } : {}),
    }).eq("id", emp.id).select("id");

    if (error) { setBusy(false); setErr(error.message); return; }
    if (!data || data.length === 0) {
      setBusy(false);
      setErr("The database refused the change and gave no reason — most likely a permissions rule. Nothing was saved.");
      return;
    }

    const { data: a, error: ae } = await supabase.rpc("hub_after_roster_edit", {
      p_id: emp.id, p_old_sal: Number(emp.sal ?? 0), p_pay_from: f.pay_from || null,
    });
    setBusy(false);
    const ar = a as { ok?: boolean; error?: string; rate_recorded?: boolean } | null;
    if (ae) { onDone(`${f.name.trim()} saved. ` + (needsMigration(ae.message) ?? `But the salary history was not updated: ${ae.message}`)); return; }
    if (ar && !ar.ok) { onDone(`${f.name.trim()} saved, but: ${ar.error}`); return; }
    onDone(`${f.name.trim()} saved.` + (ar?.rate_recorded
      ? ` New salary applies from ${f.pay_from || "today"}; days before that keep the old rate.` : ""));
  }

  async function runPreview() {
    if (!supabase || !emp || !into) return;
    setBusy(true); setErr(""); setPreview(null);
    const { data, error } = await supabase.rpc("hub_merge_att_employee", { p_from: emp.id, p_into: into, p_commit: false });
    setBusy(false);
    if (error) { setErr(needsMigration(error.message) ?? error.message); return; }
    const r = data as ({ ok?: boolean; error?: string } & Preview) | null;
    if (!r?.ok) { setErr(r?.error ?? "The preview was refused and gave no reason."); return; }
    setPreview(r);
  }

  async function commitMerge() {
    if (!supabase || !emp || !into) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_merge_att_employee", { p_from: emp.id, p_into: into, p_commit: true });
    setBusy(false);
    if (error) { setErr(needsMigration(error.message) ?? error.message); return; }
    const r = data as { ok?: boolean; error?: string; report?: string } | null;
    if (!r?.ok) { setErr(r?.error ?? "The merge was refused and gave no reason."); return; }
    onDone(r.report ?? "Merged.");
  }

  const others = all.filter((o) => o.id !== emp?.id);
  const salChanged = emp && f.sal !== "" && Number(f.sal) !== Number(emp.sal ?? 0);
  const salDiffers = preview && Number(preview.from_sal ?? 0) !== Number(preview.into_sal ?? 0);

  return (
    <Modal open={!!emp} onClose={() => !busy && onClose()} wide
           title={`Edit ${emp?.name ?? ""}`} subtitle="Hub attendance roster">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Designation"><input className={inputCls} value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
        <Field label="Department"><input className={inputCls} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
        <Field label="Phone"><input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="03XXXXXXXXX" /></Field>
        <Field label="Monthly salary (Rs)"><input type="number" className={inputCls} value={f.sal} onChange={(e) => setF({ ...f, sal: e.target.value })} /></Field>
        <Field label="Working days / month"><input type="number" className={inputCls} value={f.wd} onChange={(e) => setF({ ...f, wd: e.target.value })} /></Field>
        <Field label="Duty time"><input type="time" className={inputCls} value={f.dtime} onChange={(e) => setF({ ...f, dtime: e.target.value })} /></Field>
        {salChanged && (
          <Field label="New salary applies from">
            <input type="date" className={inputCls} value={f.pay_from} onChange={(e) => setF({ ...f, pay_from: e.target.value })} />
            <p className="mt-1 text-[11.5px] text-hint dark:text-[#8a8175]">
              Days before this keep the old rate, so months already paid do not move. Blank means today.
            </p>
          </Field>
        )}
      </div>

      {err && <div className="mt-3 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">{err}</div>}

      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={busy} onClick={save}>
          {busy && <Loader2 size={14} className="animate-spin" />} Save changes
        </button>
      </div>

      {/* ---------------- duplicate → merge ---------------- */}
      <div className="mt-6 border-t border-line pt-4 dark:border-white/10">
        <div className="text-[13px] font-bold text-ink dark:text-[#f4f1ea]">Is {emp?.name} a duplicate?</div>
        <p className="mt-1 text-[12px] text-muted dark:text-[#a89f93]">
          Pick the person to keep. Everything {emp?.name} holds — attendance days, advances, paid marks — moves
          onto them, and {emp?.name} is removed. Nothing is changed until you confirm the preview.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select className={`${inputCls} sm:max-w-xs`} value={into}
                  onChange={(e) => { setInto(e.target.value); setPreview(null); setErr(""); }}>
            <option value="">Keep which person?</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.name}{o.department ? ` — ${o.department}` : ""}</option>
            ))}
          </select>
          <button className={btnGhost} disabled={busy || !into} onClick={runPreview}>Preview the move</button>
        </div>

        {preview && (
          <div className="mt-3 rounded-card border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-950">
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              {preview.from_name} <ArrowRight size={14} /> {preview.into_name}
            </div>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              <li>{preview.days} attendance day(s) move{preview.days_dropped > 0
                ? ` — ${preview.days_dropped} more were already marked on ${preview.into_name} and are kept as ${preview.into_name} has them` : ""}.</li>
              <li>{preview.advances} advance(s) move, {rs(preview.advance_amount)} in total.</li>
              {preview.marks > 0 && <li>{preview.marks} paid/unpaid month mark(s) move.</li>}
              {preview.login_moves && <li>{preview.from_name}&apos;s login moves to {preview.into_name}.</li>}
              <li className={salDiffers ? "font-semibold text-red-800" : ""}>
                Every day is paid at {preview.into_name}&apos;s salary, {rs(preview.into_sal)}
                {salDiffers ? ` — ${preview.from_name} was on ${rs(preview.from_sal)}, so the moved days will be valued differently.` : "."}
              </li>
            </ul>
            <div className="mt-3 flex justify-end">
              <button className={btnPrimary} disabled={busy} onClick={commitMerge}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                Move to {preview.into_name} and remove {preview.from_name}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
