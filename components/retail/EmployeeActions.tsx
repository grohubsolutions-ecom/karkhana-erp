"use client";
/* ADDING AND REMOVING PEOPLE, FROM WHEREVER YOU ARE LOOKING AT THEM.
 *
 * Five screens list staff — Employees, Monthly Summary, Attendance, Ledger and
 * Repayments — and until now only the first could add or remove anybody. That
 * is the wrong shape: the moment you notice somebody is missing from the monthly
 * summary, or that a leaver is still on it, you are ON the summary, and being
 * sent to another screen to fix it is how it never gets fixed.
 *
 * So the add form, the row actions and the history count live here once and
 * are dropped into each screen, rather than copied into each — which is also
 * the only way the rule below can be guaranteed to be the same everywhere.
 *
 * THE RULE, AND WHY IT IS NOT NEGOTIABLE.
 *
 *   retail_attendance has a foreign key to the employee with ON DELETE
 *   CASCADE. Deleting the person deletes every attendance day they ever had,
 *   at once, with no warning.
 *
 *   retail_employee_ledger, retail_salary_payments and retail_wage_payments
 *   carry employee_id but have NO foreign key. Deleting the person does not
 *   touch those rows — it ORPHANS them. They stay in the table pointing at an
 *   id that no longer exists: gone from every screen, missing from every
 *   total, and impossible to find again.
 *
 * So anybody with a past is ENDED, never deleted. Ending is what this app
 * already means by a leaver: out of payroll and the pickers, history intact,
 * and reversible. A real delete is offered only where all four counts are
 * zero — somebody typed in by mistake a minute ago.
 */
import { useCallback, useEffect, useState } from "react";
import { UserPlus, UserMinus, Trash2 } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { reloadEmployees, type Branch, type Employee } from "@/components/retail/kit";

/** How many rows exist against each employee, across all four tables that
 *  reference one. Four reads in total, not four per person: the employee_id
 *  column of each table is small, and counting in the browser means a list of
 *  seventy people costs the same as a list of two. */
export function useEmployeeHistory() {
  const [history, setHistory] = useState<Map<number, number>>(new Map());

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const tally = new Map<number, number>();
    const one = async (table: string) => {
      const { data } = await supabase!.from(table).select("employee_id").limit(20000);
      ((data ?? []) as { employee_id: number | null }[]).forEach((r) => {
        if (r.employee_id == null) return;
        const k = Number(r.employee_id);
        tally.set(k, (tally.get(k) ?? 0) + 1);
      });
    };
    await Promise.all([
      one("retail_employee_ledger"), one("retail_attendance"),
      one("retail_salary_payments"), one("retail_wage_payments"),
    ]);
    setHistory(tally);
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { history, reloadHistory: reload };
}

const BLANK = {
  name: "", branch_id: "", designation: "", phone: "",
  monthly_salary: "", pay_type: "monthly", hourly_rate: "", active: true,
};

/** Add a person, or edit one, from any screen. `employee` null means add. */
export function EmployeeFormModal({ open, employee, branches, defaultBranch, onClose, onSaved }: {
  open: boolean; employee: Employee | null; branches: Branch[];
  defaultBranch?: string; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr("");
    setForm(employee ? {
      name: employee.name ?? "",
      branch_id: employee.branch_id == null ? "" : String(employee.branch_id),
      designation: employee.designation ?? "",
      phone: employee.phone ?? "",
      monthly_salary: employee.monthly_salary == null ? "" : String(employee.monthly_salary),
      pay_type: employee.pay_type ?? "monthly",
      hourly_rate: employee.hourly_rate == null ? "" : String(employee.hourly_rate),
      active: employee.active !== false,
    } : { ...BLANK, branch_id: defaultBranch ?? "" });
  }, [open, employee, defaultBranch]);

  async function save() {
    if (!form.name.trim()) { setErr("A name is required."); return; }
    if (!supabase) { setErr("Not connected."); return; }
    setSaving(true); setErr("");
    const payload = {
      name: form.name.trim(),
      branch_id: form.branch_id ? Number(form.branch_id) : null,
      designation: form.designation.trim() || null,
      phone: form.phone.trim() || null,
      monthly_salary: form.monthly_salary === "" ? 0 : Number(form.monthly_salary),
      pay_type: form.pay_type,
      /* Blank, not zero. An hourly rate of zero is a claim that the person
         works for nothing; a blank one says nobody has set it yet. */
      hourly_rate: form.hourly_rate === "" ? null : Number(form.hourly_rate),
      active: form.active,
    };
    const { error } = employee
      ? await supabase.from("retail_employees").update(payload).eq("id", employee.id)
      : await supabase.from("retail_employees").insert(payload);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    reloadEmployees();
    onSaved(); onClose();
  }

  return (
    <Modal open={open} onClose={onClose}
      title={employee ? `Edit ${employee.name}` : "Add employee"}
      subtitle={employee ? "Changes apply from now on — past months are not recalculated." : "They appear on attendance, payroll and the ledger straight away."}>
      <div className="space-y-3.5">
        <Field label="Name">
          <input className={inputCls} value={form.name} autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="As it is written on the shop's list" />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Shop">
            <select className={inputCls} value={form.branch_id}
              onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
              <option value="">— none —</option>
              {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Designation">
            <input className={inputCls} value={form.designation}
              onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="optional" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Paid">
            <select className={inputCls} value={form.pay_type}
              onChange={(e) => setForm({ ...form, pay_type: e.target.value })}>
              <option value="monthly">Monthly</option>
              <option value="hourly">By the hour</option>
            </select>
          </Field>
          {form.pay_type === "hourly" ? (
            <Field label="Rate per hour">
              <input type="number" step="1" inputMode="decimal" className={inputCls} value={form.hourly_rate}
                onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} placeholder="not set" />
            </Field>
          ) : (
            <Field label="Monthly salary">
              <input type="number" step="1" inputMode="decimal" className={inputCls} value={form.monthly_salary}
                onChange={(e) => setForm({ ...form, monthly_salary: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Phone">
          <input className={inputCls} value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="optional" />
        </Field>
        <label className="flex items-center gap-2.5 text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">
          <input type="checkbox" checked={form.active} className="h-4 w-4 accent-[#141414] dark:accent-white"
            onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Still working here
        </label>
        {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className={btnGhost}>Cancel</button>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? "Saving…" : employee ? "Save changes" : "Add employee"}
          </button>
        </div>
        {!isSupabaseConfigured && <p className="text-center text-[12px] text-hint">Preview build — nothing will be saved.</p>}
      </div>
    </Modal>
  );
}

/** The button that opens the add form. Put it in a PageHeader. */
export function AddEmployeeButton({ branches, defaultBranch, onAdded }: {
  branches: Branch[]; defaultBranch?: string; onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 dark:bg-white dark:text-[#141414]">
        <UserPlus size={14} /> Add employee
      </button>
      <EmployeeFormModal open={open} employee={null} branches={branches} defaultBranch={defaultBranch}
        onClose={() => setOpen(false)} onSaved={onAdded} />
    </>
  );
}

/** End / bring back / delete, for a row in any staff list. */
export function EmployeeRowActions({ e, history, onChanged }: {
  e: Employee; history: Map<number, number>; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const carries = history.get(e.id) ?? 0;

  async function setActive(active: boolean) {
    if (!supabase || busy) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("retail_employees").update({ active }).eq("id", e.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    reloadEmployees(); onChanged();
  }

  async function hardDelete() {
    if (!supabase || busy) return;
    if (carries > 0) { setErr("This person has history — end them instead."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.from("retail_employees").delete().eq("id", e.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setConfirm(false); reloadEmployees(); onChanged();
  }

  if (err) {
    return <span className="text-[11.5px] font-semibold text-danger" title={err}>could not save</span>;
  }
  if (e.active === false) {
    return (
      <button onClick={() => setActive(true)} disabled={busy} aria-label={`Bring ${e.name} back`}
        className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-success transition hover:bg-success-soft disabled:opacity-50 dark:border-white/10">
        {busy ? "…" : "Bring back"}
      </button>
    );
  }
  if (carries > 0) {
    return (
      <button onClick={() => setActive(false)} disabled={busy} aria-label={`End ${e.name}`}
        title={`${e.name} has ${carries} record${carries === 1 ? "" : "s"} — ledger, attendance, pay. Ending keeps those readable; deleting would destroy or orphan them.`}
        className="rounded-full p-1.5 text-muted transition hover:bg-danger-soft hover:text-danger disabled:opacity-50 dark:text-[#a89f93] dark:hover:bg-white/[0.06]">
        <UserMinus size={15} />
      </button>
    );
  }
  if (confirm) {
    return (
      <span className="flex items-center justify-end gap-1">
        <button onClick={hardDelete} disabled={busy}
          className="rounded-full bg-danger px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
          {busy ? "…" : "Delete"}
        </button>
        <button onClick={() => setConfirm(false)}
          className="rounded-full px-2 py-1.5 text-[12px] font-semibold text-muted dark:text-[#a89f93]">Keep</button>
      </span>
    );
  }
  return (
    <button onClick={() => setConfirm(true)} aria-label={`Delete ${e.name}`}
      className="rounded-full p-1.5 text-muted transition hover:bg-danger-soft hover:text-danger dark:text-[#a89f93] dark:hover:bg-white/[0.06]">
      <Trash2 size={15} />
    </button>
  );
}
