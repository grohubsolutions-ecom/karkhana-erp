"use client";
/* WHO OWES WHOM, WHEN SOMEBODY TAKES AN ADVANCE AT A SHOP THEY DO NOT WORK AT.
 *
 * The owner's case: Kashif is Fashion Collection DHA's man, he moves to FC
 * Paragon, he takes Rs 2,000 at Paragon. Two facts, and they are not the same
 * fact:
 *
 *   · FC PARAGON'S TILL IS Rs 2,000 SHORT. True of a particular day, for ever.
 *   · KASHIF OWES Rs 2,000, recovered from his salary wherever he is paid.
 *
 * He chose: settle between the shops. So Paragon paid it, Kashif's employer
 * recovers it, and until that is squared up Kashif's employer owes Paragon
 * Rs 2,000. This screen is that list, and the net per shop underneath it.
 *
 * WHAT IT CAN AND CANNOT SEE. It compares retail_employee_ledger.branch_id —
 * the till that paid, added in migration 0135 — against the employee's own
 * branch. Rows written before 0135 have no paying branch recorded, and they are
 * NOT silently assumed to have been paid by the employee's own shop: they are
 * counted separately and said out loud. A settlement built on a guess is worse
 * than one that admits what it does not know.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Scale, AlertTriangle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  DataTable, SourceNote, money, num, useIsPhone,
  type Col, type Branch, type Employee,
} from "@/components/retail/kit";

type LedRow = {
  id: number; employee_id: number | null; branch_id: number | null;
  entry_date: string; advance: number | null; purchase_details: string | null;
};
type Pair = { from: number; to: number; amount: number; n: number };

export default function BetweenShops({ employees, branches, from, to }: {
  employees: Employee[]; branches: Branch[]; from: string; to: string;
}) {
  const phone = useIsPhone();
  const [rows, setRows] = useState<LedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase
      .from("retail_employee_ledger")
      .select("id,employee_id,branch_id,entry_date,advance,purchase_details")
      .gt("advance", 0).gte("entry_date", from).lte("entry_date", to)
      .order("entry_date", { ascending: false });
    if (error) { setErr(error.message); setRows([]); setLoading(false); return; }
    setRows((data as LedRow[]) ?? []);
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const empBranch = useMemo(() => {
    const m = new Map<number, number | null>();
    employees.forEach((e) => m.set(Number(e.id), e.branch_id == null ? null : Number(e.branch_id)));
    return m;
  }, [employees]);
  const empName = useMemo(() => {
    const m = new Map<number, string>();
    employees.forEach((e) => m.set(Number(e.id), e.name));
    return m;
  }, [employees]);
  const bName = useMemo(() => {
    const m = new Map<number, string>();
    branches.forEach((b) => m.set(Number(b.id), b.name));
    return (id: unknown) => m.get(Number(id)) ?? "—";
  }, [branches]);

  /* Three buckets, and the third is the honest one. */
  const { crossed, pairs, notRecorded, sameShop } = useMemo(() => {
    const crossed: (LedRow & { owner: number })[] = [];
    const key = new Map<string, Pair>();
    let notRecorded = 0, sameShop = 0;

    rows.forEach((r) => {
      const paidBy = r.branch_id == null ? null : Number(r.branch_id);
      const owner = r.employee_id == null ? null : empBranch.get(Number(r.employee_id)) ?? null;
      if (paidBy == null) { notRecorded += num(r.advance); return; }
      if (owner == null || owner === paidBy) { sameShop += num(r.advance); return; }
      crossed.push({ ...r, owner });
      const k = `${owner}|${paidBy}`;
      const p = key.get(k) ?? { from: owner, to: paidBy, amount: 0, n: 0 };
      p.amount += num(r.advance); p.n++;
      key.set(k, p);
    });
    return {
      crossed,
      pairs: [...key.values()].sort((a, b) => b.amount - a.amount),
      notRecorded, sameShop,
    };
  }, [rows, empBranch]);

  /* Net per shop: positive means the shop is OWED, negative means it owes. */
  const net = useMemo(() => {
    const m = new Map<number, number>();
    pairs.forEach((p) => {
      m.set(p.to, (m.get(p.to) ?? 0) + p.amount);     // paid out, is owed
      m.set(p.from, (m.get(p.from) ?? 0) - p.amount); // employer owes
    });
    return [...m.entries()].map(([id, amount]) => ({ id, amount }))
      .filter((x) => Math.abs(x.amount) >= 0.5)
      .sort((a, b) => b.amount - a.amount);
  }, [pairs]);

  const cols: Col<LedRow & { owner: number }>[] = [
    { head: "Date", bold: true, cell: (r) => r.entry_date },
    { head: "Who", cell: (r) => empName.get(Number(r.employee_id)) ?? "—" },
    { head: "Works at", muted: true, cell: (r) => bName(r.owner) },
    { head: "Paid by", cell: (r) => bName(r.branch_id) },
    { head: "Amount", right: true, bold: true, cell: (r) => money(num(r.advance)) },
    { head: "Note", muted: true, cell: (r) => r.purchase_details ?? "—" },
  ];

  return (
    <>
      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">{err}</p>}

      {!loading && notRecorded > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-amber/30 bg-amber-soft p-4 dark:border-amber/30 dark:bg-amber/10">
          <AlertTriangle size={17} className="flex-none text-amber-strong dark:text-amber" />
          <p className="flex-1 text-[13px] text-ink dark:text-[#e7e2d8]">
            <strong>{money(notRecorded)}</strong> of advances in this range do not say which till paid
            them — they were written before the app started recording it. They are left out of the
            settlement rather than assumed to be the employee&apos;s own shop.
          </p>
        </div>
      )}

      {!loading && pairs.length === 0 && (
        <p className="mt-6 rounded-card border border-line bg-surface p-8 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">
          Nothing to settle. Every advance in this range was paid by the shop the person works at
          {sameShop > 0 && <> — {money(sameShop)} of them</>}.
        </p>
      )}

      {pairs.length > 0 && (
        <>
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3 dark:border-white/[0.08]">
              <Scale size={16} className="flex-none text-muted dark:text-[#a89f93]" />
              <h3 className="text-[14px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">To settle</h3>
            </div>
            {pairs.map((p) => (
              <div key={`${p.from}|${p.to}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 last:border-b-0 dark:border-white/[0.08]">
                <span className="flex min-w-0 flex-wrap items-center gap-2 text-[13.5px]">
                  <span className="font-bold text-ink dark:text-[#e7e2d8]">{bName(p.from)}</span>
                  <ArrowRight size={14} className="flex-none text-hint" />
                  <span className="font-bold text-ink dark:text-[#e7e2d8]">{bName(p.to)}</span>
                  <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
                    {p.n} advance{p.n === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="flex-none text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(p.amount)}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="border-b border-line px-5 py-3 text-[11.5px] font-bold uppercase tracking-wide text-muted dark:border-white/[0.08] dark:text-[#a89f93]">
              Net per shop
            </div>
            {net.map((n) => (
              <div key={n.id} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 last:border-b-0 dark:border-white/[0.08]">
                <span className="text-[13.5px] font-semibold text-ink dark:text-[#e7e2d8]">{bName(n.id)}</span>
                <span className={`text-[14.5px] font-extrabold tabular-nums ${n.amount > 0 ? "text-success" : "text-danger"}`}>
                  {n.amount > 0 ? `is owed ${money(n.amount)}` : `owes ${money(-n.amount)}`}
                </span>
              </div>
            ))}
          </div>

          {!phone && (
            <div className="mt-3">
              <DataTable cols={cols} rows={crossed} loading={loading} minWidth={900} empty="Nothing crossed shops." />
            </div>
          )}
        </>
      )}

      <SourceNote>
        An advance is two facts: a till is short, and a person owes. They are the same shop nearly
        always, and when somebody has moved they are not. This compares the shop that actually paid
        — recorded on the ledger row since migration 0135 — against the shop the person works at
        today, and nets the difference. The employee still repays out of his own salary wherever he
        is paid; this is only the shops squaring up with each other.
      </SourceNote>
    </>
  );
}
