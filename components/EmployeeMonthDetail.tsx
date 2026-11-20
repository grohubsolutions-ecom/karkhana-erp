"use client";
/* One employee, one month, everything — opened by clicking a row in the summary.
 *
 * The summary answers "what is everyone owed". This answers "why is THIS person
 * owed that", which is the question actually asked when somebody queries their
 * pay. Without it the only reply is a total, and a total cannot be argued with
 * or agreed to — it can only be accepted.
 *
 * So it shows the working: every day of the month, every advance, and the
 * arithmetic laid out line by line. Anyone can follow it to the same answer.
 *
 * Same calculation as the summary — hub_monthly_payable — because a detail view
 * that recomputed would eventually disagree with the list it opened from, and
 * whichever number was wrong, nobody would know which.
 *
 * H284 (1 Oct 2026): Paid goes through the same dialog as the summary (how
 * much advance to cut; the rest carried forward), extra days given are listed
 * with their reason and can be taken off while the month is unpaid, and the
 * breakdown shows the cut and what moved to next month. The row comes from
 * the summary each time it reloads, so the figures here follow every change.
 */
import { useCallback, useEffect, useState } from "react";
import { X, Loader2, Check, AlertTriangle, CalendarPlus, Trash2, ArrowRight } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { useConfirm } from "@/components/ConfirmDialog";
import type { SummaryRow } from "@/components/MonthlySummary";
import HoursLedger, { type HoursDay } from "@/components/HoursLedger";

type Row = SummaryRow;
type Day = { day: number; status: string; time_in?: string | null; time_out?: string | null };
type Adv = { id: string; date: string; amount: number; note: string | null; carried_from: string | null };
type Extra = { id: string; day: string; portion: number; reason: string; given_by_name: string | null };

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");
/* 818 → "13h 38m" (H319 hours balance) */
const hm = (v: unknown) => {
  const m = Math.abs(Math.round(Number(v) || 0)), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
const dayCount = (v: unknown) => {
  const n = Number(v) || 0;
  const w = Math.floor(n);
  if (Math.abs(n - w - 0.5) < 1e-9) return w ? `${w}½` : "½";
  return String(Math.round(n * 100) / 100);
};

export default function EmployeeMonthDetail({
  row, year, month, canManage = false, busy = false,
  onPaid, onUndo, onGiveExtra, onClose, onChanged,
}: {
  row: Row; year: number; month: number; canManage?: boolean; busy?: boolean;
  onPaid: () => void; onUndo: () => void; onGiveExtra: () => void;
  onClose: () => void; onChanged: (msg?: string) => void;
}) {
  const [days, setDays] = useState<Day[]>([]);
  const [advs, setAdvs] = useState<Adv[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [hours, setHours] = useState<HoursDay[]>([]);
  const [loading, setLoading] = useState(true);
  /* The calendar has to know about public holidays, not just Sundays.
     Without them 14 August — Independence Day, worked — renders as an ordinary
     "P" while the cards above it say "Extra days +2". The figures were right;
     the calendar was the one disagreeing. */
  const [hols, setHols] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const confirm = useConfirm();

  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true);
    const [d, a, h, x, hr] = await Promise.all([
      supabase.from("online_att_records").select("day,status,time_in,time_out")
        .eq("emp_id", row.emp_id).eq("year", year).eq("month", month).order("day"),
      supabase.from("online_att_advances").select("id,date,amount,note,carried_from")
        .eq("emp_id", row.emp_id).eq("deduct_year", year).eq("deduct_month", month).order("date"),
      supabase.from("online_att_holidays").select("hdate"),
      supabase.from("online_att_extra_days").select("id,day,portion,reason,given_by_name")
        .eq("emp_id", row.emp_id).gte("day", from).lte("day", to).order("day"),
      supabase.rpc("hub_hours_daily", { p_emp: row.emp_id, p_year: year, p_month: month }),
    ]);
    const e = d.error ?? a.error ?? x.error;
    if (e) setErr(e.message);
    setDays((d.data as Day[]) ?? []);
    setAdvs((a.data as Adv[]) ?? []);
    setHols(new Set(((h.data as { hdate: string }[]) ?? []).map((v) => v.hdate)));
    setExtras((x.data as Extra[]) ?? []);
    setHours(hr.error ? [] : ((hr.data as HoursDay[]) ?? []));
    setLoading(false);
    /* Reloaded whenever the summary's figures for this person change — a day
       given, a payment marked or undone. */
  }, [row.emp_id, year, month, from, to, row.given_days, row.advances, row.is_paid, row.carried]);
  useEffect(() => { load(); }, [load]);

  async function removeExtra(x: Extra) {
    if (!supabase) return;
    const label = new Date(x.day + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    if (!(await confirm({
      title: `Take off the extra day on ${label}?`,
      body: `${row.name} will not be paid for it in ${MONTHS[month]}.`,
      confirmLabel: "Take it off",
    }))) return;
    setRemoving(x.id); setErr("");
    const { data, error } = await supabase.rpc("hub_remove_extra_day", { p_id: x.id });
    setRemoving(null);
    const res = data as { ok?: boolean; error?: string; report?: string } | null;
    if (error) { setErr(error.message); return; }
    if (!res?.ok) { setErr(res?.error ?? "It was not removed and no reason was given."); return; }
    onChanged(res.report);
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const byDay = new Map(days.map((d) => [d.day, (d.status || "").toUpperCase()]));
  /* The hours were being recorded and shown nowhere, so a short day and a full
     day looked identical on the calendar once the month had passed. */
  const timesByDay = new Map(days.map((d) => [d.day, {
    in: (d.time_in ?? "").trim(), out: (d.time_out ?? "").trim(),
  }]));
  const extraByDay = new Map(extras.map((x) => [Number(x.day.slice(8, 10)), Number(x.portion)]));
  // From the database: a local salary ÷ 30 × days cannot see a mid-month raise.
  const gross = Number(row.gross ?? 0);
  const given = Number(row.given_days ?? 0);
  const cut = Number(row.advance_cut ?? row.advances ?? 0);
  const carried = Number(row.carried ?? 0);
  /* H296: a return is a row with a minus amount — money given back, which
     takes that much off the advance (and so puts it back on the pay). */
  const advGiven = advs.reduce((t, a) => t + Math.max(0, Number(a.amount) || 0), 0);
  const advBack = advs.reduce((t, a) => t + Math.max(0, -(Number(a.amount) || 0)), 0);
  const nextName = MONTHS[month === 12 ? 1 : month + 1];
  const mayEdit = canManage && !row.is_paid;

  const cards: [string, string, string][] = [
    ["Present", String(row.present), "text-emerald-700"],
    ["Half", String(row.half), "text-amber-700"],
    ["Leave", String(row.leave_days ?? 0), "text-sky-700"],
    ["Absent", String(row.absent), "text-red-700"],
    ["Paid off", String(row.paid_off), "text-ink dark:text-[#f4f1ea]"],
    ["Extra days", `+${dayCount(Number(row.extra_days) + given)}`, "text-emerald-700"],
    ["Counted", dayCount(row.counted_days), "text-ink dark:text-[#f4f1ea]"],
    ["Payable", rs(row.payable), "text-ink dark:text-[#f4f1ea]"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
         onClick={onClose}>
      <div className="w-full max-w-3xl rounded-card border border-line bg-surface p-5 shadow-xl dark:border-white/10 dark:bg-[#1a1713]"
           onClick={(e) => e.stopPropagation()}>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[17px] font-extrabold text-ink dark:text-[#f4f1ea]">{row.name}</div>
            <div className="text-[12.5px] text-muted dark:text-[#a89f93]">
              {row.designation ?? "—"} · {rs(row.salary)}/month · {MONTHS[month]} {year}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canManage ? (
              <button onClick={() => (row.is_paid ? onUndo() : onPaid())} disabled={busy}
                className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition disabled:opacity-50 ${
                  row.is_paid ? "bg-success-soft text-emerald-800"
                              : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
                {busy ? <Loader2 size={12} className="animate-spin" />
                  : row.is_paid ? <><Check size={12} className="mr-1 inline" />Paid</> : "Mark paid"}
              </button>
            ) : (
              <span className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold ${
                row.is_paid ? "bg-success-soft text-emerald-800" : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
                {row.is_paid ? "Paid" : "Not paid yet"}
              </span>
            )}
            <button onClick={onClose} aria-label="Close"
                    className="rounded-full p-1.5 text-muted hover:bg-panel dark:hover:bg-white/10"><X size={17} /></button>
          </div>
        </div>

        {err && (
          <div className="mt-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-2.5 text-[12px] text-red-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{err}</span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cards.map(([label, value, tone]) => (
            <div key={label} className="rounded-card border border-line p-2.5 dark:border-white/10">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted dark:text-[#a89f93]">{label}</div>
              <div className={`mt-0.5 text-[17px] font-extrabold tabular-nums ${tone}`}>{value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-2 text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
            Attendance — {MONTHS[month]} {year}
          </div>
          {loading && days.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-[10.5px] text-muted dark:text-[#a89f93]">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => <div key={d} className="py-1">{d}</div>)}
                {Array.from({ length: firstDow }).map((_, i) => <div key={`b${i}`} />)}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const dnum = i + 1;
                  const st = byDay.get(dnum);
                  const iso = `${year}-${String(month).padStart(2, "0")}-${String(dnum).padStart(2, "0")}`;
                  const sunday = new Date(year, month - 1, dnum).getDay() === 0;
                  const holiday = hols.has(iso);
                  const off = sunday || holiday;
                  const workedOff = off && (st === "P" || st === "H" || st === "L");
                  const ext = extraByDay.get(dnum);
                  const cls =
                    workedOff ? "bg-success-soft text-emerald-800 font-bold"
                    : st === "P" ? "bg-success-soft text-emerald-800"
                    : st === "L" ? "bg-periwinkle-soft text-sky-800"
                    : st === "H" ? "bg-amber-soft text-amber-900"
                    : st === "A" ? "bg-salmon-soft text-red-800"
                    : off ? "bg-panel text-muted dark:bg-white/[0.06]"
                    : "text-hint";
                  return (
                    <div key={dnum} className={`rounded-lg py-1.5 text-[11.5px] font-semibold ${cls} ${ext ? "ring-2 ring-inset ring-emerald-500" : ""}`}
                         title={ext ? `${ext === 1 ? "Full" : "Half"} extra day given` : undefined}>
                      <div>{dnum}</div>
                      <div className="text-[9px] font-normal">
                        {workedOff ? (holiday ? "Hol+" : "Sun+") : st ?? (holiday ? "Hol" : sunday ? "Sun" : "")}
                      </div>
                      {ext ? <div className="text-[9px] font-bold text-emerald-700">+{ext === 1 ? "1" : "½"}</div> : null}
                      {(() => {
                        const t = timesByDay.get(dnum);
                        if (!t || (!t.in && !t.out)) return null;
                        return (
                          <div className="text-[8.5px] font-normal leading-tight opacity-80">
                            {t.in || "—"}{t.out ? ` · ${t.out}` : ""}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 text-[10.5px] text-hint dark:text-[#8a8175]">
                P present · H half · L leave (paid) · A absent · Sun paid Sunday ·
                Sun+ worked a day off (+1) · <span className="font-semibold text-emerald-700">+1 / +½ extra day given</span> · blank not marked.
                Times below a day are clock-in · clock-out, where they were recorded.
              </div>
            </>
          )}
        </div>

        {/* H320: HOURS DAY BY DAY — the plus and minus behind the Hours column. */}
        <div className="mt-4 overflow-hidden rounded-card border border-line dark:border-white/10">
          <div className="border-b border-line bg-panel px-4 py-2.5 text-[13px] font-semibold text-ink dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea] sm:px-5">
            Hours, day by day
          </div>
          <HoursLedger rows={hours} loading={loading} />
        </div>

        {/* EXTRA DAYS GIVEN — each with its reason and who gave it. */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">Extra days given</span>
            {mayEdit && (
              <button onClick={onGiveExtra}
                className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] font-semibold text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10">
                <CalendarPlus size={13} /> Give extra day
              </button>
            )}
          </div>
          {extras.length === 0 ? (
            <p className="text-[13px] text-muted dark:text-[#a89f93]">None.</p>
          ) : (
            <div className="overflow-hidden rounded-card border border-line dark:border-white/10">
              <ul className="divide-y divide-line dark:divide-white/[0.05]">
                {extras.map((x) => (
                  <li key={x.id} className="flex items-start gap-3 px-3 py-2 text-[12.5px]">
                    <span className="w-[52px] shrink-0 pt-0.5 font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">
                      {Number(x.day.slice(8, 10))} {SHORT[month]}
                    </span>
                    <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-[11.5px] font-bold text-emerald-800">
                      {Number(x.portion) === 1 ? "Full day" : "Half day"}
                    </span>
                    <span className="min-w-0 flex-1 text-ink [overflow-wrap:anywhere] dark:text-[#e7e2d8]">
                      {x.reason}
                      {x.given_by_name && <span className="text-muted dark:text-[#a89f93]"> · by {x.given_by_name}</span>}
                    </span>
                    {mayEdit && (
                      <button onClick={() => removeExtra(x)} disabled={removing === x.id} aria-label={`Take off the extra day on ${Number(x.day.slice(8, 10))} ${SHORT[month]}`}
                        className="-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-red-700 hover:bg-red-50 disabled:opacity-40 dark:hover:bg-white/10">
                        {removing === x.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
            Advances due this month
          </div>
          {advs.length === 0 ? (
            <p className="text-[13px] text-muted dark:text-[#a89f93]">None.</p>
          ) : (
            <div className="overflow-hidden rounded-card border border-line dark:border-white/10">
              <table className="w-full text-[12.5px]">
                <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                  {advs.map((a) => {
                    const back = Number(a.amount) < 0;
                    return (
                      <tr key={a.id}>
                        <td className="px-3 py-2 text-muted dark:text-[#a89f93]">{a.date}</td>
                        <td className={`whitespace-nowrap px-3 py-2 font-semibold tabular-nums ${back ? "text-emerald-700 dark:text-success" : ""}`}>
                          {back ? `− ${rs(-Number(a.amount))}` : rs(a.amount)}
                        </td>
                        <td className={`px-3 py-2 ${a.carried_from ? "font-semibold text-ink dark:text-[#e7e2d8]" : "text-muted dark:text-[#a89f93]"}`}>
                          {back && <span className="mr-1.5 font-semibold text-emerald-700 dark:text-success">Returned</span>}
                          {a.note && !(back && a.note === "Advance returned") ? a.note : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!row.is_paid && Number(row.advances) > 0 && (
            <p className="mt-1.5 text-[11.5px] text-hint dark:text-[#8a8175]">
              Marking {MONTHS[month]} paid asks how much of this to cut; whatever is not cut moves to {nextName}.
            </p>
          )}
        </div>

        {/* The arithmetic, line by line. A total nobody can follow can only be
            accepted, never agreed to. */}
        <div className="mt-4 rounded-card border border-line bg-panel p-3.5 text-[12.5px] dark:border-white/10 dark:bg-white/[0.04]">
          <div className="mb-1.5 font-semibold text-ink dark:text-[#f4f1ea]">Payable breakdown</div>
          <div className="space-y-1 text-muted dark:text-[#a89f93]">
            <div className="flex justify-between">
              <span>Earned over {dayCount(row.counted_days)} counted days, at each day&rsquo;s own rate</span>
              <span className="tabular-nums">{rs(gross)}</span>
            </div>
            {Number(row.extra_days) > 0 && (
              <div className="text-[11.5px] text-emerald-700">
                includes {row.extra_days} day{Number(row.extra_days) > 1 ? "s" : ""} off worked (+{row.extra_days})
              </div>
            )}
            {given > 0 && (
              <div className="text-[11.5px] text-emerald-700">
                includes {dayCount(given)} extra day{given > 1 ? "s" : ""} given (+{rs(row.given_pay)})
              </div>
            )}
            {Number(row.absent) > 0 && (
              <div className="flex justify-between text-red-700">
                <span>{row.absent} absent day{Number(row.absent) > 1 ? "s" : ""} — not counted</span>
                <span className="tabular-nums">− {rs(row.absent_deduction)}</span>
              </div>
            )}
            {Number(row.balance_days) > 0 && (
              <div className={`flex justify-between ${Number(row.time_balance) < 0 ? "text-red-700" : Number(row.time_balance) > 0 ? "text-emerald-700" : ""}`}>
                <span>
                  Hours balance {Number(row.time_balance) > 0 ? "+" : Number(row.time_balance) < 0 ? "− " : ""}{hm(row.time_balance)} — worked {hm(row.worked_minutes)} of {hm(row.required_minutes)} over {row.balance_days} days
                  {Number(row.hours_deduction) > 0 ? " · minus hours cut, already off Earned" : " · plus or even, nothing cut"}
                </span>
                <span className="tabular-nums">{Number(row.hours_deduction) > 0 ? `− ${rs(row.hours_deduction)}` : "Rs 0"}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Less advance{row.is_paid && carried > 0 ? ` (${rs(cut)} of ${rs(row.advances)})` : "s"}</span>
              <span className="tabular-nums">− {rs(cut)}</span>
            </div>
            {advBack > 0 && (
              <div className="text-[11.5px] text-emerald-700 dark:text-success">
                {rs(advGiven)} given − {rs(advBack)} given back
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-1.5 text-[14px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea]">
              <span>Net payable</span><span className="tabular-nums">{rs(row.payable)}</span>
            </div>
            {carried > 0 && (
              <div className="flex justify-between pt-1 text-[12px] font-semibold text-amber-700">
                <span className="flex items-center gap-1"><ArrowRight size={12} /> Carried forward to {nextName} (not cut now)</span>
                <span className="tabular-nums">{rs(carried)}</span>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
