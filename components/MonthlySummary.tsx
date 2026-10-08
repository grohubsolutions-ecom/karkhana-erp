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
 *                  + extra days given
 *   payable      = (Salary ÷ days in the month) × counted days − advance cut
 *
 * Not computed here in the browser, for the reason four other pages in this
 * system have already demonstrated: a browser only ever sees the first thousand
 * rows it is handed. Attendance is 166 rows today and will be tens of thousands
 * within a year of running three businesses.
 *
 * Verified against the old app on the day of the changeover: all seven people
 * reconcile to the rupee, each one day further on because 28 August had been
 * marked in between.
 *
 * H284 (1 Oct 2026), the owner's three asks:
 *   - PAID ASKS HOW MUCH ADVANCE TO CUT. The whole advance by default (as much
 *     of it as was earned), any amount allowed; what is not cut moves to next
 *     month as "Advance carried forward" (PaySalaryDialog). Undoing Paid takes
 *     the carried amount back.
 *   - GIVE EXTRA DAY at the top: date, full or half day, reason (GiveExtraDay).
 *     It shows in its own column and is paid like a day worked.
 *   - Only someone allowed to manage attendance sees the buttons; anyone else
 *     with the summary sees the same figures, read-only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle, Check, CalendarPlus, X } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import EmployeeMonthDetail from "@/components/EmployeeMonthDetail";
import PaySalaryDialog, { type PayTarget } from "@/components/PaySalaryDialog";
import GiveExtraDay from "@/components/GiveExtraDay";
import { useConfirm } from "@/components/ConfirmDialog";
import { useIsPhone } from "@/components/HubUI";
/* H289: what is missing about a person before anybody is paid — and the
   joining date fixed from here, because that is the one that silently pays
   Sundays somebody was not here for. */
import StaffHealth from "@/components/StaffHealth";

export type SummaryRow = {
  emp_id: string; name: string; designation: string | null; salary: number;
  present: number; half: number; absent: number;
  leave_days: number; absent_deduction: number;
  paid_off: number; extra_days: number; counted_days: number; gross: number;
  advances: number; payable: number; is_paid: boolean;
  /* H284 */
  given_days: number; given_pay: number; advance_cut: number; carried: number;
};
type Row = SummaryRow;

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");
/* 1.5 → "1½", 0.5 → "½" */
export const dayCount = (v: unknown) => {
  const n = Number(v) || 0;
  const w = Math.floor(n);
  if (Math.abs(n - w - 0.5) < 1e-9) return w ? `${w}½` : "½";
  return String(Math.round(n * 100) / 100);
};

export default function MonthlySummary({ department = "HUB" }: { department?: string }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  /* The open person is kept by id, so after a change the sheet shows the
     figures the database worked out again, not the ones it opened with. */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<PayTarget | null>(null);
  const [extraOpen, setExtraOpen] = useState(false);
  const [extraEmp, setExtraEmp] = useState<string | null>(null);
  /* null while it is being asked: the buttons appear once it is known. */
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const confirm = useConfirm();
  /* Eleven columns do not fit a phone. There, each person is a card: what they
     are owed, and the days and deductions that produce it. */
  const phone = useIsPhone();

  /* Only the newest answer may paint (switching months quickly), and a reload
     after Paid keeps the table on screen instead of blanking it — but a
     different month is never shown under this month's name. */
  const reqId = useRef(0);
  const key = `${year}-${month}-${department}`;
  const [rowsKey, setRowsKey] = useState("");
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("hub_monthly_payable", {
      p_year: year, p_month: month, p_department: department,
    });
    if (my !== reqId.current) return;
    if (error) setErr(error.message);
    setRows((data as Row[]) ?? []);
    setRowsKey(`${year}-${month}-${department}`);
    setLoading(false);
  }, [year, month, department]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    const db = supabase;
    (async () => {
      const { data } = await db.rpc("has_permission", { p_permission_code: "hub.attendance.manage" });
      setCanManage(data === true);
    })();
  }, []);

  /* PAID. With an advance due it asks how much to cut; with none there is
     nothing to ask, and one tap marks it, as before. */
  async function markPaid(r: Row) {
    if (!supabase) return;
    setErr(""); setMsg("");
    if (Number(r.advances) > 0) {
      setPayFor({
        emp_id: r.emp_id, name: r.name, advances: Number(r.advances),
        earned: Math.max(0, Math.round(Number(r.payable) + Number(r.advances))),
      });
      return;
    }
    setBusy(r.emp_id);
    /* null, not 0: if an advance was added since this screen loaded (another
       phone, another tab), the database applies the agreed default — cut it —
       instead of quietly carrying all of it forward. */
    const { data, error } = await supabase.rpc("hub_salary_mark_paid", {
      p_emp: r.emp_id, p_year: year, p_month: month, p_cut: null,
    });
    setBusy("");
    const res = data as { ok?: boolean; error?: string; report?: string } | null;
    if (error) { setErr(error.message); return; }
    if (!res?.ok) { setErr(res?.error ?? "It was not saved and no reason was given."); return; }
    setMsg(res.report ?? `${r.name} marked paid.`);
    load();
  }

  /* UNDO. When that payment moved an advance into next month, say that it
     comes back — otherwise one tap, as before. */
  async function undoPaid(r: Row) {
    if (!supabase) return;
    setErr(""); setMsg("");
    if (Number(r.carried) > 0) {
      const nm = month === 12 ? MONTHS[1] : MONTHS[month + 1];
      const ok = await confirm({
        title: `Undo Paid for ${r.name}?`,
        body: `${MONTHS[month]} becomes unpaid again, and the ${rs(r.carried)} carried forward to ${nm} is taken back into ${MONTHS[month]}.`,
        confirmLabel: "Undo Paid", tone: "normal",
      });
      if (!ok) return;
    }
    setBusy(r.emp_id);
    const { data, error } = await supabase.rpc("hub_salary_undo_paid", {
      p_emp: r.emp_id, p_year: year, p_month: month,
    });
    setBusy("");
    const res = data as { ok?: boolean; error?: string; report?: string } | null;
    if (error) { setErr(error.message); return; }
    if (!res?.ok) { setErr(res?.error ?? "It was not undone and no reason was given."); return; }
    setMsg(res.report ?? `${r.name} is not paid any more.`);
    load();
  }

  function giveExtra(empId: string | null) {
    setErr(""); setMsg(""); setExtraEmp(empId); setExtraOpen(true);
  }

  const t = rows.reduce((a, r) => ({
    present: a.present + Number(r.present),
    half: a.half + Number(r.half),
    absent: a.absent + Number(r.absent),
    lost: a.lost + Number(r.absent_deduction),
    given: a.given + Number(r.given_days ?? 0),
    advances: a.advances + Number(r.advance_cut ?? r.advances),
    carried: a.carried + Number(r.carried ?? 0),
    earned: a.earned + Number(r.gross),
    payable: a.payable + Number(r.payable),
  }), { present: 0, half: 0, absent: 0, lost: 0, given: 0, advances: 0, carried: 0, earned: 0, payable: 0 });

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;
  const stale = rowsKey !== key;
  const nextShort = SHORT[month === 12 ? 1 : month + 1];
  /* Not while another month is loading: the sheet would show the old month's
     figures under the new month's buttons. */
  const detail = !stale && detailId ? rows.find((r) => r.emp_id === detailId) ?? null : null;

  const extraBtn = (cls: string) => (
    <button onClick={() => giveExtra(null)}
      className={`items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-semibold text-white transition hover:opacity-90 dark:bg-white dark:text-[#141414] ${cls}`}>
      <CalendarPlus size={15} /> Give extra day
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full items-end justify-between gap-3 sm:w-auto">
          <div>
            <h2 className="text-[16px] font-bold text-ink dark:text-[#f4f1ea]">Monthly Summary</h2>
            <p className="text-[12.5px] text-muted dark:text-[#a89f93]">Days, advances &amp; payable salary</p>
          </div>
          {/* "Give extra day" at the top — on a phone beside the title, on a
              desktop in front of the month. */}
          {canManage && extraBtn("flex h-11 shrink-0 sm:hidden")}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {canManage && extraBtn("hidden h-9 sm:flex")}
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month"
                  className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] sm:h-auto sm:flex-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year"
                  className="h-11 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] sm:h-auto dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={load} aria-label="Refresh" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface p-2 hover:bg-panel sm:h-auto sm:w-auto dark:border-white/10 dark:bg-white/[0.05]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <StaffHealth onChanged={load} />

      {err && (
        <div className="mt-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{err}</span>
          <button onClick={() => setErr("")} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"><X size={15} /></button>
        </div>
      )}
      {msg && (
        <div role="status" className="mt-3 flex gap-2 rounded-card border border-emerald-300 bg-emerald-50 p-3 text-[13px] text-emerald-900">
          <Check size={16} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{msg}</span>
          <button onClick={() => setMsg("")} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"><X size={15} /></button>
        </div>
      )}

      {phone ? (
        <div className="mt-4 space-y-2">
          {stale ? <p className="px-3 py-10 text-center text-muted"><Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…</p>
          : rows.length === 0 ? <p className="px-3 py-12 text-center text-[13px] text-muted dark:text-[#a89f93]">Nobody in this department for {MONTHS[month]} {year}.</p>
          : rows.map((r) => (
            <div key={r.emp_id} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
              <div className="flex items-start gap-3">
                <button onClick={() => setDetailId(r.emp_id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[14.5px] font-bold text-ink underline decoration-line underline-offset-4 dark:text-[#f4f1ea] dark:decoration-white/20">{r.name}</div>
                  <div className="truncate text-[12px] text-muted dark:text-[#a89f93]">{r.designation ? `${r.designation} · ` : ""}{rs(r.salary)} a month</div>
                </button>
                <div className="shrink-0 text-right">
                  {/* Earned = the full wage before anything is cut; payable is
                      what is left after advances (and absent days, which simply
                      are not earned). Both shown so the gap is never a mystery. */}
                  <div className="text-[13px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{rs(r.gross)}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">earned</div>
                  <div className="mt-1 text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.payable)}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">payable</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] tabular-nums">
                <span className="font-semibold text-emerald-700">{r.present} present</span>
                {Number(r.half) > 0 && <span className="text-amber-700">{r.half} half</span>}
                {Number(r.absent) > 0 && <span className="text-red-700">{r.absent} absent (− {rs(r.absent_deduction)})</span>}
                <span className="text-muted dark:text-[#a89f93]">{r.paid_off} off paid{Number(r.extra_days) > 0 ? ` +${r.extra_days}` : ""}</span>
                {Number(r.given_days) > 0 && <span className="font-semibold text-emerald-700">+{dayCount(r.given_days)} extra day</span>}
                <span className="font-semibold text-ink dark:text-[#e7e2d8]">{dayCount(r.counted_days)} counted</span>
                {Number(r.advance_cut) > 0 && <span className="text-muted dark:text-[#a89f93]">advance {rs(r.advance_cut)}</span>}
                {Number(r.carried) > 0 && <span className="font-semibold text-amber-700">{rs(r.carried)} → {nextShort}</span>}
              </div>
              {canManage ? (
                <button onClick={() => (r.is_paid ? undoPaid(r) : markPaid(r))} disabled={busy === r.emp_id}
                  className={`mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition disabled:opacity-50 ${
                    r.is_paid ? "bg-success-soft text-emerald-800" : "border border-line text-muted active:bg-panel dark:border-white/15 dark:text-[#a89f93]"}`}>
                  {busy === r.emp_id ? <Loader2 size={13} className="animate-spin" /> : r.is_paid ? <><Check size={13} /> Paid — tap to undo</> : "Unpaid — tap when paid"}
                </button>
              ) : canManage === false ? (
                <div className={`mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold ${
                  r.is_paid ? "bg-success-soft text-emerald-800" : "bg-panel text-muted dark:bg-white/[0.05] dark:text-[#a89f93]"}`}>
                  {r.is_paid ? <><Check size={13} /> Paid</> : "Not paid yet"}
                </div>
              ) : null}
            </div>
          ))}
          {!stale && rows.length > 0 && (
            <div className="rounded-xl2 bg-panel px-4 py-3 text-[12.5px] tabular-nums dark:bg-white/[0.05]">
              <div className="flex justify-between text-[13px] font-semibold text-muted dark:text-[#a89f93]"><span>Total earned</span><span className="tabular-nums">{rs(t.earned)}</span></div>
              <div className="mt-0.5 flex justify-between text-[14px] font-extrabold text-ink dark:text-[#f4f1ea]"><span>Total payable</span><span>{rs(t.payable)}</span></div>
              <div className="mt-1 text-muted dark:text-[#a89f93]">
                {t.present} present · {t.half} half · {t.absent} absent (− {rs(t.lost)}){t.given > 0 ? ` · +${dayCount(t.given)} extra` : ""} · advances {rs(t.advances)}
                {t.carried > 0 ? ` · ${rs(t.carried)} carried to ${nextShort}` : ""}
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className="mt-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[920px] text-[13px]">
          <thead className="border-b border-line text-left text-muted dark:border-white/10 dark:text-[#a89f93]">
            <tr>
              <th className="px-3 py-3 font-semibold">Employee</th>
              <th className="px-3 py-3 text-right font-semibold">Salary</th>
              <th className="px-3 py-3 text-right font-semibold text-emerald-700">Present</th>
              <th className="px-3 py-3 text-right font-semibold text-amber-700">Half</th>
              <th className="px-3 py-3 text-right font-semibold text-red-700">Absent</th>
              <th className="px-3 py-3 text-right font-semibold text-red-700">Lost</th>
              <th className="px-3 py-3 text-right font-semibold">Paid off</th>
              <th className="px-3 py-3 text-right font-semibold text-emerald-700">Extra day</th>
              <th className="px-3 py-3 text-right font-semibold">Counted</th>
              <th className="px-3 py-3 text-right font-semibold">Earned</th>
              <th className="px-3 py-3 text-right font-semibold">Advance</th>
              <th className="px-3 py-3 text-right font-semibold">Payable</th>
              <th className="px-3 py-3 text-right font-semibold">Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {stale ? (
              <tr><td colSpan={13} className="px-3 py-10 text-center text-muted">
                <Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={13} className="px-3 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
                Nobody in this department for {MONTHS[month]} {year}.
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r.emp_id} className="text-ink dark:text-[#e7e2d8]">
                <td className="px-3 py-3">
                  {/* The name is the way in. A summary answers what everyone is
                      owed; this answers why THIS person is owed it, which is the
                      question actually asked when somebody queries their pay. */}
                  <button onClick={() => setDetailId(r.emp_id)}
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
                <td className="px-3 py-3 text-right tabular-nums">
                  {Number(r.given_days) > 0
                    ? <span className="font-semibold text-emerald-700" title={`${rs(r.given_pay)} added`}>+{dayCount(r.given_days)}</span>
                    : <span className="text-hint dark:text-[#6f675d]">—</span>}
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{dayCount(r.counted_days)}</td>
                {/* Earned = the full wage for the counted days, before the
                    advance is taken off. Payable is what is left. */}
                <td className="px-3 py-3 text-right tabular-nums">{rs(r.gross)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">
                  {Number(r.advance_cut) ? rs(r.advance_cut) : "—"}
                  {Number(r.carried) > 0 && (
                    <div className="text-[11px] font-semibold text-amber-700">+{rs(r.carried)} → {nextShort}</div>
                  )}
                </td>
                <td className="px-3 py-3 text-right text-[14px] font-bold tabular-nums">{rs(r.payable)}</td>
                <td className="px-3 py-3 text-right">
                  {canManage ? (
                    <button onClick={() => (r.is_paid ? undoPaid(r) : markPaid(r))} disabled={busy === r.emp_id}
                      className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition disabled:opacity-50 ${
                        r.is_paid ? "bg-success-soft text-emerald-800"
                                  : "border border-line text-muted hover:bg-panel dark:border-white/15 dark:text-[#a89f93]"}`}>
                      {busy === r.emp_id ? <Loader2 size={11} className="animate-spin" />
                        : r.is_paid ? <><Check size={11} className="mr-1 inline" />Paid</> : "Unpaid"}
                    </button>
                  ) : canManage === false ? (
                    <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${
                      r.is_paid ? "bg-success-soft text-emerald-800" : "text-muted dark:text-[#a89f93]"}`}>
                      {r.is_paid ? "Paid" : "Unpaid"}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          {!stale && rows.length > 0 && (
            <tfoot className="border-t-2 border-line dark:border-white/10">
              <tr className="font-bold text-ink dark:text-[#f4f1ea]">
                <td className="px-3 py-3">Total</td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{t.present}</td>
                <td className="px-3 py-3 text-right tabular-nums text-amber-700">{t.half}</td>
                <td className="px-3 py-3 text-right tabular-nums text-red-700">{t.absent}</td>
                <td className="px-3 py-3 text-right tabular-nums text-red-700">− {rs(t.lost)}</td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{t.given > 0 ? `+${dayCount(t.given)}` : ""}</td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums font-semibold">{rs(t.earned)}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {rs(t.advances)}
                  {t.carried > 0 && <div className="text-[11px] text-amber-700">+{rs(t.carried)} → {nextShort}</div>}
                </td>
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
          canManage={canManage === true} busy={busy === detail.emp_id}
          onPaid={() => markPaid(detail)} onUndo={() => undoPaid(detail)}
          onGiveExtra={() => giveExtra(detail.emp_id)}
          onClose={() => setDetailId(null)} onChanged={(m) => { if (m) setMsg(m); load(); }} />
      )}

      <PaySalaryDialog target={payFor} year={year} month={month}
        onClose={() => setPayFor(null)}
        onDone={(report) => { setPayFor(null); setMsg(report); load(); }} />

      <GiveExtraDay open={extraOpen} defaultEmp={extraEmp}
        emps={rows.map((r) => ({ emp_id: r.emp_id, name: r.name, salary: Number(r.salary) }))}
        onClose={() => setExtraOpen(false)}
        onDone={(report, y, m) => {
          setExtraOpen(false); setMsg(report);
          /* Show the month the day went into; the same month just reloads. */
          if (y !== year || m !== month) { setYear(y); setMonth(m); } else load();
        }} />

      <p className="mt-3 text-[12px] leading-relaxed text-hint dark:text-[#8a8175]">
        Payable = counted days ÷ days in the month × salary − advance cut. A full month worked pays the full salary, in February as in August.
        Sundays and public holidays are paid for everyone; working a day off adds one extra day, and an extra day given is paid the same way.
        Approved leave is paid in full; an absent day is not counted, and &ldquo;Lost&rdquo; is what it would have paid.
        Marking someone paid asks how much of their advance to cut; what is not cut moves to next month as &ldquo;Advance carried forward&rdquo;.
        {isCurrentMonth && " This month counts days up to today, so the figure grows as the month goes on."}
      </p>
    </div>
  );
}
