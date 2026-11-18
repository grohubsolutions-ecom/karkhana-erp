"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Wallet, FileText, Undo2, RefreshCw, CheckCircle2, Clock, Truck, ChevronRight } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import ReturnsPanel from "@/components/ReturnsPanel";
import { HubRange, Segmented, PageActions, useIsPhone } from "@/components/HubUI";
import { rangeDates } from "@/lib/dateRange";
import { AddFinanceRow, EditFinanceRow } from "@/components/FinanceEntry";
import CprImport from "@/components/CprImport";
import CprDetail from "@/components/CprDetail";

type Tab = "payments" | "cpr" | "returns";
type Row = Record<string, unknown>;

/** One row, straight from hub_finance_summary(). Counted in the database. */
type Summary = {
  pending_value: number; pending_count: number; oldest_pending_days: number;
  received_gross: number; received_net: number; received_count: number;
  gross_cod: number; courier_fees: number; net_expected: number;
};
/** PostEx and OwnEx kept apart deliberately: OwnEx has no payment API, so its
 *  share of the receivable can only move by import or by hand. A blended figure
 *  hides which half is automatable. */
type CourierRow = {
  courier: string; pending_value: number; pending_count: number;
  oldest_pending_days: number; received_gross: number; courier_fees: number;
};

const STORES = [
  { code: "ALL", label: "All stores" },
  { code: "LM", label: "Little Minors" },
  { code: "TS", label: "TopShop" },
  { code: "TRZ", label: "Trenzee" },
];
const TABS: { key: Tab; label: string }[] = [
  { key: "payments", label: "Payments" },
  { key: "cpr", label: "CPR" },
];
const money = (n: unknown) => (n == null ? "—" : "Rs " + Math.round(Number(n) || 0).toLocaleString("en-PK"));
const sum = (rows: Row[], k: string) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);

function badge(txt: string, kind: "ok" | "warn" | "bad" | "mute") {
  const m = {
    ok: "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success",
    warn: "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber",
    bad: "bg-danger-soft text-danger dark:bg-white/[0.08] dark:text-danger",
    mute: "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]",
  }[kind];
  return <span className={`inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${m}`}>{txt}</span>;
}
const isPaid = (s: unknown) => s === "Paid" || s === "Received";

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>("payments");
  const phone = useIsPhone();
  const [store, setStore] = useState("ALL");
  /* Whose settlements am I looking at?
     PostEx and OwnEx bill on completely different terms — PostEx deducts
     withholding per parcel, OwnEx charges a fuel surcharge at invoice level —
     so a mixed list is rarely what anyone wants to read. */
  const [courier, setCourier] = useState("All couriers");
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cprRow, setCprRow] = useState<Row | null>(null);
  /* Which card is driving the list. Clicking a figure should show you the rows
     behind it — a number you cannot open is a number you have to take on
     trust, and this page exists precisely because those were wrong. */
  /* OPENS ON PENDING, AND NEVER FALLS BACK TO A MIXED LIST.
     This page is where the team goes to see what is still owed. It opened on
     no filter at all, so paid parcels came up alongside unpaid ones under a
     card that said "Pending payment", and pressing that card a second time
     switched the filter off again. The owner asked for this to be strict once
     already; the rule is now in the code rather than in somebody's memory.
     Received and Charges are still one click away; clicking an active card
     returns here, not to everything. */
  const [pick, setPick] = useState<"" | "pending" | "received" | "charges">("pending");
  const [byCourier, setByCourier] = useState<CourierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");

  /* THE CARDS COME FROM THE DATABASE, THE TABLE IS A PAGE OF ROWS.
     Two separate bugs were fixed here — see migration 0077.

     1. Counting a PostgREST response in the browser understates any total past
        1,000 rows, however large .limit() is. Fourth page with this fault.

     2. Worse: the Payments tab filtered on payment_date, which is NULL on every
        UNPAID parcel, and NULL fails every comparison. The default range is
        "30 days", so the pending rows were being deleted from the query before
        the cap was even reached. v_finance_payments.finance_date dates a paid
        row by when the money arrived and an unpaid one by when it became owed,
        so a range filter can no longer hide a receivable. */
  /* Only the newest request may paint. Switching range or tab quickly used to
     let an older answer land last — CPR rows could appear under the Payments
     columns. */
  const reqId = useRef(0);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  const load = useCallback(async (which: Tab) => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const [from, to] = rangeDates(preset, cf, ct);

    const dcol = which === "payments" ? "finance_date" : "cpr_date";
    let q =
      which === "payments"
        ? supabase.from("v_finance_payments")
            .select("id,tracking_id,order_number,store_code,courier,cod_amount,cpr_net_amount,courier_fee,courier_tax,payment_status,payment_date,delivery_date,finance_date,is_paid,age_days,cpr_number,dispatch_date", { count: "exact" })
            // Oldest first. A receivable list is worked from the top, and the
            // oldest debt is the one closest to being uncollectable.
            .order("is_paid", { ascending: true })
            .order("finance_date", { ascending: true, nullsFirst: false })
            .limit(1000)
        : supabase.from("online_cpr")
            .select("id,cpr_number,courier,store_code,cpr_date,amount,orders_count,status,gross_total,shipping_charges,gst,wh_income_tax,wh_sales_tax,net_total,delivered_count,returned_count,returns_cost,matched_count,matched_total,unmatched,settlement_status", { count: "exact" })
            .order("cpr_date", { ascending: false, nullsFirst: false }).limit(1000);
    if (from) q = q.gte(dcol, from);
    if (to) q = q.lte(dcol, to);
    if (courier !== "All couriers") q = q.eq("courier", courier);
    /* STORE AND THE CARD YOU PRESSED FILTER IN THE DATABASE.
       Both filtered the 1,000 loaded rows. Unpaid rows sort first, so with more
       than 1,000 of them "Received" — or a store — could show an empty list
       while the card above it said thousands. */
    if (store !== "ALL") q = q.eq("store_code", store);
    if (which === "payments" && pick === "pending")  q = q.eq("is_paid", false);
    if (which === "payments" && pick === "received") q = q.eq("is_paid", true);
    if (which === "payments" && pick === "charges")  q = q.or("courier_fee.gt.0,courier_tax.gt.0");

    /* The three requests go together instead of one after another. */
    const [rowsRes, smRes, bcRes] = await Promise.all([
      q,
      which === "payments"
        ? supabase.rpc("hub_finance_summary", {
            p_from: from, p_to: to, p_store: store,
            p_courier: courier === "All couriers" ? null : courier,
          })
        : Promise.resolve({ data: null, error: null }),
      which === "payments"
        ? supabase.rpc("hub_finance_by_courier", { p_from: from, p_to: to, p_store: store })
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (my !== reqId.current) return;
    const firstErr = rowsRes.error ?? smRes.error ?? bcRes.error;
    if (firstErr) setErr(firstErr.message);
    setSummary(which === "payments" ? (((smRes.data as Summary[]) ?? [])[0] ?? null) : null);
    setByCourier(which === "payments" ? ((bcRes.data as CourierRow[]) ?? []) : []);
    setRows((rowsRes.data as Row[]) ?? []);
    setMatchCount(typeof rowsRes.count === "number" ? rowsRes.count : null);
    setLoading(false);
  }, [preset, cf, ct, store, courier, pick]);
  useEffect(() => { load(tab); }, [tab, load]);

  /* The database applied store and the card you pressed; these are the rows. */
  const rowsF = rows;

  const cards = useMemo(() => {
    if (tab === "payments") {
      const s = summary;
      const [from, to] = rangeDates(preset, cf, ct);
      /* AVERAGE DELIVERY CHARGE over whatever period is selected.
         Two readings of the same figure, both useful and both shown: what one
         delivery costs on average, and what the couriers cost you per day.
         Seven days and thirty days therefore give different answers, which is
         the point — it is a rate, not a total. */
      const parcels = Number(s?.pending_count ?? 0) + Number(s?.received_count ?? 0);
      const fees = Number(s?.courier_fees ?? 0);
      const days = from && to
        ? Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1)
        : 0;
      return [
        { label: "Pending payment", value: money(s?.pending_value), Icon: Clock, bg: "bg-amber-soft",
          note: s ? `${Number(s.pending_count).toLocaleString()} parcels · oldest ${Number(s.oldest_pending_days)} days` : "",
          key: "pending" as const },
        { label: "Received", value: money(s?.received_net), Icon: CheckCircle2, bg: "bg-success-soft",
          note: s ? `${Number(s.received_count).toLocaleString()} parcels settled` : "", key: "received" as const },
        // Revenue is GROSS COD — what the customer handed over. The courier's
        // cut is a cost, shown next to it rather than folded into it.
        { label: "Gross COD", value: money(s?.gross_cod), Icon: Wallet, bg: "bg-periwinkle-soft",
          note: "what customers paid", key: "" as const },
        { label: "Courier charges", value: money(s?.courier_fees), Icon: Wallet, bg: "bg-salmon-soft",
          note: s ? `net ${money(s.net_expected)}` : "", key: "charges" as const },
        { label: "Avg delivery charge", value: parcels ? money(fees / parcels) : "—", Icon: Truck, bg: "bg-periwinkle-soft",
          note: days ? `per parcel · ${money(fees / days)}/day over ${days}d` : "per parcel", key: "charges" as const },
      ];
    }

    if (tab === "cpr") {
      // Browser-side on purpose: one row per settlement file, a few hundred at
      // most, and now filtered by store in the database. Past ~900 settlements
      // in one range this needs its own function like every other total.
      return [
        { label: "CPR batches", value: rowsF.length.toLocaleString(), Icon: FileText, bg: "bg-periwinkle-soft", note: "", key: "" as const },
        { label: "Total amount", value: money(sum(rowsF, "amount")), Icon: Wallet, bg: "bg-success-soft", note: "", key: "" as const },
        { label: "Orders covered", value: rowsF.reduce((t, r) => t + (Number(r.orders_count) || 0), 0).toLocaleString(), Icon: FileText, bg: "bg-amber-soft", note: "", key: "" as const },
        { label: "Open", value: rowsF.filter((r) => r.status !== "Paid" && r.status !== "Cleared").length.toLocaleString(), Icon: Clock, bg: "bg-salmon-soft", note: "", key: "" as const },
      ];
    }
    return [
      { label: "Returns", value: rowsF.length.toLocaleString(), Icon: Undo2, bg: "bg-periwinkle-soft", note: "", key: "" as const },
      { label: "Received back", value: rowsF.filter((r) => r.received).length.toLocaleString(), Icon: CheckCircle2, bg: "bg-success-soft", note: "", key: "" as const },
      { label: "Awaiting", value: rowsF.filter((r) => !r.received).length.toLocaleString(), Icon: Clock, bg: "bg-amber-soft", note: "", key: "" as const },
      { label: "—", value: "", Icon: Undo2, bg: "bg-salmon-soft", note: "", key: "" as const },
    ];
  }, [tab, rowsF, summary]);

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* On a phone the header's switcher already leads to Disputes. */}
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Finance</h1>
          {/* Disputes are money on both sides — COD counted as revenue in
              Shopify, and a return charge already paid. Worth a way in from
              here rather than only from inside each settlement. */}
          <Link href="/online/finance/disputes"
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-soft px-3 py-1.5 text-[12.5px] font-semibold text-amber-900 transition hover:bg-amber-100">
            Disputes — settled returns still open in Shopify
          </Link>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">CPR reconciliation, and pending &amp; received payments. Returns moved to Logistics.</p>
        </div>
        <PageActions>
          {(tab === "payments" || tab === "cpr") && (
            <select value={courier} onChange={(e) => setCourier(e.target.value)}
                    className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
              <option>All couriers</option><option>PostEx</option><option>OwnEx</option>
            </select>
          )}
          <select value={store} onChange={(e) => setStore(e.target.value)}
            className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {STORES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
          {/* Settlement import lives on the CPR tab, where the batches it
              creates are listed. Showing it on Payments would invite dropping
              an invoice onto a screen that cannot display the result. */}
          {tab === "cpr" && <CprImport onDone={() => load(tab)} />}
          <AddFinanceRow tab={tab} onDone={() => load(tab)} />
          <button onClick={() => load(tab)} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} />

      <Segmented className="mt-4 md:mt-5" value={tab} onChange={setTab} options={TABS} />

      {tab === "returns" ? <div className="mt-5"><ReturnsPanel store={store} from={rangeDates(preset, cf, ct)[0]} to={rangeDates(preset, cf, ct)[1]} /></div> : <>
      {/* Five on payments, four elsewhere. Two per row on a phone. */}
      <div className={`mt-5 grid grid-cols-2 gap-3 ${tab === "payments" ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
        {cards.map(({ label, value, Icon, bg, note, key }, i) => (
          <button key={i} type="button"
            onClick={() => key && setPick((p) => (p === key ? "pending" : key))}
            className={`min-w-0 rounded-card border ${bg} p-3.5 text-left transition sm:p-4 dark:bg-[#201c17] ${label === "—" ? "hidden opacity-0 lg:block" : ""} ${
              key ? "cursor-pointer hover:brightness-95 active:scale-[0.98]" : "cursor-default"} ${
              key && pick === key ? "border-ink ring-2 ring-ink/20 dark:border-white" : "border-line dark:border-white/[0.06]"} ${cards.length === 5 && i === 4 ? "col-span-2 lg:col-span-1" : ""}`}>
            <div className="flex items-center gap-2.5 sm:block">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><Icon size={15} /></span>
              <div className="min-w-0 sm:mt-3">
                <div className="max-sm:truncate text-[16px] font-extrabold tabular-nums text-ink sm:text-[20px] dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
                <div className="text-[12px] font-medium max-sm:truncate text-muted dark:text-[#a89f93]">{label}</div>
              </div>
            </div>
            {note && !loading && <div className="mt-0.5 text-[11px] text-hint dark:text-[#8a8175]">{note}</div>}
            {key && pick === key && <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink dark:text-white">filtering ↓</div>}
          </button>
        ))}
      </div>

      {/* Who owes what. PostEx settles through an API; OwnEx has none, so its
          line is the one that can only ever move by import or by hand. */}
      {cprRow && <CprDetail row={cprRow} onClose={() => setCprRow(null)} />}

      {tab === "payments" && byCourier.length > 0 && !loading && (
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          {/* Each chip shows the figure for whichever CARD is selected. Showing
              "pending" while the Received card was active answered a question
              nobody had asked. Clicking a chip also sets the courier filter, so
              the number and the list underneath always agree. */}
          {byCourier.map((c) => {
            const on = courier === c.courier;
            const shown =
              pick === "received" ? { v: money(c.received_gross), w: "received" }
              : pick === "charges" ? { v: money(c.courier_fees), w: "in charges" }
              : { v: money(c.pending_value), w: "pending" };
            return (
              <button key={c.courier} type="button"
                onClick={() => setCourier(on ? "All couriers" : c.courier)}
                className={`min-h-[44px] rounded-full border px-3.5 py-1.5 text-left text-[12px] transition sm:min-h-0 ${
                  on ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
                     : "border-line bg-surface text-muted hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-[#a89f93]"}`}>
                <span className={`font-semibold ${on ? "" : "text-ink dark:text-[#f4f1ea]"}`}>{c.courier}</span>
                {" · "}{shown.v} {shown.w}
                {pick !== "received" && pick !== "charges" && <>
                  {" · "}{Number(c.pending_count).toLocaleString()} parcels
                  {Number(c.oldest_pending_days) > 0 && <> · oldest {Number(c.oldest_pending_days)}d</>}
                </>}
              </button>
            );
          })}
        </div>
      )}

      {phone ? (
        <div className="mt-4 space-y-2">
          {loading ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[76px] animate-pulse rounded-xl2 bg-panel/70 dark:bg-white/[0.05]" />)
          : err ? <p className="px-4 py-10 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</p>
          : rowsF.length === 0 ? <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">{pick || store !== "ALL" || courier !== "All couriers" ? "Nothing matches these filters." : "Nothing in this period."}</p>
          : rowsF.map((r, i) => (
            <button key={i} type="button" onClick={() => (tab === "cpr" ? setCprRow(r) : setEditRow(r))}
              className="flex w-full items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3 text-left transition active:scale-[0.99] active:bg-panel dark:border-white/[0.06] dark:bg-[#201c17] dark:active:bg-white/[0.05]">
              {tab === "payments" ? (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{String(r.order_number ?? "—")}</span>
                    <span className="ml-auto shrink-0 text-[14.5px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(r.cod_amount)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted dark:text-[#a89f93]">
                    <span className="min-w-0 flex-1 truncate">{String(r.courier ?? "—")} · {String(r.tracking_id ?? "—")}</span>
                    {badge(String(r.payment_status ?? "Pending"), isPaid(r.payment_status) ? "ok" : "warn")}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted dark:text-[#a89f93]">
                    <span className="min-w-0 flex-1 truncate">{r.cpr_number ? String(r.cpr_number) : <span className="text-hint">not settled yet</span>}{r.payment_date ? ` · paid ${String(r.payment_date)}` : ""}</span>
                    <span className="shrink-0">net <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{money(r.cpr_net_amount)}</b></span>
                  </div>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{String(r.cpr_number ?? "—")}</span>
                    <span className="ml-auto shrink-0 text-[14.5px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(r.net_total ?? r.amount)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted dark:text-[#a89f93]">
                    <span className="min-w-0 flex-1 truncate">{String(r.courier ?? "—")} · {String(r.store_code ?? "—")} · {String(r.cpr_date ?? "—")}</span>
                    {badge(String(r.status ?? "Pending"), r.status === "Paid" || r.status === "Cleared" ? "ok" : "warn")}
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">{String(r.delivered_count ?? r.orders_count ?? 0)} delivered · {String(r.returned_count ?? 0)} returned</div>
                </div>
              )}
              <ChevronRight size={16} className="shrink-0 text-hint" />
            </button>
          ))}
        </div>
      ) : (
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                {tab === "payments" && <>
                  {/* Store dropped: the order number already carries it —
                      #LM15237, #TS2761, #TRZ1760 — so the column repeated
                      itself in narrower form. */}
                  <th className="px-4 py-3 font-semibold">Order #</th><th className="px-4 py-3 font-semibold">Tracking</th><th className="px-4 py-3 font-semibold">Dispatched</th><th className="px-4 py-3 font-semibold">Delivered</th><th className="px-4 py-3 font-semibold">CPR / Invoice</th><th className="px-4 py-3 font-semibold">Courier</th>
                  <th className="px-4 py-3 text-right font-semibold">COD</th>
                  <th className="px-4 py-3 text-right font-semibold">Charges</th>
                  <th className="px-4 py-3 text-right font-semibold">Net received</th>
                  <th className="px-4 py-3 font-semibold">Paid on</th><th className="px-4 py-3 font-semibold">Status</th>
                </>}
                {tab === "cpr" && <>
                  <th className="px-4 py-3 font-semibold">CPR #</th><th className="px-4 py-3 font-semibold">Courier</th><th className="px-4 py-3 font-semibold">Store</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 text-right font-semibold">Net paid</th>
                  <th className="px-4 py-3 text-right font-semibold">Delivered</th>
                  <th className="px-4 py-3 text-right font-semibold">Returned</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => <tr key={i}><td colSpan={11} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>)
              ) : err ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</td></tr>
              ) : rowsF.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">{pick || store !== "ALL" || courier !== "All couriers" ? "Nothing matches these filters." : "Nothing in this period."}</td></tr>
              ) : (
                /* SELECTING TEXT IS NOT CLICKING A ROW.
                   The whole row was a click target, so dragging across a
                   tracking number to copy it counted as a click and threw up the
                   edit dialog — which then swallowed the selection. A click that
                   ends with text highlighted was a copy, not a choice. */
                rowsF.map((r, i) => (
                  <tr key={i}
                      onClick={() => {
                        if ((window.getSelection()?.toString() ?? "").length > 0) return;
                        if (tab === "cpr") setCprRow(r); else setEditRow(r);
                      }}
                      className="cursor-pointer text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                    {tab === "payments" && <>
                      <td className="px-4 py-3 font-semibold">{String(r.order_number ?? "—")}</td>
                      <td className="px-4 py-3 font-mono text-[11.5px] text-muted dark:text-[#a89f93]">{String(r.tracking_id ?? "—")}</td>
                      {/* Which settlement paid this parcel. Without it a payment
                          can be seen but not traced back to the courier document
                          that produced it, which is the first thing anyone asks
                          when a figure is questioned. */}
                      {/* Dispatched, beside the settlement. The gap between
                          going out and being paid is the thing worth watching,
                          and it was only visible on another screen. */}
                      <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">
                        {String(r.dispatch_date ?? "—")}
                      </td>
                      {/* Dispatched, delivered, settled — left to right the row
                          shows the cash cycle: how long the courier took to
                          deliver, and how long after that the money arrived. */}
                      <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">
                        {String(r.delivery_date ?? "—")}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11.5px]">
                        {r.cpr_number
                          ? <span className="text-ink dark:text-[#e7e2d8]">{String(r.cpr_number)}</span>
                          : <span className="text-hint">not settled yet</span>}
                      </td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.courier ?? "—")}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(r.cod_amount)}</td>
                      {/* What the courier kept: its fee plus the tax withheld.
                          Shown in brackets, the way both couriers' own receipts
                          show a deduction. */}
                      <td className="px-4 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">
                        {(Number(r.courier_fee) || 0) + (Number(r.courier_tax) || 0)
                          ? "(" + Math.round((Number(r.courier_fee) || 0) + (Number(r.courier_tax) || 0)).toLocaleString("en-PK") + ")"
                          : "—"}
                      </td>
                      {/* Net is only known once a settlement has been imported.
                          A dash here means no CPR has covered this parcel yet —
                          not that the amount is zero. */}
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.cpr_net_amount)}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.payment_date ?? "—")}</td>
                      <td className="px-4 py-3">{badge(String(r.payment_status ?? "Pending"), isPaid(r.payment_status) ? "ok" : "warn")}</td>
                    </>}
                    {tab === "cpr" && <>
                      <td className="px-4 py-3 font-semibold">{String(r.cpr_number ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.courier ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.store_code ?? "—")}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(r.cpr_date ?? "—")}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.net_total ?? r.amount)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{String(r.delivered_count ?? r.orders_count ?? 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">{String(r.returned_count ?? 0)}</td>
                      <td className="px-4 py-3">{badge(String(r.status ?? "Pending"), r.status === "Paid" || r.status === "Cleared" ? "ok" : "warn")}</td>
                    </>}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {!loading && !err && rowsF.length > 0 && (
        <>
        {/* How many there really are — the list stops at 1,000. */}
        <p className="mt-3 text-center text-[12px] text-hint dark:text-[#8a8175]">
          Showing {rowsF.length.toLocaleString()} of {(matchCount ?? rowsF.length).toLocaleString()}
          {(matchCount ?? 0) > rowsF.length && " — narrow the dates to see the rest"}
        </p>
        <p className="mt-1 text-center text-[12px] text-hint dark:text-[#8a8175]">Tip: {phone ? "tap" : "click"} any row to {tab === "payments" ? "mark it paid" : tab === "cpr" ? "see how the courier calculated it" : "mark it received"}.</p>
        </>
      )}

      <EditFinanceRow tab={tab} row={editRow} onClose={() => setEditRow(null)} onDone={() => load(tab)} />

      {!isSupabaseConfigured && <p className="mt-4 text-center text-[12px] text-hint dark:text-[#8a8175]">Preview build · connect Supabase to load live finance data.</p>}
      </>}
    </div>
  );
}
