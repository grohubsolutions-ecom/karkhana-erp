"use client";
/* THE STATEMENT. One component, four screens.
 *
 * WHAT IT IS FOR, and what it deliberately is not.
 *
 * The grids answer "which day was odd". They are the wrong shape for the thing
 * actually asked at the end of a day — read me the figure — and a matrix is not
 * something anybody reads out over the phone or hands to a shop.
 *
 * The first version of this printed per-piece, bonus and a day count under
 * every shop. The owner's answer was short: no details. He is right. A payout
 * sheet is a numbered list of shops, an amount each, and a total, and every
 * extra figure on it is something to be argued about rather than paid. The
 * breakdown still exists one tap away on the screen behind; it is not what you
 * hand somebody.
 *
 * So: a numbered list, a total, a date spelled out, and two ways to get it out
 * of the screen — a printed page and a PNG for WhatsApp.
 *
 * Every number comes from the same database roll-ups the screens use —
 * retail_commission_calc, retail_sales_agg_m, retail_expense_rollup — so a
 * statement can never quietly disagree with the screen it was opened from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReceiptText, Printer, ImageDown, Share2 } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal from "@/components/Modal";
import { money, num, today, addDays, type Branch } from "@/components/retail/kit";
import { shareOrCopy } from "@/lib/retailShare";

export type StatementKind = "commission" | "sales" | "noncash" | "expenses";

const NOUN: Record<StatementKind, string> = {
  commission: "COMMISSION",
  sales: "SALES",
  noncash: "NON-CASH",
  expenses: "EXPENSES",
};
const TITLE: Record<StatementKind, string> = {
  commission: "Commission", sales: "Sales", noncash: "Non-cash", expenses: "Expenses",
};

type Line = { name: string; amount: number };

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const dayWords = (ds: string) => {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DOW[dt.getUTCDay()]}, ${d} ${MON[m - 1]} ${y}`;
};
const shortDay = (ds: string) => {
  const [y, m, d] = ds.split("-").map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
};

export function StatementButton({ kind, branchIds, branches, className }: {
  kind: StatementKind; branchIds: number[] | null; branches: Branch[]; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className={className ?? "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]"}>
        <ReceiptText size={14} /> Statement
      </button>
      <Modal open={open} onClose={() => setOpen(false)} wide
        title={`${TITLE[kind]} statement`} subtitle="Pick the days. Print it, save it as a picture, or send it.">
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
  const [lines, setLines] = useState<Line[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);

  const dTo = to > t0 ? t0 : to;
  const bad = from > dTo;
  const oneDay = from === dTo;

  const byId = useMemo(() => {
    const m = new Map<number, { name: string; chain: string }>();
    branches.forEach((b) => m.set(Number(b.id), { name: b.name, chain: String(b.chain ?? "").trim() || "Other" }));
    return m;
  }, [branches]);

  /* The name across the top. One shop names itself, one chain names the chain,
     anything wider is every shop. */
  const scopeName = useMemo(() => {
    const ids = branchIds && branchIds.length ? branchIds : [...byId.keys()];
    if (ids.length === 1) return (byId.get(ids[0])?.name ?? "SHOP").toUpperCase();
    const chains = new Set(ids.map((i) => byId.get(i)?.chain).filter(Boolean));
    if (chains.size === 1) return String([...chains][0]).toUpperCase();
    return "ALL SHOPS";
  }, [branchIds ? branchIds.join(",") : "all", byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || bad) { setLines(null); return; }
    const db = supabase;
    setLoading(true); setErr("");
    const ids = branchIds && branchIds.length ? branchIds : null;
    const per = new Map<number, number>();
    const add = (id: unknown, v: number) => {
      const k = Number(id);
      if (!Number.isFinite(k)) return;
      per.set(k, (per.get(k) ?? 0) + v);
    };

    if (kind === "commission") {
      const { data, error } = await db.rpc("retail_commission_calc", { p_from: from, p_to: dTo, p_branches: ids });
      if (error) { setErr(error.message); setLoading(false); return; }
      ((data as { branch_id: number; per_piece: number | null; bonus: number | null }[]) ?? [])
        .forEach((r) => add(r.branch_id, num(r.per_piece) + num(r.bonus)));
    } else if (kind === "sales" || kind === "noncash") {
      const { data, error } = await db.rpc("retail_sales_agg_m", {
        p_from: from, p_to: dTo, p_branches: ids,
        p_by: kind === "sales" ? ["branch_id"] : ["branch_id", "payment_method"],
      });
      if (error) { setErr(error.message); setLoading(false); return; }
      ((data as { branch_id: number; payment_method: string | null; sales: number | null }[]) ?? [])
        /* Non-cash means everything that did NOT go in the till as cash. */
        .filter((r) => kind === "sales" || String(r.payment_method ?? "") !== "cash")
        .forEach((r) => add(r.branch_id, num(r.sales)));
    } else {
      const { data, error } = await db.rpc("retail_expense_rollup", {
        p_from: from, p_to: dTo, p_branch: ids && ids.length === 1 ? ids[0] : null, p_by: ["branch_id"],
      });
      if (error) { setErr(error.message); setLoading(false); return; }
      ((data as { branch_id: number; expense: number | null; income: number | null }[]) ?? [])
        .filter((r) => !ids || ids.includes(Number(r.branch_id)))
        /* Income is the same table with the sign flipped: it comes off the
           expense rather than being listed as one. */
        .forEach((r) => add(r.branch_id, num(r.expense) - num(r.income)));
    }

    setLines(
      [...per.entries()]
        .map(([id, amount]) => ({ name: byId.get(id)?.name ?? `Shop ${id}`, amount: Math.round(amount) }))
        .filter((l) => l.amount !== 0)
        .sort((a, b) => b.amount - a.amount)
    );
    setLoading(false);
  }, [kind, from, dTo, bad, branchIds ? branchIds.join(",") : "all", byId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const total = (lines ?? []).reduce((a, l) => a + l.amount, 0);
  const when = oneDay ? dayWords(from) : `${shortDay(from)} — ${shortDay(dTo)}`;
  const heading = `${scopeName} — ${oneDay ? "DAILY " : ""}${NOUN[kind]}`;

  /* ── PRINT ────────────────────────────────────────────────────────────
     A class on <body> plus a print rule in retail-mobile.css that leaves only
     the sheet visible. Set it, print, take it off again — a stylesheet that
     stayed on would silently break every other print on the site. */
  function print() {
    const b = document.body;
    b.classList.add("rt-printing");
    const off = () => { b.classList.remove("rt-printing"); window.removeEventListener("afterprint", off); };
    window.addEventListener("afterprint", off);
    window.print();
    /* Safari does not always fire afterprint. */
    setTimeout(off, 3000);
  }

  /* ── PNG ──────────────────────────────────────────────────────────────
     Drawn on a canvas rather than screenshotting the DOM. html2canvas is
     another dependency, it needs every font and colour inlined, and it fails
     quietly on exactly the thing that matters here — a figure that renders a
     pixel off is a figure somebody pays. The sheet is a list of rows: drawing
     it directly is both smaller and exact. */
  function png() {
    const rows = lines ?? [];
    const W = 1100, PAD = 48, HEAD = 190, ROW = 62, TOTAL = 86, FOOT = 64;
    const H = HEAD + rows.length * ROW + TOTAL + FOOT;
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = W * scale; c.height = H * scale;
    const x = c.getContext("2d");
    if (!x) return;
    x.scale(scale, scale);
    const F = (w: number, s: number) => `${w} ${s}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;

    x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H);

    const g = x.createLinearGradient(0, 0, W, HEAD);
    g.addColorStop(0, "#1d4ed8"); g.addColorStop(1, "#1e3a8a");
    x.fillStyle = g; x.fillRect(0, 0, W, HEAD);
    x.fillStyle = "rgba(255,255,255,0.82)"; x.font = F(700, 20);
    x.fillText(heading, PAD, 72);
    x.fillStyle = "#ffffff"; x.font = F(800, 46);
    x.fillText(when, PAD, 132);

    let y = HEAD;
    rows.forEach((l, i) => {
      if (i % 2) { x.fillStyle = "#f8fafc"; x.fillRect(0, y, W, ROW); }
      x.fillStyle = "#94a3b8"; x.font = F(700, 20);
      x.fillText(String(i + 1), PAD, y + ROW / 2 + 7);
      x.fillStyle = "#0f172a"; x.font = F(700, 25);
      x.fillText(l.name, PAD + 54, y + ROW / 2 + 8);
      x.font = F(800, 25); x.textAlign = "right";
      x.fillText(money(l.amount), W - PAD, y + ROW / 2 + 8);
      x.textAlign = "left";
      x.strokeStyle = "#e2e8f0"; x.lineWidth = 1;
      x.beginPath(); x.moveTo(0, y + ROW - 0.5); x.lineTo(W, y + ROW - 0.5); x.stroke();
      y += ROW;
    });

    x.fillStyle = "#0f172a"; x.fillRect(0, y, W, TOTAL);
    x.fillStyle = "#ffffff"; x.font = F(800, 27);
    x.fillText("TOTAL", PAD, y + TOTAL / 2 + 10);
    x.textAlign = "right"; x.font = F(800, 34);
    x.fillText(money(total), W - PAD, y + TOTAL / 2 + 12);
    x.textAlign = "left";
    y += TOTAL;

    x.fillStyle = "#64748b"; x.font = F(500, 18);
    x.fillText(`Grohub Solutions · Shops Sales · ${when}`, PAD, y + FOOT / 2 + 6);

    const a = document.createElement("a");
    a.download = `${TITLE[kind].toLowerCase()}-${oneDay ? from : `${from}_to_${dTo}`}.png`;
    a.href = c.toDataURL("image/png");
    a.click();
    setNote("Picture saved.");
    setTimeout(() => setNote(""), 4000);
  }

  async function share() {
    const t = [`*${heading}*`, when, ""];
    (lines ?? []).forEach((l, i) => t.push(`${i + 1}. ${l.name}: ${money(l.amount)}`));
    t.push("", `*TOTAL: ${money(total)}*`);
    const r = await shareOrCopy(t.join("\n"), TITLE[kind]);
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
  const dateCls = "min-h-[40px] rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink max-md:flex-1 dark:border-white/10 dark:bg-white/[0.06] dark:text-white";
  const actionCls = "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white";
  const empty = !loading && (!lines || lines.length === 0);

  return (
    <div className="space-y-4">
      {/* ── the days ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rt-noprint">
        {quick("Today", t0, t0)}
        {quick("Yesterday", addDays(t0, -1), addDays(t0, -1))}
        {quick("Last 7 days", addDays(t0, -6), t0)}
        {quick("This month", t0.slice(0, 8) + "01", t0)}
      </div>
      <div className="flex flex-wrap items-center gap-2 rt-noprint">
        <label className="flex items-center gap-2 max-md:w-full">
          <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">From</span>
          <input type="date" value={from} max={t0} onChange={(e) => setFrom(e.target.value)} className={dateCls} />
        </label>
        <label className="flex items-center gap-2 max-md:w-full">
          <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">To</span>
          <input type="date" value={dTo} max={t0} onChange={(e) => setTo(e.target.value)} className={dateCls} />
        </label>
      </div>

      {bad && <p className="text-[12.5px] font-semibold text-danger rt-noprint">From is after To — nothing to show.</p>}
      {err && <p className="text-[12.5px] font-semibold text-danger rt-noprint">{err}</p>}

      {/* ── the sheet ────────────────────────────────────────────────── */}
      <div id="rt-statement" ref={sheetRef}
        className="overflow-hidden rounded-card border border-line bg-white shadow-sm dark:border-white/[0.08]">
        <div className="bg-gradient-to-br from-[#1d4ed8] to-[#1e3a8a] px-6 py-6 text-white">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-white/80">{heading}</div>
          <div className="mt-1.5 text-[26px] font-extrabold leading-tight tracking-tight">{when}</div>
        </div>

        {loading ? (
          <div className="space-y-2 p-6">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[44px] animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : empty ? (
          <p className="px-6 py-14 text-center text-[13.5px] text-slate-500">Nothing recorded for {when}.</p>
        ) : (
          <>
            <div className="grid grid-cols-[46px_1fr_auto] items-center gap-3 border-b border-slate-200 bg-slate-50 px-6 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
              <span>#</span><span>Shop</span><span className="text-right">{TITLE[kind]}</span>
            </div>
            {(lines ?? []).map((l, i) => (
              <div key={l.name}
                className={`grid grid-cols-[46px_1fr_auto] items-center gap-3 border-b border-slate-100 px-6 py-3.5 ${i % 2 ? "bg-slate-50/60" : ""}`}>
                <span className="text-[14px] font-bold text-slate-400">{i + 1}</span>
                <span className="truncate text-[15px] font-bold text-slate-900">{l.name}</span>
                <span className="text-right text-[16px] font-extrabold tabular-nums text-slate-900">{money(l.amount)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 bg-slate-900 px-6 py-4 text-white">
              <span className="text-[14px] font-extrabold tracking-wide">TOTAL</span>
              <span className="text-[24px] font-extrabold tabular-nums">{money(total)}</span>
            </div>
          </>
        )}
        <div className="px-6 py-3 text-[11.5px] text-slate-400">
          Grohub Solutions · Shops Sales · {when}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 rt-noprint">
        {note && <span className="mr-auto text-[12.5px] font-semibold text-success">{note}</span>}
        <button onClick={share} disabled={empty} className={actionCls}><Share2 size={14} /> Share</button>
        <button onClick={png} disabled={empty} className={actionCls}><ImageDown size={14} /> Download image</button>
        <button onClick={print} disabled={empty}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-[#141414]">
          <Printer size={14} /> Print / PDF
        </button>
      </div>
    </div>
  );
}
