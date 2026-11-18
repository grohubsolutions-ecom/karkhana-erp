"use client";
/* THE TEAM — every employee's tasks, at the top of Articles.
 *
 * The owner's words (30 Sep): "article management me top pe mjhe ek dashboard
 * chahyye of every employee status — qaswar total 10 tasks, 6 done, 4 pending;
 * hamza khan total 8 tasks, 5 done, 3 pending."
 *
 * So one card per person: TOTAL · DONE · PENDING, and a bar that shows the
 * split. Tap a card and his record opens — everything still with him, oldest
 * first, then everything he has finished, newest first, with the date, how
 * long it took and his note.
 *
 * WHAT THE NUMBERS MEAN
 *   All time        every task he has ever been given
 *   This month /    done inside that window, plus everything pending NOW —
 *   Last 7 days     a task given last month and still open is still his
 *                   problem this month, so it is never hidden by the dates.
 *   A quality check whose product is not in yet is counted as pending but
 *   said separately ("5 waiting for Hamza Mukhtar"): Abdul Rehman cannot do
 *   it yet, and the card must not make that look like his delay.
 *
 * Counted in the database (hub_team_tasks / hub_person_tasks, H282), for the
 * boss only — an employee asking gets a refusal, not somebody else's record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Users, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Segmented, Sheet } from "@/components/HubUI";

type Person = {
  user_id: string; name: string; active: boolean; designation: string | null;
  stage: string | null; stage_label: string | null;
  total: number; done: number; pending: number; blocked: number;
  oldest_open_at: string | null; last_done_at: string | null; done_all_time: number;
};
type Task = {
  task_id: string; article_id: string | null; code: string | null; article: string | null;
  title: string; stage: string | null; status: "open" | "submitted" | "returned"; attempt: number;
  opened_at: string; done_at: string | null; held: string | null; note: string | null;
  on_behalf: boolean; recorded_by: string | null; waits_for: string | null;
};
type Period = "all" | "month" | "week";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "month", label: "This month" },
  { key: "week", label: "Last 7 days" },
];
/* The job in two words — the full label is on his record. */
const STAGE: Record<string, string> = {
  product: "Product", video: "Video", qc: "Quality check", ads: "Ads", social: "Social media",
};

/* Dates are the office's dates: Pakistan time, whatever the browser thinks. */
const ymdPK = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(d);
function range(p: Period): [string | null, string | null] {
  if (p === "all") return [null, null];
  const today = ymdPK(new Date());
  if (p === "month") return [today.slice(0, 8) + "01", today];
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 6);
  return [d.toISOString().slice(0, 10), today];
}
const day = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }) : "—";
const daysSince = (s: string | null) =>
  s ? Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 86400000)) : null;

export default function TeamTaskBoard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [period, setPeriod] = useState<Period>("all");
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState<Person | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [taskErr, setTaskErr] = useState("");

  const req = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++req.current;
    setLoading(true); setErr("");
    const [from, to] = range(period);
    const { data, error } = await supabase.rpc("hub_team_tasks", { p_from: from, p_to: to });
    if (my !== req.current) return;
    setLoading(false);
    const r = (data ?? {}) as { ok?: boolean; error?: string; people?: Person[] };
    if (error) { setErr(error.message); return; }
    /* Somebody who does not run the department sees nothing here at all,
       rather than a box explaining what he may not see. */
    if (!r.ok) { if (/whoever runs the department/i.test(r.error ?? "")) setHidden(true); else setErr(r.error ?? "Could not load the team."); return; }
    setPeople(r.people ?? []);
  }, [period]);
  useEffect(() => { load(); }, [load, refreshKey]);

  /* His record, for the same window as the cards. */
  const recReq = useRef(0);
  useEffect(() => {
    if (!open || !supabase) return;
    const my = ++recReq.current;
    setTasks(null); setTaskErr("");
    const [from, to] = range(period);
    const db = supabase;
    (async () => {
      const res = await db.rpc("hub_person_tasks", { p_user: open.user_id, p_from: from, p_to: to });
      if (my !== recReq.current) return;
      const r = (res.data ?? {}) as { ok?: boolean; error?: string; tasks?: Task[] };
      if (res.error || !r.ok) { setTaskErr(res.error?.message ?? r.error ?? "Could not open the record."); setTasks([]); return; }
      setTasks(r.tasks ?? []);
    })();
  }, [open, period]);

  const sum = useMemo(() => people.reduce(
    (a, p) => ({ total: a.total + p.total, done: a.done + p.done, pending: a.pending + p.pending }),
    { total: 0, done: 0, pending: 0 }), [people]);

  if (hidden) return null;
  const periodLabel = PERIODS.find((p) => p.key === period)!.label.toLowerCase();
  const pendingList = (tasks ?? []).filter((t) => t.status === "open");
  const doneList = (tasks ?? []).filter((t) => t.status !== "open");

  return (
    <section aria-label="Team tasks" className="mt-4 rounded-card border border-line bg-surface p-3.5 sm:p-4 md:mt-5 dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-[14px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">
          <Users size={16} /> Team — tasks by person
        </h2>
        <span className="text-[12px] font-medium text-muted dark:text-[#a89f93]">
          {loading && !people.length ? "…" : `${sum.total} tasks · ${sum.done} done · ${sum.pending} pending`}
        </span>
        <Segmented className="w-full sm:ml-auto sm:w-auto" value={period} onChange={(v) => setPeriod(v as Period)} options={PERIODS} />
      </div>

      {err && <p className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-[12.5px] font-medium text-danger">{err}</p>}

      <div className="mt-3 grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,218px),1fr))]">
        {loading && !people.length
          ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[118px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)
          : people.map((p) => {
              const share = p.total ? Math.round((p.done / p.total) * 100) : 0;
              const waitDays = daysSince(p.oldest_open_at);
              return (
                <button key={p.user_id} type="button" onClick={() => setOpen(p)}
                  aria-label={`${p.name}: ${p.total} tasks, ${p.done} done, ${p.pending} pending`}
                  className="group flex min-w-0 flex-col rounded-card border border-line bg-canvas/60 p-3 text-left transition hover:border-ink/25 hover:shadow-soft dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-white/20">
                  <div className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                    <span className="ml-auto shrink-0 truncate text-[11px] font-semibold text-muted dark:text-[#a89f93]">
                      {!p.active ? "left" : (p.stage ? STAGE[p.stage] ?? p.stage : p.designation ?? "")}
                    </span>
                  </div>
                  <div className="mt-2 grid w-full grid-cols-3 gap-1 text-center">
                    {([["Total", p.total, "text-ink dark:text-[#f4f1ea]"],
                       ["Done", p.done, "text-[#2f7a3d] dark:text-[#8fd19b]"],
                       ["Pending", p.pending, p.pending ? "text-[#8a6218] dark:text-[#e0b77c]" : "text-muted dark:text-[#a89f93]"]] as const).map(([k, v, tone]) => (
                      <div key={k} className="rounded-xl2 bg-surface py-1.5 dark:bg-white/[0.04]">
                        <div className={`text-[19px] font-extrabold leading-none tabular-nums ${tone}`}>{v}</div>
                        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted dark:text-[#a89f93]">{k}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-amber-soft dark:bg-white/10" aria-hidden>
                    <span className="h-full bg-success" style={{ width: `${share}%` }} />
                  </div>
                  <div className="mt-1.5 w-full text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">
                    {p.pending === 0
                      ? (p.total ? "nothing pending" : `nothing given ${period === "all" ? "yet" : periodLabel}`)
                      : <>
                          {waitDays != null && p.pending > p.blocked && <>oldest waiting <b className={waitDays >= 3 ? "text-[#b4562f] dark:text-[#e0a183]" : "text-ink dark:text-[#e7e2d8]"}>{waitDays === 0 ? "today" : `${waitDays}d`}</b></>}
                          {p.blocked > 0 && <>{waitDays != null && p.pending > p.blocked ? " · " : ""}{p.blocked} waiting for the product</>}
                        </>}
                  </div>
                </button>
              );
            })}
      </div>
      {!loading && !people.length && !err && (
        <p className="mt-2 text-[12.5px] text-muted dark:text-[#a89f93]">Nobody holds Hub work yet.</p>
      )}

      {/* ---------------------------------------------------- his record */}
      <Sheet open={!!open} onClose={() => setOpen(null)}
        title={open?.name ?? ""}
        subtitle={open ? `${open.stage_label ?? open.designation ?? "Hub"} · ${periodLabel}` : ""}>
        {open && (
          <div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {([["Total", open.total], ["Done", open.done], ["Pending", open.pending]] as const).map(([k, v]) => (
                <div key={k} className="rounded-card border border-line py-2 dark:border-white/[0.08]">
                  <div className="text-[20px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{v}</div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted dark:text-[#a89f93]">{k}</div>
                </div>
              ))}
            </div>
            {period !== "all" && (
              <p className="mt-2 text-[11.5px] text-hint dark:text-[#8a8175]">
                Done {periodLabel}, and everything still with him now. {open.done_all_time} done in all.
              </p>
            )}

            {taskErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{taskErr}</p>}
            {tasks === null ? (
              <p className="py-8 text-center text-[13px] text-muted dark:text-[#a89f93]"><Loader2 size={15} className="mr-2 inline animate-spin" />Opening his record…</p>
            ) : (
              <>
                <h3 className="mt-4 flex items-center gap-1.5 text-[12.5px] font-bold uppercase tracking-wide text-[#8a6218] dark:text-[#e0b77c]">
                  <Clock size={13} /> Pending · {pendingList.length}
                </h3>
                {pendingList.length === 0
                  ? <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">Nothing with him right now.</p>
                  : <ul className="mt-1.5 divide-y divide-line rounded-card border border-line dark:divide-white/[0.06] dark:border-white/[0.08]">
                      {pendingList.map((t) => <TaskLine key={t.task_id} t={t} />)}
                    </ul>}

                <h3 className="mt-4 flex items-center gap-1.5 text-[12.5px] font-bold uppercase tracking-wide text-[#2f7a3d] dark:text-[#8fd19b]">
                  <CheckCircle2 size={13} /> Done · {doneList.length}
                </h3>
                {doneList.length === 0
                  ? <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">Nothing finished {period === "all" ? "yet" : periodLabel}.</p>
                  : <ul className="mt-1.5 divide-y divide-line rounded-card border border-line dark:divide-white/[0.06] dark:border-white/[0.08]">
                      {doneList.map((t) => <TaskLine key={t.task_id} t={t} />)}
                    </ul>}
                {doneList.length >= 300 && (
                  <p className="mt-1.5 text-[11.5px] text-hint dark:text-[#8a8175]">The newest 300 are shown — choose a shorter window to see further back.</p>
                )}
              </>
            )}
          </div>
        )}
      </Sheet>
    </section>
  );
}

/* One task on his record: what it was, when it came, when it went, his note. */
function TaskLine({ t }: { t: Task }) {
  const what = t.article_id
    ? <Link href={`/online/articles/${t.article_id}`} className="font-bold text-ink hover:underline dark:text-[#f4f1ea]">
        {t.article ?? t.code}{t.code && t.article ? <span className="ml-1.5 text-[11px] font-semibold text-muted dark:text-[#a89f93]">{t.code}</span> : null}
      </Link>
    : <span className="font-bold text-ink dark:text-[#f4f1ea]">{t.title}</span>;
  const open = t.status === "open";
  return (
    <li className="px-3 py-2.5 text-[12.5px]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 [overflow-wrap:anywhere]">{what}</span>
        {t.stage && <span className="text-[11px] font-semibold text-muted dark:text-[#a89f93]">{STAGE[t.stage] ?? t.stage}{t.attempt > 1 ? ` · redo ${t.attempt}` : ""}</span>}
        {!t.article_id && <span className="text-[11px] font-semibold text-muted dark:text-[#a89f93]">task</span>}
      </div>
      <div className="mt-0.5 text-[11.5px] text-muted dark:text-[#a89f93]">
        {open
          ? <>given {day(t.opened_at)} · with him <b className="text-ink dark:text-[#e7e2d8]">{t.held ?? "—"}</b></>
          : <>given {day(t.opened_at)} · {t.status === "returned" ? "sent back" : "done"} {day(t.done_at)} · took {t.held ?? "—"}</>}
      </div>
      {open && t.waits_for && (
        <div className="mt-0.5 text-[11.5px] font-semibold text-[#8a6218] dark:text-[#e0b77c]">waiting for {t.waits_for}&rsquo;s product — cannot be checked yet</div>
      )}
      {!open && t.note && (
        <div className="mt-0.5 text-[11.5px] leading-snug text-ink [overflow-wrap:anywhere] dark:text-[#e7e2d8]">&ldquo;{t.note}&rdquo;</div>
      )}
      {!open && t.on_behalf && (
        <div className="mt-0.5 text-[11px] font-semibold text-periwinkle-strong dark:text-periwinkle">recorded by {t.recorded_by ?? "the office"}, not submitted by him</div>
      )}
    </li>
  );
}
