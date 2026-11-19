"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, LayoutGrid, LogOut, RefreshCw, Search, Wallet } from "lucide-react";
import { supabase } from "@/lib/supabase";
import ThemeToggle from "@/components/ThemeToggle";
import { usePermissions } from "@/lib/usePermissions";

type Row = {
  employee_id: string;
  code: string;
  name: string;
  designation: string | null;
  section: string | null;
  phone: string | null;
  status: string | null;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number;
  shift_minutes: number;
  overtime_minutes: number;
  daily_wage: number;
  amount_due: number;
  is_running: boolean;
  amount_paid: number | null;
  paid_note: string | null;
  paid_at: string | null;
  paid_by_name: string | null;
  can_pay: boolean;
  punches: string[];
  last_punch: string | null;
  back_inside: boolean;
  balance: number | null;
};

type State = "pay" | "balance" | "inside" | "back" | "paid" | "absent";
type Filter = "all" | "to_pay" | "inside" | "paid" | "absent";

const TZ = "Asia/Karachi";
const OTHER_AREAS = [
  "inventory.view", "production.view", "reports.view", "employees.manage", "khana.view", "karkhana.admin",
  "hub.dashboard.view", "hub.orders.view", "hub.logistics.view", "hub.finance.view", "hub.attendance.view",
  "retail.access", "carrefour.view", "users.manage", "roles.manage",
];

function todayPK(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function shiftDate(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ts));
}
function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
function fmtHours(min: number): string {
  if (!min || min <= 0) return "0h";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function rs(n: number | null | undefined): string {
  return "Rs " + Math.round(Number(n || 0)).toLocaleString("en-PK");
}
function fmtDateLong(d: string): string {
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function stateOf(r: Row): State {
  const paid = r.amount_paid !== null && r.amount_paid !== undefined;
  if (paid && r.back_inside) return "back";
  if (paid && Number(r.balance || 0) >= 1) return "balance";
  if (paid) return "paid";
  if (r.is_running) return "inside";
  if (r.first_in) return "pay";
  return "absent";
}

const RANK: Record<State, number> = { pay: 0, balance: 1, back: 2, inside: 3, paid: 4, absent: 5 };

export default function WageDeskPage() {
  const router = useRouter();
  const { all, can } = usePermissions();
  const hasMore = all || can(OTHER_AREAS);

  const [date, setDate] = useState<string>(todayPK());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [payFor, setPayFor] = useState<Row | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const isToday = date === todayPK();

  const load = useCallback(async (silent = false) => {
    if (!supabase) { setError("Not connected."); setLoading(false); return; }
    if (!silent) setLoading(true);
    const { data, error } = await supabase.rpc("kk_wage_desk", { p_date: date });
    if (error) {
      setError(error.message.includes("Not allowed") ? "This login is not allowed to open the wage desk." : error.message);
      setRows([]);
    } else {
      setError(null);
      setRows((data ?? []) as Row[]);
      setUpdatedAt(new Date());
    }
    setLoading(false);
  }, [date]);

  useEffect(() => { load(); }, [load]);

  /* Punches reach the database within seconds of the scan; a 30-second poll
     keeps the screen in step without anyone pressing refresh. */
  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, 30000);
    const onShow = () => { if (!document.hidden) load(true); };
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onShow); };
  }, [isToday, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const totals = useMemo(() => {
    let present = 0, inside = 0, earned = 0, paid = 0, toPay = 0;
    for (const r of rows) {
      const s = stateOf(r);
      if (r.first_in) present++;
      if (s === "inside" || s === "back") inside++;
      earned += Number(r.amount_due || 0);
      if (r.amount_paid !== null) paid += Number(r.amount_paid);
      if (s === "pay") toPay += Number(r.amount_due || 0);
      if (s === "balance") toPay += Number(r.balance || 0);
    }
    return { present, inside, earned, paid, toPay };
  }, [rows]);

  const count = (f: Filter) => rows.filter((r) => matches(r, f)).length;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => matches(r, filter))
      .filter((r) => !needle || [r.name, r.code, r.designation, r.section, r.phone].some((v) => (v || "").toLowerCase().includes(needle)))
      .sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]);
  }, [rows, filter, q]);

  async function undo(r: Row) {
    if (!supabase) return;
    if (!confirm(`Remove the ${rs(r.amount_paid)} payment for ${r.name}?`)) return;
    const { error } = await supabase.rpc("kk_wage_desk_unpay", { p_employee_id: r.employee_id, p_date: date });
    if (error) { setToast(error.message); return; }
    setToast("Payment removed");
    load(true);
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
  }

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "to_pay", label: "To pay" },
    { key: "inside", label: "Inside" },
    { key: "paid", label: "Paid" },
    { key: "absent", label: "Absent" },
  ];

  return (
    <div className="min-h-[100dvh] bg-canvas pb-24 text-ink dark:bg-[#17140f] dark:text-[#f4f1ea]">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur dark:border-white/[0.06] dark:bg-[#17140f]/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pb-2 pt-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[13px] bg-ink text-white dark:bg-success dark:text-[#141414]">
              <Wallet size={20} strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-extrabold tracking-tight">Daily Wage Desk</h1>
              <p className="truncate text-[12px] font-medium text-muted dark:text-[#a89f93]">Karkhana · daily-wage workers</p>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            {hasMore && (
              <Link href="/" className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-semibold dark:border-white/10 dark:bg-white/[0.06]" aria-label="All departments">
                <LayoutGrid size={14} /><span className="hidden sm:inline">Departments</span>
              </Link>
            )}
            <ThemeToggle />
            <button onClick={signOut} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-semibold dark:border-white/10 dark:bg-white/[0.06]" aria-label="Sign out">
              <LogOut size={14} /><span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 pb-3 sm:px-6">
          <button onClick={() => setDate(shiftDate(date, -1))} className="flex h-11 w-11 flex-none items-center justify-center rounded-xl2 border border-line bg-surface dark:border-white/10 dark:bg-white/[0.06]" aria-label="Previous day">
            <ChevronLeft size={18} />
          </button>
          <input
            type="date"
            value={date}
            max={todayPK()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-3 text-[16px] font-semibold dark:border-white/10 dark:bg-white/[0.06] dark:[color-scheme:dark]"
          />
          <button onClick={() => !isToday && setDate(shiftDate(date, 1))} disabled={isToday} className="flex h-11 w-11 flex-none items-center justify-center rounded-xl2 border border-line bg-surface disabled:opacity-30 dark:border-white/10 dark:bg-white/[0.06]" aria-label="Next day">
            <ChevronRight size={18} />
          </button>
          {!isToday ? (
            <button onClick={() => setDate(todayPK())} className="h-11 flex-none rounded-xl2 bg-ink px-4 text-[13px] font-bold text-white dark:bg-white dark:text-[#141414]">Today</button>
          ) : (
            <button onClick={() => load()} className="flex h-11 w-11 flex-none items-center justify-center rounded-xl2 border border-line bg-surface dark:border-white/10 dark:bg-white/[0.06]" aria-label="Refresh">
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-4 sm:px-6">
        <p className="mb-3 text-[13px] font-semibold text-muted dark:text-[#a89f93]">
          {fmtDateLong(date)}
          {updatedAt && <span className="font-medium text-hint dark:text-[#8a8175]"> · updated {fmtTime(updatedAt.toISOString())}</span>}
        </p>

        <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Present" value={`${totals.present} / ${rows.length}`} sub={isToday && totals.inside ? `${totals.inside} inside now` : undefined} />
          <Tile label="Earned" value={rs(totals.earned)} sub={isToday && totals.inside ? "incl. running" : undefined} />
          <Tile label="Paid" value={rs(totals.paid)} tone="ok" />
          <Tile label="To pay" value={rs(totals.toPay)} tone={totals.toPay > 0 ? "warn" : undefined} />
        </section>

        <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={`flex-none rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ${filter === c.key
                ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
                : "border-line bg-surface dark:border-white/10 dark:bg-white/[0.06]"}`}
            >
              {c.label} <span className="opacity-60">{count(c.key)}</span>
            </button>
          ))}
        </div>

        <div className="relative mb-4">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-hint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code, section…"
            className="h-11 w-full rounded-xl2 border border-line bg-surface pl-10 pr-3 text-[16px] dark:border-white/10 dark:bg-white/[0.06]"
          />
        </div>

        {error && <div className="mb-4 rounded-xl2 border border-danger/30 bg-danger-soft p-3 text-[13px] font-medium text-[#a8463a] dark:bg-danger/10 dark:text-danger">{error}</div>}
        {loading && rows.length === 0 && <div className="py-12 text-center text-[14px] text-muted">Loading…</div>}
        {!loading && !error && shown.length === 0 && (
          <div className="rounded-card border border-dashed border-line bg-surface py-12 text-center text-[14px] text-muted dark:border-white/10 dark:bg-white/[0.03]">No workers in this list.</div>
        )}

        <ul className="space-y-3">
          {shown.map((r) => (
            <WorkerCard key={r.employee_id} r={r} onPay={() => setPayFor(r)} onUndo={() => undo(r)} />
          ))}
        </ul>
      </main>

      {payFor && (
        <PaySheet
          row={payFor}
          date={date}
          onClose={() => setPayFor(null)}
          onSaved={(msg) => { setPayFor(null); setToast(msg); load(true); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-5 py-3 text-[13px] font-semibold text-white shadow-card dark:bg-white dark:text-[#141414]">{toast}</div>
      )}
    </div>
  );
}

function matches(r: Row, f: Filter): boolean {
  const s = stateOf(r);
  if (f === "all") return true;
  if (f === "to_pay") return s === "pay" || s === "balance";
  if (f === "inside") return s === "inside" || s === "back";
  if (f === "paid") return s === "paid" || s === "balance" || s === "back";
  return s === "absent";
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" }) {
  const color = tone === "ok" ? "text-[#3f8a4b] dark:text-success" : tone === "warn" ? "text-[#b5733a] dark:text-amber" : "";
  return (
    <div className="rounded-xl2 border border-line bg-surface p-3.5 shadow-soft dark:border-white/[0.06] dark:bg-[#201c17] dark:shadow-none">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted dark:text-[#a89f93]">{label}</div>
      <div className={`mt-1 text-[18px] font-extrabold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11.5px] font-medium text-muted dark:text-[#a89f93]">{sub}</div>}
    </div>
  );
}

const BADGE: Record<State, { text: string; cls: string }> = {
  pay: { text: "Left · pay now", cls: "bg-amber-soft text-[#8a5a24] dark:bg-amber/20 dark:text-amber" },
  balance: { text: "Came back · balance due", cls: "bg-amber-soft text-[#8a5a24] dark:bg-amber/20 dark:text-amber" },
  back: { text: "Came back · inside", cls: "bg-periwinkle-soft text-[#3d5f93] dark:bg-periwinkle/20 dark:text-periwinkle" },
  inside: { text: "Inside", cls: "bg-periwinkle-soft text-[#3d5f93] dark:bg-periwinkle/20 dark:text-periwinkle" },
  paid: { text: "Paid", cls: "bg-success-soft text-[#3f8a4b] dark:bg-success/20 dark:text-success" },
  absent: { text: "Not in", cls: "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]" },
};

function WorkerCard({ r, onPay, onUndo }: { r: Row; onPay: () => void; onUndo: () => void }) {
  const s = stateOf(r);
  const meta = [r.code, r.designation, r.section].filter(Boolean).join(" · ");
  const highlight = s === "pay" || s === "balance";
  const badgeText = s === "absent" && r.status === "off" ? "Off day" : BADGE[s].text;

  return (
    <li className={`rounded-card border bg-surface p-4 shadow-soft dark:bg-[#201c17] dark:shadow-none ${highlight ? "border-amber-strong ring-1 ring-amber dark:border-amber/50 dark:ring-amber/30" : "border-line dark:border-white/[0.06]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-bold tracking-tight">{r.name}</div>
          <div className="truncate text-[12px] font-medium text-muted dark:text-[#a89f93]">{meta}</div>
          {r.phone && <a href={`tel:${r.phone}`} className="text-[12px] font-semibold text-[#3d5f93] dark:text-periwinkle">{r.phone}</a>}
        </div>
        <span className={`flex-none rounded-full px-2.5 py-1 text-[11.5px] font-bold ${BADGE[s].cls}`}>{badgeText}</span>
      </div>

      {r.punches.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted dark:text-[#a89f93]">
            Punches today · {r.punches.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {r.punches.map((p, i) => (
              <span key={i} className="rounded-lg bg-panel px-2 py-1 text-[12.5px] font-semibold tabular-nums dark:bg-white/[0.06]">
                {fmt12(p)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Cell label="First in" value={fmtTime(r.first_in)} />
        <Cell label={r.is_running ? "Now" : "Last punch"} value={r.is_running ? "inside" : r.first_in ? fmtTime(r.last_punch || r.last_out) : "—"} />
        <Cell label="Time" value={r.first_in ? fmtHours(r.worked_minutes) : "—"} sub={r.shift_minutes ? `of ${fmtHours(r.shift_minutes)}` : undefined} />
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-line pt-3 dark:border-white/[0.06]">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">
            Daily rate {rs(r.daily_wage)}{r.overtime_minutes > 0 ? ` · OT ${fmtHours(r.overtime_minutes)}` : ""}
          </div>
          <div className="text-[21px] font-extrabold tabular-nums">
            {rs(r.amount_due)}
            {r.is_running && <span className="ml-2 align-middle text-[11.5px] font-bold text-[#3d5f93] dark:text-periwinkle">so far</span>}
          </div>
          {r.amount_paid !== null && (
            <div className="mt-0.5 text-[12px] font-medium text-[#3f8a4b] dark:text-success">
              Paid {rs(r.amount_paid)}{r.paid_by_name ? ` by ${r.paid_by_name}` : ""}{r.paid_at ? ` · ${fmtTime(r.paid_at)}` : ""}
              {Number(r.balance || 0) >= 1 && <span className="font-bold text-[#b5733a] dark:text-amber"> · balance {rs(r.balance)}</span>}
              {Number(r.balance || 0) <= -1 && <span className="text-[#b5733a] dark:text-amber"> · over by {rs(-Number(r.balance))}</span>}
              {r.paid_note && <div className="text-muted dark:text-[#a89f93]">“{r.paid_note}”</div>}
            </div>
          )}
        </div>

        {r.can_pay && (
          s === "pay" ? (
            <button onClick={onPay} className="h-11 rounded-xl2 bg-ink px-5 text-[14px] font-bold text-white active:scale-[0.98] dark:bg-success dark:text-[#141414]">
              Pay {rs(r.amount_due)}
            </button>
          ) : s === "balance" ? (
            <div className="flex gap-2">
              <button onClick={onUndo} className="h-11 rounded-xl2 border border-line px-3 text-[13px] font-semibold text-[#a8463a] dark:border-white/10 dark:text-danger">Undo</button>
              <button onClick={onPay} className="h-11 rounded-xl2 bg-ink px-4 text-[14px] font-bold text-white dark:bg-success dark:text-[#141414]">Pay {rs(r.balance)}</button>
            </div>
          ) : s === "paid" || s === "back" ? (
            <div className="flex gap-2">
              <button onClick={onPay} className="h-11 rounded-xl2 border border-line px-4 text-[13px] font-semibold dark:border-white/10">Edit</button>
              <button onClick={onUndo} className="h-11 rounded-xl2 border border-line px-3 text-[13px] font-semibold text-[#a8463a] dark:border-white/10 dark:text-danger">Undo</button>
            </div>
          ) : s === "inside" ? (
            <button onClick={onPay} className="h-11 rounded-xl2 border border-line px-4 text-[13px] font-semibold dark:border-white/10">Pay early</button>
          ) : null
        )}
      </div>
    </li>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-panel px-2 py-2 dark:bg-white/[0.04]">
      <div className="text-[10.5px] font-bold uppercase tracking-wide text-muted dark:text-[#a89f93]">{label}</div>
      <div className="text-[13.5px] font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[10.5px] font-medium text-hint dark:text-[#8a8175]">{sub}</div>}
    </div>
  );
}

function PaySheet({ row, date, onClose, onSaved }: { row: Row; date: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const already = row.amount_paid !== null ? Number(row.amount_paid) : 0;
  const due = Number(row.amount_due || 0);
  const topUp = row.amount_paid !== null && Number(row.balance || 0) >= 1;
  const editing = row.amount_paid !== null && !topUp;

  const start = topUp ? Number(row.balance) : editing ? already : due;
  const [amount, setAmount] = useState<string>(String(Math.round(start)));
  const [note, setNote] = useState<string>(editing ? row.paid_note || "" : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amt = Number(amount);
  const total = topUp ? already + amt : amt;
  const diff = total - due;
  const needsNote = !Number.isNaN(amt) && Math.abs(diff) >= 1;

  async function save() {
    if (!supabase) return;
    if (amount.trim() === "" || Number.isNaN(amt) || amt < 0) { setErr("Enter the cash amount."); return; }
    if (needsNote && !note.trim()) { setErr("The total is different from the portal — write a short reason."); return; }
    setSaving(true);
    setErr(null);
    const mergedNote = topUp && row.paid_note ? `${row.paid_note} · ${note.trim()}`.replace(/ · $/, "") : note.trim();
    const { error } = await supabase.rpc("kk_wage_desk_pay", {
      p_employee_id: row.employee_id,
      p_date: date,
      p_amount: total,
      p_note: mergedNote || null,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    onSaved(topUp ? `${rs(amt)} more paid to ${row.name}` : `${rs(total)} paid to ${row.name}`);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-[26px] bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink sm:rounded-card dark:bg-[#201c17] dark:text-[#f4f1ea]" onClick={(e) => e.stopPropagation()}>
        <div className="text-[18px] font-extrabold tracking-tight">{topUp ? "Pay balance" : editing ? "Edit payment" : "Pay cash"}</div>
        <div className="mb-4 text-[13px] font-medium text-muted dark:text-[#a89f93]">
          {row.name} · {row.punches.length ? row.punches.map(fmt12).join(" → ") : "no punches"}
        </div>

        {row.is_running && (
          <div className="mb-3 rounded-xl2 bg-periwinkle-soft p-3 text-[13px] font-medium text-[#3d5f93] dark:bg-periwinkle/15 dark:text-periwinkle">
            Still inside — this is the amount earned so far. Ask him to punch out first if he is leaving.
          </div>
        )}

        <div className="mb-3 space-y-1 rounded-xl2 bg-panel p-3 text-[14px] dark:bg-white/[0.04]">
          <div className="flex justify-between"><span>Portal says</span><b className="tabular-nums">{rs(due)}</b></div>
          {topUp && <div className="flex justify-between text-muted dark:text-[#a89f93]"><span>Already paid</span><span className="tabular-nums">{rs(already)}</span></div>}
          {topUp && <div className="flex justify-between font-bold text-[#b5733a] dark:text-amber"><span>Balance</span><span className="tabular-nums">{rs(row.balance)}</span></div>}
        </div>

        <label className="mb-1 block text-[13px] font-bold">{topUp ? "Cash given now (Rs)" : "Cash given (Rs)"}</label>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mb-1 h-14 w-full rounded-xl2 border border-line bg-surface px-3 text-[22px] font-extrabold tabular-nums dark:border-white/10 dark:bg-white/[0.06]"
          autoFocus
        />
        {topUp && !Number.isNaN(amt) && <div className="mb-1 text-[13px] font-medium text-muted dark:text-[#a89f93]">Total for the day: {rs(total)}</div>}
        {needsNote && <div className="mb-1 text-[13px] font-semibold text-[#b5733a] dark:text-amber">{diff > 0 ? "More" : "Less"} than the portal by {rs(Math.abs(diff))}</div>}

        <label className="mb-1 mt-2 block text-[13px] font-bold">Note {needsNote ? "(required)" : "(optional)"}</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={needsNote ? "Why is it different?" : "e.g. took 500 now, rest tomorrow"}
          className="mb-3 h-11 w-full rounded-xl2 border border-line bg-surface px-3 text-[16px] dark:border-white/10 dark:bg-white/[0.06]"
        />

        {err && <div className="mb-3 rounded-xl2 bg-danger-soft p-2.5 text-[13px] font-medium text-[#a8463a] dark:bg-danger/10 dark:text-danger">{err}</div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="h-12 flex-1 rounded-xl2 border border-line font-semibold dark:border-white/10">Cancel</button>
          <button onClick={save} disabled={saving} className="h-12 flex-1 rounded-xl2 bg-ink font-bold text-white disabled:opacity-50 dark:bg-success dark:text-[#141414]">
            {saving ? "Saving…" : editing ? "Save" : "Confirm paid"}
          </button>
        </div>
      </div>
    </div>
  );
}
