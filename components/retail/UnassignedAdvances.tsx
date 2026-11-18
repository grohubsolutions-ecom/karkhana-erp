"use client";
/* ADVANCES THAT LEFT A TILL AND LANDED ON NOBODY.
 *
 * WHY THIS SCREEN HAS TO EXIST.
 *
 * An advance is two facts at once: a shop paid cash out, and a person now owes
 * it. The expense import has always recorded the first and tried to work out
 * the second from the note — "SONIA ADVANCE" against the staff list. When the
 * note was clear it linked; when it was not, it dropped the link and said
 * nothing. The cash was accounted for, the debt was not, and nothing anywhere
 * showed the difference.
 *
 * Measured on the live database before this screen existed: 280 advance rows
 * came in through expense files, Rs 969,500. 88 of them — Rs 277,410 — match no
 * ledger row for anybody. 55 (Rs 170,590) predate the app, which was always
 * going to need hands. The other 33, Rs 106,820, were missed in ten weeks of
 * ordinary use. Three reasons, all of them real:
 *
 *   · TWO PEOPLE, ONE NAME. Two AHMADs at Thokar, two HASEEBs at MOD. The
 *     matcher refuses to guess between them, correctly, and then forgot.
 *   · A NAME THAT IS NOT ON THE STAFF LIST at all — MUBEEN, tahaseen, abiha.
 *   · A TRANSFER. Somebody filed at one shop taking an advance at another.
 *
 * None of those can be solved by a cleverer matcher, because none of them is a
 * matching problem — they are questions only a person can answer. What was
 * wrong was that nobody was ever asked. So the import keeps running end to end,
 * and whatever it could not place waits here with the money on screen.
 *
 * WHY NOT A DROPDOWN DURING THE IMPORT. Because a file is hundreds of rows and
 * the answer is not always to hand — you may have to ring the shop. Blocking
 * the whole import on that means the sales and expenses do not land either.
 * The import should always finish; the loose ends should always be visible.
 *
 * THE PICKER IS COMPANY-WIDE, AND THAT IS THE POINT. Every employee at every
 * shop, with their shop printed beside the name, because the hard case is
 * exactly the one where the person is not filed at the shop that paid them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { UserCheck, AlertTriangle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { inputCls, btnPrimary } from "@/components/Modal";
import {
  DataTable, SourceNote, money, num, useIsPhone,
  type Col, type Branch, type Employee,
} from "@/components/retail/kit";

type AdvExpense = {
  id: number; branch_id: number | null; expense_date: string;
  amount: number; description: string | null;
};
type LedgerKey = { entry_date: string; advance: number; branch_id: number | null };

const CATEGORIES = ["Purchases", "Maintenance", "Marketing", "Other", "Rent", "Salaries", "Utilities"];

export function useUnassignedAdvances(branchIds: number[] | null) {
  const [rows, setRows] = useState<AdvExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const db = supabase;
    setLoading(true); setErr("");

    /* Both sides of the question in one round trip each. The ledger read is
       every advance row, not a per-expense lookup: 246 rows is nothing, and one
       request beats 280. */
    let q = db.from("retail_expenses")
      .select("id,branch_id,expense_date,amount,description")
      .eq("category", "Advance").eq("txn_type", "expense")
      .order("expense_date", { ascending: false });
    if (branchIds) q = q.in("branch_id", branchIds);

    const [expRes, ledRes] = await Promise.all([
      q,
      db.from("retail_employee_ledger").select("entry_date,advance,branch_id").gt("advance", 0),
    ]);
    if (expRes.error || ledRes.error) {
      setErr(expRes.error?.message || ledRes.error?.message || "");
      setRows([]); setLoading(false); return;
    }

    /* AN ADVANCE COUNTS AS PLACED when a ledger row carries the same day and
       the same amount. branch_id narrows it when the ledger row has one — rows
       written before migration 0135 do not, and those fall back to day+amount
       alone rather than being wrongly reported as missing. */
    const placed = new Set<string>();
    ((ledRes.data as LedgerKey[]) ?? []).forEach((l) => {
      const amt = num(l.advance).toFixed(2);
      placed.add(`${l.entry_date}|${amt}`);
      if (l.branch_id != null) placed.add(`${l.branch_id}|${l.entry_date}|${amt}`);
    });

    const open = ((expRes.data as AdvExpense[]) ?? []).filter((e) => {
      const amt = Math.abs(num(e.amount)).toFixed(2);
      return !placed.has(`${e.expense_date}|${amt}`)
          && !placed.has(`${e.branch_id}|${e.expense_date}|${amt}`);
    });
    setRows(open);
    setLoading(false);
  }, [branchIds ? branchIds.join(",") : "all"]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  return { rows, loading, err, reload: load };
}

export default function UnassignedAdvances({
  branchIds, employees, branches, onChanged,
}: {
  branchIds: number[] | null;
  employees: Employee[];
  branches: Branch[];
  onChanged?: () => void;
}) {
  const phone = useIsPhone();
  const { rows, loading, err, reload } = useUnassignedAdvances(branchIds);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<Record<number, string>>({});

  const branchName = useMemo(() => {
    const m = new Map<number, string>();
    branches.forEach((b) => m.set(Number(b.id), b.name));
    return (id: unknown) => m.get(Number(id)) ?? "—";
  }, [branches]);

  /* Grouped by shop so the list reads as "who, and where" — the two things you
     need to tell one ALI from another. Leavers are kept and marked: an advance
     is owed by whoever took it, and people leave owing money. */
  const byShop = useMemo(() => {
    const m = new Map<string, Employee[]>();
    employees.forEach((e) => {
      const k = branchName(e.branch_id);
      (m.get(k) ?? m.set(k, []).get(k)!).push(e);
    });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([shop, list]) => [shop, list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))] as const);
  }, [employees, branchName]);

  const total = useMemo(() => rows.reduce((a, r) => a + Math.abs(num(r.amount)), 0), [rows]);

  async function assign(r: AdvExpense) {
    const id = Number(pick[r.id] || 0);
    if (!supabase || !id) return;
    setBusy(r.id); setFailed((f) => ({ ...f, [r.id]: "" }));
    const { error } = await supabase.from("retail_employee_ledger").insert({
      employee_id: id,
      /* The shop that PAID, not the employee's shop. That distinction is the
         whole reason migration 0135 added the column. */
      branch_id: r.branch_id,
      entry_date: r.expense_date,
      advance: Math.abs(num(r.amount)),
      purchase_credit: 0, paid: 0,
      purchase_details: (r.description || "Advance") + " (assigned by hand)",
      source: "advance",
    });
    setBusy(null);
    if (error) { setFailed((f) => ({ ...f, [r.id]: error.message })); return; }
    await reload(); onChanged?.();
  }

  async function recategorise(r: AdvExpense, category: string) {
    if (!supabase || !category) return;
    setBusy(r.id); setFailed((f) => ({ ...f, [r.id]: "" }));
    /* Not a staff advance after all — a purchase, a repair, a bill. The expense
       itself is untouched except for its category, so the shop's cash position
       does not move by a rupee; it simply stops being asked about here. */
    const { error } = await supabase.from("retail_expenses")
      .update({ category }).eq("id", r.id);
    setBusy(null);
    if (error) { setFailed((f) => ({ ...f, [r.id]: error.message })); return; }
    await reload(); onChanged?.();
  }

  const Picker = ({ r }: { r: AdvExpense }) => (
    <select value={pick[r.id] ?? ""} aria-label={`Who took the ${money(Math.abs(num(r.amount)))} advance on ${r.expense_date}`}
      onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.value }))}
      className={`${inputCls} min-w-[190px]`}>
      <option value="">Who took it?</option>
      {byShop.map(([shop, list]) => (
        <optgroup key={shop} label={shop}>
          {list.map((e) => (
            <option key={e.id} value={String(e.id)}>
              {e.name}{e.active === false ? " (ended)" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  const Actions = ({ r }: { r: AdvExpense }) => (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <Picker r={r} />
      <button onClick={() => assign(r)} disabled={!pick[r.id] || busy === r.id} className={btnPrimary}>
        {busy === r.id ? "…" : <><UserCheck size={14} /> Assign</>}
      </button>
      <select value="" aria-label="Not a staff advance" onChange={(e) => recategorise(r, e.target.value)}
        className={`${inputCls} min-w-[150px]`}>
        <option value="">Not an advance…</option>
        {CATEGORIES.map((c) => <option key={c} value={c}>Move to {c}</option>)}
      </select>
    </span>
  );

  const cols: Col<AdvExpense>[] = [
    { head: "Date", bold: true, cell: (r) => r.expense_date },
    { head: "Shop", cell: (r) => branchName(r.branch_id) },
    { head: "Amount", right: true, bold: true, cell: (r) => money(Math.abs(num(r.amount))) },
    { head: "What the file said", muted: true, cell: (r) => r.description || "—" },
    { head: "", right: true, cell: (r) => (
        <span className="block">
          <Actions r={r} />
          {failed[r.id] && <span className="mt-1 block text-[11.5px] font-semibold text-danger">{failed[r.id]}</span>}
        </span>
      ) },
  ];

  return (
    <>
      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">{err}</p>}

      {!loading && rows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-amber/30 bg-amber-soft p-4 dark:border-amber/30 dark:bg-amber/10">
          <AlertTriangle size={17} className="flex-none text-amber-strong dark:text-amber" />
          <p className="flex-1 text-[13px] text-ink dark:text-[#e7e2d8]">
            <strong>{money(total)}</strong> of advances across <strong>{rows.length}</strong> payment
            {rows.length === 1 ? "" : "s"} left a till with nobody recorded as owing it. Until somebody
            is named, none of this is deducted from a salary.
          </p>
        </div>
      )}

      {!loading && rows.length === 0 && !err && (
        <p className="mt-6 rounded-card border border-line bg-surface p-8 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">
          Every advance is attached to somebody. Nothing to do here.
        </p>
      )}

      {phone ? (
        <div className="mt-3 space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{branchName(r.branch_id)}</div>
                  <div className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">
                    {r.expense_date} · {r.description || "no note"}
                  </div>
                </div>
                <div className="flex-none text-[17px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">
                  {money(Math.abs(num(r.amount)))}
                </div>
              </div>
              <div className="mt-3 space-y-2">
                <Picker r={r} />
                <button onClick={() => assign(r)} disabled={!pick[r.id] || busy === r.id} className={`${btnPrimary} w-full`}>
                  {busy === r.id ? "…" : "Assign to this person"}
                </button>
                <select value="" aria-label="Not a staff advance" onChange={(e) => recategorise(r, e.target.value)}
                  className={`${inputCls} w-full`}>
                  <option value="">Not an advance…</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>Move to {c}</option>)}
                </select>
                {failed[r.id] && <p className="text-[11.5px] font-semibold text-danger">{failed[r.id]}</p>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        rows.length > 0 && <DataTable cols={cols} rows={rows} loading={loading} minWidth={980} empty="Nothing unassigned." />
      )}

      <SourceNote>
        These are rows the expense file filed under <strong>Advance</strong> that no ledger entry
        matches. Assigning one writes it to that person&apos;s ledger against{" "}
        <strong>the shop that actually paid</strong> — which is not always the shop they work at, and
        is why the list below the name shows every shop. If it was never a staff advance, move it to
        another category and the shop&apos;s cash position does not change by a rupee.
      </SourceNote>
    </>
  );
}
