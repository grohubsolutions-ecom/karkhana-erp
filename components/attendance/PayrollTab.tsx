"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { exportExcel } from "@/lib/export";
import { hours, karachiDate, money } from "@/lib/attendance";
import { btnGhost, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, Stat, TableBox, td } from "./ui";

type Pay = {
  employee_id: string; code: string; name: string; department: string | null; pay_type: string; base_amount: number;
  present_days: number; half_days: number; absent_days: number; paid_leave_days: number; review_days: number;
  late_minutes: number; early_minutes: number; overtime_pending_minutes: number; overtime_approved_minutes: number;
  attendance_cut: number; overtime_pay: number; net_pay: number | null; wages_paid: number; note: string | null;
};

export default function PayrollTab() {
  const [month, setMonth] = useState(karachiDate().slice(0, 7));
  const [rows, setRows] = useState<Pay[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("att_month_pay", { p_month: `${month}-01` });
    setErr(error?.message ?? ""); setRows((data as Pay[]) ?? []); setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const balance = (r: Pay) => (r.net_pay == null ? null : Number(r.net_pay) - Number(r.wages_paid));
  const review = rows.reduce((t, r) => t + r.review_days, 0);

  function download() {
    exportExcel({
      title: `Attendance payroll ${month}`,
      headers: ["Code", "Name", "Department", "Pay type", "Rate", "Present", "Absent", "Late min", "Cut", "Overtime", "Net", "Already paid", "Balance", "Note"],
      rows: rows.map((r) => [r.code, r.name, r.department, r.pay_type, r.base_amount, r.present_days, r.absent_days, r.late_minutes, r.attendance_cut, r.overtime_pay, r.net_pay, r.wages_paid, balance(r), r.note]),
    });
  }

  return (
    <div>
      <ErrorNote text={err} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${inputCls} !w-44`} aria-label="Month" />
        <button className={btnGhost} onClick={load}><RefreshCw size={14} /> Recalculate</button>
        <button className={btnGhost} onClick={download} disabled={!rows.length}><Download size={14} /> Excel</button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Net pay" value={money(rows.reduce((t, r) => t + (Number(r.net_pay) || 0), 0))} />
        <Stat label="Still to pay" value={money(rows.reduce((t, r) => t + (balance(r) ?? 0), 0))} />
        <Stat label="Days to review first" value={review} />
      </div>
      <TableBox min={1040}>
        <Head cols={["Name", "Department", "Pay type", "Rate", "Present", "Absent", "Late", "Pending OT", "Cut", "Overtime", "Net", "Already paid", "Balance"]} />
        <tbody className="divide-y divide-line dark:divide-white/[0.05]">
          {rows.length === 0 ? <Empty span={13} loading={loading} text="No staff are set up for this month." /> : rows.map((r) => (
            <tr key={r.employee_id} className="text-ink dark:text-[#e7e2d8]">
              <td className={`${td} font-semibold`}>{r.name}{r.note && <span className="block text-[11.5px] font-normal text-muted">{r.note}</span>}</td>
              <td className={td}>{r.department ?? "—"}</td>
              <td className={`${td} capitalize`}>{r.pay_type || "—"}</td>
              <td className={td}>{money(r.base_amount)}</td>
              <td className={td}>{r.present_days}</td>
              <td className={td}>{r.absent_days}</td>
              <td className={td}>{r.late_minutes} min</td>
              <td className={td}>{r.overtime_pending_minutes ? hours(r.overtime_pending_minutes) : "—"}</td>
              <td className={td}>{money(r.attendance_cut)}</td>
              <td className={td}>{money(r.overtime_pay)}</td>
              <td className={`${td} font-semibold`}>{r.net_pay == null ? "—" : money(r.net_pay)}</td>
              <td className={td}>{money(r.wages_paid)}</td>
              <td className={`${td} font-semibold`}>{balance(r) == null ? "—" : money(balance(r))}</td>
            </tr>
          ))}
        </tbody>
      </TableBox>
    </div>
  );
}
