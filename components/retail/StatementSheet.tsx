"use client";
/* THE RECEIPT. One component, four screens.
 *
 * The grids answer "which day was odd". They are the wrong shape for the thing
 * actually asked at the end of a day or a week — read me the figure — and a
 * matrix is not something anybody reads out over the phone or hands to a shop.
 *
 * So: a button, a date, and a till-roll. Shop by shop, a rule, a total. It
 * fetches its OWN figures for the dates you pick, so opening it never disturbs
 * the screen behind it and you can ask about the 19th while looking at the 21st.
 *
 * Every number comes from the same database roll-ups the screens use —
 * retail_commission_calc, retail_sales_agg_m, retail_expense_rollup — so a
 * statement can never quietly disagree with the screen it was opened from.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReceiptText, Printer, Share2 } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal from "@/components/Modal";
import { money, num, today, addDays, type Branch } from "@/components/retail/kit";
import { shareOrCopy } from "@/lib/retailShare";

export type StatementKind = "commission" | "sales" | "noncash" | "expenses";

const TITLE: Record<StatementKind, string> = {
  commission: "Commission",
  sales: "Sales",
  noncash: "Non-cash payments",
  expenses: "Expenses",
};

type Line = { key: string; label: string; amount: number; sub?: string };
type Block = { heading: string; lines: Line[]; total: number };

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const dayWords = (ds: string) => {
  const [y, m, d] = ds.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

export function StatementButton({ kind, branchIds, branches, className }: {
  kind: StatementKind;
  /** The shops this screen answers for. null means every shop. */
  branchIds: number[] | null;
  branches: Branch[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className={className ?? "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]"}>
        <ReceiptText size={14} /> Statement
      </button>
      <Modal open={open} onClose={() => setOpen(false)} wide
        title={`${TITLE[kind]} statement`} subtitle="Pick the days. The figures come straight from the database.">
        <StatementSheet kind={kind} branchIds={branchIds} branches={branches} />
      </Modal>
    </>
  );
}

export default function StatementSheet({ kind, branchIds, branches }: {
  kind: StatementKind; branchIds: number[] | null; branches: Branch[];
}) {
  const t0 = today();
  const [from, setFrom] = useState(t0);
  const [to, setTo] = useState(t0);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const dTo = to > t0 ? t0 : to;
  const bad = from > dTo;

  const name = useMemo(() => {
    const m = new Map<number, { name: string; chain: string }>();
    branches.forEach((b) => m.set(Number(b.id), { name: b.name, chain: String(b.chain ?? "").trim() || "Other" }));
    return m;
  }, [branches]);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || bad) { setBlocks(null); return; }
    const db = supabase;
    setLoading(true); setErr("");

    /* One request. Each of these roll-ups already groups server-side, which is
       why a statement for a year costs the same as one for a day. */
    const ids = branchIds && branchIds.length ? branchIds : null;
    let out: Block[] = [];

    if (kind === "commission") {
      const { data, error } = await db.rpc("retail_commission_calc", { p_from: from, p_to: dTo, p_branches: ids });
      if (error) { setErr(error.message); setLoading(false); return; }
      const per = new Map<number, { pp: number; bonus: number }>();
      ((data as { branch_id: number; per_piece: number | null; bonus: number | null }[]) ?? []).forEach((r) => {
        const k = Number(r.branch_id);
        const a = per.get(k) ?? { pp: 0, bonus: 0 };
        a.pp += num(r.per_piece); a.bonus += num(r.bonus); per.set(k, a);
      });
      out = groupByChain([...per.entries()].map(([id, a]) => ({
        key: String(id), label: name.get(id)?.name ?? `Shop ${id}`,
        amount: Math.round(a.pp + a.bonus),
        sub: `Per-piece ${money(a.pp)}${a.bonus > 0 ? ` · Bonus ${money(a.bonus)}` : ""}`,
        chain: name.get(id)?.chain ?? "Other",
      })));
    }

    else if (kind === "sales" || kind === "noncash") {
      const { data, error } = await db.rpc("retail_sales_agg_m", {
        p_from: from, p_to: dTo, p_branches: ids,
        p_by: kind === "sales" ? ["branch_id", "receipts"] : ["branch_id", "payment_method"],
      });
      if (error) { setErr(error.message); setLoading(false); return; }
      type R = { branch_id: number; payment_method: string | null; sales: number | null; receipts: number | null };
      const rows = (data as R[]) ?? [];
      if (kind === "sales") {
        out = groupByChain(rows.map((r) => ({
          key: String(r.branch_id), label: name.get(Number(r.branch_id))?.name ?? `Shop ${r.branch_id}`,
          amount: num(r.sales),
          sub: num(r.receipts) > 0 ? `${num(r.receipts).toLocaleString()} bills` : undefined,
          chain: name.get(Number(r.branch_id))?.chain ?? "Other",
        })));
      } else {
        /* Non-cash is about HOW it was paid, so the shop is the heading and the
           payment method is the line. Cash is left out on purpose — this is the
           non-cash sheet, and including it would make the total read as the
           day's takings. */
        const byShop = new Map<number, Line[]>();
        rows.forEach((r) => {
          const pm = String(r.payment_method ?? "unclassified");
          if (pm === "cash") return;
          const k = Number(r.branch_id);
          (byShop.get(k) ?? byShop.set(k, []).get(k)!).push({
            key: `${k}|${pm}`, label: PM_LABEL[pm] ?? pm, amount: num(r.sales),
          });
        });
        out = [...byShop.entries()]
          .map(([id, lines]) => ({
            heading: name.get(id)?.name ?? `Shop ${id}`,
            lines: lines.sort((a, b) => b.amount - a.amount),
            total: lines.reduce((a, l) => a + l.amount, 0),
          }))
          .filter((b) => b.lines.length > 0)
          .sort((a, b) => a.heading.localeCompare(b.heading));
      }
    }

    else {
      const { data, error } = await db.rpc("retail_expense_rollup", {
        p_from: from, p_to: dTo, p_branch: ids && ids.length === 1 ? ids[0] : null, p_by: ["branch_id", "category"],
      });
      if (error) { setErr(error.message); setLoading(false); return; }
      type R = { branch_id: number; category: string | null; expense: number | null; income: number | null };
      const rows = ((data as R[]) ?? []).filter((r) => !ids || ids.includes(Number(r.branch_id)));
      const byShop = new Map<number, Line[]>();
      rows.forEach((r) => {
        /* Income is the same table with the sign flipped, so it comes OFF the
           expense rather than being listed as one. */
        const net = num(r.expense) - num(r.income);
        if (Math.abs(net) < 0.005) return;
        const k = Number(r.branch_id);
        (byShop.get(k) ?? byShop.set(k, []).get(k)!).push({
          key: `${k}|${r.category}`, label: String(r.category ?? "Uncategorised"), amount: net,
        });
      });
      out = [...byShop.entries()]
        .map(([id, lines]) => ({
          heading: name.get(id)?.name ?? `Shop ${id}`,
          lines: lines.sort((a, b) => b.amount - a.amount),
          total: lines.reduce((a, l) => a + l.amount, 0),
        }))
        .sort((a, b) => a.heading.localeCompare(b.heading));
    }

    setBlocks(out);
    setLoading(false);
  }, [kind, from, dTo, bad, branchIds ? branchIds.join(",") : "all", name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  function groupByChain(items: (Line & { chain: string })[]): Block[] {
    const m = new Map<string, Line[]>();
    items.filter((i) => i.amount !== 0).forEach((i) => {
      (m.get(i.chain) ?? m.set(i.chain, []).get(i.chain)!).push(i);
    });
    return [...m.entries()]
      .map(([heading, lines]) => ({
        heading, lines: lines.sort((a, b) => a.label.localeCompare(b.label)),
        total: lines.reduce((a, l) => a + l.amount, 0),
      }))
      .sort((a, b) => a.heading.localeCompare(b.heading));
  }

  const grand = (blocks ?? []).reduce((a, b) => a + b.total, 0);
  const when = from === dTo ? dayWords(from) : `${dayWords(from)} — ${dayWords(dTo)}`;

  async function share() {
    const lines = [`*${TITLE[kind]}*`, when, ""];
    (blocks ?? []).forEach((b) => {
      lines.push(`*${b.heading}*`);
      b.lines.forEach((l) => lines.push(`${l.label}: ${money(l.amount)}`));
      if ((blocks ?? []).length > 1) lines.push(`${b.heading} total: ${money(b.total)}`);
      lines.push("");
    });
    lines.push(`*Total: ${money(grand)}*`);
    const r = await shareOrCopy(lines.join("\n"), TITLE[kind]);
    if (r === "cancelled") return;
    setNote(r === "shared" ? "Sent." : r === "copied" ? "Copied — paste it into WhatsApp." : "Could not share.");
    setTimeout(() => setNote(""), 4000);
  }

  const quick = (label: string, f: string, t: string) => (
    <button key={label} onClick={() => { setFrom(f); setTo(t); }}
      className={`min-h-[36px] rounded-full border px-3 text-[12px] font-semibold transition ${
        from === f && dTo === t
          ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
          : "border-line bg-surface text-muted hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* ── pick the days ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {quick("Today", t0, t0)}
        {quick("Yesterday", addDays(t0, -1), addDays(t0, -1))}
        {quick("Last 7 days", addDays(t0, -6), t0)}
        {quick("This month", t0.slice(0, 8) + "01", t0)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 max-md:w-full">
          <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">From</span>
          <input type="date" value={from} max={t0} onChange={(e) => setFrom(e.target.value)}
            className="min-h-[40px] rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink max-md:flex-1 dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
        </label>
        <label className="flex items-center gap-2 max-md:w-full">
          <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">To</span>
          <input type="date" value={dTo} max={t0} onChange={(e) => setTo(e.target.value)}
            className="min-h-[40px] rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink max-md:flex-1 dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
        </label>
      </div>

      {bad && <p className="text-[12.5px] font-semibold text-danger">From is after To — nothing to show.</p>}
      {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}

      {/* ── the till roll ─────────────────────────────────────────────── */}
      <div id="rt-statement" className="overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="border-b border-dashed border-line px-5 py-4 text-center dark:border-white/[0.12]">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-hint dark:text-[#8a8175]">Shops Sales</div>
          <h2 className="mt-1 text-[19px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{TITLE[kind]}</h2>
          <p className="mt-0.5 text-[13px] text-muted dark:text-[#a89f93]">{when}</p>
        </div>

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[40px] animate-pulse rounded-lg bg-panel/70 dark:bg-white/[0.05]" />)}
          </div>
        ) : !blocks || blocks.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">
            Nothing recorded for {when}.
          </p>
        ) : (
          <>
            {blocks.map((b) => (
              <div key={b.heading} className="border-b border-dashed border-line last:border-b-0 dark:border-white/[0.12]">
                {blocks.length > 1 && (
                  <div className="bg-panel/60 px-5 py-2 text-[11.5px] font-bold uppercase tracking-wide text-muted dark:bg-white/[0.04] dark:text-[#a89f93]">
                    {b.heading}
                  </div>
                )}
                {b.lines.map((l) => (
                  <div key={l.key} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold text-ink dark:text-[#e7e2d8]">{l.label}</span>
                      {l.sub && <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">{l.sub}</span>}
                    </span>
                    <span className="flex-none text-[15px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{money(l.amount)}</span>
                  </div>
                ))}
                {blocks.length > 1 && (
                  <div className="flex items-baseline justify-between gap-3 border-t border-line px-5 py-2 dark:border-white/[0.08]">
                    <span className="text-[12px] font-bold text-muted dark:text-[#a89f93]">{b.heading} total</span>
                    <span className="text-[13.5px] font-extrabold tabular-nums text-muted dark:text-[#a89f93]">{money(b.total)}</span>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 bg-ink px-5 py-4 text-white dark:bg-white dark:text-[#141414]">
              <span className="text-[13.5px] font-bold">Total {TITLE[kind].toLowerCase()}</span>
              <span className="text-[22px] font-extrabold tabular-nums">{money(grand)}</span>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {note && <span className="mr-auto text-[12.5px] font-semibold text-success">{note}</span>}
        <button onClick={share} disabled={!blocks || blocks.length === 0}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <Share2 size={14} /> Share
        </button>
        <button onClick={() => window.print()} disabled={!blocks || blocks.length === 0}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <Printer size={14} /> Print
        </button>
      </div>
    </div>
  );
}

const PM_LABEL: Record<string, string> = {
  meezan_card: "Card (Meezan)",
  card: "Card",
  jazzcash: "JazzCash",
  online: "Online transfer",
  credit: "Credit (udhaar)",
  unclassified: "Not yet classified",
};
