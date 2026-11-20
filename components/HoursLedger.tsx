"use client";
/* H320: HOURS, DAY BY DAY — the working behind the month's hours balance.
 *
 * Every marked day with its time in and out, the hours worked against the
 * shift, the plus or minus it adds, and the running balance. The same rows
 * the database adds up for the Monthly Summary's "Hours" column, so the last
 * running figure here always equals that column.
 *
 * Used in two places: the employee's own portal (my_hours_daily) and the Hub
 * employee sheet (hub_hours_daily). Shown only — the balance never changes pay.
 */
export type HoursDay = {
  day: number; day_date: string; status: string;
  time_in: string | null; time_out: string | null;
  shift_name: string | null; shift_start: string | null; shift_end: string | null;
  required_min: number | null; worked_min: number | null; diff_min: number | null;
  counted: boolean; note: string | null;
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* 818 → "13h 38m", 45 → "45m" */
export const hm = (v: unknown) => {
  const m = Math.abs(Math.round(Number(v) || 0)), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
/* Signed: +1h 2m / − 1h 26m / 0 */
export const signed = (v: unknown) => {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? `+${hm(n)}` : n < 0 ? `− ${hm(n)}` : "0";
};
export const tone = (v: unknown) => {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? "text-emerald-700" : n < 0 ? "text-red-700" : "text-muted dark:text-[#a89f93]";
};

export function hoursTotals(rows: HoursDay[]) {
  const c = rows.filter((r) => r.counted);
  return {
    balance: c.reduce((t, r) => t + Number(r.diff_min || 0), 0),
    worked: c.reduce((t, r) => t + Number(r.worked_min || 0), 0),
    required: c.reduce((t, r) => t + Number(r.required_min || 0), 0),
    days: c.length,
    plus: c.reduce((t, r) => t + Math.max(0, Number(r.diff_min || 0)), 0),
    minus: c.reduce((t, r) => t + Math.min(0, Number(r.diff_min || 0)), 0),
  };
}

export default function HoursLedger({ rows, loading = false, compact = false }: {
  rows: HoursDay[]; loading?: boolean; compact?: boolean;
}) {
  const t = hoursTotals(rows);
  const todayIso = new Date().toLocaleDateString("en-CA");
  let running = 0;

  return (
    <div>
      {/* The month in one line: the balance, then where it came from. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
        <div>
          <div className="text-[11.5px] font-semibold text-muted dark:text-[#a89f93]">Hours balance this month</div>
          <div className={`text-[22px] font-extrabold tabular-nums leading-tight ${tone(t.balance)}`}>
            {loading ? "—" : t.days ? signed(t.balance) : "0"}
          </div>
        </div>
        {!loading && t.days > 0 && (
          <div className="text-[12px] tabular-nums text-muted dark:text-[#a89f93] sm:text-right">
            <div><span className="font-semibold text-emerald-700">+{hm(t.plus)}</span> extra · <span className="font-semibold text-red-700">− {hm(t.minus)}</span> short</div>
            <div>worked {hm(t.worked)} of {hm(t.required)} · {t.days} {t.days === 1 ? "day" : "days"} counted</div>
          </div>
        )}
      </div>

      {loading ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted dark:text-[#a89f93]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="border-t border-line px-4 py-5 text-[13px] text-muted dark:border-white/[0.06] dark:text-[#a89f93] sm:px-5">
          No days marked yet.
        </p>
      ) : (
        <>
        {/* PHONE: one compact row per day, nothing wider than the screen. The
            six-column table needed 520px and was cut off on an iPhone. */}
        <ul className="divide-y divide-line border-t border-line dark:divide-white/[0.05] dark:border-white/[0.06] sm:hidden">
          {(() => {
            let run = 0;
            return rows.map((r) => {
              if (r.counted) run += Number(r.diff_min || 0);
              const d = new Date(r.day_date + "T00:00:00");
              const note = r.note === "no time out" && r.day_date === todayIso ? "still at work" : r.note;
              return (
                <li key={r.day} className={`flex items-center gap-3 px-4 py-2.5 ${r.counted ? "text-ink dark:text-[#e7e2d8]" : "text-muted dark:text-[#8a8175]"}`}>
                  <div className="w-[52px] flex-none leading-tight">
                    <div className="text-[13px] font-bold tabular-nums">{d.getDate()} {SHORT[d.getMonth() + 1]}</div>
                    <div className="text-[11px] text-hint dark:text-[#8a8175]">{DOW[d.getDay()]}</div>
                  </div>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[13px] font-semibold tabular-nums">
                      {r.time_in || r.time_out ? `${r.time_in ?? "—"} – ${r.time_out ?? "—"}` : "—"}
                    </div>
                    <div className="truncate text-[11px] text-muted dark:text-[#a89f93]">
                      {r.worked_min != null ? hm(r.worked_min) : "—"}
                      {r.required_min ? ` of ${hm(r.required_min)}` : ""}
                      {note ? ` · ${note}` : ""}
                    </div>
                  </div>
                  <div className="flex-none text-right leading-tight tabular-nums">
                    {r.counted
                      ? <div className={`text-[13px] font-bold ${tone(r.diff_min)}`}>{signed(r.diff_min)}</div>
                      : <div className="text-[11px] italic">not counted</div>}
                    {r.counted && <div className={`text-[10.5px] font-semibold ${tone(run)}`}>bal {signed(run)}</div>}
                  </div>
                </li>
              );
            });
          })()}
        </ul>
        <div className="hidden overflow-x-auto border-t border-line dark:border-white/[0.06] sm:block">
          <table className={`w-full text-[12.5px] ${compact ? "" : "min-w-[440px]"}`}>
            <thead className="text-left text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">
              <tr>
                <th className="px-4 py-2 font-semibold sm:px-5">Day</th>
                <th className="px-2 py-2 font-semibold">In – Out</th>
                <th className="px-2 py-2 text-right font-semibold">Worked</th>
                <th className="px-2 py-2 text-right font-semibold">Shift</th>
                <th className="px-2 py-2 text-right font-semibold">+ / −</th>
                <th className="px-4 py-2 text-right font-semibold sm:px-5">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {rows.map((r) => {
                if (r.counted) running += Number(r.diff_min || 0);
                const d = new Date(r.day_date + "T00:00:00");
                const note = r.note === "no time out" && r.day_date === todayIso ? "still at work" : r.note;
                return (
                  <tr key={r.day} className={r.counted ? "text-ink dark:text-[#e7e2d8]" : "text-muted dark:text-[#8a8175]"}>
                    <td className="whitespace-nowrap px-4 py-2 sm:px-5">
                      <span className="font-semibold tabular-nums">{d.getDate()} {SHORT[d.getMonth() + 1]}</span>
                      <span className="ml-1.5 text-[11px] text-hint dark:text-[#8a8175]">{DOW[d.getDay()]}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                      {r.time_in || r.time_out ? `${r.time_in ?? "—"} – ${r.time_out ?? "—"}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {r.worked_min != null ? hm(r.worked_min) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted dark:text-[#a89f93]"
                        title={r.shift_name ?? undefined}>
                      {r.required_min ? hm(r.required_min) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {r.counted
                        ? <span className={`font-semibold ${tone(r.diff_min)}`}>{signed(r.diff_min)}</span>
                        : <span className="text-[11px] italic">{note ?? "not counted"}</span>}
                      {r.counted && note && <div className="text-[10.5px] text-hint dark:text-[#8a8175]">{note}</div>}
                    </td>
                    <td className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums sm:px-5 ${r.counted ? tone(running) : "text-hint dark:text-[#6f675d]"}`}>
                      {r.counted ? signed(running) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      <p className="border-t border-line px-4 py-2.5 text-[11px] leading-snug text-hint dark:border-white/[0.06] dark:text-[#8a8175] sm:px-5">
        Each present day: hours worked minus the shift&rsquo;s hours. Extra time on one day covers short time on another.
        Up to 10 minutes short counts as 0. Overtime shows as plus but adds no pay, and the balance does not change the salary.
        A day without a time in and time out cannot be measured and is not counted.
      </p>
    </div>
  );
}
