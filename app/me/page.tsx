"use client";
/* The employee portal. One person, their own month, nothing else.
 *
 * WHAT IT IS FOR
 *   Somebody who works here signs in and wants three answers: have my days been
 *   marked correctly, what have I already taken as an advance, and what am I
 *   owed so far. That is the whole product.
 *
 * WHY IT SHOWS A RUNNING TOTAL
 *   The payable grows through the month rather than appearing at the end. Being
 *   able to watch it is the point — it turns payday from a figure handed down
 *   into one the person has been able to check all along, and a wrong day gets
 *   queried on the 3rd instead of argued about on the 30th.
 *
 * WHERE THE SECURITY IS
 *   Not here. Every figure comes from a my_* function that filters on
 *   auth.uid() inside Postgres. This page cannot ask for somebody else's data
 *   because there is no parameter to ask with — and if it could, the database
 *   would refuse. A filter written in a page is a filter that can be bypassed
 *   from the browser console.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, HandCoins, Wallet, Loader2, AlertTriangle, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import MyWork from "@/components/MyWork";
import MyPendingReturns from "@/components/MyPendingReturns";
import FirstAttemptDesk from "@/components/FirstAttemptDesk";
import HubSessionGuard from "@/components/HubSessionGuard";
import HubBell from "@/components/HubBell";
/* The Hub's phone rules (16px inputs so iPhones do not zoom, thumb-sized
   buttons, no sideways drift) apply here too — this is the page staff open on
   their phones. They are scoped to html.hub, switched on below. */
import "../online/hub-mobile.css";

type Me = { emp_id: string; name: string; designation: string | null; department: string | null; salary: number };
type Pay = {
  name: string; designation: string | null; salary: number;
  leave_days: number; absent_deduction: number;
  present: number; half: number; absent: number; paid_off: number;
  extra_days: number; counted_days: number; gross: number; advances: number;
  payable: number; is_paid: boolean;
  /* H284: extra days given, what was cut from the advance when paid, and what
     moved to next month. */
  given_days?: number; given_pay?: number; advance_cut?: number; carried?: number;
};
type Day = { day: number; status: string };
type Adv = { date: string; amount: number; note: string | null };
type Extra = { day: string; portion: number; reason: string };
/* 1.5 → "1½" */
const dayCount = (v: unknown) => {
  const n = Number(v) || 0;
  const w = Math.floor(n);
  if (Math.abs(n - w - 0.5) < 1e-9) return w ? `${w}½` : "½";
  return String(Math.round(n * 100) / 100);
};

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");

export default function MyPortal() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("hub");
    return () => html.classList.remove("hub");
  }, []);
  const router = useRouter();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [me, setMe] = useState<Me | null>(null);
  const [pay, setPay] = useState<Pay | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [advs, setAdvs] = useState<Adv[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  /* The calendar has to know about public holidays too.
     It only checked for Sundays, so 14 August — Independence Day, worked —
     showed as an ordinary "present" day while the figures above it said
     "days off you worked +1". The two disagreed on the same screen, and the
     calendar was the one that was wrong. */
  const [hols, setHols] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  /* null = the person has not picked a tab yet, so the portal opens on his
     main job: Delivery Under Review for whoever works that desk, My work for
     everyone else. Work first because it is the half that changes during the
     day; the wage figure has not moved since last night. */
  const [tab, setTab] = useState<"work" | "pay" | "returns" | "attempt" | null>(null);
  /* TWO TABS ARE NOT FOR EVERYONE.
     Each is one person's job and appears only for whoever holds its key:
     'returns.print' is Abdul Rehman's printed returns sheet, 'returns.rescue'
     is Abdullah's Delivery Under Review desk. They are separate keys on
     purpose — the two jobs are different, and neither man should inherit the
     other's screen. Neither permission opens a page of its own; the database
     functions behind the tabs are the only things they unlock, so a portal
     without them is exactly the portal it was before.
     Both are asked before the portal is shown, so it opens on the right tab
     rather than flicking from My work to the desk a moment later. */
  const [perms, setPerms] = useState<{ returns: boolean; rescue: boolean } | null>(null);
  const canReturns = perms?.returns === true;
  const canRescue = perms?.rescue === true;
  /* How many parcels are waiting on the desk — shown on its tab, so it is
     seen from the other tabs too. Reported by the desk itself. */
  const [rescueCount, setRescueCount] = useState<number | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) { setPerms({ returns: false, rescue: false }); return; }
    Promise.all([
      supabase.rpc("has_permission", { p_permission_code: "returns.print" }),
      supabase.rpc("has_permission", { p_permission_code: "returns.rescue" }),
    ]).then(([p, r]) => setPerms({ returns: p.data === true, rescue: r.data === true }))
      .catch(() => setPerms({ returns: false, rescue: false }));
  }, []);
  const shown = tab ?? (canRescue ? "attempt" : "work");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const [m, p, d, a, h, x] = await Promise.all([
      supabase.rpc("my_employee"),
      supabase.rpc("my_monthly_payable", { p_year: year, p_month: month }),
      supabase.rpc("my_attendance", { p_year: year, p_month: month }),
      supabase.rpc("my_advances", { p_year: year, p_month: month }),
      supabase.from("online_att_holidays").select("hdate,name"),
      supabase.rpc("my_extra_days", { p_year: year, p_month: month }),
    ]);
    /* Any failure is said. Only the first one was checked, so a failed pay
       figure showed Rs 0 — as if nothing had been earned this month. */
    const firstErr = m.error ?? p.error ?? d.error ?? a.error ?? h.error ?? x.error;
    if (firstErr) setErr(firstErr.message);
    setMe(((m.data as Me[]) ?? [])[0] ?? null);
    setPay(((p.data as Pay[]) ?? [])[0] ?? null);
    setDays((d.data as Day[]) ?? []);
    setAdvs((a.data as Adv[]) ?? []);
    setExtras((x.data as Extra[]) ?? []);
    setHols(new Set(((h.data as { hdate: string }[]) ?? []).map((x) => x.hdate)));
    setLoading(false);
  }, [year, month]);
  useEffect(() => { load(); }, [load]);

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const byDay = new Map(days.map((d) => [d.day, d.status]));
  const extraByDay = new Map(extras.map((x) => [Number(x.day.slice(8, 10)), Number(x.portion)]));
  const isCurrent = year === today.getFullYear() && month === today.getMonth() + 1;
  /* The gross comes from the database, not from salary ÷ 30 × days here.
     That local sum cannot know a rate changed mid-month, which is precisely how
     Hamza Khan's August was overstated by Rs 7,700. */
  const gross = Number(pay?.gross ?? 0);
  const given = Number(pay?.given_days ?? 0);
  /* What actually comes off: the amount chosen when the month was paid, or —
     before it is paid — the whole advance. */
  const advCut = Number(pay?.advance_cut ?? pay?.advances ?? 0);
  const carried = Number(pay?.carried ?? 0);
  const nextMonth = MONTHS[month === 12 ? 1 : month + 1];
  const extraLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[month].slice(0, 3)}`;

  if (loading || !perms) {
    return <div className="flex min-h-screen items-center justify-center bg-canvas dark:bg-[#17140f]">
      <Loader2 size={20} className="animate-spin text-muted" /></div>;
  }

  /* No link, no data. Said plainly rather than shown as an empty portal, which
     looks like a broken page rather than an unfinished setup step. */
  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6 dark:bg-[#17140f]">
        <div className="max-w-sm rounded-card border border-line bg-surface p-6 text-center dark:border-white/10 dark:bg-[#201c17]">
          <AlertTriangle size={22} className="mx-auto text-amber-600" />
          <div className="mt-3 text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Not linked yet</div>
          <p className="mt-1.5 text-[13px] text-muted dark:text-[#a89f93]">
            Your login is not attached to an employee record, so there is nothing to show.
            Ask whoever manages the department to link it.
          </p>
          {err && <p className="mt-2 text-[12px] text-red-700">{err}</p>}
          <button onClick={signOut} className="mt-4 rounded-full border border-line px-4 py-2 text-[13px] font-semibold dark:border-white/15 dark:text-white">
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="hub-clip min-h-screen bg-canvas pb-[calc(64px+env(safe-area-inset-bottom))] dark:bg-[#17140f]">
      {/* Staff sign in less often than the office and leave the tab open for
          days — the likeliest place for a sign-in to go stale unnoticed. */}
      <HubSessionGuard />

      {/* THE IDENTITY BAND.
          A wage slip opens by saying who it is for and what it is worth, and
          everything after that is the working. So the department, the person and
          the amount share one dark field at the top — the single bold thing on
          the page. Everything below stays light and ruled, which is what makes
          this read as a document rather than a wall of cards. */}
      <header className="bg-ink text-white dark:bg-[#221d17]">
        <div className="mx-auto max-w-5xl px-4 pb-7 pt-[calc(20px+env(safe-area-inset-top))] sm:px-6 sm:pb-9 sm:pt-7">

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-white/55">
                {me.department ?? "Employee"}
              </div>
              <h1 className="mt-1.5 truncate text-[26px] font-extrabold leading-none tracking-tight sm:text-[32px]">
                {me.name}
              </h1>
              <p className="mt-1.5 text-[13px] text-white/60">
                {me.designation ?? "—"} · {rs(me.salary)} a month
              </p>
            </div>
            {/* The bell sits on the dark band, where the person is already
                looking when the page opens. Work assigned to them is the one
                thing here that is time-sensitive; their wages are not. */}
            <div className="flex shrink-0 items-center gap-2">
              <HubBell dark size="lg" />
              <button onClick={signOut} aria-label="Sign out"
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                <LogOut size={17} />
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-white/55">
                {isCurrent ? `Earned up to ${today.getDate()} ${MONTHS[month]}` : `Payable for ${MONTHS[month]}`}
              </div>
              <div className="mt-1 text-[42px] font-extrabold leading-none tabular-nums tracking-tight sm:text-[54px]">
                {rs(pay?.payable ?? 0)}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {pay?.is_paid ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1.5 text-[12px] font-bold text-emerald-200">
                  <Wallet size={12} /> Paid
                </span>
              ) : (
                <span className="rounded-full border border-white/25 px-3 py-1.5 text-[12px] font-semibold text-white/70">
                  Not paid yet
                </span>
              )}
              <label className="sr-only" htmlFor="m">Month</label>
              <select id="m" value={month} onChange={(e) => setMonth(Number(e.target.value))}
                      className="h-10 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[12.5px] font-semibold text-white outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1} className="text-ink">{m}</option>)}
              </select>
              <label className="sr-only" htmlFor="y">Year</label>
              <select id="y" value={year} onChange={(e) => setYear(Number(e.target.value))}
                      className="h-10 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[12.5px] font-semibold text-white outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                {/* Built from TODAY's year, not the chosen one. Choosing last year
                    used to drop this year from the list, with no way back but a reload. */}
                {[today.getFullYear() - 1, today.getFullYear()].map((y) => <option key={y} value={y} className="text-ink">{y}</option>)}
              </select>
            </div>
          </div>
        </div>
      </header>

      {/* Two columns on a desktop, stacked on a phone. The order is the order
          somebody reads in: the money first, then the days behind it, then the
          evidence. On a wide screen the calendar sits beside the figures rather
          than a screen below them. */}
      {/* TABS, ONE PORTAL.
          A man opening this in the morning wants one of exactly two things:
          what have I been given to do, or what am I owed. Stacking them made a
          long scroll on a phone where the second half was never reached. Work
          is first because it is the half that changes during the day — and for
          Abdullah his work IS the Delivery Under Review desk, so that tab comes
          first and the portal opens on it.
          The same tabs on a phone and on a desktop — there is no third layout
          to keep in step. */}
      <div className="mx-auto -mt-4 max-w-5xl px-4 sm:px-6">
        {/* Two to a row on a phone. With four tabs a single row ran 170px past
            the edge of a 390px screen and the last two could not be reached;
            a lone last tab takes the whole width rather than sitting half-empty. */}
        <div role="tablist" aria-label="Your portal"
          className="mb-4 grid w-full grid-cols-2 gap-1 rounded-[24px] bg-panel p-1 [&>button:last-child:nth-child(odd)]:col-span-2 dark:bg-white/[0.06] sm:flex sm:w-max sm:rounded-full">
          {([...(canRescue ? [["attempt", "Delivery Under Review"] as const] : []),
             ["work", "My work"] as const, ["pay", "Attendance & pay"] as const,
             ...(canReturns ? [["returns", "Pending returns"] as const] : [])]).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={shown === key} onClick={() => setTab(key)}
              className={`h-11 min-w-0 flex-1 truncate rounded-full px-3 text-[13.5px] font-semibold transition sm:h-auto sm:flex-none sm:whitespace-nowrap sm:px-5 sm:py-2 sm:text-[13px] ${
                shown === key ? "bg-ink text-white shadow-soft dark:bg-white dark:text-[#141414]"
                              : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
              {/* The one long name gets a short form on a phone, where two tabs
                  share a row and it would otherwise be cut mid-word. The count
                  is what is waiting on the desk right now — red while there is
                  anything, so it is seen from the other tabs too. */}
              {key === "attempt"
                ? <>
                    <span className="sm:hidden">Under review</span><span className="hidden sm:inline">{label}</span>
                    {rescueCount != null && (
                      <span className={`ml-1.5 inline-block min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-bold leading-[18px] tabular-nums ${
                        rescueCount > 0 ? "bg-[#E5786B] text-white"
                        : shown === key ? "bg-white/20 dark:bg-black/10" : "bg-black/[0.06] dark:bg-white/10"}`}>
                        {rescueCount}
                      </span>
                    )}
                  </>
                : label}
            </button>
          ))}
        </div>

        {shown === "work" && <MyWork />}

        {shown === "returns" && canReturns && <MyPendingReturns />}

        {/* DELIVERY UNDER REVIEW — the whole section, as the office sees it
            under Hub → Logistics: the same component and the same pair of
            database functions, so the two lists cannot drift apart. It stays
            mounted behind the other tabs, so coming back to it keeps the
            attempt tab and the ticks he left it on. */}
        {canRescue && (
          <section aria-label="Delivery Under Review" className={shown === "attempt" ? "" : "hidden"}>
            <div className="px-1">
              <h2 className="text-[20px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea] sm:text-[22px]">
                Delivery Under Review
              </h2>
              <p className="mt-1 max-w-[70ch] text-[13px] leading-snug text-muted dark:text-[#a89f93]">
                Yesterday&rsquo;s and today&rsquo;s failed deliveries that PostEx or OwnEx still have under review,
                sorted by which attempt they are on, with the courier&rsquo;s own reason. Ring the customer, copy the
                tracking IDs into the courier&rsquo;s group, ring the rider — then press Re-attempt or Return and it
                moves to History.
              </p>
            </div>
            <FirstAttemptDesk onCount={setRescueCount} />
          </section>
        )}

        <div className={`grid gap-4 lg:grid-cols-[1fr_1.05fr] lg:items-start ${shown === "pay" ? "" : "hidden"}`}>

          <div className="space-y-4">

            <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
              <h2 className="border-b border-line px-4 py-3 text-[13px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea] sm:px-5">
                How this is worked out
              </h2>
              <dl className="text-[13px]">
                <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                  <dt className="text-muted dark:text-[#a89f93]">
                    Earned over {pay?.counted_days ?? 0} days
                    <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">
                      each day at that day&rsquo;s rate, over the days in the month
                    </span>
                    {given > 0 && (
                      <span className="mt-0.5 block text-[11.5px] font-semibold text-emerald-700">
                        includes {dayCount(given)} extra day{given > 1 ? "s" : ""} given (+{rs(pay?.given_pay)})
                      </span>
                    )}
                  </dt>
                  <dd className="shrink-0 font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{rs(gross)}</dd>
                </div>
                {advCut > 0 && (
                  <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                    <dt className="text-muted dark:text-[#a89f93]">
                      {carried > 0 ? "Advance cut from this month" : "Advances already taken"}
                    </dt>
                    <dd className="shrink-0 font-semibold tabular-nums text-amber-700">− {rs(advCut)}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-4 bg-panel px-4 py-3 dark:bg-white/[0.04] sm:px-5">
                  <dt className="font-bold text-ink dark:text-[#f4f1ea]">Net payable</dt>
                  <dd className="shrink-0 text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">
                    {rs(pay?.payable ?? 0)}
                  </dd>
                </div>
                {carried > 0 && (
                  <div className="flex items-baseline justify-between gap-4 border-t border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                    <dt className="text-muted dark:text-[#a89f93]">
                      Advance carried forward to {nextMonth}
                      <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">not cut this month — it comes off {nextMonth}&rsquo;s pay</span>
                    </dt>
                    <dd className="shrink-0 font-semibold tabular-nums text-amber-700">{rs(carried)}</dd>
                  </div>
                )}
              </dl>
            </section>

            {/* Zero rows are dropped. A line reading "Half days 0" is one the
                reader has to check and then discard. */}
            <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
              <h2 className="border-b border-line px-4 py-3 text-[13px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea] sm:px-5">
                The {pay?.counted_days ?? 0} days you are paid for
              </h2>
              <dl className="text-[13px]">
                {([
                  ["Days present", String(pay?.present ?? 0), "text-emerald-700", true],
                  ["Half days", String(pay?.half ?? 0), "text-amber-700", Number(pay?.half) > 0],
                  ["Approved leave — paid", String(pay?.leave_days ?? 0), "text-sky-700", Number(pay?.leave_days) > 0],
                  ["Absent — not counted", String(pay?.absent ?? 0), "text-red-700", Number(pay?.absent) > 0],
                  ["Sundays & holidays — paid", String(pay?.paid_off ?? 0), "text-ink dark:text-[#e7e2d8]", true],
                  ["Days off you worked", `+${pay?.extra_days ?? 0}`, "text-emerald-700", Number(pay?.extra_days) > 0],
                  ["Extra days given to you", `+${dayCount(given)}`, "text-emerald-700", given > 0],
                ] as [string, string, string, boolean][]).filter(([, , , show]) => show).map(([label, value, tone], i) => (
                  <div key={i} className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                    <dt className="text-muted dark:text-[#a89f93]">{label}</dt>
                    <dd className={`shrink-0 text-[14px] font-bold tabular-nums ${tone}`}>{value}</dd>
                  </div>
                ))}
                {/* Each extra day with its reason — the person sees why, not
                    just that a number went up. */}
                {extras.map((x) => (
                  <div key={x.day} className="flex items-baseline gap-3 border-b border-line bg-success-soft/40 px-4 py-2 text-[12.5px] dark:border-white/[0.06] dark:bg-white/[0.02] sm:px-5">
                    <dt className="flex shrink-0 gap-3">
                      <span className="w-[48px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{extraLabel(x.day)}</span>
                      <span className="font-semibold text-emerald-700">{Number(x.portion) === 1 ? "Full day" : "Half day"}</span>
                    </dt>
                    <dd className="min-w-0 flex-1 text-muted [overflow-wrap:anywhere] dark:text-[#a89f93]">{x.reason}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 bg-panel px-4 py-3 dark:bg-white/[0.04] sm:px-5">
                  <dt className="font-bold text-ink dark:text-[#f4f1ea]">Counted days</dt>
                  <dd className="shrink-0 text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">
                    {pay?.counted_days ?? 0}
                  </dd>
                </div>
              </dl>
            </section>

          </div>

          <div className="space-y-4">

            <section className="rounded-card border border-line bg-surface p-4 shadow-card dark:border-white/10 dark:bg-[#201c17] sm:p-5">
              <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold text-ink dark:text-[#f4f1ea]">
                <CalendarDays size={15} /> Your days in {MONTHS[month]}
              </h2>
              <div className="grid grid-cols-7 gap-1 text-center sm:gap-1.5">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <div key={i} className="pb-1 text-[10px] font-bold uppercase tracking-wider text-hint dark:text-[#8a8175]">{d}</div>
                ))}
                {Array.from({ length: firstDow }).map((_, i) => <div key={`b${i}`} />)}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const dnum = i + 1;
                  const st = byDay.get(dnum);
                  const iso = `${year}-${String(month).padStart(2, "0")}-${String(dnum).padStart(2, "0")}`;
                  const sunday = new Date(year, month - 1, dnum).getDay() === 0;
                  const holiday = hols.has(iso);
                  const off = sunday || holiday;
                  const workedOff = off && (st === "P" || st === "H" || st === "L");
                  const cls =
                    workedOff ? "bg-success-soft text-emerald-900 ring-2 ring-emerald-400"
                    : st === "P" ? "bg-success-soft text-emerald-800"
                    : st === "L" ? "bg-periwinkle-soft text-sky-800"
                    : st === "H" ? "bg-amber-soft text-amber-900"
                    : st === "A" ? "bg-salmon-soft text-red-800"
                    : off ? "bg-panel text-muted dark:bg-white/[0.06]"
                    : "text-hint dark:text-[#6f675d]";
                  const word = workedOff ? "worked" : st === "P" ? "present" : st === "H" ? "half"
                    : st === "L" ? "leave" : st === "A" ? "absent"
                    : holiday ? "holiday" : sunday ? "off" : "";
                  const ext = extraByDay.get(dnum);
                  return (
                    <div key={dnum} title={`${dnum} ${MONTHS[month]}${holiday ? " · public holiday" : ""} — ${word || "not marked"}${ext ? ` · ${ext === 1 ? "full" : "half"} extra day given` : ""}`}
                         className={`rounded-xl py-2 ${cls} ${ext ? "ring-2 ring-inset ring-emerald-500" : ""}`}>
                      <div className="text-[12.5px] font-bold tabular-nums leading-none">{dnum}</div>
                      <div className="mt-1 text-[8.5px] font-semibold uppercase leading-none tracking-wide opacity-75">{word}</div>
                      {ext ? <div className="mt-0.5 text-[8.5px] font-bold leading-none text-emerald-700">+{ext === 1 ? "1" : "½"}</div> : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
              <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea] sm:px-5">
                <HandCoins size={15} /> Advances taken
              </h2>
              {advs.length === 0 ? (
                <p className="px-4 py-5 text-[13px] text-muted dark:text-[#a89f93] sm:px-5">
                  You have not taken any advance in {MONTHS[month]}.
                </p>
              ) : (
                <dl className="text-[13px]">
                  {advs.map((a, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                      <dt className="min-w-0">
                        <span className="text-ink dark:text-[#e7e2d8]">{a.date}</span>
                        {a.note && <span className="ml-2 text-muted dark:text-[#a89f93]">{a.note}</span>}
                      </dt>
                      <dd className="shrink-0 font-semibold tabular-nums">{rs(a.amount)}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-4 bg-panel px-4 py-3 dark:bg-white/[0.04] sm:px-5">
                    <dt className="font-bold text-ink dark:text-[#f4f1ea]">Deducted this month</dt>
                    <dd className="shrink-0 font-extrabold tabular-nums text-amber-700">− {rs(advCut)}</dd>
                  </div>
                  {carried > 0 && (
                    <div className="flex items-baseline justify-between gap-4 border-t border-line px-4 py-2.5 dark:border-white/[0.06] sm:px-5">
                      <dt className="text-muted dark:text-[#a89f93]">Carried forward to {nextMonth}</dt>
                      <dd className="shrink-0 font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{rs(carried)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </section>

          </div>
        </div>

        <p className={`mt-5 px-1 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175] ${shown === "pay" ? "" : "hidden"}`}>
          Sundays and public holidays are paid. Working one adds a day, and an extra day
          given to you is paid the same way. An absent day is not counted, and it is the
          only thing that reduces what you earn. Advance not cut in a month moves to the
          next month as &ldquo;Advance carried forward&rdquo;.
          {isCurrent && " This month is still running, so the figure grows each day you are marked present."}
          {" "}Something look wrong? Speak to whoever marks attendance for your department.
        </p>
      </div>
    </div>
  );
}
