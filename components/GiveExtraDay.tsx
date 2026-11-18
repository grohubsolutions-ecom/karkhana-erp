"use client";
/* GIVE EXTRA DAY (H284, 1 Oct 2026).
 *
 * The owner: "some employees have to be given an extra day because of extra
 * time. Put 'Give extra day' at the top of the summary — it asks which date,
 * full day or half day, and the reason."
 *
 * An extra day is paid exactly like a day worked: that day's salary rate over
 * the days in that month, in full or half. It lands in the month of the date
 * chosen. The database refuses a date in the future, a second extra day on the
 * same date, and a month already marked paid (hub_give_extra_day) — this form
 * says the same things before anything is sent.
 */
import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");
/* Pakistan's date, whatever the device clock's zone. */
const pkToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
const QUICK = ["Stayed extra time", "Worked late at night", "Came in on a day off"];

export type ExtraDayEmp = { emp_id: string; name: string; salary: number };

export default function GiveExtraDay({ open, emps, defaultEmp, onClose, onDone }: {
  open: boolean; emps: ExtraDayEmp[]; defaultEmp?: string | null;
  onClose: () => void; onDone: (report: string, year: number, month: number) => void;
}) {
  const [emp, setEmp] = useState("");
  const [day, setDay] = useState(pkToday());
  const [portion, setPortion] = useState<1 | 0.5>(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmp(defaultEmp ?? ""); setDay(pkToday()); setPortion(1); setReason(""); setErr("");
  }, [open, defaultEmp]);

  const today = pkToday();
  const [y, m] = day ? day.split("-").map(Number) : [0, 0];
  const person = emps.find((e) => e.emp_id === emp);
  const monthDays = y && m ? new Date(y, m, 0).getDate() : 30;
  /* An estimate from today's salary: the database uses the rate that was in
     force on that date, which differs only across a pay change. */
  const worth = person ? (Number(person.salary) || 0) / monthDays * portion : 0;

  const problem =
    !emp ? "Pick the employee."
    : !day ? "Pick the date."
    : day > today ? "The date cannot be in the future."
    : reason.trim().length < 3 ? "Write the reason."
    : reason.trim().length > 300 ? "Keep the reason under 300 characters."
    : "";

  async function save() {
    if (!supabase || problem) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_give_extra_day", {
      p_emp: emp, p_day: day, p_portion: portion, p_reason: reason.trim(),
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string; report?: string } | null;
    if (error) { setErr(error.message); return; }
    if (!res?.ok) { setErr(res?.error ?? "It was not saved and no reason was given."); return; }
    onDone(res.report ?? "Extra day given.", y, m);
  }

  const pill = (on: boolean) => `flex h-11 flex-1 items-center justify-center rounded-full border text-[13.5px] font-semibold transition sm:h-10 ${on
    ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
    : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10"}`;

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="Give extra day"
      subtitle="Paid like a day worked, in the month of the date you pick.">
      <div className="space-y-3.5">
        <Field label="Employee">
          <select value={emp} onChange={(e) => setEmp(e.target.value)} aria-label="Employee"
            className={`${inputCls} max-sm:text-[16px]`}>
            <option value="">Select…</option>
            {emps.map((e) => <option key={e.emp_id} value={e.emp_id}>{e.name}</option>)}
          </select>
        </Field>

        <Field label="Which date?">
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} aria-label="Date"
            className={`${inputCls} max-sm:text-[16px]`} />
        </Field>

        <div>
          <div className="text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">Full day or half day?</div>
          <div role="radiogroup" aria-label="Full day or half day" className="mt-1.5 flex gap-2">
            <button type="button" role="radio" aria-checked={portion === 1} onClick={() => setPortion(1)} className={pill(portion === 1)}>Full day</button>
            <button type="button" role="radio" aria-checked={portion === 0.5} onClick={() => setPortion(0.5)} className={pill(portion === 0.5)}>Half day</button>
          </div>
        </div>

        <Field label="Reason">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} aria-label="Reason"
            placeholder="e.g. stayed 4 hours extra for the sale"
            className={`${inputCls} max-sm:text-[16px] min-h-[72px]`} />
        </Field>
        <div className="-mt-1.5 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button key={q} type="button" onClick={() => setReason(q)}
              className="rounded-full bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-line dark:bg-white/[0.07] dark:text-[#e7e2d8] dark:hover:bg-white/[0.12]">
              {q}
            </button>
          ))}
        </div>

        {person && day && day <= today && (
          <p className="rounded-xl2 bg-success-soft px-3 py-2.5 text-[12.5px] leading-snug text-emerald-900 dark:bg-white/[0.05] dark:text-[#bfe6c6]">
            Adds about <b className="tabular-nums">{rs(worth)}</b> to {person.name}&rsquo;s {MONTHS[m]} {y} pay
            — {portion === 1 ? "one day" : "half a day"} at {rs(person.salary)} ÷ {monthDays} days.
          </p>
        )}

        {err && (
          <p className="flex items-start gap-1.5 rounded-xl2 bg-danger-soft px-3 py-2 text-[12.5px] font-semibold text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={busy || !!problem} className={btnPrimary}>
          {busy && <Loader2 size={14} className="animate-spin" />} Give extra day
        </button>
        <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
        {problem && !err && <span className="text-[12px] text-muted dark:text-[#a89f93]">{problem}</span>}
      </div>
    </Modal>
  );
}
