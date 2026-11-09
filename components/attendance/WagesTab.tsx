"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { hours, karachiDate, karachiTime, money } from "@/lib/attendance";
import { inputCls } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { DeptPicker, Empty, ErrorNote, Head, Stat, StatusBadge, TableBox, deptOf, linkBtn, td } from "./ui";

type Wage = {
  employee_id: string; code: string; name: string; department: string | null; status: string | null;
  first_in: string | null; last_out: string | null; worked_minutes: number; shift_minutes: number; overtime_minutes: number;
  daily_wage: number; amount_due: number; amount_paid: number | null;
};

export default function WagesTab() {
  const [date, setDate] = useState(karachiDate());
  const [rows, setRows] = useState<Wage[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [dept, setDept] = useState("all");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("att_daily_wages", { p_date: date });
    setErr(error?.message ?? ""); setRows((data as Wage[]) ?? []); setAmounts({}); setLoading(false);
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const amountOf = (r: Wage) => (amounts[r.employee_id] ?? String(Math.round(Number(r.amount_due))));

  async function pay(r: Wage) {
    if (!supabase) return;
    const amount = Number(amountOf(r));
    if (!(amount > 0)) { setErr("Enter the amount to pay."); return; }
    const ok = await confirm({ title: `Pay ${r.name}?`, body: `${money(amount)} for ${date}.`, confirmLabel: "Mark paid", tone: "normal" });
    if (!ok) return;
    const { error } = await supabase.from("att_wage_payments").insert({ employee_id: r.employee_id, pay_date: date, amount });
    if (error) setErr(error.code === "23505" ? "This person is already marked paid for this date." : error.message); else load();
  }

  async function undo(r: Wage) {
    if (!supabase) return;
    const { error } = await supabase.from("att_wage_payments").delete().eq("employee_id", r.employee_id).eq("pay_date", date);
    if (error) setErr(error.message); else load();
  }

  const names = [...new Set(rows.map((r) => deptOf(r.department)))];
  const shown = rows.filter((r) => dept === "all" || deptOf(r.department) === dept);

  return (
    <div>
      <ErrorNote text={err} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="date" value={date} max={karachiDate()} onChange={(e) => setDate(e.target.value)} className={`${inputCls} !w-44`} aria-label="Date" />
        <DeptPicker names={names} value={dept} onChange={setDept} allLabel="All daily-wage staff" />
      </div>
      <div className="mb-3 rounded-card border border-line bg-surface p-3 text-[13px] text-ink dark:border-white/10 dark:bg-white/[0.03] dark:text-[#e7e2d8]">
        <b>How it is worked out:</b> daily wage ÷ shift hours × hours worked. Full shift = full wage. Approved overtime is added on top.
        The amount appears after the worker scans out. You can change it before you press Mark paid.
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:max-w-md">
        <Stat label="To pay" value={money(shown.reduce((t, r) => t + (r.amount_paid == null ? Number(amountOf(r)) || 0 : 0), 0))} />
        <Stat label="Paid" value={money(shown.reduce((t, r) => t + (Number(r.amount_paid) || 0), 0))} />
      </div>
      <TableBox min={980}>
        <Head cols={["Name", "Department", "In", "Out", "Daily wage", "Hours worked", "Status", "Pay", ""]} />
        <tbody className="divide-y divide-line dark:divide-white/[0.05]">
          {shown.length === 0 ? <Empty span={9} loading={loading} text="No daily-wage staff yet. Set Pay type to Daily in the Staff tab." /> : shown.map((r) => (
            <tr key={r.employee_id} className="text-ink dark:text-[#e7e2d8]">
              <td className={`${td} font-semibold`}>{r.name}</td>
              <td className={td}>{r.department ?? "—"}</td>
              <td className={td}>{karachiTime(r.first_in)}</td>
              <td className={td}>{karachiTime(r.last_out)}</td>
              <td className={td}>{money(r.daily_wage)}</td>
              <td className={td}>
                {r.last_out ? `${hours(r.worked_minutes)} of ${hours(r.shift_minutes)}` : "—"}
                {r.overtime_minutes > 0 && <span className="block text-[11.5px] text-muted">+ {hours(r.overtime_minutes)} overtime</span>}
              </td>
              <td className={td}><StatusBadge status={r.status} /></td>
              <td className={td}>
                {r.amount_paid != null ? <b>{money(r.amount_paid)}</b> : (
                  <input type="number" min="0" aria-label={`Pay for ${r.name}`} className={`${inputCls} !w-28`}
                    value={amountOf(r)} onChange={(e) => setAmounts((a) => ({ ...a, [r.employee_id]: e.target.value }))} />
                )}
              </td>
              <td className={`${td} text-right`}>
                {r.amount_paid != null ? <button className={linkBtn} onClick={() => undo(r)}>Undo paid</button>
                  : <button className={linkBtn} disabled={!(Number(amountOf(r)) > 0)} onClick={() => pay(r)}>Mark paid</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </TableBox>
    </div>
  );
}
