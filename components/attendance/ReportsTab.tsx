"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { exportExcel } from "@/lib/export";
import { STAFF_FIELDS, STATUS_LABEL, flatStaff, hours, karachiDate, karachiTime, type Day, type Staff } from "@/lib/attendance";
import { Segmented } from "@/components/HubUI";
import { btnGhost, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, StatusBadge, TableBox, td } from "./ui";

type Punch = { device_user_id: string; punched_at: string; raw_line: string | null };
type Link = { employee_id: string; device_user_id: string | null };
type View = "days" | "punches";
const LIMIT = 5000;
const karachiDay = (v: string) => new Date(v).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });

export default function ReportsTab() {
  const [month, setMonth] = useState(karachiDate().slice(0, 7));
  const [view, setView] = useState<View>("days");
  const [person, setPerson] = useState("all");
  const [days, setDays] = useState<Day[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
    const [d, p, s, l] = await Promise.all([
      supabase.from("att_days").select("*").gte("att_date", from).lte("att_date", to).order("att_date").limit(LIMIT),
      supabase.from("att_punches").select("device_user_id,punched_at,raw_line").gte("punched_at", `${from}T00:00:00+05:00`).lte("punched_at", `${to}T23:59:59+05:00`).order("punched_at").limit(LIMIT),
      supabase.from("employees").select(STAFF_FIELDS).order("name").limit(1000),
      supabase.from("att_employee_settings").select("employee_id,device_user_id"),
    ]);
    setErr(d.error?.message || p.error?.message || s.error?.message || l.error?.message || "");
    setDays((d.data as Day[]) ?? []); setPunches((p.data as Punch[]) ?? []);
    setStaff(flatStaff(s.data)); setLinks((l.data as Link[]) ?? []);
    setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const byDevice = useMemo(() => new Map(links.filter((l) => l.device_user_id).map((l) => [l.device_user_id as string, l.employee_id])), [links]);
  const shownDays = days.filter((d) => person === "all" || d.employee_id === person);
  const shownPunches = punches.filter((p) => person === "all" || byDevice.get(p.device_user_id) === person);
  const punchName = (p: Punch) => byId.get(byDevice.get(p.device_user_id) ?? "")?.name ?? "Not linked";
  const capped = days.length >= LIMIT || punches.length >= LIMIT;

  function download() {
    if (view === "days") {
      exportExcel({
        title: `Attendance ${month}`,
        headers: ["Date", "Name", "Department", "In", "Out", "Worked", "Late min", "Early min", "Overtime min", "Status", "Note"],
        rows: shownDays.map((d) => {
          const s = byId.get(d.employee_id);
          return [d.att_date, s?.name ?? "", s?.departments?.name ?? "", karachiTime(d.first_in), karachiTime(d.last_out), hours(d.worked_minutes), d.late_minutes, d.early_minutes, d.overtime_minutes, STATUS_LABEL[d.status] ?? d.status, d.note ?? ""];
        }),
      });
    } else {
      exportExcel({
        title: `Punches ${month}`,
        headers: ["Date", "Time", "Device ID", "Name"],
        rows: shownPunches.map((p) => [karachiDay(p.punched_at), karachiTime(p.punched_at), p.device_user_id, punchName(p)]),
      });
    }
  }

  return (
    <div>
      <ErrorNote text={err} />
      {capped && <ErrorNote text={`Only the first ${LIMIT} rows of this month are shown.`} />}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${inputCls} !w-44`} aria-label="Month" />
        <select value={person} onChange={(e) => setPerson(e.target.value)} className={`${inputCls} !w-56`} aria-label="Person">
          <option value="all">Everyone</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Segmented value={view} onChange={setView} options={[{ key: "days", label: "Daily attendance" }, { key: "punches", label: "Machine punches" }]} />
        <button className={btnGhost} onClick={download}><Download size={14} /> Excel</button>
      </div>
      {view === "days" ? (
        <TableBox min={860}>
          <Head cols={["Date", "Name", "In", "Out", "Worked", "Late", "Overtime", "Status"]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {shownDays.length === 0 ? <Empty span={8} loading={loading} text="No attendance for this month." /> : shownDays.map((d) => (
              <tr key={d.employee_id + d.att_date} className="text-ink dark:text-[#e7e2d8]">
                <td className={td}>{d.att_date}</td>
                <td className={`${td} font-semibold`}>{byId.get(d.employee_id)?.name ?? "—"}</td>
                <td className={td}>{karachiTime(d.first_in)}</td>
                <td className={td}>{karachiTime(d.last_out)}</td>
                <td className={td}>{hours(d.worked_minutes)}</td>
                <td className={td}>{d.late_minutes} min</td>
                <td className={td}>{hours(d.overtime_minutes)}</td>
                <td className={td}><StatusBadge status={d.status} /></td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      ) : (
        <TableBox>
          <Head cols={["Date", "Time", "Device ID", "Name"]} />
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {shownPunches.length === 0 ? <Empty span={4} loading={loading} text="No punches for this month." /> : shownPunches.map((p) => (
              <tr key={p.device_user_id + p.punched_at} className="text-ink dark:text-[#e7e2d8]">
                <td className={td}>{karachiDay(p.punched_at)}</td>
                <td className={td}>{karachiTime(p.punched_at)}</td>
                <td className={td}>{p.device_user_id}</td>
                <td className={`${td} font-semibold`}>{punchName(p)}</td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      )}
    </div>
  );
}
