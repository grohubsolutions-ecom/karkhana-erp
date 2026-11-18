"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!
);

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
};

type Filter = "all" | "to_pay" | "paid" | "inside" | "absent";

const TZ = "Asia/Karachi";

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
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function stateOf(r: Row): "paid" | "inside" | "left" | "absent" {
  if (r.amount_paid !== null && r.amount_paid !== undefined) return "paid";
  if (r.first_in && !r.last_out) return "inside";
  if (r.first_in && r.last_out) return "left";
  return "absent";
}

const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  half_day: "Half day",
  in_progress: "Inside",
  missing_out: "No check-out",
  absent: "Absent",
  off: "Off day",
  pending: "Not in yet",
  paid_leave: "Paid leave",
};

export default function WageDeskPage() {
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

  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, 60000);
    return () => clearInterval(t);
  }, [isToday, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const totals = useMemo(() => {
    let present = 0, inside = 0, earned = 0, paid = 0, toPay = 0, unpaidLeft = 0;
    for (const r of rows) {
      if (r.first_in) present++;
      if (r.first_in && !r.last_out) inside++;
      earned += Number(r.amount_due || 0);
      if (r.amount_paid !== null) paid += Number(r.amount_paid);
      else if (r.first_in) { toPay += Number(r.amount_due || 0); if (r.last_out) unpaidLeft++; }
    }
    return { present, inside, earned, paid, toPay, unpaidLeft };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const s = stateOf(r);
      if (filter === "to_pay" && (s === "paid" || s === "absent")) return false;
      if (filter === "paid" && s !== "paid") return false;
      if (filter === "inside" && s !== "inside") return false;
      if (filter === "absent" && s !== "absent") return false;
      if (!needle) return true;
      return [r.name, r.code, r.designation, r.section, r.phone].some((v) => (v || "").toLowerCase().includes(needle));
    }).sort((a, b) => {
      const rank = (r: Row) => ({ left: 0, inside: 1, paid: 2, absent: 3 }[stateOf(r)]);
      return rank(a) - rank(b);
    });
  }, [rows, filter, q]);

  async function undo(r: Row) {
    if (!confirm(`Remove the ${rs(r.amount_paid)} payment for ${r.name}?`)) return;
    const { error } = await supabase.rpc("kk_wage_desk_unpay", { p_employee_id: r.employee_id, p_date: date });
    if (error) { alert(error.message); return; }
    setToast("Payment removed");
    load(true);
  }

  const chips: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: rows.length },
    { key: "to_pay", label: "To pay", n: rows.filter((r) => ["left", "inside"].includes(stateOf(r))).length },
    { key: "inside", label: "Inside", n: rows.filter((r) => stateOf(r) === "inside").length },
    { key: "paid", label: "Paid", n: rows.filter((r) => stateOf(r) === "paid").length },
    { key: "absent", label: "Absent", n: rows.filter((r) => stateOf(r) === "absent").length },
  ];

  return (
    <div className="min-h-screen bg-slate-50 pb-24 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold">Daily Wage Desk</h1>
            <p className="text-xs text-slate-500">Karkhana · daily-wage workers</p>
          </div>
          <button
            onClick={async () => { await supabase.auth.signOut(); window.location.href = "/"; }}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium"
          >
            Sign out
          </button>
        </div>
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 pb-3">
          <button onClick={() => setDate(shiftDate(date, -1))} className="rounded-lg border border-slate-300 px-3 py-2 text-base" aria-label="Previous day">‹</button>
          <input
            type="date"
            value={date}
            max={todayPK()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base"
          />
          <button onClick={() => !isToday && setDate(shiftDate(date, 1))} disabled={isToday} className="rounded-lg border border-slate-300 px-3 py-2 text-base disabled:opacity-30" aria-label="Next day">›</button>
          {!isToday && (
            <button onClick={() => setDate(todayPK())} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Today</button>
          )}
          <button onClick={() => load()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" aria-label="Refresh">↻</button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-4">
        <p className="mb-3 text-sm text-slate-600">
          {fmtDateLong(date)}
          {updatedAt && <span className="text-slate-400"> · updated {fmtTime(updatedAt.toISOString())}{isToday ? " · auto-refresh 1 min" : ""}</span>}
        </p>

        <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Present" value={`${totals.present} / ${rows.length}`} sub={isToday && totals.inside ? `${totals.inside} still inside` : undefined} />
          <Tile label="Earned" value={rs(totals.earned)} sub={isToday && totals.inside ? "incl. running" : undefined} />
          <Tile label="Paid" value={rs(totals.paid)} tone="ok" />
          <Tile label="Still to pay" value={rs(totals.toPay)} tone={totals.toPay > 0 ? "warn" : undefined} sub={totals.unpaidLeft ? `${totals.unpaidLeft} left unpaid` : undefined} />
        </section>

        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium ${filter === c.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white"}`}
            >
              {c.label} <span className="opacity-60">{c.n}</span>
            </button>
          ))}
        </div>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, code, section…"
          className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base"
        />

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {loading && <div className="py-10 text-center text-slate-500">Loading…</div>}
        {!loading && !error && shown.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-10 text-center text-slate-500">No workers in this list.</div>
        )}

        <ul className="space-y-3">
          {!loading && shown.map((r) => (
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
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">{toast}</div>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" }) {
  const color = tone === "ok" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function WorkerCard({ r, onPay, onUndo }: { r: Row; onPay: () => void; onUndo: () => void }) {
  const s = stateOf(r);
  const badge = {
    paid: "bg-emerald-100 text-emerald-800",
    inside: "bg-sky-100 text-sky-800",
    left: "bg-amber-100 text-amber-800",
    absent: "bg-slate-100 text-slate-600",
  }[s];
  const badgeText = s === "paid" ? "Paid" : s === "inside" ? "Inside" : s === "left" ? "Left · pay now" : STATUS_LABEL[r.status || ""] || "Absent";
  const meta = [r.code, r.designation, r.section].filter(Boolean).join(" · ");

  return (
    <li className={`rounded-xl border bg-white p-4 ${s === "left" ? "border-amber-300 ring-1 ring-amber-200" : "border-slate-200"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">{r.name}</div>
          <div className="truncate text-xs text-slate-500">{meta}</div>
          {r.phone && <a href={`tel:${r.phone}`} className="text-xs text-sky-700">{r.phone}</a>}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${badge}`}>{badgeText}</span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Cell label="Check in" value={fmtTime(r.first_in)} />
        <Cell label="Check out" value={r.last_out ? fmtTime(r.last_out) : r.first_in ? (r.is_running ? "inside" : "missing") : "—"} />
        <Cell label="Worked" value={r.first_in ? fmtHours(r.worked_minutes) : "—"} sub={r.shift_minutes ? `of ${fmtHours(r.shift_minutes)}` : undefined} />
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 pt-3">
        <div>
          <div className="text-xs text-slate-500">
            Daily rate {rs(r.daily_wage)}{r.overtime_minutes > 0 ? ` · OT ${fmtHours(r.overtime_minutes)}` : ""}
          </div>
          <div className="text-xl font-bold tabular-nums">
            {rs(r.amount_due)}
            {r.is_running && <span className="ml-2 align-middle text-xs font-medium text-sky-700">so far</span>}
          </div>
          {s === "paid" && (
            <div className="mt-0.5 text-xs text-emerald-700">
              Paid {rs(r.amount_paid)}
              {r.paid_by_name ? ` by ${r.paid_by_name}` : ""}
              {r.paid_at ? ` · ${fmtTime(r.paid_at)}` : ""}
              {Number(r.amount_paid) !== Number(r.amount_due) && (
                <span className="text-amber-700"> · {Number(r.amount_paid) > Number(r.amount_due) ? "over" : "short"} by {rs(Math.abs(Number(r.amount_paid) - Number(r.amount_due)))}</span>
              )}
              {r.paid_note && <div className="text-slate-500">“{r.paid_note}”</div>}
            </div>
          )}
        </div>

        {r.can_pay && (
          s === "paid" ? (
            <div className="flex gap-2">
              <button onClick={onPay} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium">Edit</button>
              <button onClick={onUndo} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700">Undo</button>
            </div>
          ) : r.first_in ? (
            <button onClick={onPay} className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white active:bg-emerald-700">
              Pay {rs(r.amount_due)}
            </button>
          ) : null
        )}
      </div>
    </li>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function PaySheet({ row, date, onClose, onSaved }: { row: Row; date: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const editing = row.amount_paid !== null;
  const [amount, setAmount] = useState<string>(String(Math.round(Number(editing ? row.amount_paid : row.amount_due) || 0)));
  const [note, setNote] = useState<string>(row.paid_note || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amt = Number(amount);
  const due = Number(row.amount_due || 0);
  const diff = amt - due;
  const needsNote = !Number.isNaN(amt) && Math.abs(diff) >= 1;

  async function save() {
    if (amount.trim() === "" || Number.isNaN(amt) || amt < 0) { setErr("Enter the cash amount."); return; }
    if (needsNote && !note.trim()) { setErr("The amount is different from the portal — write a short reason."); return; }
    setSaving(true);
    setErr(null);
    const { error } = await supabase.rpc("kk_wage_desk_pay", {
      p_employee_id: row.employee_id,
      p_date: date,
      p_amount: amt,
      p_note: note.trim() || null,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    onSaved(`${rs(amt)} paid to ${row.name}`);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-lg font-bold">{editing ? "Edit payment" : "Pay cash"}</div>
        <div className="mb-4 text-sm text-slate-600">
          {row.name} · {fmtTime(row.first_in)} → {row.last_out ? fmtTime(row.last_out) : "still inside"}
        </div>

        {row.is_running && (
          <div className="mb-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-800">
            Not checked out yet — this is the amount earned so far. Ask him to punch out first if he is leaving.
          </div>
        )}

        <div className="mb-3 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="flex justify-between"><span>Portal says</span><b className="tabular-nums">{rs(due)}</b></div>
        </div>

        <label className="mb-1 block text-sm font-medium">Cash given (Rs)</label>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mb-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-xl font-bold tabular-nums"
          autoFocus
        />
        {needsNote && (
          <div className="mb-2 text-sm text-amber-700">{diff > 0 ? "More" : "Less"} than the portal by {rs(Math.abs(diff))}</div>
        )}

        <label className="mb-1 mt-2 block text-sm font-medium">Note {needsNote ? "(required)" : "(optional)"}</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={needsNote ? "Why is it different?" : "e.g. took 500 now, rest tomorrow"}
          className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
        />

        {err && <div className="mb-3 rounded-lg bg-red-50 p-2.5 text-sm text-red-700">{err}</div>}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-3 font-medium">Cancel</button>
          <button onClick={save} disabled={saving} className="flex-1 rounded-lg bg-emerald-600 py-3 font-semibold text-white disabled:opacity-50">
            {saving ? "Saving…" : editing ? "Save" : "Confirm paid"}
          </button>
        </div>
      </div>
    </div>
  );
}
