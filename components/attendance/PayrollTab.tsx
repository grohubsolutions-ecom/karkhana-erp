"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { exportExcel } from "@/lib/export";
import { hours, karachiDate, money } from "@/lib/attendance";
import { btnGhost, inputCls } from "@/components/Modal";
import { Empty, ErrorNote, Head, Stat, TableBox, linkBtn, td } from "./ui";

type Pay = {
  employee_id: string; code: string; name: string; department: string | null; pay_type: string; base_amount: number;
  present_days: number; half_days: number; absent_days: number; paid_leave_days: number; review_days: number;
  late_minutes: number; early_minutes: number; overtime_pending_minutes: number; overtime_approved_minutes: number;
  attendance_cut: number; overtime_pay: number; net_pay: number | null; wages_paid: number; advances: number; deductions: number; bonuses: number; note: string | null;
};

type Hours = { employee_id: string; required_minutes: number; attended_minutes: number; working_days: number; total_salary: number | null; obtained_salary: number | null; final_amount: number | null };

export default function PayrollTab() {
  const [month, setMonth] = useState(karachiDate().slice(0, 7));
  const [rows, setRows] = useState<Pay[]>([]);
  const [hrs, setHrs] = useState<Map<string, Hours>>(new Map());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("att_month_pay", { p_month: `${month}-01` });
    const h = await supabase.rpc("att_month_hours", { p_month: `${month}-01` });
    setErr(error?.message || h.error?.message || ""); setRows((data as Pay[]) ?? []);
    setHrs(new Map(((h.data as Hours[]) ?? []).map((x) => [x.employee_id, x]))); setLoading(false);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const hoursOf = (id: string) => hrs.get(id);
  const finalOf = (r: Pay) => {
    const typed = drafts[r.employee_id];
    if (typed !== undefined && typed !== "") return Number(typed);
    return typed === "" ? null : hoursOf(r.employee_id)?.final_amount ?? null;
  };
  const balance = (r: Pay) => {
    const f = finalOf(r);
    return f == null ? null : Number(f) + Number(r.bonuses) - Number(r.deductions) - Number(r.advances) - Number(r.wages_paid);
  };
  const review = rows.reduce((t, r) => t + r.review_days, 0);
  const decided = rows.filter((r) => finalOf(r) != null).length;

  async function saveFinal(r: Pay, amount: number | null) {
    if (!supabase) return;
    const key = { employee_id: r.employee_id, pay_month: `${month}-01` };
    const { error } = amount == null
      ? await supabase.from("att_pay_final").delete().eq("employee_id", key.employee_id).eq("pay_month", key.pay_month)
      : await supabase.from("att_pay_final").upsert({ ...key, amount, updated_at: new Date().toISOString() }, { onConflict: "employee_id,pay_month" });
    if (error) { setErr(error.message); return; }
    setDrafts((d) => { const n = { ...d }; delete n[r.employee_id]; return n; });
    load();
  }
  const withOt = (v: number | null | undefined, r: Pay) => Math.round(Number(v ?? 0) + Number(r.overtime_pay));

  function download() {
    exportExcel({
      title: `Attendance payroll ${month}`,
      headers: ["Code", "Name", "Department", "Pay type", "Hours required", "Hours attended", "Absent days", "Total salary", "Obtained salary", "Overtime pay", "Final salary", "Bonus", "Deduction", "Advance", "Already paid", "Balance", "Note"],
      rows: rows.map((r) => {
        const h = hoursOf(r.employee_id);
        return [r.code, r.name, r.department, r.pay_type, Number(((h?.required_minutes ?? 0) / 60).toFixed(2)), Number(((h?.attended_minutes ?? 0) / 60).toFixed(2)), r.absent_days, h?.total_salary ?? null, h?.obtained_salary ?? null, r.overtime_pay, finalOf(r), r.bonuses, r.deductions, r.advances, r.wages_paid, balance(r), r.note];
      }),
    });
  }

  return (
    <div>
      <ErrorNote text={err} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setDrafts({}); }} className={`${inputCls} !w-44`} aria-label="Month" />
        <button className={btnGhost} onClick={load}><RefreshCw size={14} /> Recalculate</button>
        <button className={btnGhost} onClick={download} disabled={!rows.length}><Download size={14} /> Excel</button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total salary" value={money(rows.reduce((t, r) => t + Number(hoursOf(r.employee_id)?.total_salary ?? 0), 0))} />
        <Stat label="Obtained salary" value={money(rows.reduce((t, r) => t + Number(hoursOf(r.employee_id)?.obtained_salary ?? 0), 0))} />
        <Stat label="Decided" value={`${decided} of ${rows.length}`} />
        <Stat label="Days to review first" value={review} />
      </div>
      <p className="mb-3 text-[12.5px] text-muted dark:text-[#a89f93]">Nothing is cut until you decide. Full and Obtained add any approved overtime. Type any other amount in Final salary.</p>
      <TableBox min={1320}>
        <Head cols={["Name", "Department", "Hours required", "Hours attended", "Absent", "Total salary", "Obtained salary", "Overtime", "Final salary", "", "Bonus", "Deduction", "Advance", "Already paid", "Balance"]} />
        <tbody className="divide-y divide-line dark:divide-white/[0.05]">
          {rows.length === 0 ? <Empty span={15} loading={loading} text="No staff are set up for this month." /> : rows.map((r) => {
            const h = hoursOf(r.employee_id);
            return (
              <tr key={r.employee_id} className="text-ink dark:text-[#e7e2d8]">
                <td className={`${td} font-semibold`}>{r.name}{r.note && <span className="block text-[11.5px] font-normal text-muted">{r.note}</span>}</td>
                <td className={td}>{r.department ?? "—"}</td>
                <td className={td}>{hours(h?.required_minutes)}</td>
                <td className={td}>{hours(h?.attended_minutes)}</td>
                <td className={td}>{r.absent_days}</td>
                <td className={td}>{h?.total_salary == null ? "—" : money(h.total_salary)}</td>
                <td className={`${td} font-semibold`}>{h?.obtained_salary == null ? "—" : money(h.obtained_salary)}</td>
                <td className={td}>{money(r.overtime_pay)}{r.overtime_pending_minutes > 0 && <span className="block text-[11.5px] text-muted">{hours(r.overtime_pending_minutes)} to approve</span>}</td>
                <td className={td}>
                  <input type="number" min="0" aria-label={`Final salary for ${r.name}`} className={`${inputCls} !w-28`}
                    value={drafts[r.employee_id] ?? (h?.final_amount == null ? "" : String(Number(h.final_amount)))}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.employee_id]: e.target.value }))}
                    onBlur={() => { const v = drafts[r.employee_id]; if (v !== undefined) saveFinal(r, v === "" ? null : Number(v)); }} />
                </td>
                <td className={td}>
                  <button className={linkBtn} disabled={h?.total_salary == null} onClick={() => saveFinal(r, withOt(h?.total_salary, r))}>Full</button>{" "}
                  <button className={linkBtn} disabled={h?.obtained_salary == null} onClick={() => saveFinal(r, withOt(h?.obtained_salary, r))}>Obtained</button>
                </td>
                <td className={td}>{money(r.bonuses)}</td>
                <td className={td}>{money(r.deductions)}</td>
                <td className={td}>{money(r.advances)}</td>
                <td className={td}>{money(r.wages_paid)}</td>
                <td className={`${td} font-semibold`}>{balance(r) == null ? "—" : money(balance(r))}</td>
              </tr>
            );
          })}
        </tbody>
      </TableBox>
    </div>
  );
}
