"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, CalendarCheck, HandCoins, Wallet, RefreshCw, Phone, Pencil } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { AddEmployee, DayRoster, AddAdvance, localISO } from "@/components/AttendanceEntry";
import MonthlySummary from "@/components/MonthlySummary";
import { useConfirm } from "@/components/ConfirmDialog";
import { Segmented, PageActions, useIsPhone } from "@/components/HubUI";

type Tab = "employees" | "attendance" | "advances" | "salaries";
type Row = Record<string, unknown>;
type Emp = { id: string; name: string; designation?: string; department?: string; sal?: number; wd?: number; phone?: string };

/* Attendance first: marking the day is what this page is opened for, every
   morning. Staff, advances and the payroll summary are one tap away.
   "Summary" rather than "Salaries": it is a payroll calculation, not a list of
   paid/unpaid flags. */
const TABS: { key: Tab; label: string; short?: string }[] = [
  { key: "attendance", label: "Attendance", short: "Daily" },
  { key: "employees", label: "Staff" },
  { key: "advances", label: "Advances" },
  { key: "salaries", label: "Summary" },
];
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: unknown) => "Rs " + (Number(n) || 0).toLocaleString("en-PK");
const pad = (n: unknown) => String(n).padStart(2, "0");

function statusBadge(s: string) {
  const kind = s === "P" ? "ok" : s === "A" ? "bad" : s === "L" ? "warn" : "mute";
  const m = {
    ok: "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success",
    warn: "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber",
    bad: "bg-danger-soft text-danger dark:bg-white/[0.08] dark:text-danger",
    mute: "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]",
  }[kind];
  const label = s === "P" ? "Present" : s === "A" ? "Absent" : s === "L" ? "Leave" : s === "H" ? "Half day" : (s || "—");
  return <span className={`inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${m}`}>{label}</span>;
}

export default function AttendancePage() {
  const [tab, setTab] = useState<Tab>("attendance");
  const [emps, setEmps] = useState<Emp[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const phone = useIsPhone();
  const confirm = useConfirm();
  /* The roster's day lives here so a day in the history below can be opened
     in it for correcting. */
  const [day, setDay] = useState(localISO());
  const [dirty, setDirty] = useState(0);
  const rosterTop = useRef<HTMLDivElement | null>(null);

  const empName = (id: unknown) => emps.find((e) => e.id === id)?.name ?? String(id ?? "—");

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    supabase.from("online_att_employees").select("id,name,designation,department,sal,wd,phone").order("name")
      .then(({ data, error }) => { if (error) setErr(error.message); setEmps((data as Emp[]) ?? []); });
  }, []);

  /* The attendance cards are counted by the database. The list stops at 1,000
     records — about four months of this team — and counting it would quietly
     go short after that. */
  const [attCounts, setAttCounts] = useState<{ all: number; P: number; A: number; L: number } | null>(null);
  /* Only the newest request may paint: switching tabs quickly could otherwise
     show one tab's rows under another tab's columns. */
  const reqId = useRef(0);

  const load = useCallback(async (which: Tab) => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    if (which === "employees") {
      const { data, error } = await supabase.from("online_att_employees").select("id,name,designation,department,sal,wd,phone").order("name");
      if (my !== reqId.current) return;
      if (error) setErr(error.message); setEmps((data as Emp[]) ?? []); setRows((data as Row[]) ?? []);
    } else if (which === "attendance") {
      const count = () => supabase!.from("online_att_records").select("id", { count: "exact", head: true });
      const [list, cAll, cP, cA, cL] = await Promise.all([
        supabase.from("online_att_records").select("id,emp_id,year,month,day,status,time_in").order("year", { ascending: false }).order("month", { ascending: false }).order("day", { ascending: false }).limit(1000),
        count(), count().eq("status", "P"), count().eq("status", "A"), count().eq("status", "L"),
      ]);
      if (my !== reqId.current) return;
      const e = list.error ?? cAll.error ?? cP.error ?? cA.error ?? cL.error;
      if (e) setErr(e.message);
      setRows((list.data as Row[]) ?? []);
      setAttCounts({ all: cAll.count ?? 0, P: cP.count ?? 0, A: cA.count ?? 0, L: cL.count ?? 0 });
    } else if (which === "advances") {
      const { data, error } = await supabase.from("online_att_advances").select("id,emp_id,amount,date,note,deduct_month,deduct_year,settled").order("date", { ascending: false }).limit(1000);
      if (my !== reqId.current) return;
      if (error) setErr(error.message); setRows((data as Row[]) ?? []);
    } else {
      const { data, error } = await supabase.from("online_att_salary_status").select("id,emp_id,year,month,paid").order("year", { ascending: false }).order("month", { ascending: false }).limit(1000);
      if (my !== reqId.current) return;
      if (error) setErr(error.message); setRows((data as Row[]) ?? []);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);

  /* Leaving the Attendance tab with marks not saved asks first. */
  async function switchTab(t: Tab) {
    if (t === tab) return;
    if (tab === "attendance" && dirty > 0) {
      const ok = await confirm({ title: "Leave without saving?", body: `${dirty} attendance change${dirty === 1 ? "" : "s"} will be thrown away.`, confirmLabel: "Discard", cancelLabel: "Stay" });
      if (!ok) return;
    }
    setRows([]); setTab(t);
  }
  async function editDay(iso: string) {
    if (iso !== day && dirty > 0) {
      const ok = await confirm({ title: "Leave without saving?", body: `${dirty} change${dirty === 1 ? "" : "s"} will be thrown away.`, confirmLabel: "Discard", cancelLabel: "Stay" });
      if (!ok) return;
    }
    setDay(iso);
    rosterTop.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const cards = useMemo(() => {
    if (tab === "employees") {
      const deps = new Set(emps.map((e) => e.department).filter(Boolean));
      return [
        { label: "Employees", value: emps.length.toLocaleString(), Icon: Users, bg: "bg-periwinkle-soft" },
        { label: "Monthly salary", value: money(emps.reduce((t, e) => t + (Number(e.sal) || 0), 0)), Icon: Wallet, bg: "bg-success-soft" },
        { label: "Departments", value: deps.size.toLocaleString(), Icon: Users, bg: "bg-amber-soft" },
      ];
    }
    if (tab === "attendance") {
      const c = attCounts ?? { all: 0, P: 0, A: 0, L: 0 };
      return [
        { label: "Records", value: c.all.toLocaleString(), Icon: CalendarCheck, bg: "bg-periwinkle-soft" },
        { label: "Present", value: c.P.toLocaleString(), Icon: CalendarCheck, bg: "bg-success-soft" },
        { label: "Absent", value: c.A.toLocaleString(), Icon: CalendarCheck, bg: "bg-danger-soft" },
        { label: "Leave", value: c.L.toLocaleString(), Icon: CalendarCheck, bg: "bg-amber-soft" },
      ];
    }
    const uns = rows.filter((r) => !r.settled);
    return [
      { label: "Advances", value: rows.length.toLocaleString(), Icon: HandCoins, bg: "bg-periwinkle-soft" },
      { label: "Total amount", value: money(rows.reduce((t, r) => t + (Number(r.amount) || 0), 0)), Icon: Wallet, bg: "bg-success-soft" },
      { label: "Unsettled", value: uns.length.toLocaleString(), Icon: HandCoins, bg: "bg-amber-soft" },
    ];
  }, [tab, rows, emps, attCounts]);

  /* History on a phone: one card per day, saying who was NOT simply present.
     A present day is the normal case; the exceptions are what anyone checks. */
  const days = useMemo(() => {
    if (tab !== "attendance") return [];
    const out: { iso: string; label: string; recs: Row[] }[] = [];
    for (const r of rows) {
      const iso = `${r.year}-${pad(r.month)}-${pad(r.day)}`;
      if (!out.length || out[out.length - 1].iso !== iso) {
        if (out.length >= 31) break;
        out.push({ iso, label: `${r.day} ${MONTHS[Number(r.month)] ?? r.month} ${r.year}`, recs: [] });
      }
      out[out.length - 1].recs.push(r);
    }
    return out;
  }, [tab, rows]);

  const empty = !loading && !err && rows.length === 0;
  const Empty = () => <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">Nothing here yet — this fills once employees &amp; attendance are brought in.</p>;

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Attendance</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">Employees, daily attendance, advances &amp; salaries.</p>
        </div>
        {tab !== "salaries" && (
          /* On the Attendance tab a phone gets no Refresh — the roster reloads
             its own day, and the space goes to the roster. The desktop keeps it. */
          <div className={tab === "attendance" ? "hidden md:block" : "contents"}>
          <PageActions>
            {tab === "employees" && <AddEmployee onDone={() => load(tab)} />}
            {tab === "advances" && <AddAdvance emps={emps} onDone={() => load(tab)} />}
            <button onClick={() => load(tab)} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </PageActions>
          </div>
        )}
      </div>

      <Segmented className="mt-1 md:mt-6" value={tab} onChange={switchTab} options={TABS} />

      {tab === "salaries" ? (
        <div className="mt-5"><MonthlySummary department="HUB" /></div>
      ) : (<>
      {tab === "attendance" && (
        <div ref={rosterTop} className="mt-4 scroll-mt-[124px] md:max-w-3xl md:scroll-mt-4">
          <DayRoster emps={emps} date={day} onDate={setDay} onDirty={setDirty} onDone={() => load("attendance")} />
        </div>
      )}

      {tab === "attendance" && <h2 className="mt-6 text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">History</h2>}
      <div className={`${tab === "attendance" ? "mt-3" : "mt-4"} grid grid-cols-2 gap-3 ${cards.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {cards.map(({ label, value, Icon, bg }, i) => (
          <div key={i} className={`rounded-card border border-line ${bg} p-3.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${cards.length === 3 && i === 2 ? "col-span-2 lg:col-span-1" : ""}`}>
            <div className="flex items-center gap-2.5 sm:block">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><Icon size={15} /></span>
              <div className="min-w-0 sm:mt-3">
                <div className="max-sm:truncate text-[17px] font-extrabold tabular-nums text-ink sm:text-[20px] dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
                <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {phone ? (
        /* ---------------------------------------------------------- phone */
        <div className="mt-4 space-y-2">
          {loading ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-xl2 bg-panel/70 dark:bg-white/[0.05]" />)
          : err ? <p className="px-4 py-10 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</p>
          : empty ? <Empty />
          : tab === "attendance" ? days.map((g) => {
              const by = (s: string) => g.recs.filter((r) => r.status === s);
              const odd = g.recs.filter((r) => r.status !== "P");
              return (
                <div key={g.iso} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{g.label}</div>
                      <div className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">
                        {by("P").length} present{by("H").length ? ` · ${by("H").length} half` : ""}{by("L").length ? ` · ${by("L").length} leave` : ""}{by("A").length ? ` · ${by("A").length} absent` : ""}
                      </div>
                    </div>
                    <button type="button" onClick={() => editDay(g.iso)}
                      className="flex h-10 items-center gap-1.5 rounded-full border border-line px-3.5 text-[12.5px] font-semibold text-ink active:bg-panel dark:border-white/10 dark:text-white">
                      <Pencil size={13} /> Edit
                    </button>
                  </div>
                  {odd.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {odd.map((r) => <span key={String(r.id)} className="flex items-center gap-1.5 rounded-full bg-panel py-0.5 pl-2.5 pr-1 text-[12px] font-semibold text-ink dark:bg-white/[0.06] dark:text-[#e7e2d8]">{empName(r.emp_id)} {statusBadge(String(r.status))}</span>)}
                    </div>
                  )}
                </div>
              );
            })
          : tab === "employees" ? rows.map((r, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{String(r.name ?? "—")}</div>
                  <div className="truncate text-[12px] text-muted dark:text-[#a89f93]">{[r.designation, r.department].filter(Boolean).join(" · ") || "—"}</div>
                  <div className="mt-1 text-[12.5px] tabular-nums text-ink dark:text-[#e7e2d8]"><b>{money(r.sal)}</b> <span className="text-muted dark:text-[#a89f93]">· {String(r.wd ?? "—")} work days</span></div>
                </div>
                {r.phone ? (
                  <a href={`tel:${String(r.phone)}`} aria-label={`Call ${String(r.name)}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-ink active:bg-panel dark:border-white/10 dark:text-white"><Phone size={17} /></a>
                ) : null}
              </div>
            ))
          : rows.map((r, i) => (
              <div key={i} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{empName(r.emp_id)}</div>
                    <div className="text-[12px] text-muted dark:text-[#a89f93]">Given {String(r.date ?? "—")} · from {MONTHS[Number(r.deduct_month)] ?? r.deduct_month} {String(r.deduct_year ?? "")} pay</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[14.5px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(r.amount)}</div>
                    {r.settled ? <span className="text-[12px] font-semibold text-success">Settled</span> : <span className="text-[12px] font-semibold text-amber-strong dark:text-amber">Not settled</span>}
                  </div>
                </div>
                {r.note ? <div className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">{String(r.note)}</div> : null}
              </div>
            ))}
        </div>
      ) : (
      /* ---------------------------------------------------------- desktop */
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                {tab === "employees" && <><th className="px-4 py-3 font-semibold">Name</th><th className="px-4 py-3 font-semibold">Designation</th><th className="px-4 py-3 font-semibold">Department</th><th className="px-4 py-3 text-right font-semibold">Salary</th><th className="px-4 py-3 text-right font-semibold">Work days</th><th className="px-4 py-3 font-semibold">Phone</th></>}
                {tab === "attendance" && <><th className="px-4 py-3 font-semibold">Employee</th><th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold">Time in</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3" /></>}
                {tab === "advances" && <><th className="px-4 py-3 font-semibold">Employee</th><th className="px-4 py-3 text-right font-semibold">Amount</th><th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold">Deduct</th><th className="px-4 py-3 font-semibold">Note</th><th className="px-4 py-3 font-semibold">Settled</th></>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>)
              ) : err ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}><Empty /></td></tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i} className="text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                    {tab === "employees" && <>
                      <td className="px-4 py-3 font-semibold">{String(r.name ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.designation ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.department ?? "—")}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.sal)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{String(r.wd ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.phone ?? "—")}</td>
                    </>}
                    {tab === "attendance" && <>
                      <td className="px-4 py-3 font-semibold">{empName(r.emp_id)}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.day)} {MONTHS[Number(r.month)] ?? r.month} {String(r.year)}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.time_in || "—")}</td>
                      <td className="px-4 py-3">{statusBadge(String(r.status ?? ""))}</td>
                      <td className="px-4 py-3 text-right"><button type="button" onClick={() => editDay(`${r.year}-${pad(r.month)}-${pad(r.day)}`)} className="text-[12px] font-semibold text-muted underline hover:text-ink dark:text-[#a89f93] dark:hover:text-white">Edit day</button></td>
                    </>}
                    {tab === "advances" && <>
                      <td className="px-4 py-3 font-semibold">{empName(r.emp_id)}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.amount)}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.date ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{MONTHS[Number(r.deduct_month)] ?? r.deduct_month} {String(r.deduct_year ?? "")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.note || "—")}</td>
                      <td className="px-4 py-3">{r.settled ? <span className="text-[12px] font-semibold text-success">Yes</span> : <span className="text-[12px] font-semibold text-amber-strong dark:text-amber">No</span>}</td>
                    </>}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {!isSupabaseConfigured && <p className="mt-4 text-center text-[12px] text-hint dark:text-[#8a8175]">Preview build · connect Supabase to load attendance.</p>}
      </>)}
    </div>
  );
}
