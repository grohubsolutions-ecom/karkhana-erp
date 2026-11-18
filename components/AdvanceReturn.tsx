"use client";
/* ADVANCE RETURN (H296, 19 Oct 2026).
 *
 * The owner: "In the advances I want an option — advance return — what
 * employees give back, and their payment is updated as well."
 *
 * A return comes off one month's advance, so that month's pay goes up by
 * exactly what came back. It goes against a month that is not paid yet, and
 * never for more than is left of that month's advance. The database refuses
 * anything else (hub_advance_return); this form says the same things before
 * anything is sent. A return entered wrongly can be changed or taken off again
 * until its month is marked paid (hub_advance_return_edit / _remove).
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");
/* Pakistan's date, whatever the device clock's zone. */
const pkToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
const NOTE_DEFAULT = "Advance returned";

/* One person's month with advance still left in it (hub_advance_outstanding). */
type Open = { emp_id: string; name: string; year: number; month: number; given: number; returned: number; outstanding: number };
/* A return already recorded, opened to be changed. Its amount is negative in
   the table: the minus is what makes every pay figure take it off. */
export type ReturnEntry = {
  id: string; emp_id: string; name: string; amount: number; date: string; note: string | null;
  deduct_year: number; deduct_month: number;
};
type Res = { ok?: boolean; error?: string; report?: string } | null;

export default function AdvanceReturn({ open, edit, onClose, onDone }: {
  open: boolean; edit?: ReturnEntry | null;
  onClose: () => void; onDone: (report: string) => void;
}) {
  const [opens, setOpens] = useState<Open[] | null>(null);
  const [emp, setEmp] = useState("");
  const [key, setKey] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(pkToday());
  const [note, setNote] = useState("");
  /* Changing a return: the most it can be — the month's advance with this
     return taken out again. */
  const [room, setRoom] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr(""); setBusy(false);
    if (edit) {
      setEmp(edit.emp_id); setKey(`${edit.deduct_year}-${edit.deduct_month}`);
      setAmount(String(Math.abs(Number(edit.amount) || 0)));
      setDay(edit.date || pkToday());
      setNote(edit.note && edit.note !== NOTE_DEFAULT ? edit.note : "");
      setRoom(null);
    } else {
      setEmp(""); setKey(""); setAmount(""); setDay(pkToday()); setNote(""); setOpens(null);
    }
    if (!supabase) return;
    const db = supabase;
    let live = true;
    if (edit) {
      (async () => {
        const { data, error } = await db.from("online_att_advances").select("amount")
          .eq("emp_id", edit.emp_id).eq("deduct_year", edit.deduct_year).eq("deduct_month", edit.deduct_month);
        if (!live) return;
        if (error) { setErr(error.message); return; }
        const net = ((data as { amount: number }[]) ?? []).reduce((t, r) => t + (Number(r.amount) || 0), 0);
        setRoom(net - Number(edit.amount));
      })();
    } else {
      (async () => {
        const { data, error } = await db.rpc("hub_advance_outstanding");
        if (!live) return;
        if (error) {
          setErr(/Could not find the function|schema cache/i.test(error.message)
            ? "This needs migration H296 on the database, which has not been run yet."
            : error.message);
          setOpens([]);
          return;
        }
        setOpens((data as Open[]) ?? []);
      })();
    }
    return () => { live = false; };
  }, [open, edit]);

  /* Everyone with advance left, and each of their months that still has some. */
  const people = useMemo(() => {
    const by = new Map<string, { emp_id: string; name: string; total: number; months: Open[] }>();
    for (const o of opens ?? []) {
      const p = by.get(o.emp_id) ?? { emp_id: o.emp_id, name: o.name, total: 0, months: [] };
      p.total += Number(o.outstanding) || 0;
      p.months.push(o);
      by.set(o.emp_id, p);
    }
    return [...by.values()];
  }, [opens]);
  const person = people.find((p) => p.emp_id === emp);

  /* Picking a person picks their first month with advance in it. */
  useEffect(() => {
    if (edit || !person) return;
    if (!person.months.some((o) => `${o.year}-${o.month}` === key)) {
      setKey(`${person.months[0].year}-${person.months[0].month}`);
    }
  }, [person, key, edit]);

  const chosen = person?.months.find((o) => `${o.year}-${o.month}` === key) ?? null;
  const [y, m] = key ? key.split("-").map(Number) : [0, 0];
  const limit = edit ? room : chosen ? Number(chosen.outstanding) : null;
  const before = edit ? Math.abs(Number(edit.amount) || 0) : 0;

  const today = pkToday();
  const n = useMemo(() => {
    const t = amount.trim();
    if (t === "") return NaN;
    const v = Number(t.replace(/,/g, ""));
    return Number.isFinite(v) ? v : NaN;
  }, [amount]);
  const problem =
    !edit && !emp ? "Pick the employee."
    : !edit && !chosen ? "Pick the month the advance is in."
    : Number.isNaN(n) ? "Write how much was returned."
    : !Number.isInteger(n) ? "Whole rupees only."
    : n <= 0 ? "The amount must be more than zero."
    : limit !== null && n > limit ? `Only ${rs(limit)} of advance is left in ${MONTHS[m]} — that is the most that can come back.`
    : !day ? "Pick the date."
    : day > today ? "The date cannot be in the future."
    : note.trim().length > 300 ? "Keep the note under 300 characters."
    : "";

  async function save() {
    if (!supabase || problem) return;
    setBusy(true); setErr("");
    const { data, error } = edit
      ? await supabase.rpc("hub_advance_return_edit", {
          p_id: edit.id, p_amount: n, p_date: day, p_note: note.trim() || null,
        })
      : await supabase.rpc("hub_advance_return", {
          p_emp: emp, p_year: y, p_month: m, p_amount: n, p_date: day, p_note: note.trim() || null,
        });
    setBusy(false);
    const res = data as Res;
    if (error) {
      setErr(/Could not find the function|schema cache/i.test(error.message)
        ? "This needs migration H296 on the database, which has not been run yet."
        : error.message);
      return;
    }
    if (!res?.ok) { setErr(res?.error ?? "It was not saved and no reason was given."); return; }
    onDone(res.report ?? "Return recorded.");
  }

  const nothing = !edit && opens !== null && people.length === 0;
  const diff = edit && !problem ? n - before : 0;

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }}
      title={edit ? `Change return — ${edit.name}` : "Advance returned"}
      subtitle="Money an employee gives back. It comes off that month's advance, so the month's pay goes up by the same amount.">
      {!edit && opens === null ? (
        <p className="flex items-center gap-2 py-6 text-[13px] text-muted dark:text-[#a89f93]">
          <Loader2 size={14} className="animate-spin" /> Finding who has advance left…
        </p>
      ) : nothing && !err ? (
        <p className="rounded-xl2 bg-panel px-3.5 py-3 text-[13px] leading-snug text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">
          Nobody has advance left in a month that is not paid yet, so there is nothing to return against.
        </p>
      ) : (
        <div className="space-y-3.5">
          {edit ? (
            <div className="rounded-xl2 border border-line bg-panel px-3.5 py-2.5 text-[13px] dark:border-white/10 dark:bg-white/[0.05]">
              <span className="font-bold text-ink dark:text-[#f4f1ea]">{edit.name}</span>
              <span className="text-muted dark:text-[#a89f93]"> · against the {MONTHS[edit.deduct_month]} {edit.deduct_year} advance</span>
            </div>
          ) : (<>
            <Field label="Employee">
              <select value={emp} onChange={(e) => { setEmp(e.target.value); setAmount(""); }} aria-label="Employee"
                className={`${inputCls} max-sm:text-[16px]`}>
                <option value="">Select…</option>
                {people.map((p) => <option key={p.emp_id} value={p.emp_id}>{p.name} — {rs(p.total)} advance left</option>)}
              </select>
            </Field>
            {person && person.months.length > 1 && (
              <Field label="From which month's advance?">
                <select value={key} onChange={(e) => { setKey(e.target.value); setAmount(""); }} aria-label="Month"
                  className={`${inputCls} max-sm:text-[16px]`}>
                  {person.months.map((o) => (
                    <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                      {MONTHS[o.month]} {o.year} — {rs(o.outstanding)} left
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>)}

          <Field label="Amount returned (Rs)">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" aria-label="Amount returned"
              placeholder={limit ? `up to ${Math.round(limit).toLocaleString("en-PK")}` : "e.g. 5000"}
              className={`${inputCls} max-sm:text-[16px] tabular-nums`} />
          </Field>
          {!edit && limit !== null && limit > 0 && (
            <div className="-mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setAmount(String(Math.round(limit)))}
                className="rounded-full bg-panel px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-line dark:bg-white/[0.07] dark:text-[#e7e2d8] dark:hover:bg-white/[0.12]">
                All of it — {rs(limit)}
              </button>
            </div>
          )}

          <Field label="Date given back">
            <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} aria-label="Date given back"
              className={`${inputCls} max-sm:text-[16px]`} />
          </Field>

          <Field label="Note (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note"
              placeholder="e.g. paid back in cash at the office"
              className={`${inputCls} max-sm:text-[16px]`} />
          </Field>

          {limit !== null && !problem && (
            <div className="rounded-xl2 bg-success-soft px-3.5 py-3 text-[12.5px] leading-snug text-emerald-900 dark:bg-white/[0.05] dark:text-[#bfe6c6]">
              <div className="flex items-baseline justify-between gap-3">
                <span>{MONTHS[m]} advance {edit ? "without this return" : "now"}</span>
                <b className="tabular-nums">{rs(limit)}</b>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span>After this return</span>
                <b className="tabular-nums">{rs(limit - n)}</b>
              </div>
              <div className="mt-1.5 border-t border-emerald-300/60 pt-1.5 font-semibold dark:border-white/10">
                {edit
                  ? diff === 0 ? "The amount is the same; only the date or note changes."
                    : `${MONTHS[m]} pay goes ${diff > 0 ? "up" : "down"} by ${rs(Math.abs(diff))} from what it is now.`
                  : `${MONTHS[m]} pay goes up by ${rs(n)}.`}
              </div>
            </div>
          )}
        </div>
      )}

      {err && (
        <p className="mt-3.5 flex items-start gap-1.5 rounded-xl2 bg-danger-soft px-3 py-2 text-[12.5px] font-semibold text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {!nothing && (
          <button onClick={save} disabled={busy || !!problem || (!edit && opens === null)} className={btnPrimary}>
            {busy && <Loader2 size={14} className="animate-spin" />} {edit ? "Save change" : "Record return"}
          </button>
        )}
        <button onClick={onClose} disabled={busy} className={btnGhost}>{nothing ? "Close" : "Cancel"}</button>
        {problem && !err && !nothing && (edit || opens !== null) && (
          <span className="text-[12px] text-muted dark:text-[#a89f93]">{problem}</span>
        )}
      </div>
    </Modal>
  );
}
