"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { STAFF_FIELDS, flatStaff, hours, karachiDate, karachiTime, type Day, type Staff } from "@/lib/attendance";
import { inputCls, btnGhost } from "@/components/Modal";
import { DeptPicker, Empty, ErrorNote, Head, Stat, StatusBadge, TableBox, deptOf, td } from "./ui";

type Device = { serial_no: string; name: string; last_seen_at: string | null };

export default function TodayTab() {
  const [date, setDate] = useState(karachiDate());
  const [staff, setStaff] = useState<Staff[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [dept, setDept] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setErr("");
    const calc = await supabase.rpc("att_recalculate_range", { p_from: date, p_to: date, p_employee_id: null });
    const [s, d, dv] = await Promise.all([
      supabase.from("employees").select(STAFF_FIELDS).eq("is_active", true).order("name"),
      supabase.from("att_days").select("*").eq("att_date", date),
      supabase.from("att_devices").select("serial_no,name,last_seen_at").order("name"),
    ]);
    setErr(calc.error?.message || s.error?.message || d.error?.message || dv.error?.message || "");
    setStaff(flatStaff(s.data)); setDays((d.data as Day[]) ?? []); setDevices((dv.data as Device[]) ?? []);
    setLoading(false);
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map(days.map((d) => [d.employee_id, d])), [days]);
  const names = useMemo(() => [...new Set(staff.map((s) => deptOf(s.departments?.name)))].sort(), [staff]);
  const chosen = dept && (dept === "all" || names.includes(dept)) ? dept : names[0] ?? "";
  const shown = staff.filter((s) => chosen === "all" || deptOf(s.departments?.name) === chosen);
  const shownDays = shown.map((s) => byId.get(s.id)).filter((d): d is Day => !!d);
  const count = (...s: string[]) => shownDays.filter((d) => s.includes(d.status)).length;
  const online = (v: string | null) => !!v && Date.now() - new Date(v).getTime() < 5 * 60 * 1000;

  return (
    <div>
      <ErrorNote text={err} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="date" value={date} max={karachiDate()} onChange={(e) => setDate(e.target.value)} className={`${inputCls} !w-44`} aria-label="Date" />
        <DeptPicker names={names} value={chosen} onChange={setDept} allLabel="All departments" />
        <button onClick={load} className={btnGhost}><RefreshCw size={14} /> Refresh</button>
        {devices.map((d) => (
          <span key={d.serial_no} className="ml-auto text-[12.5px] text-muted dark:text-[#a89f93]">
            {d.name}: <b className={online(d.last_seen_at) ? "text-ink dark:text-[#f4f1ea]" : "text-danger"}>{online(d.last_seen_at) ? "Online" : "Offline"}</b>
            {d.last_seen_at ? ` · last seen ${karachiTime(d.last_seen_at)}` : " · not connected yet"}
          </span>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Present or at work" value={count("present", "in_progress", "worked_off")} />
        <Stat label="Absent" value={count("absent")} />
        <Stat label="Late" value={shownDays.filter((d) => d.late_minutes > 0).length} />
        <Stat label="Need review" value={count("missing_out", "no_shift")} />
      </div>
      <TableBox>
        <Head cols={["Name", "Department", "In", "Out", "Worked", "Late", "Early", "Status"]} />
        <tbody className="divide-y divide-line dark:divide-white/[0.05]">
          {shown.length === 0 ? <Empty span={8} loading={loading} text="No active staff." /> : shown.map((s) => {
            const d = byId.get(s.id);
            return (
              <tr key={s.id} className="text-ink dark:text-[#e7e2d8]">
                <td className={`${td} font-semibold`}>{s.name}</td>
                <td className={td}>{s.departments?.name ?? "—"}</td>
                <td className={td}>{karachiTime(d?.first_in ?? null)}</td>
                <td className={td}>{karachiTime(d?.last_out ?? null)}</td>
                <td className={td}>{d?.worked_minutes ? hours(d.worked_minutes) : "—"}</td>
                <td className={td}>{d?.late_minutes ? `${d.late_minutes} min` : "—"}</td>
                <td className={td}>{d?.early_minutes ? `${d.early_minutes} min` : "—"}</td>
                <td className={td}><StatusBadge status={d?.status} /></td>
              </tr>
            );
          })}
        </tbody>
      </TableBox>
    </div>
  );
}
