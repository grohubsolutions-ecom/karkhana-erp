"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { PAY_TYPES, STAFF_FIELDS, flatStaff, hhmm, money, karachiDate, type Dept, type Settings, type Shift, type Staff } from "@/lib/attendance";
import Modal, { Field, btnGhost, btnPrimary, inputCls } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { Empty, ErrorNote, Head, TableBox, linkBtn, td } from "./ui";

type Form = {
  id: string | null; name: string; phone: string; department_id: string; pay_type: string; pay_amount: string;
  join_date: string; device_user_id: string; shift_id: string; working_days_per_month: string;
  late_cut_enabled: boolean; overtime_enabled: boolean; overtime_multiplier: string;
};
const blank = (): Form => ({
  id: null, name: "", phone: "", department_id: "", pay_type: "Monthly", pay_amount: "", join_date: karachiDate(),
  device_user_id: "", shift_id: "", working_days_per_month: "26", late_cut_enabled: true, overtime_enabled: true, overtime_multiplier: "1",
});
const canonicalPay = (v: string | null) => {
  const s = (v ?? "").toLowerCase();
  return s.startsWith("piece") ? "Piece-rate" : PAY_TYPES.find((p) => p.toLowerCase() === s) ?? "Monthly";
};

export default function StaffTab() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [settings, setSettings] = useState<Settings[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [showLeft, setShowLeft] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [formErr, setFormErr] = useState("");
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [e, s, d, sh] = await Promise.all([
      supabase.from("employees").select(STAFF_FIELDS).order("name").limit(1000),
      supabase.from("att_employee_settings").select("*"),
      supabase.from("departments").select("id,code,name,kind,parent_id,is_active").eq("is_active", true).order("name"),
      supabase.from("att_shifts").select("*").eq("is_active", true).order("name"),
    ]);
    setErr(e.error?.message || s.error?.message || d.error?.message || sh.error?.message || "");
    setStaff(flatStaff(e.data)); setSettings((s.data as Settings[]) ?? []);
    setDepts((d.data as Dept[]) ?? []); setShifts((sh.data as Shift[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const setOf = useMemo(() => new Map(settings.map((s) => [s.employee_id, s])), [settings]);
  const shiftName = (id: string | null | undefined) => shifts.find((s) => s.id === id)?.name;
  const shown = staff.filter((s) =>
    (showLeft || s.is_active) && (dept === "all" || s.department_id === dept) &&
    (!q.trim() || [s.name, s.code, setOf.get(s.id)?.device_user_id].some((x) => String(x ?? "").toLowerCase().includes(q.trim().toLowerCase()))));

  function edit(s: Staff) {
    const c = setOf.get(s.id);
    setFormErr("");
    setForm({
      id: s.id, name: s.name, phone: s.phone ?? "", department_id: s.department_id ?? "", pay_type: canonicalPay(s.pay_type),
      pay_amount: s.pay_amount == null ? "" : String(s.pay_amount), join_date: s.join_date ?? "",
      device_user_id: c?.device_user_id ?? "", shift_id: c?.shift_id ?? "",
      working_days_per_month: String(c?.working_days_per_month ?? 26), late_cut_enabled: c?.late_cut_enabled ?? true,
      overtime_enabled: c?.overtime_enabled ?? true, overtime_multiplier: String(c?.overtime_multiplier ?? 1),
    });
  }

  async function save() {
    if (!supabase || !form) return;
    if (!form.name.trim()) { setFormErr("Enter a name."); return; }
    if (!form.department_id) { setFormErr("Choose a department."); return; }
    if (form.pay_type !== "Piece-rate" && !(Number(form.pay_amount) > 0)) { setFormErr("Enter the pay amount."); return; }
    setBusy(true); setFormErr("");
    const person = {
      name: form.name.trim(), phone: form.phone.trim() || null, department_id: form.department_id, pay_type: form.pay_type,
      pay_amount: form.pay_amount === "" ? null : Number(form.pay_amount), join_date: form.join_date || null,
    };
    const res = form.id
      ? await supabase.from("employees").update(person).eq("id", form.id).select("id").single()
      : await supabase.from("employees").insert(person).select("id").single();
    if (res.error || !res.data) { setBusy(false); setFormErr(res.error?.message ?? "Could not save."); return; }
    const up = await supabase.from("att_employee_settings").upsert({
      employee_id: (res.data as { id: string }).id, device_user_id: form.device_user_id.trim() || null, shift_id: form.shift_id || null,
      working_days_per_month: Number(form.working_days_per_month) || 26, late_cut_enabled: form.late_cut_enabled,
      overtime_enabled: form.overtime_enabled, overtime_multiplier: Number(form.overtime_multiplier) || 0, updated_at: new Date().toISOString(),
    }, { onConflict: "employee_id" });
    setBusy(false);
    if (up.error) {
      setFormErr(up.error.code === "23505" ? "That device ID already belongs to someone else." : up.error.message);
      setForm({ ...form, id: (res.data as { id: string }).id });
      load();
      return;
    }
    setForm(null); load();
  }

  async function toggle(s: Staff) {
    if (!supabase) return;
    if (s.is_active) {
      const ok = await confirm({ title: `Remove ${s.name}?`, body: "Attendance stops, but their history and pay records stay.", confirmLabel: "Remove" });
      if (!ok) return;
    }
    const { error } = await supabase.from("employees").update({ is_active: !s.is_active }).eq("id", s.id);
    if (error) setErr(error.message); else load();
  }

  const f = (patch: Partial<Form>) => setForm((p) => (p ? { ...p, ...patch } : p));

  return (
    <div>
      <ErrorNote text={err} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or device ID" aria-label="Search staff" className={`${inputCls} !w-64 !pl-8`} />
        </div>
        <select value={dept} onChange={(e) => setDept(e.target.value)} className={`${inputCls} !w-52`} aria-label="Department">
          <option value="all">All departments</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted dark:text-[#a89f93]">
          <input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} /> Show removed staff
        </label>
        <button className={`${btnPrimary} ml-auto`} onClick={() => { setFormErr(""); setForm(blank()); }}><Plus size={15} /> Add employee</button>
      </div>
      <TableBox min={880}>
        <Head cols={["Name", "Department", "Device ID", "Shift", "Pay", "Late cut", "Overtime", ""]} />
        <tbody className="divide-y divide-line dark:divide-white/[0.05]">
          {shown.length === 0 ? <Empty span={8} loading={loading} text="No staff match this filter." /> : shown.map((s) => {
            const c = setOf.get(s.id);
            return (
              <tr key={s.id} className={s.is_active ? "text-ink dark:text-[#e7e2d8]" : "text-muted"}>
                <td className={`${td} font-semibold`}>{s.name}<span className="block text-[11.5px] font-normal text-muted">{s.code}{s.is_active ? "" : " · Removed"}</span></td>
                <td className={td}>{s.departments?.name ?? "—"}</td>
                <td className={td}>{c?.device_user_id ?? <span className="text-danger">Not linked</span>}</td>
                <td className={td}>{shiftName(c?.shift_id) ?? "Department default"}</td>
                <td className={td}>{canonicalPay(s.pay_type)}{s.pay_amount != null ? ` · ${money(s.pay_amount)}` : ""}</td>
                <td className={td}>{c ? (c.late_cut_enabled ? "On" : "Off") : "—"}</td>
                <td className={td}>{c ? (c.overtime_enabled ? `${c.overtime_multiplier}×` : "Off") : "—"}</td>
                <td className={`${td} text-right`}>
                  <button className={linkBtn} onClick={() => edit(s)}>Edit</button>{" "}
                  <button className={linkBtn} onClick={() => toggle(s)}>{s.is_active ? "Remove" : "Restore"}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableBox>

      <Modal open={!!form} onClose={() => setForm(null)} wide title={form?.id ? "Edit employee" : "Add employee"} subtitle="The device ID must match the User ID enrolled on the machine.">
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name"><input className={inputCls} value={form.name} onChange={(e) => f({ name: e.target.value })} /></Field>
            <Field label="Phone"><input className={inputCls} value={form.phone} onChange={(e) => f({ phone: e.target.value })} /></Field>
            <Field label="Department">
              <select className={inputCls} value={form.department_id} onChange={(e) => f({ department_id: e.target.value })}>
                <option value="">Choose…</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Join date"><input type="date" className={inputCls} value={form.join_date} onChange={(e) => f({ join_date: e.target.value })} /></Field>
            <Field label="Device ID"><input className={inputCls} value={form.device_user_id} onChange={(e) => f({ device_user_id: e.target.value })} /></Field>
            <Field label="Own shift" hint="Leave on default to use the department's shift.">
              <select className={inputCls} value={form.shift_id} onChange={(e) => f({ shift_id: e.target.value })}>
                <option value="">Department default</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({hhmm(s.start_time)}–{hhmm(s.end_time)})</option>)}
              </select>
            </Field>
            <Field label="Pay type">
              <select className={inputCls} value={form.pay_type} onChange={(e) => f({ pay_type: e.target.value })}>
                {PAY_TYPES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label={form.pay_type === "Monthly" ? "Monthly salary (Rs)" : form.pay_type === "Daily" ? "Daily wage (Rs)" : form.pay_type === "Hourly" ? "Hourly rate (Rs)" : "Amount (not used for piece rate)"}>
              <input type="number" min="0" className={inputCls} value={form.pay_amount} onChange={(e) => f({ pay_amount: e.target.value })} />
            </Field>
            <Field label="Working days per month"><input type="number" min="1" className={inputCls} value={form.working_days_per_month} onChange={(e) => f({ working_days_per_month: e.target.value })} /></Field>
            <Field label="Overtime rate" hint="1 = normal rate, 1.5 = time and a half.">
              <input type="number" min="0" step="0.25" className={inputCls} value={form.overtime_multiplier} onChange={(e) => f({ overtime_multiplier: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ink dark:text-[#e7e2d8]"><input type="checkbox" checked={form.late_cut_enabled} onChange={(e) => f({ late_cut_enabled: e.target.checked })} /> Cut pay for late arrival and early leaving</label>
            <label className="flex items-center gap-2 text-[13px] text-ink dark:text-[#e7e2d8]"><input type="checkbox" checked={form.overtime_enabled} onChange={(e) => f({ overtime_enabled: e.target.checked })} /> Allow overtime</label>
            <div className="sm:col-span-2"><ErrorNote text={formErr} /></div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button className={btnGhost} onClick={() => setForm(null)}>Cancel</button>
              <button className={btnPrimary} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
