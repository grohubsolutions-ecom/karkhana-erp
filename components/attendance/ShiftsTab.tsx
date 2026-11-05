"use client";
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { WEEKDAYS, hhmm, type Dept, type Shift } from "@/lib/attendance";
import Modal, { Field, btnGhost, btnPrimary, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, TableBox, linkBtn, td } from "./ui";

type Form = {
  id: string | null; name: string; start_time: string; end_time: string; break_minutes: string; late_grace_minutes: string;
  early_grace_minutes: string; half_day_minutes: string; overtime_after_minutes: string; off_weekdays: number[];
};
const blank = (): Form => ({
  id: null, name: "", start_time: "09:00", end_time: "17:00", break_minutes: "0", late_grace_minutes: "10",
  early_grace_minutes: "10", half_day_minutes: "", overtime_after_minutes: "30", off_weekdays: [0],
});

export default function ShiftsTab() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Form | null>(null);
  const [newDept, setNewDept] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [s, d, m] = await Promise.all([
      supabase.from("att_shifts").select("*").eq("is_active", true).order("name"),
      supabase.from("departments").select("id,code,name,kind,parent_id,is_active").eq("is_active", true).order("name"),
      supabase.from("att_department_settings").select("department_id,default_shift_id"),
    ]);
    setErr(s.error?.message || d.error?.message || m.error?.message || "");
    setShifts((s.data as Shift[]) ?? []); setDepts((d.data as Dept[]) ?? []);
    setDefaults(Object.fromEntries(((m.data ?? []) as { department_id: string; default_shift_id: string | null }[]).map((r) => [r.department_id, r.default_shift_id ?? ""])));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function saveShift() {
    if (!supabase || !form) return;
    if (!form.name.trim()) { setErr("Enter a shift name."); return; }
    if (form.end_time <= form.start_time) { setErr("The shift must end after it starts."); return; }
    const row = {
      name: form.name.trim(), start_time: form.start_time, end_time: form.end_time, break_minutes: Number(form.break_minutes) || 0,
      late_grace_minutes: Number(form.late_grace_minutes) || 0, early_grace_minutes: Number(form.early_grace_minutes) || 0,
      half_day_minutes: form.half_day_minutes === "" ? null : Number(form.half_day_minutes),
      overtime_after_minutes: Number(form.overtime_after_minutes) || 0, off_weekdays: form.off_weekdays, updated_at: new Date().toISOString(),
    };
    const { error } = form.id ? await supabase.from("att_shifts").update(row).eq("id", form.id) : await supabase.from("att_shifts").insert(row);
    if (error) { setErr(error.message); return; }
    setErr(""); setForm(null); load();
  }

  async function setDefault(deptId: string, shiftId: string) {
    if (!supabase) return;
    setDefaults((m) => ({ ...m, [deptId]: shiftId }));
    const { error } = await supabase.from("att_department_settings").upsert(
      { department_id: deptId, default_shift_id: shiftId || null, updated_at: new Date().toISOString() }, { onConflict: "department_id" });
    if (error) setErr(error.message);
  }

  async function addDept() {
    if (!supabase || !newDept.trim()) return;
    const code = newDept.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16);
    const { error } = await supabase.from("departments").insert({ code, name: newDept.trim(), kind: "business_unit" });
    if (error) { setErr(error.code === "23505" ? "That department already exists." : error.message); return; }
    setErr(""); setNewDept(""); load();
  }

  const f = (p: Partial<Form>) => setForm((x) => (x ? { ...x, ...p } : x));
  const num = (key: keyof Form, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min="0" className={inputCls} value={form?.[key] as string} onChange={(e) => f({ [key]: e.target.value } as Partial<Form>)} />
    </Field>
  );

  return (
    <div className="space-y-6">
      <ErrorNote text={err} />
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Shifts</h2>
          <button className={btnPrimary} onClick={() => setForm(blank())}><Plus size={15} /> Add shift</button>
        </div>
        <TableBox>
          <Head cols={["Shift", "Time", "Break", "Late grace", "Half day under", "Overtime after", "Off days", ""]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {shifts.length === 0 ? <Empty span={8} loading={loading} text="No shifts yet." /> : shifts.map((s) => (
              <tr key={s.id} className="text-ink dark:text-[#e7e2d8]">
                <td className={`${td} font-semibold`}>{s.name}</td>
                <td className={td}>{hhmm(s.start_time)}–{hhmm(s.end_time)}</td>
                <td className={td}>{s.break_minutes} min</td>
                <td className={td}>{s.late_grace_minutes} min</td>
                <td className={td}>{s.half_day_minutes ? `${s.half_day_minutes} min` : "—"}</td>
                <td className={td}>{s.overtime_after_minutes} min</td>
                <td className={td}>{s.off_weekdays.map((d) => WEEKDAYS[d]).join(", ") || "None"}</td>
                <td className={`${td} text-right`}>
                  <button className={linkBtn} onClick={() => setForm({
                    id: s.id, name: s.name, start_time: hhmm(s.start_time), end_time: hhmm(s.end_time), break_minutes: String(s.break_minutes),
                    late_grace_minutes: String(s.late_grace_minutes), early_grace_minutes: String(s.early_grace_minutes),
                    half_day_minutes: s.half_day_minutes == null ? "" : String(s.half_day_minutes),
                    overtime_after_minutes: String(s.overtime_after_minutes), off_weekdays: s.off_weekdays,
                  })}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Departments</h2>
          <div className="flex gap-2">
            <input className={`${inputCls} !w-56`} placeholder="New department name" aria-label="New department name" value={newDept} onChange={(e) => setNewDept(e.target.value)} />
            <button className={btnGhost} onClick={addDept}><Plus size={14} /> Add</button>
          </div>
        </div>
        <p className="mb-2 text-[12.5px] text-muted dark:text-[#a89f93]">A section with no shift uses its parent department's shift.</p>
        <TableBox min={480}>
          <Head cols={["Department", "Default shift"]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {depts.length === 0 ? <Empty span={2} loading={loading} text="No departments." /> : depts.map((d) => (
              <tr key={d.id} className="text-ink dark:text-[#e7e2d8]">
                <td className={`${td} font-semibold`}>{d.name}</td>
                <td className={td}>
                  <select aria-label={`Default shift for ${d.name}`} className={`${inputCls} !w-64`} value={defaults[d.id] ?? ""} onChange={(e) => setDefault(d.id, e.target.value)}>
                    <option value="">{d.parent_id ? "Use parent department" : "No shift"}</option>
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      </section>

      <Modal open={!!form} onClose={() => setForm(null)} wide title={form?.id ? "Edit shift" : "Add shift"} subtitle="Changes apply when days are recalculated, including past days in this month.">
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Shift name"><input className={inputCls} value={form.name} onChange={(e) => f({ name: e.target.value })} /></Field></div>
            <Field label="Start"><input type="time" className={inputCls} value={form.start_time} onChange={(e) => f({ start_time: e.target.value })} /></Field>
            <Field label="End"><input type="time" className={inputCls} value={form.end_time} onChange={(e) => f({ end_time: e.target.value })} /></Field>
            {num("break_minutes", "Unpaid break (minutes)")}
            {num("late_grace_minutes", "Late grace (minutes)")}
            {num("early_grace_minutes", "Early leaving grace (minutes)")}
            {num("half_day_minutes", "Half day if worked under (minutes)", "Leave empty for staff who only work half days.")}
            {num("overtime_after_minutes", "Overtime starts after (minutes)")}
            <div>
              <p className="text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">Off days</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {WEEKDAYS.map((w, i) => (
                  <label key={w} className="flex items-center gap-1 text-[12.5px] text-ink dark:text-[#e7e2d8]">
                    <input type="checkbox" checked={form.off_weekdays.includes(i)}
                      onChange={(e) => f({ off_weekdays: e.target.checked ? [...form.off_weekdays, i] : form.off_weekdays.filter((d) => d !== i) })} /> {w}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button className={btnGhost} onClick={() => setForm(null)}>Cancel</button>
              <button className={btnPrimary} onClick={saveShift}>Save</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
