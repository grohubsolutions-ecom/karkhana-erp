"use client";
/* THE FS TRADERS KIT.
 *
 * WHY IT EXISTS
 *   The department is twenty-odd screens that are all the same shape: a title,
 *   a date range, four figures across the top, one table, one dialog. Written
 *   out longhand that is roughly two hundred lines per page of which a hundred
 *   and seventy are identical, and the first time a column header needs a
 *   different colour somebody edits twenty files and misses three.
 *
 *   So the shape lives here once. A page below is the part that is actually
 *   different: which table it reads and what the columns mean.
 *
 * WHAT IT IS NOT
 *   Not a design system and not a place for business logic. The cash book sum,
 *   the commission rules and the import guard belong to the pages and to the
 *   database. This file knows about layout and loading states.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RefreshCw, X, ChevronRight, type LucideIcon } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import RangeBar from "@/components/RangeBar";
import { PRESETS } from "@/lib/dateRange";

/* ── numbers & dates ─────────────────────────────────────────────────────── */

export type Row = Record<string, unknown>;

export const num = (v: unknown) => Number(v) || 0;
export const money = (v: unknown) => "Rs " + Math.round(num(v)).toLocaleString("en-PK");
/** Money that is allowed to be blank. A missing physical cash count is not zero. */
export const moneyOrDash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : money(v));
export const sum = (rows: Row[], k: string) => rows.reduce((t, r) => t + num(r[k]), 0);

/** 'YYYY-MM-DD' for the calendar day this Date falls on, IN THE LOCAL CALENDAR.
 *
 *  This used to be `d.toISOString().slice(0, 10)`, which converts to UTC first.
 *  Pakistan is UTC+5, so between local midnight and 5am every date in the
 *  department read as YESTERDAY: `today()` on the expense dialog defaulted a
 *  7pm-shift expense to the previous day, attendance for "today" marked
 *  yesterday, and the cash book's 399-day floor moved. Nothing errored and
 *  nothing looked wrong — the date box just quietly held the day before.
 *
 *  Every caller passes a Date built from local parts (`new Date()`, or a local
 *  midnight shifted with `setDate`), so local parts out is what each of them
 *  meant. The Non-cash screen had already hand-rolled this for itself; this is
 *  the same fix, in the one place it belongs. */
export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const today = () => iso(new Date());

/** 'YYYY-MM-DD' shifted by n days, from the STRING's own parts.
 *
 *  Date.UTC in, getUTC* out: no local-midnight Date is ever formed, so neither
 *  the timezone nor a DST shift can drop or duplicate a day. On a carried cash
 *  balance that would be a wrong number rather than a cosmetic glitch, which is
 *  why it is done this way and not with `setDate` on a local Date. */
export const addDays = (ds: string, n: number): string => {
  const [y, m, d] = ds.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};
export const text = (v: unknown, dash = "—") => (v === null || v === undefined || v === "" ? dash : String(v));

/** 'YYYY-MM' for the month a date falls in. Salary and summary screens key on this. */
export const monthKey = (d: Date | string = new Date()) => {
  const x = typeof d === "string" ? new Date(d + "T00:00:00") : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
};
export const monthBounds = (mk: string): [string, string] => {
  const [y, m] = mk.split("-").map(Number);
  return [`${mk}-01`, iso(new Date(y, m, 0))];
};
export const daysInMonth = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};
export const monthLabel = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};
/** The last n months, newest first, as 'YYYY-MM'. */
export const recentMonths = (n = 15) => {
  const out: string[] = [];
  const t = new Date();
  for (let i = 0; i < n; i++) out.push(monthKey(new Date(t.getFullYear(), t.getMonth() - i, 1)));
  return out;
};

/* ── shared types ────────────────────────────────────────────────────────── */

export type Branch = { id: number; name: string; code?: string; chain?: string; color?: string; active?: boolean; nimbus_name?: string | null; needs_review?: boolean; business?: string };
export type Employee = { id: number; name: string; branch_id: number | null; designation?: string; active?: boolean; monthly_salary?: number; pay_type?: string; hourly_rate?: number | null; phone?: string; repay_freq?: string | null; repay_amount?: number | null };

/* ── the constants the business runs on ──────────────────────────────────
 * Each of these is a number somebody discovered the hard way. They live here
 * rather than in the screen that uses them so there is exactly one place to
 * change them, and so a second screen cannot quietly disagree with the first.
 */

/** The acquirer's cut on a card sale. The bank credits NET; the till records
 *  GROSS. Reconciling one against the other without this reports ~1.28% of card
 *  turnover as permanently missing. */
export const CARD_RATE_PCT = 1.276;
export const cardExpected = (grossCardSale: number, ratePct = CARD_RATE_PCT) =>
  grossCardSale * (1 - ratePct / 100);

/** Matching tolerance for a card settlement: Rs 2, or 0.5% of the expected
 *  figure, whichever is larger. Rs 2 because rounding; 0.5% because a big
 *  shop-day's rounding is bigger. */
export const crTol = (expected: number) => Math.max(2, Math.abs(expected) * 0.005);

/** A shop-day still short after this many days is filled from the unmatched
 *  pool rather than reported as a shortage — by then the money has landed,
 *  it just never got tied to a day. */
export const CR_AGE_DAYS = 3;

/** Commission bonus, ported verbatim. `total` is RUPEES, never a count. */
export type CommCfg = { bonus_mode?: string; bonus_basis?: string; bonus_slab?: number; bonus_per_slab?: number };
export function commBonus(total: number, cfg: CommCfg): number {
  const slab = num(cfg.bonus_slab) || 5000;
  const per = num(cfg.bonus_per_slab) || 50;
  /* 'exact' pays only on an exact multiple of the slab. It looks like a bug
     and is not — it is a rule some shops run, and floor() would overpay them
     on every receipt that lands between slabs. */
  if (cfg.bonus_mode === "exact") return total > 0 && total % slab === 0 ? (total / slab) * per : 0;
  return Math.floor(total / slab) * per;
}

/** Head Office is a branch like any other in the data; it is only the UI that
 *  separates it, because the people who run it are a different team. */
export const isHeadOffice = (b?: Branch) => (b?.chain ?? "").toLowerCase().includes("head office");

/** Only 'hourly' is hourly. Everyone else is on a flat monthly salary — there
 *  is no third pay type in the retail business, whatever the column allows. */
export const isHourly = (e?: Employee | null) => !!e && e.pay_type === "hourly";

/** Hours between two "HH:MM" strings, crossing midnight if the shift does.
 *  Either side missing means no hours: a person clocked in and never out has
 *  not worked an unknown number of hours, they have an incomplete record, and
 *  guessing one would put money on it. */
export const attHours = (tin?: string | null, tout?: string | null): number => {
  if (!tin || !tout) return 0;
  const p = (s: string) => { const a = String(s).split(":"); return (+a[0] || 0) * 60 + (+a[1] || 0); };
  let d = p(tout) - p(tin);
  if (d < 0) d += 1440;
  return d / 60;
};

/** Sunday is an automatic paid holiday across the shops — it is never marked,
 *  and a screen that asks for it is asking for noise. */
export const isSunday = (ds: string) => new Date(ds + "T00:00:00").getDay() === 0;

/* ── the upload-log unit key ──────────────────────────────────────────────
 * retail_upload_log records that a shop-day HAS been uploaded, and the
 * dashboard reports the gaps. Which means the key has to match the shape of
 * the FILE, not the shape of the branch table.
 *
 * Top Shop exports as ONE combined all-stores file. Six branches, one upload.
 * Key it per branch and a single missing file is reported as six missing
 * shop-days, and marking one done leaves five nagging — a reminder nobody
 * trusts after the first week. So all Top Shop branches share the unit
 * "topshop", and each Fashion Collection shop, which exports on its own, is
 * "b<id>".
 *
 * This is the old app's convention, kept verbatim so the migrated upload_log
 * rows still line up. Changing it silently orphans three years of them.
 */
export const unitForBranch = (b?: Branch | null): string | null => {
  if (!b) return null;
  return (b.chain ?? "") === "Topshop" ? "topshop" : "b" + b.id;
};

/** The label to show beside a unit key in the reminder. */
export const unitLabel = (unit: string, branches: Branch[]): string => {
  if (unit === "topshop") return "Top Shop (all branches)";
  const b = branches.find((x) => "b" + x.id === unit);
  return b?.name ?? unit;
};

/* ── data hooks ──────────────────────────────────────────────────────────── */

/** Branches, once per page. Every FS screen needs them to name a row. */
export function useBranches() {
  const [branches, setBranches] = useState<Branch[]>([]);
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.from("retail_branches").select("id,name,code,chain,color,active").order("name")
      .then(({ data }) => setBranches((data as Branch[]) ?? []));
  }, []);
  const name = useCallback(
    (id: unknown) => branches.find((b) => b.id === Number(id))?.name ?? "—",
    [branches]
  );
  return { branches, branchName: name };
}

/** Employees, optionally scoped to head office or to the shops.
 *
 *  `repay_freq` / `repay_amount` are selected because the repayment screen
 *  pre-fills the deduction from them, and a screen that has to re-query for two
 *  columns it could have asked for the first time is a screen that will forget.
 */
export function useEmployees(scope: "all" | "shops" | "ho" = "all") {
  const { branches } = useBranches();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.from("retail_employees")
      .select("id,name,branch_id,designation,active,monthly_salary,pay_type,hourly_rate,phone,repay_freq,repay_amount")
      .order("name")
      .then(({ data }) => setEmployees((data as Employee[]) ?? []));
  }, [tick]);

  const scoped = useMemo(() => {
    if (scope === "all") return employees;
    const hoIds = new Set(branches.filter(isHeadOffice).map((b) => b.id));
    return employees.filter((e) => (scope === "ho" ? hoIds.has(Number(e.branch_id)) : !hoIds.has(Number(e.branch_id))));
  }, [employees, branches, scope]);

  /* Most screens want only people still working here. Leavers keep their rows
     — their history has to stay readable — but a leaver in a payroll total or
     an attendance list is a wrong number and a confusing screen. Callers that
     genuinely want everyone (the Employees admin screen) take `allEmployees`. */
  const active = useMemo(() => scoped.filter((e) => e.active !== false), [scoped]);

  return { employees: active, allEmployees: scoped, everyEmployee: employees, branches,
           reloadEmployees: () => setTick((t) => t + 1) };
}

/* ── paging ──────────────────────────────────────────────────────────────
 * PostgREST caps a response at 1000 rows. A `.limit(5000)` does not raise
 * that — it silently returns what it returns, and a sales total that is quietly
 * a lower bound is worse than one that errors, because nobody checks a number
 * that looks plausible. Every screen that reads sale lines pages instead.
 */
export async function fetchAll<T = Row>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  step = 1000,
  hardCap = 200000
): Promise<{ rows: T[]; error: string; truncated: boolean }> {
  const out: T[] = [];
  for (let from = 0; from < hardCap; from += step) {
    const { data, error } = await build(from, from + step - 1);
    if (error) return { rows: out, error: error.message, truncated: false };
    const got = (data as T[]) ?? [];
    out.push(...got);
    if (got.length < step) return { rows: out, error: "", truncated: false };
  }
  /* THE CEILING IS REAL AND IT HAS TO SAY SO.
     This loop used to stop at 200,000 rows and return as though it had read
     everything. The department is already at roughly 150,000 sale lines for "all
     time", so the ceiling is close enough to be crossed — and a screen that then
     prints "all 200,000 are in every total on this page" is stating something
     false about money. `truncated` is what lets a caller say "this is a lower
     bound" instead. */
  return { rows: out, error: "", truncated: true };
}

/* ── KEYSET PAGING — THE FIX FOR THE STATEMENT TIMEOUTS ──────────────────────
 *
 * `fetchAll` above pages with PostgREST's `.range(lo, hi)`, which is
 * LIMIT/OFFSET. That is fine for a few thousand rows and quietly catastrophic
 * after that, because OFFSET does not skip rows — it READS them and throws them
 * away. Measured on the live database at 58,303 sale lines:
 *
 *     one page at offset 55,000   307 ms   (scans and discards 56,000 rows)
 *     the same page by key          8 ms   (index range scan, 1,000 rows read)
 *
 * and the cost of reading a whole range is the SUM of every page, so it grows
 * with the square of the table: about 1.7 million row visits to return 58,000
 * rows. Under real load those 307 ms became 7,563 ms — against the 8-second
 * statement timeout Supabase sets on the `authenticated` role. That is the
 * "canceling statement due to statement timeout" the shops started seeing, and
 * why it got worse every single day.
 *
 * Keyset paging asks for "the next 1,000 rows after id N" instead of "rows
 * 55,000 to 56,000". The primary key takes it straight to the right place, so
 * every page costs the same as the first one however large the table gets.
 *
 * WHAT A CALLER MUST DO
 *   Order by `id` ascending ONLY, and apply no other sort. A keyset cursor is
 *   the sort order — ordering by something else and then paging on `id` is not
 *   keyset paging, it is a different query per page. Sort the finished rows in
 *   JavaScript if the screen needs a different order; by then they are in memory
 *   and it is free.
 *
 * WHY THIS IS ALSO SAFER THAN WHAT IT REPLACES
 *   OFFSET paging over a table that is being appended to can return a row twice
 *   or skip it entirely — the offsets shift under you mid-read. On the
 *   commissions screen those rows ARE somebody's payout. A cursor on a unique,
 *   ever-increasing id cannot do either.
 */
export async function fetchKeyset<T = Row>(
  build: (afterId: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  step = 1000,
  hardCap = 500000
): Promise<{ rows: T[]; error: string; truncated: boolean }> {
  const out: T[] = [];
  let after = 0;
  while (out.length < hardCap) {
    const { data, error } = await build(after);
    if (error) return { rows: out, error: error.message, truncated: false };
    const got = (data as T[]) ?? [];
    out.push(...got);
    if (got.length < step) return { rows: out, error: "", truncated: false };
    /* The cursor is the last row's id, so the caller MUST select `id`. A page
       that comes back without one would loop for ever on the same rows, so this
       stops instead and says the read is incomplete. */
    const last = got[got.length - 1] as unknown as { id?: number };
    const nextId = Number(last?.id);
    if (!Number.isFinite(nextId) || nextId <= after) {
      return { rows: out, error: "", truncated: true };
    }
    after = nextId;
  }
  return { rows: out, error: "", truncated: true };
}

type QueryBuilder = { select: (cols: string) => unknown };

/** The fetch-with-loading-and-error dance every screen repeats.
 *  `build` gets the client and returns a finished PostgREST query. */
export function useRetailQuery<T = Row>(
  build: (db: NonNullable<typeof supabase>) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  deps: unknown[]
) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    (async () => {
      const { data, error } = await build(supabase!);
      if (!live) return;
      if (error) setErr(error.message);
      setRows((data as T[]) ?? []);
      setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { rows, loading, err, reload: () => setTick((t) => t + 1), setRows };
}

/* ── layout ──────────────────────────────────────────────────────────────── */

/* THE HEADER EVERY FS SCREEN USES.
 *
 * Phone changes, Oct 2026 — the markup from 768px up is byte-for-byte what it
 * was, so the computer site is untouched:
 *
 *   · The title block is `hidden md:block`. The sticky bar at the top of the
 *     phone already names the screen; printing "Card Reconciliation" again
 *     costs a fifth of a 390×660 display to say nothing new.
 *   · The buttons become a full-width row that wraps and shares the width
 *     evenly. Three 100px buttons squeezed beside a title is three mis-taps.
 *   · "Refresh" loses its word and keeps its arrow on a phone — an icon that
 *     everybody already recognises, and 60px back.
 */
export function PageHeader({ title, subtitle, onRefresh, loading, children }: {
  title: string; subtitle?: string; onRefresh?: () => void; loading?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="hidden min-w-0 md:block">
        <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-md:w-full max-md:[&>*]:min-w-[46%] max-md:[&>*]:flex-1">
        {children}
        {onRefresh && (
          <button onClick={onRefresh} aria-label="Refresh" className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> <span className="max-md:hidden">Refresh</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** The page padding. `rt-page` carries the bottom clearance that keeps the last
 *  row of every list above the phone tab bar; `rt-clip` is what the phone CSS
 *  hangs no-sideways-scroll and minimum-tap-target off. Both are inert above
 *  767.98px and inert outside this department. */
export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="rt-page rt-clip px-4 py-5 sm:px-6 sm:py-6 md:px-10 md:py-8">{children}</div>;
}

export type Stat = { label: string; value: string; Icon: LucideIcon; bg?: string };

export function StatCards({ stats, loading }: { stats: Stat[]; loading?: boolean }) {
  const bgs = ["bg-salmon-soft", "bg-success-soft", "bg-periwinkle-soft", "bg-amber-soft"];
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map(({ label, value, Icon, bg }, i) => (
        <div key={i} className={`rounded-card border border-line ${bg ?? bgs[i % 4]} p-4 dark:border-white/[0.06] dark:bg-[#201c17]`}>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white dark:bg-white dark:text-[#141414]"><Icon size={16} /></span>
          <div className="mt-3 text-[20px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
          <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{label}</div>
        </div>
      ))}
    </div>
  );
}

/* TABS.
 *
 * A pill row on a computer, unchanged. On a phone, FOUR OR MORE tabs become a
 * native select. Six pills at 390px is a 450px strip that scrolls sideways
 * inside the page — and a sideways scroll with no visible edge is a tab nobody
 * ever finds. Bank Statements has six; Cards has four. Three or fewer still fit
 * across a 390px screen, so those stay pills and stay one tap.
 *
 * The native control is deliberate, not a styled dropdown: it opens as the
 * phone's own wheel, which is the fastest widget on the device and the only one
 * that is already the right size for a thumb.
 */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { key: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  const phone = useIsPhone();
  if (phone && tabs.length > 3) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label="View"
        className="mt-5 w-full rounded-xl2 border border-line bg-surface px-3.5 py-3 font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
        {tabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
    );
  }
  return (
    <div className="mt-5 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.05] max-md:w-full">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition max-md:flex-1 max-md:py-2.5 ${value === t.key ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export type Col<T> = {
  head: string;
  /** Right-aligns and tabular-nums the cell. Every money and count column wants this. */
  right?: boolean;
  bold?: boolean;
  muted?: boolean;
  cell: (row: T, index: number) => React.ReactNode;
  /** WHERE THIS COLUMN GOES ON A PHONE CARD.
   *  Left off, the card is worked out automatically (see cardPlan below) and
   *  every existing screen gets a usable card without being edited. Set it when
   *  the automatic guess picks the wrong column — it is a hint, not a rewrite. */
  phone?: "title" | "meta" | "lead" | "pair" | "hide";
};

/* HOW A TABLE BECOMES A CARD WITHOUT THE SCREEN BEING REWRITTEN.
 *
 * There are 22 tables in this department, the widest 1,180px. On a 390px phone
 * a 1,180px table is not a table — it is eight columns you drag past looking for
 * the one you wanted, and the row you were reading has scrolled out of sight by
 * the time you get there.
 *
 * Every one of those tables already declares what its columns ARE: a heading, an
 * alignment, whether it is bold. That is enough to lay the same row out as a
 * card, so the conversion happens here, once, instead of in 22 files:
 *
 *   title  what the row IS       → first plain column (a date, a shop, a name)
 *   meta   the second identifier → next plain column, small and grey underneath
 *   lead   the one big figure    → the last bold right-aligned column, which in
 *                                  a money table is reliably the total
 *   pairs  everything else       → labelled, two to a line, under a rule
 *
 * A screen that wants different can say so per column with `phone`, or hand over
 * its own card with the `card` prop. Nothing about the table changes above
 * 767.98px — same markup, same widths, same `minWidth`.
 */
function cardPlan<T>(cols: Col<T>[]) {
  const live = cols.filter((c) => c.phone !== "hide");
  const pick = (k: NonNullable<Col<T>["phone"]>) => live.find((c) => c.phone === k);

  const title = pick("title") ?? live.find((c) => !c.right && !c.phone);
  const lead = pick("lead")
    ?? [...live].reverse().find((c) => c.right && c.bold && c !== title)
    ?? [...live].reverse().find((c) => c.right && c !== title);
  const meta = pick("meta") ?? live.find((c) => !c.right && !c.phone && c !== title);

  const pairs = live.filter((c) => c !== title && c !== meta && c !== lead);
  return { title, meta, lead, pairs };
}

/** The table shell, with the four states every screen has to handle:
 *  skeleton while loading, the error, the empty case, and rows — as a table on a
 *  computer, as cards on a phone. */
export function DataTable<T>({ cols, rows, loading, err, empty, minWidth = 640, footer, card, onRowTap }: {
  cols: Col<T>[]; rows: T[]; loading?: boolean; err?: string; empty?: string; minWidth?: number;
  footer?: React.ReactNode;
  /** Override the automatic card for this table. */
  card?: (row: T, index: number) => React.ReactNode;
  /** Makes each card tappable — for a row that has a detail worth opening. */
  onRowTap?: (row: T, index: number) => void;
}) {
  const phone = useIsPhone();

  if (phone) {
    const plan = cardPlan(cols);
    return (
      <>
        <CardList
          rows={rows} loading={loading} err={err} empty={empty}
          /* The totals row still matters most on the smallest screen, so it is
             kept — rendered in a table of its own, because a <tr> is only valid
             inside one. */
          /* `rt-scroll-x`, not `overflow-hidden`: a footer row with six money
             cells is wider than 390px, and a clipped total is a total that is
             silently missing its last column — which on these screens is
             reliably the one somebody opened the page for. It scrolls inside its
             own box instead, and never drags the page sideways. */
          footer={footer && rows.length > 0 ? (
            <div className="rt-scroll-x rounded-card border border-line bg-panel/50 dark:border-white/[0.06] dark:bg-white/[0.04]">
              <table className="w-full text-left text-[13px]"><tfoot>{footer}</tfoot></table>
            </div>
          ) : undefined}
          render={(r, i) =>
            card ? <div key={i}>{card(r, i)}</div> : (
              <RowCard
                key={i}
                title={plan.title ? plan.title.cell(r, i) : `Row ${i + 1}`}
                meta={plan.meta ? plan.meta.cell(r, i) : undefined}
                right={plan.lead ? plan.lead.cell(r, i) : undefined}
                pairs={plan.pairs.map((c) => ({ k: c.head, v: c.cell(r, i) }))}
                onTap={onRowTap ? () => onRowTap(r, i) : undefined}
              />
            )
          }
        />
      </>
    );
  }

  return (
    <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]" style={{ minWidth }}>
          <thead>
            <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
              {cols.map((c, i) => (
                <th key={i} className={`px-4 py-3 font-semibold ${c.right ? "text-right" : ""}`}>{c.head}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}><td colSpan={cols.length} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>
              ))
            ) : err ? (
              <tr><td colSpan={cols.length} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={cols.length} className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">{empty ?? "Nothing here yet."}</td></tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                  {cols.map((c, j) => (
                    <td key={j} className={`px-4 py-3 ${c.right ? "text-right tabular-nums" : ""} ${c.bold ? "font-semibold" : ""} ${c.muted ? "text-muted dark:text-[#a89f93]" : ""}`}>
                      {c.cell(r, i)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && !loading && rows.length > 0 && (
            <tfoot className="border-t-2 border-line dark:border-white/[0.08]">{footer}</tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/* ── small pieces ────────────────────────────────────────────────────────── */

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn" | "info"; children: React.ReactNode }) {
  const cls = {
    neutral: "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]",
    good: "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success",
    bad: "bg-danger-soft text-danger dark:bg-white/[0.08] dark:text-danger",
    warn: "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber",
    info: "bg-periwinkle-soft text-periwinkle-strong dark:bg-white/[0.08] dark:text-periwinkle",
  }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${cls}`}>{children}</span>;
}

/** A difference that is meant to be zero. Red when it is not, because on the
 *  cash book a non-zero difference is the only number anybody is looking for. */
export function Diff({ value }: { value: number }) {
  if (Math.abs(value) < 1) return <Pill tone="good">Clear</Pill>;
  return <Pill tone="bad">{value > 0 ? "+" : ""}{money(value)}</Pill>;
}

export function Select({ value, onChange, children, className = "" }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode; className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink outline-none transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white ${className}`}>
      {children}
    </select>
  );
}

export function BranchPicker({ branches, value, onChange, allLabel = "All branches" }: {
  branches: Branch[]; value: string; onChange: (v: string) => void; allLabel?: string;
}) {
  return (
    <Select value={value} onChange={onChange}>
      <option value="">{allLabel}</option>
      {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
    </Select>
  );
}

export function MonthPicker({ value, onChange, months = recentMonths() }: {
  value: string; onChange: (v: string) => void; months?: string[];
}) {
  return (
    <Select value={value} onChange={onChange}>
      {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
    </Select>
  );
}

export function PreviewNote() {
  if (isSupabaseConfigured) return null;
  return <p className="mt-4 text-center text-[12px] text-hint dark:text-[#8a8175]">Preview build · connect Supabase to load this screen.</p>;
}

/** A note explaining where a figure comes from. The old app made every number
 *  tappable for this reason: a total nobody can explain is a total nobody
 *  trusts, and the first question about any of these screens is "from where?". */
export function SourceNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-xl2 border border-line bg-panel/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[#a89f93]">
      {children}
    </p>
  );
}

export type { QueryBuilder };


/* ═══════════════════════════════════════════════════════════════════════════
   PHONE
   ───────────────────────────────────────────────────────────────────────────
   Added Oct 2026, mirroring what was done for the Hub in September. The rule
   is the owner's and it is not negotiable: THE COMPUTER SITE STAYS AS IT WAS.
   Everything below either only fires below 768px, or renders exactly what it
   rendered before at desktop width.

   Three breakpoints, because a phone held sideways is neither a phone nor a
   computer:
     < 768px   phone        document scroll, bottom tab bar, no sidebar
     768–1023  handheld wide sidebar is a drawer behind an arrow tab
     ≥ 1024px  computer     the original permanent 248px sidebar, untouched
   ═══════════════════════════════════════════════════════════════════════════ */

/* useSyncExternalStore, not a useEffect + useState pair. The effect version
   renders once at the server's guess of the width and then corrects itself,
   which on a phone is a visible flash of the desktop layout on every
   navigation. This reads the real width on the first client render. */
function mediaStore(query: string) {
  let mql: MediaQueryList | null = null;
  const get = () => {
    if (typeof window === "undefined") return false;
    mql = mql ?? window.matchMedia(query);
    return mql.matches;
  };
  return {
    subscribe(cb: () => void) {
      if (typeof window === "undefined") return () => {};
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    get,
  };
}
const PHONE = mediaStore("(max-width: 767.98px)");
const HANDHELD_WIDE = mediaStore("(min-width: 768px) and (max-width: 1023.98px)");

/** True below 768px. Server render returns false, so the computer layout is
 *  what gets sent — a phone corrects on its first paint, before anything is
 *  interactive. */
export const useIsPhone = () =>
  useSyncExternalStore(PHONE.subscribe, PHONE.get, () => false);

/** 768–1023px: tablet, or a phone held sideways. The sidebar is a drawer. */
export const useIsHandheldWide = () =>
  useSyncExternalStore(HANDHELD_WIDE.subscribe, HANDHELD_WIDE.get, () => false);

/* ── page frame ─────────────────────────────────────────────────────────── */

/** The page title. HIDDEN ON A PHONE — the sticky header already names the
 *  screen, and repeating it costs a quarter of a small display. */
export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="hidden min-w-0 md:block">
      <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</h1>
      {subtitle && <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">{subtitle}</p>}
    </div>
  );
}

/** Buttons for a screen. On a phone they become a full-width row that wraps,
 *  because three buttons crammed beside a title is three mis-taps. */
export function PageActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1">{children}</div>;
}

/** Header row: title on the left, actions on the right; stacked on a phone. */
export function PageHead({ title, subtitle, children, onRefresh, loading }: {
  title: string; subtitle?: string; children?: React.ReactNode;
  onRefresh?: () => void; loading?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <PageTitle title={title} subtitle={subtitle} />
      {(children || onRefresh) && (
        <PageActions>
          {children}
          {onRefresh && (
            <button onClick={onRefresh} aria-label="Refresh"
              className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              <span className="max-sm:hidden">Refresh</span>
            </button>
          )}
        </PageActions>
      )}
    </div>
  );
}

/* ── tabs ───────────────────────────────────────────────────────────────── */

/** Tabs. A pill row on a computer; on a phone, a native select once there are
 *  more than three, because four pills at 390px is a sideways scroll nobody
 *  discovers. Three or fewer still fit, so they stay pills. */
export function Segmented<T extends string>({ tabs, value, onChange, label = "View" }: {
  tabs: { key: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string;
}) {
  const phone = useIsPhone();
  if (phone && tabs.length > 3) {
    return (
      <label className="mt-4 block">
        <span className="sr-only">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value as T)}
          className="w-full rounded-xl2 border border-line bg-surface px-3.5 py-3 font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          {tabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div className="mt-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.05]">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-[12.5px] font-semibold transition ${value === t.key ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── date range ─────────────────────────────────────────────────────────── */

/** The range picker. The shared RangeBar lays nine presets in a row about
 *  770px wide — on a phone that is the single worst sideways-scroll offender
 *  on the department. Phone gets a native select; the computer gets the
 *  unchanged RangeBar, imported by the page as before.
 *
 *  `right` is for extra filters (a branch picker), which on a phone stack
 *  underneath at full width instead of trailing off the edge. */
export function RangeSelect({ preset, setPreset, cf, setCf, ct, setCt, presets, right }: {
  preset: string; setPreset: (v: string) => void;
  cf: string; setCf: (v: string) => void;
  ct: string; setCt: (v: string) => void;
  presets: { key: string; label: string }[];
  right?: React.ReactNode;
}) {
  return (
    <div className="mt-4 space-y-2">
      <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range"
        className="w-full rounded-xl2 border border-line bg-surface px-3.5 py-3 font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      {preset === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <input type="date" value={cf} onChange={(e) => setCf(e.target.value)} aria-label="From"
            className="w-full rounded-xl2 border border-line bg-surface px-3 py-2.5 text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
          <input type="date" value={ct} onChange={(e) => setCt(e.target.value)} aria-label="To"
            className="w-full rounded-xl2 border border-line bg-surface px-3 py-2.5 text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
        </div>
      )}
      {right && <div className="flex flex-col gap-2 [&>*]:w-full">{right}</div>}
    </div>
  );
}

/** THE ONE RANGE CONTROL FS TRADERS USES.
 *
 *  Identical props to the shared `RangeBar`, so a screen swaps one import and
 *  one tag name and is done. Above 767.98px it renders the shared RangeBar
 *  itself — the same component, untouched, so the computer site is unchanged and
 *  a change the Hub makes to RangeBar still reaches these screens. Below it,
 *  `RangeSelect`, because the nine presets lay out as a 770px strip and that one
 *  control was the worst sideways-scroll offender in the department.
 *
 *  RangeBar is a shared file. It is IMPORTED here, never edited. */
export function RetailRange({ preset, setPreset, cf, setCf, ct, setCt, presets, right }: {
  preset: string; setPreset: (v: string) => void;
  cf: string; setCf: (v: string) => void;
  ct: string; setCt: (v: string) => void;
  presets?: { key: string; label: string }[];
  right?: React.ReactNode;
}) {
  const phone = useIsPhone();
  if (phone) {
    return <RangeSelect preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
      presets={presets ?? PRESETS} right={right} />;
  }
  return <RangeBar preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
    presets={presets} right={right} />;
}

/* ── phone lists ────────────────────────────────────────────────────────── */

/** One row of a phone list. A table with eight columns at 390px is unreadable
 *  however much it scrolls, so the same row becomes a card: the two things
 *  that identify it on the top line, the money on the right, and the rest as
 *  labelled pairs underneath. Tapping it opens the full row in a Sheet. */
export function RowCard({ title, meta, right, pairs, pills, onTap, tone }: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  pairs?: { k: string; v: React.ReactNode }[];
  pills?: React.ReactNode;
  onTap?: () => void;
  tone?: "plain" | "good" | "bad" | "warn";
}) {
  /* THE DARK VARIANT IS NOT OPTIONAL HERE.
     The card's own class list contains `dark:border-white/[0.06]`, which Tailwind
     compiles to `.dark\:border-…:is(.dark *)` — specificity (0,2,0). A plain
     `border-l-success` is (0,1,0), so in dark mode the grey border wins and the
     coloured edge silently does not render. On this component that edge is the
     whole signal: it is what makes a non-zero cash difference or an unpaid
     salary visible without reading. Naming the dark variant explicitly puts both
     rules at the same specificity, and this one comes later in the sheet. */
  const edge = tone === "good" ? "border-l-success dark:border-l-success"
    : tone === "bad" ? "border-l-danger dark:border-l-danger"
    : tone === "warn" ? "border-l-amber-strong dark:border-l-amber-strong" : "";
  const Tag = onTap ? "button" : "div";
  return (
    <Tag
      {...(onTap ? { onClick: onTap, type: "button" as const } : {})}
      className={`w-full rounded-card border border-line bg-surface p-3.5 text-left dark:border-white/[0.06] dark:bg-[#201c17] ${edge ? "border-l-[5px] " + edge : ""} ${onTap ? "active:bg-panel/70 dark:active:bg-white/[0.05]" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{title}</div>
          {meta && <div className="mt-0.5 truncate text-[12.5px] text-muted dark:text-[#a89f93]">{meta}</div>}
        </div>
        {right && <div className="flex-none text-right text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{right}</div>}
        {onTap && <ChevronRight size={16} className="mt-0.5 flex-none text-hint" />}
      </div>
      {pills && <div className="mt-2 flex flex-wrap gap-1.5">{pills}</div>}
      {pairs && pairs.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line pt-2.5 dark:border-white/[0.06]">
          {pairs.map((p, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">{p.k}</dt>
              <dd className="truncate text-[13px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{p.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Tag>
  );
}

/** The phone list shell — skeletons, error, empty, rows. Same four states as
 *  DataTable so a page can hand both the same data and they cannot disagree. */
export function CardList<T>({ rows, render, loading, err, empty, footer }: {
  rows: T[]; render: (row: T, i: number) => React.ReactNode;
  loading?: boolean; err?: string; empty?: string; footer?: React.ReactNode;
}) {
  if (loading) return (
    <div className="mt-4 space-y-2">
      {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[76px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)}
    </div>
  );
  if (err) return <p className="mt-4 rounded-card border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger dark:bg-danger/10">Couldn&apos;t load: {err}</p>;
  if (!rows.length) return <p className="mt-4 rounded-card border border-line bg-surface p-8 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">{empty ?? "Nothing here yet."}</p>;
  return (
    <div className="mt-4 space-y-2">
      {rows.map((r, i) => render(r, i))}
      {footer}
    </div>
  );
}

/* ── sheet ──────────────────────────────────────────────────────────────── */

/** A bottom sheet on a phone, a centred dialog on a computer. Used for a row's
 *  full detail — the columns a card had to leave out. */
export function Sheet({ open, onClose, title, subtitle, children, wide }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`max-h-[88dvh] w-full overflow-y-auto rounded-t-card border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-card sm:pb-5 dark:border-white/[0.08] dark:bg-[#201c17] ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        {/* A grab handle, so it reads as something you can pull down. */}
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line sm:hidden dark:bg-white/15" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[17px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-muted dark:text-[#a89f93]">{subtitle}</p>}
          </div>
          {/* `rt-tight` used to sit here, which exempted this button from the
              department's 44px dialog floor and left it 40×40 in a page sheet and
              34×34 in the More sheet — the smallest target in the phone chrome,
              on the control people reach for first. The explicit size replaces
              the exemption. */}
          <button onClick={onClose} aria-label="Close" className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Labelled rows inside a Sheet — the detail a card could not show. */
export function Detail({ items }: { items: { k: string; v: React.ReactNode }[] }) {
  return (
    <dl className="divide-y divide-line dark:divide-white/[0.06]">
      {items.map((it, i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-2.5">
          <dt className="text-[12.5px] text-muted dark:text-[#a89f93]">{it.k}</dt>
          <dd className="text-right text-[13.5px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A fixed bar for a bulk action on a phone — sits above the tab bar, never on
 *  top of it. Pages showing one must pad their list by `pb-24`. */
export function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-40 flex gap-2 border-t border-line bg-surface/95 p-3 backdrop-blur md:static md:mt-4 md:rounded-card md:border md:bg-surface md:p-3 dark:border-white/[0.08] dark:bg-[#201c17]/95 md:dark:bg-[#201c17]">
      {children}
    </div>
  );
}
