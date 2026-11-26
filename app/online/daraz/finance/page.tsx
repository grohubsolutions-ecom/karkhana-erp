"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Download, Wallet } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { HubRange, PageActions, Segmented } from "@/components/HubUI";
import { MONEY_PRESETS, rangeDates, num, rs } from "@/lib/dateRange";
import { exportCSV } from "@/lib/export";
import { settleClass } from "@/lib/daraz";

type Fee = { fee_name: string; lines: number; amount: number; paid: number; unpaid: number };
type Stmt = { statement: string; first_txn: string | null; last_txn: string | null; lines: number; orders: number; credits: number; debits: number; net: number; paid: boolean };
type Row = Record<string, unknown>;
type Tab = "fees" | "statements" | "awaiting";

/* DARAZ FINANCE. Daraz pays by statement: every order's sale is credited and
   its commission, payment fee, shipping and vouchers are debited against it.
   Fees and statements are dated by TRANSACTION date; "Awaiting payout" lists
   delivered orders whose money is not yet paid, oldest first. */
export default function DarazFinancePage() {
  const [tab, setTab] = useState<Tab>("fees");
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [fees, setFees] = useState<Fee[]>([]);
  const [stmts, setStmts] = useState<Stmt[]>([]);
  const [awaiting, setAwaiting] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [coverFrom, setCoverFrom] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const [from, to] = rangeDates(preset, cf, ct);
    /* Only orders from the period the uploaded statements cover can be "awaiting
       payout": an order delivered a year ago was paid in a statement that was
       never uploaded, not left unpaid. Window = earliest statement line − 14 days. */
    const first = await supabase.from("daraz_statement_lines").select("txn_date")
      .not("txn_date", "is", null).order("txn_date", { ascending: true }).limit(1);
    const firstTxn = (first.data as { txn_date: string }[] | null)?.[0]?.txn_date;
    const since = firstTxn ? new Date(new Date(firstTxn).getTime() - 14 * 86400000).toISOString().slice(0, 10) : null;
    setCoverFrom(since);
    let aq = supabase.from("daraz_orders_v")
      .select("order_number,order_date,customer_name,paid_value,settlement,net_payout,unpaid_net,statement")
      .eq("status_group", "Delivered").neq("settlement", "Paid")
      .order("order_date", { ascending: true }).limit(1000);
    if (since) aq = aq.gte("order_date", since);
    const [f, s, a] = await Promise.all([
      supabase.rpc("daraz_fee_breakdown", { p_from: from, p_to: to }),
      supabase.rpc("daraz_statements", { p_from: from, p_to: to }),
      since ? aq : Promise.resolve({ data: [], error: null }),
    ]);
    if (my !== reqId.current) return;
    const e = f.error ?? s.error ?? a.error; if (e) setErr(e.message);
    setFees((f.data as Fee[]) ?? []); setStmts((s.data as Stmt[]) ?? []); setAwaiting((a.data as Row[]) ?? []);
    setLoading(false);
  }, [preset, cf, ct]);
  useEffect(() => { load(); }, [load]);

  const tot = (k: keyof Fee) => fees.reduce((t, x) => t + num(x[k]), 0);
  const credits = fees.filter((x) => num(x.amount) > 0).reduce((t, x) => t + num(x.amount), 0);
  const debits = fees.filter((x) => num(x.amount) < 0).reduce((t, x) => t + num(x.amount), 0);
  const awaitVal = awaiting.reduce((t, x) => t + num(x.paid_value), 0);
  const cards = [
    { label: "Credits (sales)", value: rs(credits) },
    { label: "Fees & deductions", value: rs(debits), sub: credits ? `${Math.abs((debits / credits) * 100).toFixed(1)}% of credits` : "" },
    { label: "Net", value: rs(tot("amount")) },
    { label: "Paid out", value: rs(tot("paid")) },
    { label: "Unpaid in statements", value: rs(tot("unpaid")) },
    { label: "Delivered, payout pending", value: rs(awaitVal), sub: `${awaiting.length} orders${coverFrom ? ` · since ${coverFrom}` : ""}` },
  ];

  function doExport() {
    if (tab === "fees") exportCSV({ title: "Daraz fees", headers: ["Fee", "Lines", "Amount", "Paid", "Unpaid"], rows: fees.map((x) => [x.fee_name, num(x.lines), num(x.amount), num(x.paid), num(x.unpaid)]) });
    else if (tab === "statements") exportCSV({ title: "Daraz statements", headers: ["Statement", "From", "To", "Lines", "Orders", "Credits", "Debits", "Net", "Paid"], rows: stmts.map((x) => [x.statement, x.first_txn ?? "", x.last_txn ?? "", num(x.lines), num(x.orders), num(x.credits), num(x.debits), num(x.net), x.paid ? "Paid" : "Unpaid"]) });
    else exportCSV({ title: "Daraz awaiting payout", headers: ["Order #", "Date", "Customer", "Value", "Payout", "Unpaid in statement"], rows: awaiting.map((x) => [String(x.order_number), String(x.order_date ?? ""), String(x.customer_name ?? ""), num(x.paid_value), String(x.settlement), num(x.unpaid_net)]) });
  }

  const th = "px-4 py-3 font-semibold";
  const td = "px-4 py-2.5";
  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Daraz · Finance</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">From uploaded account statements. Dates are Daraz transaction dates.</p>
        </div>
        <PageActions>
          <button onClick={doExport} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white"><Download size={14} /> Export</button>
          <button onClick={load} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} presets={MONEY_PRESETS} />

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted dark:text-[#a89f93]"><Wallet size={13} /> {c.label}</div>
            <div className="mt-1 text-[17px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : c.value}</div>
            {c.sub && <div className="text-[11.5px] text-hint">{c.sub}</div>}
          </div>
        ))}
      </div>

      <Segmented className="mt-5" value={tab} onChange={setTab} options={[
        { key: "fees", label: "By fee type", short: "Fees" },
        { key: "statements", label: "Statements", short: "Statements" },
        { key: "awaiting", label: `Awaiting payout (${awaiting.length})`, short: "Awaiting" },
      ]} />

      {err && <p className="mt-4 text-[13px] text-danger">{err}</p>}
      <div className="mt-4 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <table className="w-full min-w-[640px] text-left text-[13px] text-ink dark:text-[#e7e2d8]">
          {tab === "fees" && (<>
            <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06]">
              <th className={th}>Fee / credit</th><th className={th + " text-right"}>Lines</th><th className={th + " text-right"}>Amount</th><th className={th + " text-right"}>Paid</th><th className={th + " text-right"}>Unpaid</th></tr></thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {fees.length === 0 ? <tr><td colSpan={5} className="px-4 py-14 text-center text-muted">{loading ? "Loading…" : "No statement lines in this period — upload an account statement."}</td></tr>
                : fees.map((x) => (
                  <tr key={x.fee_name}>
                    <td className={td + " font-semibold"}>{x.fee_name}</td>
                    <td className={td + " text-right tabular-nums"}>{num(x.lines).toLocaleString()}</td>
                    <td className={`${td} text-right font-semibold tabular-nums ${num(x.amount) < 0 ? "text-danger" : ""}`}>{rs(num(x.amount))}</td>
                    <td className={td + " text-right tabular-nums text-muted"}>{rs(num(x.paid))}</td>
                    <td className={td + " text-right tabular-nums text-muted"}>{rs(num(x.unpaid))}</td>
                  </tr>))}
            </tbody></>)}
          {tab === "statements" && (<>
            <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06]">
              <th className={th}>Statement</th><th className={th}>Period</th><th className={th + " text-right"}>Orders</th><th className={th + " text-right"}>Credits</th><th className={th + " text-right"}>Debits</th><th className={th + " text-right"}>Net</th><th className={th}>Status</th></tr></thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {stmts.length === 0 ? <tr><td colSpan={7} className="px-4 py-14 text-center text-muted">{loading ? "Loading…" : "No statements in this period."}</td></tr>
                : stmts.map((x) => (
                  <tr key={x.statement}>
                    <td className={td + " font-semibold"}>{x.statement}</td>
                    <td className={td + " text-muted"}>{x.first_txn ?? "—"} → {x.last_txn ?? "—"}</td>
                    <td className={td + " text-right tabular-nums"}>{num(x.orders).toLocaleString()}</td>
                    <td className={td + " text-right tabular-nums"}>{rs(num(x.credits))}</td>
                    <td className={td + " text-right tabular-nums text-danger"}>{rs(num(x.debits))}</td>
                    <td className={td + " text-right font-semibold tabular-nums"}>{rs(num(x.net))}</td>
                    <td className={td}><span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${settleClass(x.paid ? "Paid" : "In statement")}`}>{x.paid ? "Paid" : "Unpaid"}</span></td>
                  </tr>))}
            </tbody></>)}
          {tab === "awaiting" && (<>
            <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06]">
              <th className={th}>Order #</th><th className={th}>Order date</th><th className={th}>Customer</th><th className={th + " text-right"}>Value</th><th className={th}>Payout</th><th className={th + " text-right"}>Unpaid net</th></tr></thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {awaiting.length === 0 ? <tr><td colSpan={6} className="px-4 py-14 text-center text-muted">{loading ? "Loading…" : "Every delivered order is paid out."}</td></tr>
                : awaiting.map((x) => (
                  <tr key={String(x.order_number)}>
                    <td className={td + " font-semibold"}>{String(x.order_number)}</td>
                    <td className={td + " text-muted"}>{String(x.order_date ?? "—")}</td>
                    <td className={td}>{String(x.customer_name ?? "—")}</td>
                    <td className={td + " text-right tabular-nums"}>{rs(num(x.paid_value))}</td>
                    <td className={td}><span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${settleClass(String(x.settlement))}`}>{String(x.settlement)}</span></td>
                    <td className={td + " text-right tabular-nums"}>{num(x.unpaid_net) ? rs(num(x.unpaid_net)) : "—"}</td>
                  </tr>))}
            </tbody></>)}
        </table>
      </div>
    </div>
  );
}
