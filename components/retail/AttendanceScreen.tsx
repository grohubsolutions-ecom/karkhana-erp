"use client";
/* Attendance — a day at a time, with a month view for looking back.
 *
 * WHY THE DAY IS THE DEFAULT
 *   Attendance is entered by somebody standing in the shop, on a phone, for
 *   today. They already know who was in; what they need is a list of names and
 *   one tap each. A month grid is the right shape for reviewing or correcting
 *   and the wrong shape for the job that happens every evening — 31 columns on
 *   a phone means a 7px target.
 *
 *   So: Today is the default, Month is a tab. An earlier version of this screen
 *   had only the grid, which made the daily job harder in order to make the
 *   monthly one prettier.
 *
 * THREE STATUSES, AND TAPPING THE ACTIVE ONE CLEARS IT
 *   Present, Half, Absent. That is what the shops use. There is no "leave" and
 *   no "weekly off" because Sunday is an automatic paid holiday and anything
 *   else is a conversation, not a status. Tapping the status a person already
 *   has deletes the row — unmarked and absent are different things, and there
 *   has to be a way back to unmarked.
 *
 * HOURLY STAFF DO NOT GET THE THREE BUTTONS
 *   They are paid by the hour, so what matters is time in and time out, and a
 *   "present" with no times earns them nothing. They get the time pickers
 *   instead; saving a time marks them present automatically.
 *
 * ON A PHONE (Oct 2026) — nothing below 768px changes the computer screen.
 *   This is the one screen in the department that is used STANDING UP: the
 *   morning round, ten or fifteen names, one tap each, phone in one hand. So on
 *   a phone the day list is one card per person with 44px status buttons, the
 *   previous/next-day arrows live in a bar at the bottom where a thumb already
 *   is rather than in the header where it has to be reached for, and the names
 *   nobody is marking — the rest of the shop, who turned up as usual — go
 *   present in one tap from that same bar.
 *
 *   The month grid stays a grid. It is a calendar: 31 columns across the top is
 *   what makes it readable, and cards would destroy the one thing it is for. It
 *   scrolls inside its own box (`rt-scroll-x`) with the name column pinned, so
 *   reading across a row never drags the whole page sideways.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCheck, UserCheck, UserX, Clock, Sun, ChevronLeft, ChevronRight, CheckCheck } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { AddEmployeeButton, EmployeeRowActions, useEmployeeHistory } from "@/components/retail/EmployeeActions";
import {
  Shell, PageHeader, StatCards, Tabs, BranchPicker, MonthPicker, PreviewNote, SourceNote,
  ActionBar, useIsPhone,
  useEmployees, monthKey, monthBounds, daysInMonth, isHeadOffice, isHourly, attHours, isSunday,
  money, num, today, iso, type Row, type Employee,
} from "@/components/retail/kit";
import { useStaffScope } from "@/lib/retailShop";

type Scope = "shops" | "ho";
type Status = "present" | "half" | "absent";
type Rec = { status?: string; time_in?: string | null; time_out?: string | null };

const STATUSES: { key: Status; label: string; on: string }[] = [
  { key: "present", label: "Present", on: "bg-success text-white border-success" },
  { key: "half", label: "Half", on: "bg-amber-strong text-white border-amber-strong" },
  { key: "absent", label: "Absent", on: "bg-danger text-white border-danger" },
];
const CH: Record<string, string> = { present: "P", half: "½", absent: "A" };
const CELL: Record<string, string> = {
  present: "bg-success-soft text-success dark:bg-success/20",
  half: "bg-amber-soft text-amber-strong dark:bg-amber/20 dark:text-amber",
  absent: "bg-danger-soft text-danger dark:bg-danger/20",
};
/** One sentence, in both layouts, so the day list cannot say two things. */
const NOBODY = "No active staff here — add them under Employee ▸ Employees.";

export default function AttendanceScreen({ scope }: { scope: Scope }) {
  const phone = useIsPhone();
  const { employees, branches } = useEmployees(scope);
  const [tab, setTab] = useState<"day" | "month">("day");
  const [date, setDate] = useState(today());
  const [month, setMonth] = useState(monthKey());
  const [day, setDay] = useState<Record<number, Rec>>({});
  const [grid, setGrid] = useState<Record<string, Rec>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const { history, reloadHistory } = useEmployeeHistory();
  const [timeFor, setTimeFor] = useState<Employee | null>(null);
  const [tin, setTin] = useState(""); const [tout, setTout] = useState("");
  const [bulk, setBulk] = useState(false);

  const pool = useMemo(
    () => branches.filter((b) => (scope === "ho" ? isHeadOffice(b) : !isHeadOffice(b))),
    [branches, scope]
  );
  /* THE SHOP, from the left menu — except in the Head Office copy of this
     screen, which is not a shop and keeps its own picker. */
  const { branch, setBranch, pickable, inPool } = useStaffScope(branches, pool, scope !== "ho");
  const people = useMemo(
    () => employees.filter((e) => e.active !== false
      && (branch ? String(e.branch_id) === branch : inPool(e.branch_id))),
    [employees, branch, inPool]
  );
  const ids = useMemo(() => people.map((p) => p.id), [people]);
  const branchName = (id: unknown) => branches.find((b) => b.id === Number(id))?.name ?? "";

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    if (!ids.length) { setDay({}); setGrid({}); setLoading(false); return; }
    setLoading(true); setErr("");
    if (tab === "day") {
      const { data, error } = await supabase.from("retail_attendance")
        .select("employee_id,status,time_in,time_out").eq("att_date", date).in("employee_id", ids);
      if (error) setErr(error.message);
      const next: Record<number, Rec> = {};
      ((data as Row[]) ?? []).forEach((r) => {
        next[Number(r.employee_id)] = { status: String(r.status), time_in: r.time_in as string | null, time_out: r.time_out as string | null };
      });
      setDay(next);
    } else {
      const [from, to] = monthBounds(month);
      const { data, error } = await supabase.from("retail_attendance")
        .select("employee_id,att_date,status,time_in,time_out").in("employee_id", ids).gte("att_date", from).lte("att_date", to);
      if (error) setErr(error.message);
      const next: Record<string, Rec> = {};
      ((data as Row[]) ?? []).forEach((r) => {
        next[`${r.employee_id}:${String(r.att_date)}`] = { status: String(r.status), time_in: r.time_in as string | null, time_out: r.time_out as string | null };
      });
      setGrid(next);
    }
    setLoading(false);
  }, [ids, date, month, tab]);
  useEffect(() => { load(); }, [load]);

  /* Tapping the status somebody already has clears it. Unmarked and absent are
     different claims and there has to be a way back to the first one. */
  async function mark(empId: number, s: Status, ds = date) {
    const cur = ds === date ? day[empId]?.status : grid[`${empId}:${ds}`]?.status;
    const next = cur === s ? "" : s;
    if (ds === date) {
      setDay((m) => { const c = { ...m }; if (next) c[empId] = { ...c[empId], status: next }; else delete c[empId]; return c; });
    } else {
      setGrid((m) => { const c = { ...m }; if (next) c[`${empId}:${ds}`] = { ...c[`${empId}:${ds}`], status: next }; else delete c[`${empId}:${ds}`]; return c; });
    }
    if (!supabase) return;
    const { error } = next === ""
      ? await supabase.from("retail_attendance").delete().eq("employee_id", empId).eq("att_date", ds)
      : await supabase.from("retail_attendance").upsert({ employee_id: empId, att_date: ds, status: next }, { onConflict: "employee_id,att_date" });
    if (error) { setErr(error.message); load(); }
  }

  /* ── the day, moved one step at a time ─────────────────────────────────
   * The header keeps its date box for jumping to an arbitrary day. This is the
   * other 95% of the job: yesterday, because somebody forgot, and back again.
   * `max` on that box stops a future date being typed; the arrows honour the
   * same limit rather than quietly disagreeing with it.
   */
  function shiftDay(n: number) {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + n);
    const next = iso(d);
    if (next > today()) return;
    setDate(next);
  }

  /** People on the three buttons who have no status yet. Hourly staff are never
   *  in here — a "present" with no times pays them nothing, so there is nothing
   *  to fill in for them. */
  const unmarked = useMemo(
    () => people.filter((e) => !isHourly(e) && !day[e.id]?.status),
    [people, day]
  );
  const markedCount = useMemo(
    () => people.filter((e) => !!day[e.id]?.status).length,
    [people, day]
  );

  /* MARK THE REST PRESENT.
   * The morning round is fifteen names of whom thirteen turned up as usual, and
   * tapping Present thirteen times is the whole job the phone was supposed to
   * make shorter. This fills only the people who have NO status yet: somebody
   * already marked absent or half stays as they are, because that mark was a
   * decision and this button is a default.
   *
   * Same table, same columns and the same conflict target as a single tap — one
   * request instead of thirteen.
   */
  async function markRestPresent() {
    const rest = unmarked;
    if (!rest.length) return;
    setBulk(true); setErr("");
    setDay((m) => {
      const c = { ...m };
      rest.forEach((e) => { c[e.id] = { ...c[e.id], status: "present" }; });
      return c;
    });
    if (!supabase) { setBulk(false); return; }
    const { error } = await supabase.from("retail_attendance").upsert(
      rest.map((e) => ({ employee_id: e.id, att_date: date, status: "present" })),
      { onConflict: "employee_id,att_date" });
    setBulk(false);
    if (error) { setErr(error.message); load(); }
  }

  function openTimes(e: Employee) {
    const r = day[e.id] ?? {};
    setTin(r.time_in ?? "09:00"); setTout(r.time_out ?? "18:00"); setTimeFor(e);
  }
  async function saveTimes() {
    if (!timeFor || !supabase) return;
    const { error } = (!tin && !tout)
      ? await supabase.from("retail_attendance").delete().eq("employee_id", timeFor.id).eq("att_date", date)
      : await supabase.from("retail_attendance").upsert(
          { employee_id: timeFor.id, att_date: date, status: "present", time_in: tin || null, time_out: tout || null },
          { onConflict: "employee_id,att_date" });
    if (error) { setErr(error.message); return; }
    setTimeFor(null); load();
  }

  const stats = useMemo(() => {
    const vals = tab === "day"
      ? Object.values(day)
      : Object.entries(grid).filter(([k]) => people.some((p) => k.startsWith(p.id + ":"))).map(([, v]) => v);
    const c = (s: string) => vals.filter((v) => v.status === s).length;
    const hrs = vals.reduce((t, v) => t + attHours(v.time_in, v.time_out), 0);
    return [
      { label: "People", value: String(people.length), Icon: CalendarCheck },
      { label: "Present", value: String(c("present")), Icon: UserCheck },
      { label: "Absent", value: String(c("absent")), Icon: UserX },
      { label: "Hours logged", value: hrs ? hrs.toFixed(1) : "—", Icon: Clock },
    ];
  }, [tab, day, grid, people]);

  const nDays = daysInMonth(month);
  const days = useMemo(() => Array.from({ length: nDays }, (_, i) => i + 1), [nDays]);

  /** "Today · Mon 5 Oct". The word matters: on a phone, half the mistakes on an
   *  attendance screen are marking the right people on the wrong day. */
  const dayLabel = useMemo(() => {
    const d = new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return date === today() ? `Today · ${d}` : d;
  }, [date]);

  return (
    <Shell>
      <PageHeader
        title={scope === "ho" ? "Head Office Attendance" : "Attendance"}
        subtitle="Present, half or absent. Tapping the same one again clears it."
        onRefresh={load} loading={loading}
      >
        {tab === "day"
          ? <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)}
              className="rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink outline-none dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
          : <MonthPicker value={month} onChange={setMonth} />}
        {pickable.length > 1 && <BranchPicker branches={pickable} value={branch} onChange={setBranch} />}
        <AddEmployeeButton branches={pickable} defaultBranch={branch || undefined}
          onAdded={() => { reloadHistory(); load(); }} />
      </PageHeader>

      <Tabs tabs={[{ key: "day" as const, label: "Today" }, { key: "month" as const, label: "Month view" }]} value={tab} onChange={setTab} />
      <StatCards stats={stats} loading={loading} />

      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">Couldn&apos;t save: {err}</p>}

      {tab === "day" && isSunday(date) && (
        <div className="mt-4 flex items-center gap-3 rounded-card border border-line bg-amber-soft p-4 dark:border-white/[0.06] dark:bg-amber/10">
          <Sun size={18} className="flex-none text-amber-strong dark:text-amber" />
          <p className="text-[12.5px] font-medium text-ink dark:text-[#e7e2d8]">
            This is a Sunday — an automatic paid holiday. Nothing needs marking.
          </p>
        </div>
      )}

      {/* ── DAY, ON A PHONE ───────────────────────────────────────────────
          ONE CARD PER PERSON, AND THE BUTTONS ARE THE CARD.

          The computer row lays the name and three 36px buttons across 900px.
          At 390px those three buttons are what is left after the name, which is
          about 70px each for a target that writes a wage record — and the name
          they belong to has been squeezed to an ellipsis by then.

          So the card gives the name the top line at 16px with a 44px initial
          beside it (you are checking a face against a name, not reading a
          table), and the three statuses a full-width row of 44px buttons
          underneath. Three taps' worth of target for the same three taps.

          Hourly staff still get one button instead of three — see the note at
          the top of the file — and it carries the hours it has recorded, which
          on the computer sits in the subtitle. */}
      {tab === "day" && phone && (
        loading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[108px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)}
          </div>
        ) : people.length === 0 ? (
          <p className="mt-4 rounded-card border border-line bg-surface p-8 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">{NOBODY}</p>
        ) : (
          <div className="mt-4 space-y-2">
            {people.map((e) => {
              const r = day[e.id] ?? {};
              const hourly = isHourly(e);
              return (
                <div key={e.id} className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl2 bg-lavender-soft text-[16px] font-extrabold text-ink dark:bg-white/[0.08] dark:text-white">
                      {(e.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[16px] font-extrabold leading-tight text-ink dark:text-[#f4f1ea]">{e.name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                        {pickable.length > 1 && !branch ? `${branchName(e.branch_id)} · ` : ""}
                        {hourly ? `${money(e.hourly_rate)}/hr` : `${money(e.monthly_salary)}/month`}
                      </div>
                    </div>
                    {/* End / bring back / delete, on the person's own card. */}
                    <EmployeeRowActions e={e} history={history}
                      onChanged={() => { reloadHistory(); load(); }} />
                  </div>
                  {hourly ? (
                    <button onClick={() => openTimes(e)}
                      className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl2 border border-line bg-surface text-[13.5px] font-semibold text-ink transition active:bg-panel dark:border-white/10 dark:bg-white/[0.04] dark:text-white">
                      <Clock size={15} />
                      {r.time_in
                        ? <>{r.time_in}{r.time_out ? `–${r.time_out}` : ""} · <strong>{attHours(r.time_in, r.time_out).toFixed(1)} h</strong></>
                        : "Set time in / out"}
                    </button>
                  ) : (
                    /* 44px is Apple's floor and this is the tap that records a
                       day's wage, so it is not negotiated down. */
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {STATUSES.map((s) => {
                        const on = r.status === s.key;
                        return (
                          <button key={s.key} onClick={() => mark(e.id, s.key)} aria-pressed={on}
                            className={`min-h-[44px] rounded-xl2 border text-[13.5px] font-bold transition ${on ? s.on : "border-line bg-surface text-ink active:bg-panel dark:border-white/10 dark:bg-white/[0.04] dark:text-white"}`}>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── DAY ─────────────────────────────────────────────────────────── */}
      {tab === "day" && !phone && (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          {loading ? (
            <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" />)}</div>
          ) : people.length === 0 ? (
            <p className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">{NOBODY}</p>
          ) : people.map((e) => {
            const r = day[e.id] ?? {};
            const hourly = isHourly(e);
            return (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0 dark:border-white/[0.06]">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl2 bg-lavender-soft text-[14px] font-extrabold text-ink dark:bg-white/[0.08] dark:text-white">
                    {(e.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">
                      {e.name}
                      {pickable.length > 1 && !branch && <span className="ml-1.5 text-[12px] font-medium text-muted dark:text-[#a89f93]">· {branchName(e.branch_id)}</span>}
                    </div>
                    <div className="text-[12px] text-muted dark:text-[#a89f93]">
                      {hourly ? `${money(e.hourly_rate)}/hr` : `${money(e.monthly_salary)}/month`}
                      {hourly && r.time_in && <> · {r.time_in}{r.time_out ? `–${r.time_out}` : ""} · <strong>{attHours(r.time_in, r.time_out).toFixed(1)} h</strong></>}
                    </div>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  {hourly ? (
                    <button onClick={() => openTimes(e)} className={btnGhost}><Clock size={14} /> {r.time_in ? "Edit time" : "Set time in/out"}</button>
                  ) : STATUSES.map((s) => {
                    const on = r.status === s.key;
                    return (
                      <button key={s.key} onClick={() => mark(e.id, s.key)}
                        className={`rounded-xl2 border px-3.5 py-2 text-[12.5px] font-semibold transition ${on ? s.on : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:hover:bg-white/[0.10]"}`}>
                        {s.label}
                      </button>
                    );
                  })}
                  {/* End / bring back / delete, on the computer list too — the
                      phone cards above carry the same control. */}
                  <EmployeeRowActions e={e} history={history}
                    onChanged={() => { reloadHistory(); load(); }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── MONTH ───────────────────────────────────────────────────────── */}
      {tab === "month" && (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          {/* A MONTH GRID STAYS A GRID — it is a calendar, and 31 columns across
              the top is the whole point of it. `rt-scroll-x` is what keeps that
              honest on a phone: the grid scrolls inside this box, with momentum
              and without handing the swipe on to the page, so reading across one
              person's month never drags the screen sideways. The name column is
              already pinned (`sticky left-0`), so the row you are reading still
              says whose it is at day 29. `overflow-x-auto` stays for the
              computer, where nothing about this changes. */}
          <div className="rt-scroll-x overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                  <th className="sticky left-0 z-10 bg-surface px-4 py-3 font-semibold max-md:px-3 dark:bg-[#201c17]">Name</th>
                  {days.map((d) => {
                    const ds = `${month}-${String(d).padStart(2, "0")}`;
                    return <th key={d} className={`px-1 py-3 text-center font-semibold ${isSunday(ds) ? "text-amber-strong dark:text-amber" : ""}`}>{d}</th>;
                  })}
                  <th className="px-3 py-3 text-right font-semibold">P</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                {loading ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={nDays + 2} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>
                )) : people.length === 0 ? (
                  <tr><td colSpan={nDays + 2} className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">No active staff here.</td></tr>
                ) : people.map((p) => {
                  const hourly = isHourly(p);
                  const marked = days.filter((d) => grid[`${p.id}:${month}-${String(d).padStart(2, "0")}`]);
                  const score = hourly
                    ? marked.reduce((t, d) => { const r = grid[`${p.id}:${month}-${String(d).padStart(2, "0")}`]; return t + attHours(r?.time_in, r?.time_out); }, 0).toFixed(1)
                    : String(marked.reduce((t, d) => {
                        const s = grid[`${p.id}:${month}-${String(d).padStart(2, "0")}`]?.status;
                        return t + (s === "present" ? 1 : s === "half" ? 0.5 : 0);
                      }, 0));
                  return (
                    <tr key={p.id} className="text-ink dark:text-[#e7e2d8]">
                      {/* Capped on a phone so the pinned column leaves room for
                          the days it exists to label. */}
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-4 py-2 font-semibold max-md:px-3 dark:bg-[#201c17]">
                        <span className="block max-md:max-w-[104px] max-md:truncate">{p.name}</span>
                      </td>
                      {days.map((d) => {
                        const ds = `${month}-${String(d).padStart(2, "0")}`;
                        const r = grid[`${p.id}:${ds}`];
                        const s = r?.status;
                        return (
                          <td key={d} className="px-0.5 py-1.5 text-center">
                            <button
                              onClick={() => { if (!hourly) mark(p.id, (s === "present" ? "half" : s === "half" ? "absent" : "present") as Status, ds); }}
                              disabled={hourly}
                              title={hourly ? (r?.time_in ? `${r.time_in}–${r.time_out ?? "?"}` : "Set times on the day view") : (s ?? "Not marked")}
                              /* 28px is a mouse target. On a phone the same cell
                                 is 36px — the grid already scrolls sideways, so
                                 the extra width costs nothing and a mis-tap here
                                 writes the wrong status on the wrong day. */
                              className={`h-7 w-7 rounded-lg text-[11.5px] font-bold transition max-md:h-9 max-md:w-9 max-md:text-[12.5px] ${s ? CELL[s] : isSunday(ds) ? "bg-amber-soft/50 text-amber-strong dark:bg-amber/10 dark:text-amber" : "bg-canvas text-hint hover:bg-panel dark:bg-white/[0.03] dark:text-[#6b6358] dark:hover:bg-white/[0.08]"} ${hourly ? "cursor-default opacity-70" : ""}`}>
                              {s ? CH[s] : isSunday(ds) ? "•" : "·"}
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right font-bold tabular-nums">{score}{hourly ? "h" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px] font-semibold">
        {STATUSES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-muted dark:text-[#a89f93]">
            <span className={`flex h-5 w-5 items-center justify-center rounded ${CELL[s.key]}`}>{CH[s.key]}</span>{s.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-muted dark:text-[#a89f93]">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-amber-soft/50 text-amber-strong dark:bg-amber/10 dark:text-amber">•</span>Sunday — paid holiday
        </span>
      </div>

      <SourceNote>
        Sundays are automatic paid holidays and are never marked. <strong>Hourly staff</strong> are
        paid on real hours, so they get time in and time out instead of the three buttons — saving a
        time marks them present. <strong>Monthly staff</strong> are paid the full salary regardless;
        their attendance is the record of who was where, not the thing that sets the wage.
      </SourceNote>

      <Modal open={!!timeFor} onClose={() => setTimeFor(null)}
        title={timeFor ? `${timeFor.name} — time in / out` : ""}
        subtitle={new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}>
        <div className="space-y-3.5">
          {/* These two stay side by side on a phone. They are one fact read
              left to right — the shift — and a native time control is about
              120px wide, so both fit at 390px with room to spare. Stacking
              them would separate a pair and push Save under the keyboard. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time in"><input type="time" value={tin} onChange={(e) => setTin(e.target.value)} className={inputCls} /></Field>
            <Field label="Time out"><input type="time" value={tout} onChange={(e) => setTout(e.target.value)} className={inputCls} /></Field>
          </div>
          <p className="rounded-xl2 bg-panel/60 px-3.5 py-2.5 text-[12.5px] font-semibold text-ink dark:bg-white/[0.04] dark:text-[#e7e2d8]">
            {attHours(tin, tout).toFixed(1)} hours
            {timeFor && num(timeFor.hourly_rate) > 0 && <> · {money(num(timeFor.hourly_rate) * attHours(tin, tout))}</>}
          </p>
          {/* Stacked and full width on a phone, Save last so it is the button
              nearest the thumb. Two 100px buttons in the bottom corner of a
              dialog is where a mis-tap clears a shift somebody just typed. */}
          <div className="flex justify-end gap-2 pt-1 max-md:flex-col">
            <button onClick={() => { setTin(""); setTout(""); }} className={`${btnGhost} max-md:w-full`}>Clear both</button>
            <button onClick={saveTimes} className={`${btnPrimary} max-md:w-full`}>Save</button>
          </div>
        </div>
      </Modal>

      <PreviewNote />

      {/* ── THE DAY BAR — PHONE ONLY ──────────────────────────────────────
          Two jobs, both at the bottom because that is where the thumb already
          is while the other hand is holding the door open:

          1. PREVIOUS / NEXT DAY. The date box is in the header, which on a
             phone is a stretch to the top of the screen for the commonest
             action on the screen. Down here it is where the hand rests.
          2. MARK THE REST PRESENT. Thirteen of fifteen turned up; this says so
             once instead of thirteen times. It only ever fills people with no
             status yet, so a mark somebody made by hand is never overwritten.

          Not on a Sunday: Sunday is an automatic paid holiday and is never
          marked, so a bulk button there would write fifteen rows of noise.

          `ActionBar` sits above the tab bar, never over it; the spacer is this
          page's `pb-24` so the source note is not left underneath it.
          The whole thing is behind `phone`, so no part of it exists at 1024px. */}
      {phone && tab === "day" && (
        <>
          <div aria-hidden className="h-24" />
          <ActionBar>
            <div className="w-full">
              {/* Repeated here on purpose. A save started from this bar that
                  fails puts its message at the top of the page, which on a phone
                  is several screens above the thumb that pressed the button —
                  and the marks go back to unmarked with no reason given. */}
              {err && <p className="mb-2 text-[11.5px] font-semibold text-danger">Couldn&apos;t save: {err}</p>}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => shiftDay(-1)} aria-label="Previous day"
                  className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line bg-surface text-ink transition active:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
                  <ChevronLeft size={18} />
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <div className="truncate text-[13px] font-extrabold text-ink dark:text-[#f4f1ea]">{dayLabel}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">
                    {people.length === 0 ? "nobody in scope" : `${markedCount} of ${people.length} marked`}
                  </div>
                </div>
                <button type="button" onClick={() => shiftDay(1)} disabled={date >= today()} aria-label="Next day"
                  className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line bg-surface text-ink transition active:bg-panel disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
                  <ChevronRight size={18} />
                </button>
              </div>
              {!isSunday(date) && unmarked.length > 0 && (
                <button type="button" onClick={markRestPresent} disabled={bulk}
                  className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-semibold text-white transition disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                  <CheckCheck size={16} />
                  {bulk ? "Marking…" : `Mark remaining ${unmarked.length} present`}
                </button>
              )}
            </div>
          </ActionBar>
        </>
      )}
    </Shell>
  );
}
