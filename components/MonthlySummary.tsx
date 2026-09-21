"use client";
/* Monthly Summary — days, advances and payable salary.
 *
 * This is the screen the old attendance app had and this system did not. The
 * Salaries tab here listed online_att_salary_status, which is a paid/unpaid
 * FLAG per person per month — useful, but not a payroll. It read empty because
 * nobody had pressed Mark Paid yet, which looked like missing data and was not.
 *
 * EVERY FIGURE COMES FROM hub_monthly_payable(), computed in Postgres.
 *   counted days = Present + ½·Half + paid days off (+1 per day off worked)
 *   payable      = (Salary ÷ 30) × counted days − advances
 *
 * Not computed here in the browser, for the reason four other pages in this
 * system have already demonstrated: a browser only ever sees the first thousand
 * rows it is handed. Attendance is 166 rows today and will be tens of thousands
 * within a year of running three businesses.
 *
 * Verified against the old app on the day of the changeover: all seven people
 * reconcile to the rupee, each one day further on because 28 August had been
 * marked in between.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle, Check } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import EmployeeMonthDetail from "@/components/EmployeeMonthDetail";
import { useIsPhone } from "@/components/HubUI";

type Row = {
  emp_id: string; name: string; designation: string | null; salary: number;
  present: number; half: number; absent: number;
  leave_days: number; absent_deduction: number;
  paid_off: number; extra_days: number; counted_days: number; gross: number;
  advances: number; payable: number; is_paid: boolean;
};

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");

export default function MonthlySummary({ department = "HUB" }: { department?: string }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  /* Eleven columns do not fit a phone. There, each person is a card: what they
     are owed, and the days and deductions that produce it. */
  const phone = useIsPhone();

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("hub_monthly_payable", {
      p_year: year, p_month: month, p_department: department,
    });
    if (error) setErr(error.message);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [year, month, department]);
  useEffect(() => { load(); }, [load]);

  /* Marking someone paid records a fact, it does not change the calculation.
     The payable stands whether or not the money has gone out; this only says
     that it has. */
  async function togglePaid(r: Row) {
    if (!supabase) return;
    setBusy(r.emp_id); setErr("");
    const { error } = await supabase.from("online_att_salary_status")
      .upsert({ id: `${r.emp_id}-${year}-${month}`, emp_id: r.emp_id,
                year, month, paid: !r.is_paid }, { onConflict: "id" });
    if (error) setErr(error.message);
    else setRows((xs) => xs.map((x) => x.emp_id === r.emp_id ? { ...x, is_paid: !x.is_paid } : x));
    setBusy("");
  }

  const t = rows.reduce((a, r) => ({
    present: a.present + Number(r.present),
    half: a.half + Number(r.half),
    absent: a.absent + Number(r.absent),
    lost: a.lost + Number(r.absent_deduction),
    advances: a.advances + Number(r.advances),
    payable: a.payable + Number(r.payable),
  }), { present: 0, half: 0, absent: 0, lost: 0, advances: 0, payable: 0 });

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-bold text-ink dark:text-[#f4f1ea]">Monthly summary</h2>
          <p className="text-[12.5px] text-muted dark:text-[#a89f93]">Days, advances &amp; payable salary</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                  className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] sm:h-auto sm:flex-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                  className="h-11 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] sm:h-auto dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={load} aria-label="Refresh" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface p-2 hover:bg-panel sm:h-auto sm:w-auto dark:border-white/10 dark:bg-white/[0.05]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {err && (
        <div className="mt-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{err}</span>
        </div>
      )}

      {phone ? (
        <div className="mt-4 space-y-2">
          {loading ? <p className="px-3 py-10 text-center text-muted"><Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…</p>
          : rows.length === 0 ? <p className="px-3 py-12 text-center text-[13px] text-muted dark:text-[#a89f93]">Nobody in this department for {MONTHS[month]} {year}.</p>
          : rows.map((r) => (
            <div key={r.emp_id} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
              <div className="flex items-start gap-3">
                <button onClick={() => setDetail(r)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[14.5px] font-bold text-ink underline decoration-line underline-offset-4 dark:text-[#f4f1ea] dark:decoration-white/20">{r.name}</div>
                  <div className="truncate text-[12px] text-muted dark:text-[#a89f93]">{r.designation ? `${r.designation} · ` : ""}{rs(r.salary)} a month</div>
                </button>
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.payable)}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">payable</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] tabular-nums">
                <span className="font-semibold text-emerald-700">{r.present} present</span>
                {Number(r.half) > 0 && <span className="text-amber-700">{r.half} half</span>}
                {Number(r.absent) > 0 && <span className="text-red-700">{r.absent} absent (− {rs(r.absent_deduction)})</span>}
                <span className="text-muted dark:text-[#a89f93]">{r.paid_off} off paid{Number(r.extra_days) > 0 ? ` +${r.extra_days}` : ""}</span>
                <span className="font-semibold text-ink dark:text-[#e7e2d8]">{r.counted_days} counted</span>
                {Number(r.advances) > 0 && <span className="text-muted dark:text-[#a89f93]">advance {rs(r.advances)}</span>}
              </div>
              <button onClick={() => togglePaid(r)} disabled={busy === r.emp_id}
                className={`mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition disabled:opacity-50 ${
                  r.is_paid ? "bg-success-soft text-emerald-800" : "border border-line text-muted active:bg-panel dark:border-white/15 dark:text-[#a89f93]"}`}>
                {busy === r.emp_id ? <Loader2 size={13} className="animate-spin" /> : r.is_paid ? <><Check size={13} /> Paid — tap to undo</> : "Unpaid — tap when paid"}
              </button>
            </div>
          ))}
          {rows.length > 0 && (
            <div className="rounded-xl2 bg-panel px-4 py-3 text-[12.5px] tabular-nums dark:bg-white/[0.05]">
              <div className="flex justify-between text-[14px] font-extrabold text-ink dark:text-[#f4f1ea]"><span>Total payable</span><span>{rs(t.payable)}</span></div>
              <div className="mt-1 text-muted dark:text-[#a89f93]">{t.present} present · {t.half} half · {t.absent} absent (− {rs(t.lost)}) · advances {rs(t.advances)}</div>
            </div>
          )}
        </div>
      ) : (
      <div className="mt-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead className="border-b border-line text-left text-muted dark:border-white/10 dark:text-[#a89f93]">
            <tr>
              <th className="px-3 py-3 font-semibold">Employee</th>
              <th className="px-3 py-3 text-right font-semibold">Salary</th>
              <th className="px-3 py-3 text-right font-semibold text-emerald-700">Present</th>
              <th className="px-3 py-3 text-right font-semibold text-amber-700">Half</th>
              <th className="px-3 py-3 text-right font-semibold text-red-700">Absent</th>
              <th className="px-3 py-3 text-right font-semibold text-red-700">Lost</th>
              <th className="px-3 py-3 text-right font-semibold">Paid off</th>
              <th className="px-3 py-3 text-right font-semibold">Counted</th>
              <th className="px-3 py-3 text-right font-semibold">Advance</th>
              <th className="px-3 py-3 text-right font-semibold">Payable</th>
              <th className="px-3 py-3 text-right font-semibold">Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {loading ? (
              <tr><td colSpan={11} className="px-3 py-10 text-center text-muted">
                <Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={11} className="px-3 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
                Nobody in this department for {MONTHS[month]} {year}.
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r.emp_id} className="text-ink dark:text-[#e7e2d8]">
                <td className="px-3 py-3">
                  {/* The name is the way in. A summary answers what everyone is
                      owed; this answers why THIS person is owed it, which is the
                      question actually asked when somebody queries their pay. */}
                  <button onClick={() => setDetail(r)}
                          className="text-left font-semibold underline decoration-transparent underline-offset-2 transition hover:decoration-current">
                    {r.name}
                  </button>
                  {r.designation && <div className="text-[11.5px] text-muted dark:text-[#a89f93]">{r.designation}</div>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{rs(r.salary)}</td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums text-emerald-700">{r.present}</td>
                <td className="px-3 py-3 text-right tabular-nums text-amber-700">{r.half || "0"}</td>
                <td className="px-3 py-3 text-right tabular-nums text-red-700">{r.absent || "0"}</td>
                {/* The deduction, stated. An absent day already cost a day's pay
                    by not being counted, but subtraction by omission is invisible
                    — Ahmad's two absences turned 13,000 into 12,000 with nothing
                    on screen saying why. */}
                <td className="px-3 py-3 text-right tabular-nums text-red-700">
                  {Number(r.absent_deduction) ? "− " + rs(r.absent_deduction) : "—"}
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">
                  {r.paid_off}{Number(r.extra_days) > 0 && <span className="text-emerald-700"> +{r.extra_days}</span>}
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{r.counted_days}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">
                  {Number(r.advances) ? rs(r.advances) : "—"}
                </td>
                <td className="px-3 py-3 text-right text-[14px] font-bold tabular-nums">{rs(r.payable)}</td>
                <td className="px-3 py-3 text-right">
                  <button onClick={() => togglePaid(r)} disabled={busy === r.emp_id}
                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition disabled:opacity-50 ${
                      r.is_paid ? "bg-success-soft text-emerald-800"
                                : "border border-line text-muted hover:bg-panel dark:border-white/15 dark:text-[#a89f93]"}`}>
                    {busy === r.emp_id ? <Loader2 size={11} className="animate-spin" />
                      : r.is_paid ? <><Check size={11} className="mr-1 inline" />Paid</> : "Unpaid"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t-2 border-line dark:border-white/10">
              <tr className="font-bold text-ink dark:text-[#f4f1ea]">
                <td className="px-3 py-3">Total</td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{t.present}</td>
                <td className="px-3 py-3 text-right tabular-nums text-amber-700">{t.half}</td>
                <td className="px-3 py-3 text-right tabular-nums text-red-700">{t.absent}</td>
                <td className="px-3 py-3 text-right tabular-nums text-red-700">− {rs(t.lost)}</td>
                <td /><td />
                <td className="px-3 py-3 text-right tabular-nums">{rs(t.advances)}</td>
                <td className="px-3 py-3 text-right text-[15px] tabular-nums">{rs(t.payable)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}

      {detail && (
        <EmployeeMonthDetail row={detail} year={year} month={month}
          onClose={() => setDetail(null)} onChanged={load} />
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-hint dark:text-[#8a8175]">
        Payable = counted days ÷ days in the month × salary − advances. A full month worked pays the full salary, in February as in August.
        Sundays and public holidays are paid for everyone; working a day off adds one extra day.
        Approved leave is paid in full; an absent day is not counted, and "Lost" is what it would have paid.
        {isCurrentMonth && " This month counts days up to today, so the figure grows as the month goes on."}
      </p>
    </div>
  );
}
