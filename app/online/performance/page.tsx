"use client";

/* ---------------------------------------------------------------------------
   PERFORMANCE — how each person in the Hub is doing, and why they differ.

   THE PROBLEM THIS PAGE HAD TO SOLVE FIRST.
   The Hub pipeline has five stages and each stage has exactly one owner. So
   putting five people's hold times side by side is not comparing five people:
   it is comparing a quality check against a video shoot. Eight hours is slow
   for one and very fast for the other.

   So nobody is compared to anybody else's clock. Each person is compared to
   the bar for HIS OWN job — a target in hours, kept in the database, which the
   owner can change from the Targets button. Once everybody's number means the
   same thing ("how close to what this job should take"), the numbers can sit
   in one list honestly.

   WHAT THE SCORE IS MADE OF. The weights are read from the answer, not written
   here, so the footnote can never disagree with the arithmetic:
     on time    35 — finished within the target for that stage
     cleared    25 — finished, against what is still sitting past its target
     attendance 25 — days present (leave is paid, so it counts as present)
     no rework  15 — product work that did not have to be done twice
   A part with nothing to measure is dropped and the rest are re-weighted, so
   nobody is marked on an empty column.

   THREE THINGS THIS PAGE REFUSES TO PRETEND.
   1. Somebody with nothing finished has no work figures, so he is listed on
      attendance and kept out of the ranking. Ranking a man first because he
      has nothing to be late with is the opposite of what this page is for.
   2. Work an administrator recorded on somebody's behalf, against a chosen
      day, cannot be timed. It counts as finished and is left out of the
      timing — which is why "done" and "timed" are shown as two numbers.
   3. Punctuality is not scored. Arrival times exist on a handful of rows; a
      score built on that would be a made-up number with a decimal point. The
      page says how many rows carry a time instead.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RefreshCw, Loader2, Trophy, Gauge, Target, Info, AlertTriangle, Check } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { HubRange, PageActions, Segmented, Sheet, Detail, useIsPhone } from "@/components/HubUI";

/* A month is the unit people are paid and judged by, so the list starts there
   rather than on a week that may be half a holiday. */
const PERIODS = [["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["60d", "60 days"], ["90d", "90 days"], ["custom", "Custom"]]
  .map(([key, label]) => ({ key, label }));

/* THE DATE IN LAHORE, NOT IN LONDON. toISOString() is UTC, so before 5am here
   it is still yesterday — which on this page would drag a day of the previous
   month into a month that is compared against payroll. */
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function periodRange(preset: string, cf: string, ct: string): { from: string; to: string } | null {
  const t = new Date();
  const back = (n: number) => { const d = new Date(t); d.setDate(t.getDate() - n); return d; };
  switch (preset) {
    case "7d":  return { from: localISO(back(6)),  to: localISO(t) };
    case "30d": return { from: localISO(back(29)), to: localISO(t) };
    case "60d": return { from: localISO(back(59)), to: localISO(t) };
    case "90d": return { from: localISO(back(89)), to: localISO(t) };
    case "month": return { from: localISO(new Date(t.getFullYear(), t.getMonth(), 1)), to: localISO(t) };
    /* Both ends, or nothing: quietly showing the last 30 days under a label
       that says "Custom" is how a wrong figure gets believed. */
    case "custom": return cf && ct ? { from: cf, to: ct } : null;
    default: return { from: localISO(back(29)), to: localISO(t) };
  }
}

type Person = {
  name: string; designation: string | null; user_id: string | null; emp_id: string | null;
  stage: string | null; stage_label: string | null; target_hours: number;
  finished: number; measured: number; sent_back: number; on_time: number;
  avg_hours: number | null; fastest_hours: number | null; slowest_hours: number | null;
  recorded_by_other: number; redone: number;
  open_now: number; late_now: number; oldest_hours: number | null;
  att_days: number; present: number; half: number; on_leave: number; absent: number; timed: number;
  trend: { d: string; n: number; ok: number }[];
  s_on_time: number | null; s_cleared: number | null; s_clean: number | null; s_present: number | null;
  basis: "work" | "attendance"; score: number | null;
};
type Weights = { on_time: number; cleared: number; attendance: number; clean: number };
type Payload = {
  ok: boolean; error?: string; from: string; to: string; bucket: "day" | "week";
  weights: Weights;
  targets: { stage: string; hours: number; label: string | null; owner: string | null }[];
  people: Person[]; punctuality_rows: number; attendance_rows: number;
};

/* Hours, said the way somebody says them out loud. */
function hrs(h: number | null | undefined): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${Math.round(h * 10) / 10} h`;
  const d = Math.floor(h / 24), r = Math.round(h % 24);
  return r ? `${d}d ${r}h` : `${d}d`;
}
/* A target is a rule, not a measurement: "24 h" is what people were told,
   "1d" is an interpretation of it. */
const tgt = (h: number) => `${Math.round(h * 10) / 10} h`;
const pc = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);
const keyOf = (p: Person) => p.user_id ?? p.emp_id ?? p.name;

/* One scale for every bar and every number on the page. */
function band(score: number | null) {
  if (score == null) return { bar: "#B4ABA0", chip: "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]", word: "no figures" };
  if (score >= 90) return { bar: "#7FC489", chip: "bg-success-soft text-[#2f7a3d]", word: "strong" };
  if (score >= 75) return { bar: "#A6C0E6", chip: "bg-periwinkle-soft text-[#38507a]", word: "steady" };
  if (score >= 60) return { bar: "#E4B47E", chip: "bg-amber-soft text-[#7a5a28]", word: "slipping" };
  return { bar: "#E5786B", chip: "bg-danger-soft text-[#8d3328]", word: "needs a word" };
}

export default function PerformancePage() {
  const phone = useIsPhone();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [view, setView] = useState<"rank" | "speed" | "days">("rank");
  /* The open sheet is held by WHO, not by a copy of his figures: a copy would
     still be showing last month's numbers after the range changed. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [boss, setBoss] = useState(false);
  const [targets, setTargets] = useState(false);

  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState("");
  const [ct, setCt] = useState("");
  const range = useMemo(() => periodRange(preset, cf, ct), [preset, cf, ct]);

  /* Two quick taps on the range and the slower answer lands last: the earlier
     period's figures under the later period's label. Every Hub page with a
     date range guards this the same way. */
  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    if (!range) { setLoading(false); setErr(""); setData(null); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const { data: d, error } = await supabase.rpc("hub_performance", { p_from: range.from, p_to: range.to });
    if (my !== reqId.current) return;                 // superseded by a newer request
    setLoading(false);
    if (error) {
      /* A function that has not been installed yet answers with a sentence
         about a schema cache, which tells nobody anything. */
      setErr(/function|schema cache/i.test(error.message)
        ? "This page needs migration H273, which has not been run on the database yet. Open Supabase → SQL editor, run H273_hub_performance.sql, then reload."
        : error.message);
      return;
    }
    const p = d as Payload;
    if (!p?.ok) { setErr(p?.error ?? "Could not read the figures."); setData(null); return; }
    /* Somebody with no stage of his own is judged by the one-off task target,
       so that is the target his row should show. */
    setData({
      ...p,
      targets: p.targets ?? [],
      people: (p.people ?? []).map((x) => ({
        ...x,
        target_hours: (p.targets ?? []).find((t) => t.stage === (x.stage ?? "task"))?.hours ?? x.target_hours,
      })),
    });
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.rpc("hub_is_boss").then(({ data: d }: { data: unknown }) => setBoss(d === true));
  }, []);

  /* Ranked people first; everybody else after, on attendance alone. Two lists,
     because they answer two different questions. */
  const ranked = useMemo(() => (data?.people ?? []).filter((p) => p.basis === "work"), [data]);
  const others = useMemo(() => (data?.people ?? []).filter((p) => p.basis !== "work"), [data]);
  const open = useMemo(() => (data?.people ?? []).find((p) => keyOf(p) === openKey) ?? null, [data, openKey]);
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : undefined;
  const gap = best && worst && best.score != null && worst.score != null ? best.score - worst.score : null;
  const team = useMemo(() => {
    const s = ranked.map((p) => p.score).filter((x): x is number => x != null);
    return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
  }, [ranked]);
  const doneTotal = useMemo(() => ranked.reduce((a, p) => a + p.finished, 0), [ranked]);
  const lateTotal = useMemo(() => ranked.reduce((a, p) => a + p.late_now, 0), [ranked]);
  const untimed = useMemo(() => ranked.reduce((a, p) => a + (p.finished - p.measured), 0), [ranked]);

  /* What separates the best from the worst, in one line, taken from whichever
     part of the score they differ on most. Guesswork is what the owner is
     trying to get away from. */
  const reason = useMemo(() => {
    if (!best || !worst) return "";
    const parts: [string, number | null, number | null][] = [
      ["finishing inside the target", best.s_on_time, worst.s_on_time],
      ["clearing what lands on him", best.s_cleared, worst.s_cleared],
      ["work not coming back", best.s_clean, worst.s_clean],
      ["being here", best.s_present, worst.s_present],
    ];
    let name = "", diff = 0;
    for (const [label, b, w] of parts) {
      if (b == null || w == null) continue;
      if (b - w > diff) { diff = b - w; name = label; }
    }
    return name ? `Mostly ${name}: ${Math.round(diff)} points of the difference.` : "";
  }, [best, worst]);

  const maxHold = useMemo(() => {
    const v = ranked.flatMap((p) => [p.avg_hours ?? 0, p.target_hours]);
    return Math.max(1, ...v) * 1.15;
  }, [ranked]);

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Performance</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">
            Each person against the bar for his own job — not against each other&rsquo;s clock.
          </p>
        </div>
        <PageActions>
          {boss && (
            <button onClick={() => setTargets(true)}
              className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
              <Target size={14} /> Targets
            </button>
          )}
          <button onClick={load}
            className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} presets={PERIODS} />

      {!range && (
        <p className="mt-4 rounded-card border border-line bg-panel px-4 py-3 text-[13px] text-muted dark:border-white/[0.06] dark:bg-white/[0.05] dark:text-[#a89f93]">
          Pick both dates and the figures will follow.
        </p>
      )}

      {err && (
        <div className="mt-4 flex items-start gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{err}</span>
        </div>
      )}

      {loading && !data && range && (
        <p className="flex items-center justify-center gap-2 px-4 py-16 text-[13px] text-muted dark:text-[#a89f93]">
          <Loader2 size={16} className="animate-spin" /> Working out the figures…
        </p>
      )}

      {data && !err && (
        <>
          {/* THE THINGS THE OWNER ASKED FOR: the best, the worst, and the gap
              with a reason attached to it rather than left to be guessed at. */}
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-6 md:grid-cols-4 md:gap-3">
            <Stat icon={<Trophy size={15} />} label="Best" value={best ? best.name : "—"}
              sub={best?.score != null ? `${best.score} / 100` : ""} tone="#7FC489" />
            <Stat icon={<Gauge size={15} />} label="Lowest" value={worst ? worst.name : "—"}
              sub={worst?.score != null ? `${worst.score} / 100` : ""} tone="#E4B47E" />
            <Stat icon={<Gauge size={15} />} label="Team average" value={team != null ? String(team) : "—"}
              sub={`${ranked.length} ${ranked.length === 1 ? "person" : "people"} ranked`} tone="#A6C0E6" />
            <Stat icon={<Target size={15} />} label="Work finished" value={String(doneTotal)}
              sub={lateTotal > 0 ? `${lateTotal} still past its target` : "nothing past its target"} tone="#B693DD" />
          </div>

          {gap != null && best && worst && (
            <div className="mt-2.5 rounded-card border border-lavender bg-[#F7F2FC] px-4 py-3 md:mt-3 dark:border-white/[0.10] dark:bg-white/[0.04]">
              <div className="text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">
                {gap} points between {best.name} and {worst.name}
              </div>
              {reason && <div className="mt-0.5 text-[12px] leading-snug text-muted dark:text-[#a89f93]">{reason}</div>}
            </div>
          )}

          <Segmented className="mt-4 md:mt-6" value={view} onChange={setView} options={[
            { key: "rank", label: "Scoreboard", short: "Score" },
            { key: "speed", label: "Time vs target", short: "Speed" },
            { key: "days", label: "Attendance", short: "Days" },
          ]} />

          {/* ---------------------------------------------------------- RANK */}
          {view === "rank" && (
            <>
              <Card title="Everyone, ranked" note="Tap a name for the whole breakdown.">
                {ranked.length === 0 && <Empty>Nothing was finished in this period.</Empty>}
                {ranked.map((p, i) => {
                  const b = band(p.score);
                  return (
                    <button key={keyOf(p)} onClick={() => setOpenKey(keyOf(p))}
                      className="block w-full rounded-xl2 px-2 py-2.5 text-left transition active:bg-panel md:hover:bg-panel dark:active:bg-white/[0.05] dark:md:hover:bg-white/[0.05]">
                      <div className="flex items-baseline gap-2">
                        <span className="w-5 shrink-0 text-[12px] font-bold text-hint dark:text-[#8a8175]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                        <span className="shrink-0 text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{p.score ?? "—"}</span>
                      </div>
                      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.07]">
                        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, p.score ?? 0)}%`, background: b.bar }} />
                      </div>
                      {/* The label may be long and the late count matters more,
                          so the label is what gets clipped, never the count. */}
                      <div className="mt-1 flex items-baseline gap-1.5 text-[11.5px] text-muted dark:text-[#a89f93]">
                        <span className="min-w-0 flex-1 truncate">
                          {p.stage_label ?? p.designation ?? "—"} · {p.finished} done · {pc(p.s_on_time)} on time
                        </span>
                        {p.late_now > 0 && (
                          <span className="shrink-0 font-semibold text-[#b4562f] dark:text-[#e0a183]">{p.late_now} late</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </Card>

              {/* The whole table, where there is room for it. A phone gets the
                  same numbers in the sheet instead of a table that would have
                  scrolled sideways under the thumb. */}
              <div className="hidden md:block">
                <Card title="The numbers behind it">
                  {/* Ten columns need about 860px. On a small laptop the card
                      scrolls sideways rather than losing its last two columns
                      off the edge — what every other Hub table does. */}
                  <div className="overflow-x-auto rounded-xl2 border border-line dark:border-white/[0.06]">
                    <table className="w-full min-w-[860px] text-[13px]">
                      <thead className="bg-panel text-left text-[11.5px] uppercase tracking-wide text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">
                        <tr>
                          {["Person", "Stage", "Done", "Timed", "On time", "Average hold", "Target", "Still open", "Present", "Score"].map((h) => (
                            <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ranked.map((p) => (
                          <tr key={keyOf(p)} onClick={() => setOpenKey(keyOf(p))}
                            className="cursor-pointer border-t border-line transition hover:bg-panel dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                            <td className="px-3 py-2 font-semibold text-ink dark:text-[#f4f1ea]">{p.name}</td>
                            <td className="px-3 py-2 capitalize text-muted dark:text-[#a89f93]">{p.stage ?? "—"}</td>
                            <td className="px-3 py-2 tabular-nums">{p.finished}</td>
                            <td className="px-3 py-2 tabular-nums text-muted dark:text-[#a89f93]">{p.measured}</td>
                            <td className="px-3 py-2 tabular-nums">{p.on_time}<span className="text-hint"> / {p.measured}</span></td>
                            <td className="px-3 py-2 tabular-nums">{hrs(p.avg_hours)}</td>
                            <td className="px-3 py-2 tabular-nums text-muted dark:text-[#a89f93]">{tgt(p.target_hours)}</td>
                            <td className={`px-3 py-2 tabular-nums ${p.late_now ? "font-semibold text-[#b4562f] dark:text-[#e0a183]" : ""}`}>
                              {p.open_now}{p.late_now > 0 && <span className="text-[11.5px]"> ({p.late_now} late)</span>}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{p.present}<span className="text-hint"> / {p.att_days}</span></td>
                            <td className="px-3 py-2">
                              <span className={`rounded-full px-2 py-0.5 text-[12px] font-bold tabular-nums ${band(p.score).chip}`}>{p.score ?? "—"}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {untimed > 0 && (
                    <p className="px-2 pt-2 text-[11.5px] text-hint dark:text-[#8a8175]">
                      TIMED is the part of the work that carries a real clock. The other {untimed} were recorded
                      afterwards, on somebody&rsquo;s behalf or against a chosen day, so they count as done and are
                      left out of the timing rather than counted as instant.
                    </p>
                  )}
                </Card>
              </div>
            </>
          )}

          {/* --------------------------------------------------------- SPEED */}
          {view === "speed" && (
            <Card title="How long work is held, against the target for that job"
              note="The line is the target. A bar that stops before it finished inside the time that job was given.">
              {ranked.length === 0 && <Empty>Nothing was finished in this period.</Empty>}
              {ranked.map((p) => {
                const avg = p.avg_hours ?? 0;
                const over = avg > p.target_hours;
                return (
                  <button key={keyOf(p)} onClick={() => setOpenKey(keyOf(p))}
                    className="block w-full rounded-xl2 px-2 py-2.5 text-left transition active:bg-panel md:hover:bg-panel dark:active:bg-white/[0.05] dark:md:hover:bg-white/[0.05]">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                      <span className={`shrink-0 text-[13.5px] font-bold tabular-nums ${p.avg_hours == null ? "text-muted" : over ? "text-[#b4562f] dark:text-[#e0a183]" : "text-[#2f7a3d] dark:text-[#8fd39a]"}`}>{hrs(p.avg_hours)}</span>
                    </div>
                    <div className="relative mt-1.5 h-3 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.07]">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (avg / maxHold) * 100)}%`, background: over ? "#E5786B" : "#7FC489" }} />
                      {/* the bar this job was given */}
                      <span className="absolute top-0 h-full w-[2px] bg-ink/45 dark:bg-white/50"
                        style={{ left: `${Math.min(99.5, (p.target_hours / maxHold) * 100)}%` }} />
                    </div>
                    <div className="mt-1 truncate text-[11.5px] text-muted dark:text-[#a89f93]">
                      target {tgt(p.target_hours)} · {p.measured} timed · fastest {hrs(p.fastest_hours)} · slowest {hrs(p.slowest_hours)}
                    </div>
                  </button>
                );
              })}
              <p className="px-2 pt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
                Sundays and holidays come off the clock. A quality check is timed from the moment the product
                was submitted, not from when the article was created — the waiting belongs to whoever is
                making the product.
              </p>
            </Card>
          )}

          {/* ----------------------------------------------------------- DAYS */}
          {view === "days" && (
            <Card title="Days present" note={`${data.attendance_rows} days marked in this period. Leave is paid, so it counts as a day present.`}>
              {[...ranked, ...others].sort((a, b) => (b.s_present ?? -1) - (a.s_present ?? -1)).map((p) => (
                <div key={keyOf(p)} className="rounded-xl2 px-2 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                    <span className="shrink-0 text-[13.5px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{pc(p.s_present)}</span>
                  </div>
                  <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.07]">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, p.s_present ?? 0)}%`, background: band(p.s_present).bar }} />
                  </div>
                  <div className="mt-1 text-[11.5px] text-muted dark:text-[#a89f93]">
                    {p.present} present{p.half ? ` · ${p.half} half` : ""}{p.on_leave ? ` · ${p.on_leave} leave` : ""}
                    {p.absent ? <span className="text-[#b4562f] dark:text-[#e0a183]"> · {p.absent} absent</span> : ""} of {p.att_days} marked
                  </div>
                </div>
              ))}
              <p className="px-2 pt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
                Arrival times are recorded on {data.punctuality_rows} of {data.attendance_rows} days, so lateness is not
                scored here. It can be, once the roster carries a time-in for everybody.
              </p>
            </Card>
          )}

          {/* Everybody with no finished work. Listed, not ranked — and said so. */}
          {others.length > 0 && view === "rank" && (
            <Card title="Scored on attendance only"
              note="Nothing closed in this period — either the job is not tracked task by task, or no work came through. They are not ranked against the list above.">
              <div className="grid gap-2 sm:grid-cols-2">
                {others.map((p) => (
                  <div key={keyOf(p)} className="rounded-xl2 border border-line px-3.5 py-3 dark:border-white/[0.06]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                      <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{pc(p.s_present)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-muted dark:text-[#a89f93]">
                      {p.stage_label ?? p.designation ?? "—"} · {p.present} of {p.att_days} days
                      {p.open_now > 0 && ` · ${p.open_now} in hand`}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <p className="mt-5 flex items-start gap-2 px-1 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Out of 100: on time {data.weights.on_time}, cleared {data.weights.cleared},
              attendance {data.weights.attendance}, work not sent back {data.weights.clean}.
              Each stage is judged against its own target{boss ? ", which you can change with the Targets button" : ""}.
              A part with nothing in it is left out and the rest are re-weighted.
            </span>
          </p>
        </>
      )}

      {open && data && (
        <PersonSheet person={open} onClose={() => setOpenKey(null)} weights={data.weights} bucket={data.bucket} phone={phone} />
      )}
      {targets && <TargetsSheet targets={data?.targets ?? []} onClose={() => setTargets(false)} onSaved={load} />}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Stat({ icon, label, value, sub, tone }: {
  icon: ReactNode; label: string; value: string; sub?: string; tone: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted dark:text-[#a89f93]">
        <span style={{ color: tone }}>{icon}</span>{label}
      </div>
      {/* A name is allowed two lines rather than being cut in half: "Muhammad
          Us…" names nobody. */}
      <div className="mt-1 text-[16px] font-extrabold leading-tight tracking-tight text-ink [overflow-wrap:anywhere] dark:text-[#f4f1ea]">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">{sub}</div>}
    </div>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-3 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
      <h2 className="px-2 text-[14px] font-bold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</h2>
      {note && <p className="mb-1 px-2 pt-0.5 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">{note}</p>}
      <div className="mt-1 space-y-1">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-8 text-center text-[13px] text-muted dark:text-[#a89f93]">{children}</p>
);

/* One part of the score, with the weight it carries, so a low total can always
   be traced to the thing that caused it. */
function Meter({ label, weight, value }: { label: string; weight: number; value: number | null }) {
  const b = band(value);
  return (
    <div className="py-1.5">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate text-muted dark:text-[#a89f93]">{label} <span className="text-hint dark:text-[#8a8175]">· {weight}%</span></span>
        <span className="shrink-0 font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{value == null ? "not measured" : Math.round(value)}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.07]">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, value ?? 0)}%`, background: b.bar }} />
      </div>
    </div>
  );
}

/* A short history of finished work: how much, and how much of it was on time.
   Drawn by hand — the site carries no charting library and one page is not a
   reason to add 100kB to every page. The column itself carries the height: a
   percentage inside a box of its own choosing resolves to nothing, which is a
   chart of nothing. */
function Spark({ trend, bucket }: { trend: Person["trend"]; bucket: "day" | "week" }) {
  if (!trend?.length) return null;
  const max = Math.max(1, ...trend.map((t) => t.n));
  return (
    <div className="pt-1">
      <div className="flex h-16 items-end gap-1">
        {trend.map((t) => (
          <div key={t.d} title={`${t.d}: ${t.n} done, ${t.ok} inside the target`}
            className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-t-[3px] bg-panel dark:bg-white/[0.10]"
            style={{ height: `${Math.max(5, (t.n / max) * 100)}%` }}>
            <div className="w-full" style={{ height: `${t.n ? (t.ok / t.n) * 100 : 0}%`, background: "#7FC489" }} />
          </div>
        ))}
      </div>
      <p className="pt-1 text-[11px] text-hint dark:text-[#8a8175]">
        Finished per {bucket === "day" ? "day" : "week"}; the green part was inside the target.
      </p>
    </div>
  );
}

function PersonSheet({ person: p, onClose, weights: w, bucket, phone }: {
  person: Person; onClose: () => void; bucket: "day" | "week"; phone: boolean; weights: Weights;
}) {
  const b = band(p.score);
  return (
    <Sheet open onClose={onClose} title={p.name}
      subtitle={`${p.stage_label ?? p.designation ?? "—"}${p.stage ? ` · target ${tgt(p.target_hours)}` : ""}`}>
      <div className="flex items-center gap-3 rounded-xl2 bg-panel px-4 py-3 dark:bg-white/[0.05]">
        <span className="text-[30px] font-extrabold leading-none tabular-nums text-ink dark:text-[#f4f1ea]">{p.score ?? "—"}</span>
        <div className="min-w-0">
          <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-bold ${b.chip}`}>{b.word}</span>
          <div className="mt-1 text-[11.5px] text-muted dark:text-[#a89f93]">
            {p.basis === "work" ? "out of 100, from the four parts below" : "attendance only — nothing closed in this period"}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <Meter label="Finished inside the target" weight={w.on_time} value={p.s_on_time} />
        <Meter label="Cleared what landed on him" weight={w.cleared} value={p.s_cleared} />
        <Meter label="Days present" weight={w.attendance} value={p.s_present} />
        <Meter label="Work not sent back" weight={w.clean} value={p.s_clean} />
      </div>

      {p.trend?.length > 0 && <Spark trend={p.trend} bucket={bucket} />}

      <div className="mt-2">
        <Detail label="Finished">{p.finished}{p.sent_back > 0 && <span className="font-normal text-muted"> · {p.sent_back} sent back for a fault</span>}</Detail>
        {p.finished > 0 && <Detail label="Carrying a real clock">{p.measured} of {p.finished}</Detail>}
        <Detail label="Inside the target">{p.on_time} of {p.measured} · target {tgt(p.target_hours)}</Detail>
        <Detail label="Average hold">{hrs(p.avg_hours)}</Detail>
        <Detail label="Fastest · slowest">{hrs(p.fastest_hours)} · {hrs(p.slowest_hours)}</Detail>
        <Detail label="Still open">{p.open_now}{p.late_now > 0 && <span className="text-[#b4562f] dark:text-[#e0a183]"> · {p.late_now} past the target</span>}</Detail>
        {p.open_now > 0 && <Detail label="Oldest in hand">{hrs(p.oldest_hours)}</Detail>}
        {p.redone > 0 && <Detail label="Done a second time">{p.redone}</Detail>}
        <Detail label="Attendance">{p.present} present{p.half ? `, ${p.half} half` : ""}{p.on_leave ? `, ${p.on_leave} leave` : ""}{p.absent ? `, ${p.absent} absent` : ""} of {p.att_days}</Detail>
      </div>

      {p.recorded_by_other > 0 && (
        <p className="mt-2 rounded-xl2 bg-amber-soft px-3 py-2 text-[11.5px] leading-snug text-[#7a5a28]">
          {p.recorded_by_other} of these were submitted for him by somebody else, so what is recorded is when it
          was written down, not necessarily when it was done. Any of those that cannot be timed are left out of
          the hold times rather than counted as instant.
        </p>
      )}
      {phone && <div className="h-1" />}
    </Sheet>
  );
}

/* THE BAR EACH JOB IS GIVEN. Only an administrator sees this, and every figure
   on the page moves when it changes — which is the point: the standard is the
   owner's to set, not something buried in code. */
function TargetsSheet({ targets, onClose, onSaved }: {
  targets: { stage: string; hours: number; label: string | null; owner: string | null }[];
  onClose: () => void; onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(targets.map((t) => [t.stage, String(t.hours)]))
  );
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");

  async function save(stage: string) {
    if (!supabase) return;
    const h = Number(vals[stage]);
    if (!Number.isFinite(h) || h <= 0 || h > 720) { setErr("A target is between 1 and 720 hours."); return; }
    setBusy(stage); setErr(""); setSaved("");
    const { data, error } = await supabase.rpc("hub_perf_set_target", { p_stage: stage, p_hours: h });
    setBusy("");
    const r = (data ?? {}) as { ok?: boolean; error?: string; hours?: number };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not save that."); return; }
    /* Echo back what was stored — the database rounds, and a figure that
       quietly differs from what is on screen is how trust goes. */
    if (r.hours != null) setVals((v) => ({ ...v, [stage]: String(r.hours) }));
    setSaved(stage);
    onSaved();
  }

  return (
    <Sheet open onClose={onClose} title="Targets"
      subtitle="How long each stage should take. Every figure on the page is measured against these.">
      {err && <p className="mb-2 rounded-xl2 bg-danger-soft px-3 py-2 text-[12.5px] text-[#8d3328]">{err}</p>}
      {targets.length === 0 && <Empty>No targets are set up yet.</Empty>}
      <div className="space-y-2">
        {targets.map((t) => (
          <div key={t.stage} className="rounded-xl2 border border-line p-3 dark:border-white/[0.06]">
            <div className="text-[13.5px] font-semibold capitalize text-ink dark:text-[#f4f1ea]">
              {t.stage === "task" ? "One-off tasks" : t.stage}
              {t.owner && <span className="font-normal text-muted dark:text-[#a89f93]"> · {t.owner}</span>}
            </div>
            {t.label && <div className="mt-0.5 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">{t.label}</div>}
            <div className="mt-2 flex items-center gap-2">
              <input type="number" inputMode="decimal" min={1} max={720} step={1}
                value={vals[t.stage] ?? ""} aria-label={`${t.stage} target in hours`}
                onChange={(e) => { setSaved(""); setVals((v) => ({ ...v, [t.stage]: e.target.value })); }}
                className="h-11 w-24 rounded-full border border-line bg-surface px-3 text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
              <span className="text-[12.5px] text-muted dark:text-[#a89f93]">hours</span>
              {saved === t.stage && (
                <span className="flex items-center gap-1 text-[12px] font-semibold text-[#2f7a3d] dark:text-[#8fd39a]"><Check size={13} /> Saved</span>
              )}
              <button onClick={() => save(t.stage)} disabled={busy === t.stage}
                className="ml-auto flex h-11 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                {busy === t.stage ? <Loader2 size={14} className="animate-spin" /> : null} Save
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="pt-3 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        A working day is about 9 hours, so 24 hours means &ldquo;by this time tomorrow&rdquo;.
        Sundays and holidays are already taken off the clock before anything is measured.
      </p>
    </Sheet>
  );
}
