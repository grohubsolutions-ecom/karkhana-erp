"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, UserPlus, Wallet, Loader2, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, CalendarDays, CheckCheck } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";

type Result = { ok: boolean; msg: string } | null;
export type EmpLite = { id: string; name: string };

/* THE CODE IS WHAT GETS STORED, AND IT MUST BE ONE LETTER — P, H, L or A —
   because the payable calculation reads exactly those. The label is for the
   person; the code is for the database. (The roster below says why.) */
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const today = () => new Date().toISOString().slice(0, 10);
/** these tables use a TEXT primary key supplied by the app, not a sequence */
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function Feedback({ res }: { res: Result }) {
  if (!res) return null;
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-[13px] font-semibold ${res.ok ? "text-success" : "text-danger"}`}>
      {res.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{res.msg}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  Employee                                                           */
/* ------------------------------------------------------------------ */
export function AddEmployee({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const [f, setF] = useState({ name: "", designation: "", department: "", phone: "", sal: "", wd: "26", dtime: "10:00" });

  async function save() {
    if (!supabase) return;
    if (!f.name.trim()) { setRes({ ok: false, msg: "Name is required." }); return; }
    setBusy(true); setRes(null);
    const { error } = await supabase.from("online_att_employees").insert({
      id: newId("emp"),
      name: f.name.trim(),
      designation: f.designation.trim() || null,
      department: f.department.trim() || null,
      phone: f.phone.trim() || null,
      sal: f.sal ? Number(f.sal) : 0,
      wd: f.wd ? Number(f.wd) : 26,
      dtime: f.dtime || "10:00",
    });
    setBusy(false);
    if (error) { setRes({ ok: false, msg: error.message }); return; }
    setRes({ ok: true, msg: `${f.name.trim()} added.` });
    setF({ name: "", designation: "", department: "", phone: "", sal: "", wd: "26", dtime: "10:00" });
    onDone();
  }

  return (
    <>
      <button onClick={() => { setOpen(true); setRes(null); }} className={btnPrimary}><UserPlus size={15} /> Add employee</button>
      <Modal open={open} onClose={() => setOpen(false)} wide title="Add employee" subtitle="Joins the Hub attendance roster.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name *"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Designation"><input className={inputCls} value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
          <Field label="Department"><input className={inputCls} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
          <Field label="Phone"><input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="03XXXXXXXXX" /></Field>
          <Field label="Monthly salary (Rs)"><input type="number" className={inputCls} value={f.sal} onChange={(e) => setF({ ...f, sal: e.target.value })} /></Field>
          <Field label="Working days / month"><input type="number" className={inputCls} value={f.wd} onChange={(e) => setF({ ...f, wd: e.target.value })} /></Field>
          <Field label="Duty time"><input type="time" className={inputCls} value={f.dtime} onChange={(e) => setF({ ...f, dtime: e.target.value })} /></Field>
        </div>
        <Feedback res={res} />
        <div className="mt-5 flex gap-2">
          <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={14} className="animate-spin" />} Save employee</button>
          <button onClick={() => setOpen(false)} className={btnGhost}>Close</button>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Daily attendance — the day roster                                  */
/* ------------------------------------------------------------------ */
/* ONE PASS, EVERYBODY, ON ONE SCREEN.
 *
 * This used to be a dialog: pick ONE status, tick the people it applies to in
 * a small box that scrolled by itself, save, then do it again for the next
 * status. A normal day — six present, one absent, one on leave — was three
 * rounds of that, inside a sheet that also scrolled. On a phone it meant
 * scrolling up and down again and again.
 *
 * Now every person is a row with four big buttons. What the day already says
 * is lit as it loads, so a correction looks like one. Tap to change; tap the
 * lit button again to clear the mark. "Mark the rest present" fills everyone
 * not yet marked. Nothing is written until Save — the bar at the bottom says
 * how many changes are waiting, and Undo throws them away.
 *
 * WHAT IS STORED IS UNCHANGED: one row per person per day, id
 * `${emp}-${y}-${m}-${d}`, one letter for the status (P / H / L / A — the
 * payable calculation reads exactly these), and clearing DELETES the row
 * rather than writing an empty status.
 *
 * Leave is PAID (counts as a present day). Absent is unpaid. A Sunday marked
 * Present earns an EXTRA day on top of being paid — one stray tap once put
 * Abdul Rehman on 31 counted days — so a Sunday or holiday says so up front. */
const MARKS = [
  { code: "P", short: "P", label: "Present",  on: "border-transparent bg-emerald-600 text-white" },
  { code: "H", short: "½", label: "Half day", on: "border-transparent bg-amber-500 text-white" },
  { code: "L", short: "L", label: "Leave",    on: "border-transparent bg-sky-600 text-white" },
  { code: "A", short: "A", label: "Absent",   on: "border-transparent bg-red-600 text-white" },
];
const markLabel = (c: string) => MARKS.find((x) => x.code === c)?.label ?? "Not marked";

/* The date in Lahore, not in London: toISOString() is UTC, which before 5am
   here is still yesterday. */
export const localISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const shiftDay = (iso: string, n: number) => { const [y, m, d] = parts(iso); return localISO(new Date(y, m - 1, d + n)); };
export const dayLabel = (iso: string) => {
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

type Saved = Record<string, { status: string; time_in: string }>;

export function DayRoster({ emps, date, onDate, onDirty, onDone }: {
  emps: (EmpLite & { designation?: string | null })[];
  date: string; onDate: (iso: string) => void;
  onDirty?: (n: number) => void; onDone: () => void;
}) {
  const confirm = useConfirm();
  const [saved, setSaved] = useState<Saved>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const [timeIn, setTimeIn] = useState("");
  const [holiday, setHoliday] = useState<string | null>(null);
  /* If the day's marks could not be read, the roster does not know what is
     already saved — so it cannot be marked. "All present" on a blank it only
     believes is blank would overwrite real Absent and Leave marks. */
  const [loadErr, setLoadErr] = useState("");
  const req = useRef(0);
  const [y, m, d] = parts(date);
  const sunday = new Date(y, m - 1, d).getDay() === 0;
  const isToday = date === localISO();

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    const my = ++req.current;
    setLoading(true);
    const [recs, hol] = await Promise.all([
      supabase.from("online_att_records").select("emp_id,status,time_in").eq("year", y).eq("month", m).eq("day", d),
      supabase.from("online_att_holidays").select("name").eq("hdate", date).maybeSingle(),
    ]);
    if (my !== req.current) return;
    setLoadErr(recs.error ? recs.error.message : "");
    const map: Saved = {};
    for (const r of (recs.data ?? []) as { emp_id: string; status: string; time_in: string | null }[])
      map[r.emp_id] = { status: r.status, time_in: r.time_in ?? "" };
    setSaved(map);
    setHoliday((hol.data as { name?: string } | null)?.name ?? null);
    setLoading(false);
  }, [date, y, m, d]);

  // A new day starts clean: its own marks, no leftover changes.
  useEffect(() => { setDraft({}); setRes(null); load(); }, [load]);

  const changes = Object.entries(draft);
  useEffect(() => { onDirty?.(changes.length); }, [changes.length, onDirty]);

  const current = (id: string) => (id in draft ? draft[id] : saved[id]?.status ?? "");

  const locked = loading || busy || !!loadErr;
  function tap(id: string, code: string) {
    if (locked) return;
    setRes(null);
    setDraft((prev) => {
      const was = saved[id]?.status ?? "";
      const now = id in prev ? prev[id] : was;
      const target = now === code ? "" : code;   // tapping the lit one clears it
      const next = { ...prev };
      if (target === was) delete next[id]; else next[id] = target;
      return next;
    });
  }
  const unmarked = emps.filter((e) => current(e.id) === "");
  function markRestPresent() {
    if (locked) return;
    setRes(null);
    setDraft((prev) => {
      const next = { ...prev };
      for (const e of unmarked) { if ((saved[e.id]?.status ?? "") === "P") delete next[e.id]; else next[e.id] = "P"; }
      return next;
    });
  }

  async function goTo(next: string) {
    /* A date box being typed into reports half-finished years (0002-09-21).
       Only a whole, plausible date moves the roster. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number(next.slice(0, 4)) < 2020 || next === date) return;
    if (changes.length) {
      const ok = await confirm({ title: "Leave without saving?", body: `${changes.length} change${changes.length === 1 ? "" : "s"} for ${dayLabel(date)} will be thrown away.`, confirmLabel: "Discard", cancelLabel: "Stay" });
      if (!ok) return;
    }
    onDate(next);
  }

  async function save() {
    if (!supabase || !changes.length) return;
    setBusy(true); setRes(null);
    const ups = changes.filter(([, s]) => s).map(([emp_id, status]) => ({
      id: `${emp_id}-${y}-${m}-${d}`, emp_id, year: y, month: m, day: d, status,
      time_in: status === "P" || status === "H" ? (timeIn || saved[emp_id]?.time_in || "") : "",
    }));
    const dels = changes.filter(([, s]) => !s).map(([id]) => id);
    if (ups.length) {
      const { error } = await supabase.from("online_att_records").upsert(ups, { onConflict: "emp_id,year,month,day" });
      if (error) { setBusy(false); setRes({ ok: false, msg: error.message }); return; }
    }
    if (dels.length) {
      const { error } = await supabase.from("online_att_records").delete()
        .in("emp_id", dels).eq("year", y).eq("month", m).eq("day", d);
      if (error) { setBusy(false); setRes({ ok: false, msg: error.message }); return; }
    }
    const corrected = ups.filter((u) => saved[u.emp_id] && saved[u.emp_id].status !== u.status).length;
    const counts = MARKS.map((k) => [k.label, ups.filter((u) => u.status === k.code).length] as const).filter(([, n]) => n);
    setBusy(false);
    setRes({ ok: true, msg: `Saved for ${dayLabel(date)}: ` +
      [...counts.map(([l, n]) => `${n} ${l.toLowerCase()}`), ...(dels.length ? [`${dels.length} cleared`] : [])].join(", ") +
      (corrected ? ` (${corrected} corrected).` : ".") });
    setDraft({});
    await load();
    onDone();
  }

  const tally = MARKS.map((k) => ({ ...k, n: emps.filter((e) => current(e.id) === k.code).length }));

  return (
    <section className={`rounded-card border border-line bg-surface p-3 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${changes.length ? "mb-[76px] md:mb-0" : ""}`}>
      {/* the day */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => goTo(shiftDay(date, -1))} aria-label="Previous day"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-ink active:bg-panel dark:border-white/10 dark:text-white"><ChevronLeft size={20} /></button>
        <label className="relative flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-panel px-3 text-[14.5px] font-bold text-ink dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <CalendarDays size={16} className="shrink-0 text-muted" />
          <span className="truncate">{dayLabel(date)}</span>
          <input type="date" aria-label="Pick a day" value={date} onChange={(e) => goTo(e.target.value)}
            /* On a desktop a click on a hidden date box only focuses it; open
               the calendar instead, as a phone does. */
            onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* older browsers open it themselves */ } }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
        <button type="button" onClick={() => goTo(shiftDay(date, 1))} aria-label="Next day" disabled={isToday}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-ink active:bg-panel disabled:opacity-30 dark:border-white/10 dark:text-white"><ChevronRight size={20} /></button>
      </div>
      {!isToday && (
        <button type="button" onClick={() => goTo(localISO())} className="mt-2 w-full text-center text-[12.5px] font-semibold text-muted underline dark:text-[#a89f93]">Back to today</button>
      )}

      {(sunday || holiday) && (
        <p className="mt-3 flex items-start gap-2 rounded-xl2 bg-amber-soft px-3 py-2.5 text-[12.5px] leading-snug text-amber-900 dark:bg-white/[0.06] dark:text-amber">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{holiday ? `${holiday} — a holiday.` : "Sunday."} Marking someone Present here pays an <b>extra</b> day. Only mark people who actually worked.</span>
        </p>
      )}

      {/* quick actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={markRestPresent} disabled={locked || unmarked.length === 0}
          className="flex h-11 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white active:opacity-80 disabled:opacity-40 sm:flex-none dark:bg-white dark:text-[#141414]">
          <CheckCheck size={16} /> {unmarked.length === 0 ? "All marked" : unmarked.length === emps.length ? "All present" : `Rest present (${unmarked.length})`}
        </button>
        <label className="flex h-11 items-center gap-2 rounded-full border border-line px-3 text-[12.5px] font-semibold text-muted dark:border-white/10 dark:text-[#a89f93]">
          Time in
          <input type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)}
            className="w-[92px] bg-transparent text-[13px] text-ink outline-none dark:text-white" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted dark:text-[#a89f93]">
        {tally.map((t) => <span key={t.code}><b className="text-ink dark:text-[#f4f1ea]">{t.short}</b> {t.label} · {t.n}</span>)}
        <span>· {unmarked.length} not marked</span>
      </div>

      <Feedback res={res} />
      {loadErr && (
        <div className="mt-3 flex items-start gap-2 rounded-xl2 bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="flex-1">Couldn&apos;t read this day&apos;s marks, so marking is paused — saving now could overwrite them. {loadErr}</span>
          <button type="button" onClick={load} className="h-9 shrink-0 rounded-full border border-danger/30 px-3 font-semibold">Retry</button>
        </div>
      )}

      {/* everybody */}
      <ul className="mt-2 divide-y divide-line dark:divide-white/[0.06]">
        {loading ? Array.from({ length: Math.max(emps.length, 4) }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 py-3"><div className="h-4 flex-1 animate-pulse rounded bg-panel dark:bg-white/[0.06]" /><div className="h-11 w-[188px] animate-pulse rounded-xl2 bg-panel dark:bg-white/[0.06]" /></li>
        )) : emps.length === 0 ? (
          <li className="py-8 text-center text-[13px] text-muted dark:text-[#a89f93]">No employees yet — add one under Staff.</li>
        ) : emps.map((e) => {
          const now = current(e.id);
          const was = saved[e.id]?.status ?? "";
          const changed = e.id in draft;
          return (
            <li key={e.id} className={`flex items-center gap-3 py-2.5 ${changed ? "-mx-3 bg-amber-soft/50 px-3 sm:-mx-4 sm:px-4 dark:bg-white/[0.03]" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[14.5px] font-semibold leading-tight text-ink dark:text-[#f4f1ea]">{e.name}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-muted dark:text-[#a89f93]">
                  {changed
                    ? (was ? `was ${markLabel(was)} · not saved` : "not saved yet")
                    : was ? `${markLabel(was)}${saved[e.id]?.time_in ? ` · in ${saved[e.id].time_in}` : ""}` : (e.designation || "not marked")}
                </div>
              </div>
              <div className="flex shrink-0 gap-1" role="group" aria-label={`${e.name}`}>
                {MARKS.map((k) => {
                  const on = now === k.code;
                  return (
                    <button key={k.code} type="button" onClick={() => tap(e.id, k.code)} aria-pressed={on} aria-label={`${e.name}: ${k.label}`} disabled={locked}
                      className={`flex h-11 w-11 items-center justify-center rounded-xl border text-[15px] font-extrabold transition active:scale-95 disabled:opacity-60 ${on ? k.on
                        : "border-line bg-surface text-muted dark:border-white/10 dark:bg-white/[0.03] dark:text-[#a89f93]"}`}>
                      {k.short}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        Tap a lit button again to clear that mark. Leave is paid; Absent loses the day&apos;s pay.
      </p>

      {/* waiting changes: above the tab bar on a phone, at the foot of the card on a desktop */}
      {changes.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 border-t border-line bg-surface px-3 py-2.5 shadow-[0_-6px_20px_rgba(20,16,12,0.08)] md:sticky md:bottom-0 md:-mx-4 md:mt-3 md:rounded-b-card md:px-4 dark:border-white/[0.08] dark:bg-[#201c17]">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <div className="min-w-0 flex-1 text-[13px] leading-tight text-ink dark:text-[#f4f1ea]">
              <b>{changes.length} change{changes.length === 1 ? "" : "s"}</b>
              <span className="block truncate text-[11.5px] text-muted dark:text-[#a89f93]">{dayLabel(date)} · not saved yet</span>
            </div>
            <button type="button" onClick={() => { setDraft({}); setRes(null); }} disabled={busy}
              className="h-11 rounded-full border border-line px-4 text-[13.5px] font-semibold text-ink active:bg-panel dark:border-white/10 dark:text-white">Undo</button>
            <button type="button" onClick={save} disabled={busy}
              className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-semibold text-white active:opacity-80 disabled:opacity-50 dark:bg-white dark:text-[#141414]">
              {busy && <Loader2 size={15} className="animate-spin" />} Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Advance                                                            */
/* ------------------------------------------------------------------ */
export function AddAdvance({ emps, onDone }: { emps: EmpLite[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const now = new Date();
  const [f, setF] = useState({
    emp_id: "", amount: "", date: today(), note: "",
    deduct_month: String(now.getMonth() + 1), deduct_year: String(now.getFullYear()),
  });

  async function save() {
    if (!supabase) return;
    if (!f.emp_id) { setRes({ ok: false, msg: "Select an employee." }); return; }
    if (!f.amount || Number(f.amount) <= 0) { setRes({ ok: false, msg: "Enter an amount greater than zero." }); return; }
    setBusy(true); setRes(null);
    const { error } = await supabase.from("online_att_advances").insert({
      id: newId("adv"),
      emp_id: f.emp_id,
      amount: Number(f.amount),
      date: f.date,
      note: f.note.trim(),
      deduct_month: Number(f.deduct_month),
      deduct_year: Number(f.deduct_year),
      settled: false,
    });
    setBusy(false);
    if (error) { setRes({ ok: false, msg: error.message }); return; }
    setRes({ ok: true, msg: `Advance of Rs ${Number(f.amount).toLocaleString()} recorded.` });
    setF({ ...f, amount: "", note: "" });
    onDone();
  }

  return (
    <>
      <button onClick={() => { setOpen(true); setRes(null); }} className={btnGhost}><Wallet size={15} /> Give advance</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Record an advance"
        subtitle="Deducted from the chosen month's salary.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Employee *">
            <select className={inputCls} value={f.emp_id} onChange={(e) => setF({ ...f, emp_id: e.target.value })}>
              <option value="">Select…</option>
              {emps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          <Field label="Amount (Rs) *"><input type="number" className={inputCls} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Date given"><input type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Deduct from month">
            <select className={inputCls} value={f.deduct_month} onChange={(e) => setF({ ...f, deduct_month: e.target.value })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Deduct from year"><input type="number" className={inputCls} value={f.deduct_year} onChange={(e) => setF({ ...f, deduct_year: e.target.value })} /></Field>
          <Field label="Note"><input className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <Feedback res={res} />
        <div className="mt-5 flex gap-2">
          <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={14} className="animate-spin" />} Save advance</button>
          <button onClick={() => setOpen(false)} className={btnGhost}>Close</button>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Salary paid / unpaid                                               */
/* ------------------------------------------------------------------ */
export function MarkSalary({ emps, onDone }: { emps: EmpLite[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [paid, setPaid] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));



  async function save() {
    if (!supabase) return;
    if (!picked.length) { setRes({ ok: false, msg: "Select at least one employee." }); return; }
    setBusy(true); setRes(null);
    const y = Number(year), m = Number(month);
    /* Clearing is a delete, not a write. Storing an empty status would leave a
       row that says nothing and still has to be reasoned about. */

    const rowsToSave = picked.map((emp_id) => ({ id: `${emp_id}-${y}-${m}`, emp_id, year: y, month: m, paid }));
    const { error } = await supabase.from("online_att_salary_status").upsert(rowsToSave, { onConflict: "emp_id,year,month" });
    setBusy(false);
    if (error) { setRes({ ok: false, msg: error.message }); return; }
    setRes({ ok: true, msg: `${rowsToSave.length} salary record(s) marked ${paid ? "paid" : "unpaid"} for ${MONTHS[m - 1]} ${y}.` });
    setPicked([]);
    onDone();
  }

  return (
    <>
      <button onClick={() => { setOpen(true); setRes(null); }} className={btnGhost}><Plus size={15} /> Salary status</button>
      <Modal open={open} onClose={() => setOpen(false)} wide title="Mark salaries"
        subtitle="One record per employee per month — re-marking corrects it.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Month">
            <select className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Year"><input type="number" className={inputCls} value={year} onChange={(e) => setYear(e.target.value)} /></Field>
          <Field label="Mark as">
            <select className={inputCls} value={paid ? "paid" : "unpaid"} onChange={(e) => setPaid(e.target.value === "paid")}>
              <option value="paid">Paid</option>
              <option value="unpaid">Unpaid</option>
            </select>
          </Field>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-ink dark:text-[#f4f1ea]">Employees ({picked.length} selected)</span>
            <button onClick={() => setPicked(picked.length === emps.length ? [] : emps.map((e) => e.id))}
              className="text-[12px] font-semibold text-muted underline hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
              {picked.length === emps.length ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className="max-h-[240px] overflow-y-auto rounded-card border border-line p-1 dark:border-white/[0.06]">
            {emps.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted dark:text-[#a89f93]">No employees yet.</p>}
            {emps.map((e) => (
              <label key={e.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl2 px-3 py-2 text-[13px] text-ink transition hover:bg-panel dark:text-[#f4f1ea] dark:hover:bg-white/[0.05]">
                <input type="checkbox" checked={picked.includes(e.id)} onChange={() => toggle(e.id)} className="h-4 w-4 accent-current" />
                {e.name}
              </label>
            ))}
          </div>
        </div>

        <Feedback res={res} />
        <div className="mt-5 flex gap-2">
          <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
          <button onClick={() => setOpen(false)} className={btnGhost}>Close</button>
        </div>
      </Modal>
    </>
  );
}
