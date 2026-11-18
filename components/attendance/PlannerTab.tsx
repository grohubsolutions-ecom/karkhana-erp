"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { STAFF_FIELDS, flatStaff, hhmm, karachiDate, money, type Shift, type Staff } from "@/lib/attendance";
import { Field, btnPrimary, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, TableBox, linkBtn, td } from "./ui";

type Adj = { id: number; employee_id: string; adj_date: string; kind: string; amount: number; note: string | null };
type Temp = { employee_id: string; att_date: string; shift_id: string };
type Holiday = { hdate: string; name: string };
type Form = {
  employee: string; from: string; to: string; leave: string; note: string; shift: string;
  otDate: string; otHours: string; otNote: string; adjDate: string; adjKind: string; adjAmount: string; adjNote: string;
  holidayDate: string; holidayName: string;
};
const MAX_DAYS = 62;

function dateRange(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`) && out.length <= MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-bold text-ink dark:text-[#f4f1ea]">{title}</h2>
      <p className="mb-3 text-[12.5px] text-muted dark:text-[#a89f93]">{hint}</p>
      {children}
    </section>
  );
}

export default function PlannerTab() {
  const today = karachiDate();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [adjs, setAdjs] = useState<Adj[]>([]);
  const [temps, setTemps] = useState<Temp[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState<Form>({
    employee: "", from: today, to: today, leave: "paid_leave", note: "", shift: "", otDate: today, otHours: "", otNote: "",
    adjDate: today, adjKind: "advance", adjAmount: "", adjNote: "", holidayDate: today, holidayName: "",
  });
  const set = (patch: Partial<Form>) => setF((p) => ({ ...p, ...patch }));

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const year = today.slice(0, 4);
    const [e, s, a, t, h] = await Promise.all([
      supabase.from("employees").select(STAFF_FIELDS).eq("is_active", true).order("name").limit(1000),
      supabase.from("att_shifts").select("*").eq("is_active", true).order("name"),
      supabase.from("att_adjustments").select("*").order("adj_date", { ascending: false }).limit(50),
      supabase.from("att_day_shifts").select("employee_id,att_date,shift_id").gte("att_date", today).order("att_date").limit(100),
      supabase.from("online_att_holidays").select("hdate,name").gte("hdate", `${year}-01-01`).order("hdate"),
    ]);
    setErr(e.error?.message || s.error?.message || a.error?.message || t.error?.message || h.error?.message || "");
    setStaff(flatStaff(e.data)); setShifts((s.data as Shift[]) ?? []); setAdjs((a.data as Adj[]) ?? []);
    setTemps((t.data as Temp[]) ?? []); setHolidays((h.data as Holiday[]) ?? []);
    setLoading(false);
  }, [today]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (id: string) => staff.find((s) => s.id === id)?.name ?? "—";
  const shiftOf = (id: string) => shifts.find((s) => s.id === id)?.name ?? "—";

  async function run(work: () => Promise<string | null>, message: string) {
    setBusy(true); setErr(""); setDone("");
    const problem = await work();
    setBusy(false);
    if (problem) setErr(problem); else { setDone(message); load(); }
  }

  const checkedRange = () => {
    if (!f.employee) return "Choose a person at the top.";
    if (f.to < f.from) return "The end date is before the start date.";
    if (dateRange(f.from, f.to).length > MAX_DAYS) return `Choose ${MAX_DAYS} days or fewer.`;
    return null;
  };

  const saveLeave = () => run(async () => {
    const bad = checkedRange(); if (bad || !supabase) return bad;
    for (const date of dateRange(f.from, f.to)) {
      const { error } = await supabase.rpc("att_set_day_status", { p_employee_id: f.employee, p_date: date, p_status: f.leave === "auto" ? null : f.leave, p_note: f.note || "Leave" });
      if (error) return `${date}: ${error.message}`;
    }
    return null;
  }, "Leave saved.");

  const saveTemp = () => run(async () => {
    const bad = checkedRange() ?? (f.shift ? null : "Choose the hours."); if (bad || !supabase) return bad;
    const rows = dateRange(f.from, f.to).map((att_date) => ({ employee_id: f.employee, att_date, shift_id: f.shift }));
    const { error } = await supabase.from("att_day_shifts").upsert(rows, { onConflict: "employee_id,att_date" });
    if (error) return error.message;
    const { error: calc } = await supabase.rpc("att_recalculate_range", { p_from: f.from, p_to: f.to, p_employee_id: f.employee });
    return calc?.message ?? null;
  }, "Hours changed for those dates.");

  const removeTemp = (t: Temp) => run(async () => {
    if (!supabase) return null;
    const { error } = await supabase.from("att_day_shifts").delete().eq("employee_id", t.employee_id).eq("att_date", t.att_date);
    if (error) return error.message;
    const { error: calc } = await supabase.rpc("att_recalculate_range", { p_from: t.att_date, p_to: t.att_date, p_employee_id: t.employee_id });
    return calc?.message ?? null;
  }, "Back to normal hours.");

  const saveOt = () => run(async () => {
    if (!supabase) return null;
    if (!f.employee) return "Choose a person at the top.";
    const minutes = Math.round(Number(f.otHours) * 60);
    if (!(minutes >= 0) || f.otHours === "") return "Enter the hours.";
    const { error } = await supabase.rpc("att_add_overtime", { p_employee_id: f.employee, p_date: f.otDate, p_minutes: minutes, p_note: f.otNote || null });
    return error?.message ?? null;
  }, "Overtime saved. Enter 0 to remove it.");

  const saveAdj = () => run(async () => {
    if (!supabase) return null;
    if (!f.employee) return "Choose a person at the top.";
    if (!(Number(f.adjAmount) > 0)) return "Enter the amount.";
    const { error } = await supabase.from("att_adjustments").insert({ employee_id: f.employee, adj_date: f.adjDate, kind: f.adjKind, amount: Number(f.adjAmount), note: f.adjNote || null });
    if (!error) set({ adjAmount: "", adjNote: "" });
    return error?.message ?? null;
  }, "Saved to payroll.");

  const removeAdj = (a: Adj) => run(async () => {
    if (!supabase) return null;
    const { error } = await supabase.from("att_adjustments").delete().eq("id", a.id);
    return error?.message ?? null;
  }, "Removed.");

  const saveHoliday = (date: string, name: string) => run(async () => {
    if (!supabase) return null;
    const { error } = await supabase.rpc("att_set_holiday", { p_date: date, p_name: name });
    if (!error) set({ holidayName: "" });
    return error?.message ?? null;
  }, "Holidays updated.");

  return (
    <div className="space-y-7">
      <ErrorNote text={err} />
      {done && <p className="text-[13px] font-semibold text-ink dark:text-[#f4f1ea]" role="status">{done}</p>}
      <Field label="Person">
        <select className={`${inputCls} sm:!w-80`} value={f.employee} onChange={(e) => set({ employee: e.target.value })}>
          <option value="">Choose…</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.departments?.name ?? "No department"}</option>)}
        </select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From"><input type="date" className={inputCls} value={f.from} onChange={(e) => set({ from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="To"><input type="date" className={inputCls} value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
      </div>

      <div className="grid gap-7 lg:grid-cols-2">
        <Section title="Leave" hint="Uses the person and dates above.">
          <div className="space-y-3">
            <Field label="Type">
              <select className={inputCls} value={f.leave} onChange={(e) => set({ leave: e.target.value })}>
                <option value="paid_leave">Paid leave</option>
                <option value="absent">Unpaid leave</option>
                <option value="auto">Cancel leave, use punches</option>
              </select>
            </Field>
            <Field label="Reason"><input className={inputCls} value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
            <button className={btnPrimary} disabled={busy} onClick={saveLeave}>Save leave</button>
          </div>
        </Section>

        <Section title="Different hours for some dates" hint="Uses the person and dates above. Their normal shift returns afterwards.">
          <div className="space-y-3">
            <Field label="Hours on those dates">
              <select className={inputCls} value={f.shift} onChange={(e) => set({ shift: e.target.value })}>
                <option value="">Choose…</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({hhmm(s.start_time)}–{hhmm(s.end_time)})</option>)}
              </select>
            </Field>
            <button className={btnPrimary} disabled={busy} onClick={saveTemp}>Save hours</button>
            {temps.map((t) => (
              <div key={t.employee_id + t.att_date} className="flex items-center justify-between gap-2 text-[13px] text-ink dark:text-[#e7e2d8]">
                <span>{t.att_date} · {nameOf(t.employee_id)} · {shiftOf(t.shift_id)}</span>
                <button className={linkBtn} disabled={busy} onClick={() => removeTemp(t)}>Remove</button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Add overtime by hand" hint="For work the machine did not record. This is paid without a separate approval.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date"><input type="date" className={inputCls} value={f.otDate} onChange={(e) => set({ otDate: e.target.value })} /></Field>
            <Field label="Hours"><input type="number" min="0" step="0.25" className={inputCls} value={f.otHours} onChange={(e) => set({ otHours: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Reason"><input className={inputCls} value={f.otNote} onChange={(e) => set({ otNote: e.target.value })} /></Field></div>
            <button className={`${btnPrimary} w-fit`} disabled={busy} onClick={saveOt}>Save overtime</button>
          </div>
        </Section>

        <Section title="Holidays" hint="Monthly staff are paid. Daily and hourly staff are paid only if they work.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date"><input type="date" className={inputCls} value={f.holidayDate} onChange={(e) => set({ holidayDate: e.target.value })} /></Field>
            <Field label="Name"><input className={inputCls} value={f.holidayName} onChange={(e) => set({ holidayName: e.target.value })} /></Field>
            <button className={`${btnPrimary} w-fit`} disabled={busy || !f.holidayName.trim()} onClick={() => saveHoliday(f.holidayDate, f.holidayName)}>Add holiday</button>
          </div>
          <div className="mt-3 space-y-2">
            {holidays.map((h) => (
              <div key={h.hdate} className="flex items-center justify-between gap-2 text-[13px] text-ink dark:text-[#e7e2d8]">
                <span>{h.hdate} · {h.name}</span>
                <button className={linkBtn} disabled={busy} onClick={() => saveHoliday(h.hdate, "")}>Remove</button>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Advances, deductions and bonuses" hint="These change the balance in Payroll for the month of the date you pick.">
        <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date"><input type="date" className={inputCls} value={f.adjDate} onChange={(e) => set({ adjDate: e.target.value })} /></Field>
          <Field label="Type">
            <select className={inputCls} value={f.adjKind} onChange={(e) => set({ adjKind: e.target.value })}>
              <option value="advance">Advance</option><option value="deduction">Deduction</option><option value="bonus">Bonus</option>
            </select>
          </Field>
          <Field label="Amount (Rs)"><input type="number" min="0" className={inputCls} value={f.adjAmount} onChange={(e) => set({ adjAmount: e.target.value })} /></Field>
          <Field label="Note"><input className={inputCls} value={f.adjNote} onChange={(e) => set({ adjNote: e.target.value })} /></Field>
        </div>
        <button className={`${btnPrimary} mb-3`} disabled={busy} onClick={saveAdj}>Save</button>
        <TableBox>
          <Head cols={["Date", "Name", "Type", "Amount", "Note", ""]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {adjs.length === 0 ? <Empty span={6} loading={loading} text="Nothing added yet." /> : adjs.map((a) => (
              <tr key={a.id} className="text-ink dark:text-[#e7e2d8]">
                <td className={td}>{a.adj_date}</td>
                <td className={`${td} font-semibold`}>{nameOf(a.employee_id)}</td>
                <td className={`${td} capitalize`}>{a.kind}</td>
                <td className={td}>{money(a.amount)}</td>
                <td className={td}>{a.note ?? "—"}</td>
                <td className={`${td} text-right`}><button className={linkBtn} disabled={busy} onClick={() => removeAdj(a)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      </Section>
    </div>
  );
}
