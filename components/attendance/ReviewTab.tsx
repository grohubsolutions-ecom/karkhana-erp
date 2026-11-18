"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { STAFF_FIELDS, flatStaff, hours, karachiDate, karachiTime, type Day, type Staff } from "@/lib/attendance";
import Modal, { Field, btnGhost, btnPrimary, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, StatusBadge, TableBox, linkBtn, td } from "./ui";

type Unmapped = { device_user_id: string; punches: number; last_punch: string };
type Fix = { day: Day; name: string; time: string; status: string; note: string };

export default function ReviewTab() {
  const [month, setMonth] = useState(karachiDate().slice(0, 7));
  const [days, setDays] = useState<Day[]>([]);
  const [ot, setOt] = useState<Day[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [fix, setFix] = useState<Fix | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
    const [d, o, s, u] = await Promise.all([
      supabase.from("att_days").select("*").gte("att_date", from).lte("att_date", to).in("status", ["missing_out", "no_shift", "absent", "half_day"]).order("att_date", { ascending: false }).limit(1000),
      supabase.from("att_days").select("*").gte("att_date", from).lte("att_date", to).gt("overtime_minutes", 0).order("att_date", { ascending: false }).limit(1000),
      supabase.from("employees").select(STAFF_FIELDS).limit(1000),
      supabase.from("att_unmapped_punches").select("device_user_id,punches,last_punch"),
    ]);
    setErr(d.error?.message || o.error?.message || s.error?.message || u.error?.message || "");
    setDays((d.data as Day[]) ?? []); setOt((o.data as Day[]) ?? []);
    setStaff(flatStaff(s.data)); setUnmapped((u.data as Unmapped[]) ?? []);
    setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const name = useMemo(() => { const m = new Map(staff.map((s) => [s.id, s.name])); return (id: string) => m.get(id) ?? "—"; }, [staff]);

  async function approve(d: Day, minutes: number) {
    if (!supabase) return;
    const { error } = await supabase.from("att_days").update({ overtime_approved_minutes: minutes }).eq("employee_id", d.employee_id).eq("att_date", d.att_date);
    if (error) setErr(error.message); else load();
  }

  async function saveFix() {
    if (!supabase || !fix) return;
    const args = { p_employee_id: fix.day.employee_id, p_date: fix.day.att_date };
    const { error } = fix.status === "punch"
      ? await supabase.rpc("att_add_manual_punch", { ...args, p_time: fix.time, p_note: fix.note })
      : await supabase.rpc("att_set_day_status", { ...args, p_status: fix.status === "auto" ? null : fix.status, p_note: fix.note });
    if (error) { setErr(error.message); return; }
    setErr(""); setFix(null); load();
  }

  return (
    <div className="space-y-6">
      <ErrorNote text={err} />
      <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${inputCls} !w-44`} aria-label="Month" />

      {unmapped.length > 0 && (
        <section className="rounded-card border border-amber-strong bg-amber-soft p-4 text-[13px] text-ink">
          <b>Punches with no employee.</b> Link these device IDs in the Staff tab: {unmapped.map((u) => `ID ${u.device_user_id} (${u.punches})`).join(", ")}.
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Days to check</h2>
        <TableBox>
          <Head cols={["Date", "Name", "In", "Out", "Status", ""]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {days.length === 0 ? <Empty span={6} loading={loading} text="Nothing to check this month." /> : days.map((d) => (
              <tr key={d.employee_id + d.att_date} className="text-ink dark:text-[#e7e2d8]">
                <td className={td}>{d.att_date}</td>
                <td className={`${td} font-semibold`}>{name(d.employee_id)}</td>
                <td className={td}>{karachiTime(d.first_in)}</td>
                <td className={td}>{karachiTime(d.last_out)}</td>
                <td className={td}><StatusBadge status={d.status} />{d.is_manual ? " Corrected" : ""}</td>
                <td className={`${td} text-right`}><button className={linkBtn} onClick={() => setFix({ day: d, name: name(d.employee_id), time: "", status: "punch", note: "" })}>Correct</button></td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      </section>

      <section>
        <h2 className="mb-2 text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Overtime</h2>
        <p className="mb-2 text-[12.5px] text-muted dark:text-[#a89f93]">Only approved overtime is paid.</p>
        <TableBox>
          <Head cols={["Date", "Name", "Overtime", "Approved", ""]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {ot.length === 0 ? <Empty span={5} loading={loading} text="No overtime this month." /> : ot.map((d) => (
              <tr key={d.employee_id + d.att_date} className="text-ink dark:text-[#e7e2d8]">
                <td className={td}>{d.att_date}</td>
                <td className={`${td} font-semibold`}>{name(d.employee_id)}</td>
                <td className={td}>{hours(d.overtime_minutes)}</td>
                <td className={td}>{hours(d.overtime_approved_minutes)}</td>
                <td className={`${td} text-right`}>
                  {d.overtime_approved_minutes < d.overtime_minutes
                    ? <button className={linkBtn} onClick={() => approve(d, d.overtime_minutes)}>Approve</button>
                    : <button className={linkBtn} onClick={() => approve(d, 0)}>Undo</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      </section>

      <Modal open={!!fix} onClose={() => setFix(null)} title="Correct this day" subtitle={fix ? `${fix.name} · ${fix.day.att_date}` : ""}>
        {fix && (
          <div className="space-y-3">
            <Field label="Correction">
              <select className={inputCls} value={fix.status} onChange={(e) => setFix({ ...fix, status: e.target.value })}>
                <option value="punch">Add a missed punch</option>
                <option value="present">Mark present for the full day</option>
                <option value="paid_leave">Mark paid leave</option>
                <option value="absent">Mark absent</option>
                <option value="auto">Remove correction, use punches</option>
              </select>
            </Field>
            {fix.status === "punch" && <Field label="Punch time"><input type="time" className={inputCls} value={fix.time} onChange={(e) => setFix({ ...fix, time: e.target.value })} /></Field>}
            <Field label="Reason"><input className={inputCls} value={fix.note} onChange={(e) => setFix({ ...fix, note: e.target.value })} /></Field>
            <div className="flex justify-end gap-2">
              <button className={btnGhost} onClick={() => setFix(null)}>Cancel</button>
              <button className={btnPrimary} disabled={(fix.status === "punch" && !fix.time) || !fix.note.trim()} onClick={saveFix}>Save</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
