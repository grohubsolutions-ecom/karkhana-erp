"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveTables } from "@/lib/useLiveTables";
import { ShoppingBag, Clock, Undo2, Wallet, TrendingUp, Truck, RefreshCw, MapPin, Ban, Receipt, Tag, Package, XCircle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { HubRange, PageActions, Segmented, useIsPhone } from "@/components/HubUI";
import { rangeDates, rs } from "@/lib/dateRange";

const STORES = [
  { code: "ALL", label: "All stores", color: "#141414" },
  { code: "LM", label: "Little Minors", color: "#A6C0E6" },
  { code: "TS", label: "TopShop", color: "#EBA98F" },
  { code: "TRZ", label: "Trenzee", color: "#D2B9EA" },
];
const PIE = ["#A6C0E6", "#D2B9EA", "#EBA98F", "#EFD0A6", "#EDA6D0", "#B4ABA0"];

function Pie({ data }: { data: { label: string; value: number }[] }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return <div className="py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">No city data yet.</div>;
  const cx = 100, cy = 100, r = 88; let acc = 0;
  const arc = (v: number) => {
    const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2;
    acc += v;
    const a1 = (acc / total) * 2 * Math.PI - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`;
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-6 sm:justify-start">
      <svg width="200" height="200" viewBox="0 0 200 200" className="shrink-0">
        {/* One slice is a whole circle, and an arc that starts and ends at the
            same point draws nothing — a store selling into one city showed an
            empty chart. A single value is drawn as a plain circle instead. */}
        {data.filter((d) => d.value > 0).length === 1
          ? <circle cx={cx} cy={cy} r={r} fill={PIE[data.findIndex((d) => d.value > 0) % PIE.length]} />
          : data.map((d, i) => <path key={d.label} d={arc(d.value)} fill={PIE[i % PIE.length]} stroke="var(--surface,#fff)" strokeWidth="1.5" />)}
      </svg>
      <div className="flex min-w-[170px] flex-1 flex-col gap-2">
        {data.map((d, i) => (
          <div key={d.label} className="flex items-center gap-2 text-[13px]">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: PIE[i % PIE.length] }} />
            <span className="flex-1 truncate text-ink dark:text-[#e7e2d8]">{d.label}</span>
            <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{d.value.toLocaleString()}</b>
            <span className="w-12 text-right tabular-nums text-muted dark:text-[#a89f93]">{((d.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type DashSummary = {
  total_orders: number; pending: number; returned_cancel: number;
  delivered: number; in_transit: number;
  order_value: number; avg_order: number; delivery_rate: number;
  cod_received: number; cod_receivable: number; receivable_count: number;
};

/* H285: the order counts on top, all from Shopify, so every order is in
   exactly one card and they add up to the total: pending (not fulfilled),
   dispatched (fulfilled), returned (fulfilled, then cancelled — only those,
   not every parcel the courier brought back) and cancelled (cancelled without
   ever being fulfilled). Pending and Dispatched equal the Orders page. */
type DashCounts = {
  total_orders: number; pending: number; dispatched: number; returned: number;
  cancelled_unfulfilled: number; cancelled_all: number;
};

/* H287: the other question about cancellations — not "of the orders placed in
   these dates, how many are cancelled now" (the cards) but "what did Shopify
   cancel IN these dates", whenever the order was placed. On 2 Oct Shopify
   cancelled 38 orders and only 2 of them had been placed that day, which is
   why "Today" looked as if cancellations were not arriving. */
type DashCancels = { cancelled: number; not_fulfilled: number; fulfilled: number; placed_earlier: number };

/* H308 (2 Nov 2026): Shopify-style sales lines — exactly how Shopify's own
   finance report breaks a store's revenue down. All six come from
   online_orders (Shopify is the source of truth for order value). The math:
     Gross sales      = subtotal + discount_total   (products at list price)
     Discounts        = discount_total               (promo codes, line discounts)
     Returns          = order amount, fulfilled then cancelled
     Cancellations    = order amount, cancelled before fulfilment
     Shipping charges = shipping_total               (what customers paid for delivery)
     Net sales        = Gross − Discounts − Returns − Cancellations
   Verified against Shopify's own fields: amount = subtotal + shipping + tax. */
type ShopifySales = {
  gross_sales: number; discounts: number; returns_amount: number;
  cancellations: number; shipping_charges: number; net_sales: number;
  returns_count: number; cancellations_count: number; order_count: number;
};

type RateRow = { month_label: string; courier: string; returned: number;
                 return_pct: number | null; change_pts: number | null;
                 cod_returned: number | null; is_part_month: boolean };

/* ONE ROW PER STORE, FROM hub_dashboard_breakdown().
   Every order is in exactly one state — the courier's parcel decides, Shopify
   only breaks ties — so the columns add up to the total and nothing is counted
   twice. Money is the order amount throughout. */
type StoreRow = {
  store_code: string; is_total: boolean; orders: number;
  sale_orders: number; sale_value: number;
  pending_n: number; pending_v: number;
  dispatched_n: number; dispatched_v: number;
  transit_n: number; transit_v: number;
  paid_n: number; paid_v: number;
  unpaid_n: number; unpaid_v: number;
  returned_n: number; returned_v: number;
  cancelled_n: number; cancelled_v: number;
  delivery_rate: number | null;
};
type CourierRow = { courier: string; dispatched: number; delivered: number; returned: number };
type Breakdown = { stores: StoreRow[]; couriers: CourierRow[]; cities: { label: string; value: number }[] };

/* The ladder, top to bottom. Indent shows what sits inside what:
   Total sales = Not dispatched + Dispatched, and
   Dispatched  = In transit + Delivered & paid + Delivered, payment due + Returned.
   Cancelled sits below the line — it never left the building, and two voided
   Trenzee test orders (Rs 32,950,200 and Rs 1,049,700) would otherwise make
   Trenzee a Rs 34M store. */
const LADDER: {
  key: string; v: keyof StoreRow; n: keyof StoreRow; label: string; hint?: string;
  indent: 0 | 1 | 2; strong?: boolean; tone?: "good" | "warn" | "bad" | "muted"; below?: boolean;
}[] = [
  { key: "sale",       v: "sale_value",   n: "sale_orders",  label: "Total sales",            hint: "every order except cancelled", indent: 0, strong: true },
  { key: "pending",    v: "pending_v",    n: "pending_n",    label: "Not dispatched yet",     indent: 1 },
  { key: "dispatched", v: "dispatched_v", n: "dispatched_n", label: "Dispatched",             hint: "handed to a courier", indent: 1, strong: true },
  { key: "transit",    v: "transit_v",    n: "transit_n",    label: "In transit",             indent: 2 },
  { key: "paid",       v: "paid_v",       n: "paid_n",       label: "Delivered & paid",       hint: "customer received it, courier has paid", indent: 2, tone: "good" },
  { key: "unpaid",     v: "unpaid_v",     n: "unpaid_n",     label: "Delivered, payment due", hint: "customer received it, money not in yet", indent: 2, tone: "warn" },
  { key: "returned",   v: "returned_v",   n: "returned_n",   label: "Returned",               hint: "parcel came back", indent: 2, tone: "bad" },
  { key: "cancelled",  v: "cancelled_v",  n: "cancelled_n",  label: "Cancelled",              hint: "never dispatched — not in sales", indent: 0, tone: "muted", below: true },
];
const TONE_TXT = {
  good: "text-success", warn: "text-amber-strong dark:text-amber",
  bad: "text-red-700 dark:text-salmon", muted: "text-muted dark:text-[#a89f93]",
} as const;
const STORE_ORDER = ["LM", "TS", "TRZ"];

export default function HubDashboard() {
  const phone = useIsPhone();
  /* On a phone the store columns do not fit side by side; the ladder shows one
     store at a time, picked here. */
  const [col, setCol] = useState("ALL");
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rates, setRates] = useState<RateRow[]>([]);
  // The two cards answer "is it getting worse". The months answer "what is
  // normal" — worth having, not worth pushing the rest of the page down.
  const [showMonths, setShowMonths] = useState(false);
  const [store, setStore] = useState("ALL");
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [summary, setSummary] = useState<DashSummary | null>(null);
  const [counts, setCounts] = useState<DashCounts | null>(null);
  const [cancels, setCancels] = useState<DashCancels | null>(null);
  const [sales, setSales] = useState<ShopifySales | null>(null);

  /* EVERY FIGURE ON THIS PAGE IS COUNTED IN THE DATABASE.
     This page used to fetch 1,000 orders and 1,000 parcels and add them up
     here. PostgREST caps a response at 1,000 rows whatever .limit() asks, so on
     30 days the by-store panel saw 1,000 of 1,570 orders — LM 609 + TopShop 391
     made exactly 1,000 and Trenzee disappeared — and "COD receivable" read
     Rs 16,091 while the database knew Rs 137,392. The parcels were not even
     filtered by date. Now there are no raw rows at all: two calls, both
     counted server-side, both limited to hub.dashboard.view. */
  const reqId = useRef(0);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    if (!opts?.silent) setLoading(true);
    setErr("");
    const [from, to] = rangeDates(preset, cf, ct);
    const args = { p_from: from, p_to: to, p_store: store === "ALL" ? null : store };

    const [sum, br, rt, cnt, cx, sh] = await Promise.all([
      supabase.rpc("hub_dashboard_summary", args),
      supabase.rpc("hub_dashboard_breakdown", args),
      supabase.rpc("hub_return_rates", { p_months: 3 }),
      supabase.rpc("hub_dashboard_counts", args),
      supabase.rpc("hub_dashboard_cancellations", args),
      supabase.rpc("hub_dashboard_shopify_sales", args),
    ]);
    if (my !== reqId.current) return;          // superseded by a newer request
    const firstErr = sum.error ?? br.error ?? cnt.error;
    if (firstErr) setErr(firstErr.message);
    setSummary((sum.data as DashSummary[])?.[0] ?? null);
    setCounts((cnt.data as DashCounts[])?.[0] ?? null);
    /* A missing function (H287 not run yet) hides the row instead of
       putting an error over the whole dashboard. */
    setCancels(cx.error ? null : ((cx.data as DashCancels[])?.[0] ?? null));
    /* Shopify sales — same tolerance: if the H308 migration hasn't landed,
       the whole section hides rather than breaking the dashboard. */
    setSales(sh.error ? null : ((sh.data as ShopifySales[])?.[0] ?? null));
    setBreakdown((br.data as Breakdown) ?? null);
    setRates((rt.data as RateRow[]) ?? []);
    setLoading(false);
  }, [preset, cf, ct, store]);

  useEffect(() => { load(); }, [load]);

  /* Live: the couriers and Shopify both write straight to these tables, so the
     dashboard repaints itself rather than waiting for someone to press Refresh. */
  const { live } = useLiveTables(
    ["online_orders", "online_logistics"],
    useCallback(() => load({ silent: true }), [load]),
  );

  const M = useMemo(() => {
    const total = Number(counts?.total_orders ?? summary?.total_orders ?? 0);
    const pending = Number(counts?.pending ?? 0);
    const dispatched = Number(counts?.dispatched ?? 0);
    const returned = Number(counts?.returned ?? 0);
    const cancelled = Number(counts?.cancelled_unfulfilled ?? 0);
    const delivered = Number(summary?.delivered ?? 0);
    const transit = Number(summary?.in_transit ?? 0);
    const totalAmt = Number(summary?.order_value ?? 0);
    const avgAmt = Number(summary?.avg_order ?? 0);
    const deliveryRate = Number(summary?.delivery_rate ?? 0);
    const received = Number(summary?.cod_received ?? 0);
    const receivable = Number(summary?.cod_receivable ?? 0);
    const receivableCount = Number(summary?.receivable_count ?? 0);

    /* Always the three stores in a fixed order, even one with no orders in the
       dates — a store that silently drops out of the table reads as a store
       that does not exist, which is exactly what happened to Trenzee. */
    const got = breakdown?.stores ?? [];
    const zero = (code: string): StoreRow => ({
      store_code: code, is_total: code === "ALL", orders: 0, sale_orders: 0, sale_value: 0,
      pending_n: 0, pending_v: 0, dispatched_n: 0, dispatched_v: 0, transit_n: 0, transit_v: 0,
      paid_n: 0, paid_v: 0, unpaid_n: 0, unpaid_v: 0, returned_n: 0, returned_v: 0,
      cancelled_n: 0, cancelled_v: 0, delivery_rate: null,
    });
    const codes = store === "ALL" ? [...STORE_ORDER, "ALL"] : [store];
    const storeCols = codes.map((c) => got.find((r) => r.store_code === c) ?? zero(c));

    return {
      total, pending, dispatched, returned, cancelled, delivered, transit, totalAmt, avgAmt, deliveryRate,
      received, receivable, receivableCount, storeCols,
      cities: breakdown?.cities ?? [], couriers: breakdown?.couriers ?? [],
    };
  }, [summary, counts, breakdown, store]);

  const pct = (n: number) => (M.total ? Math.round((n / M.total) * 100) : 0);
  /* Return rate per courier, this month against last. The dashboard already
     counts returns; it never said whether the rate was rising or falling, which
     is the only part anyone can act on. */
  const rateCards = rates.filter((x) => !x.is_part_month).reduce((acc: RateRow[], r) => {
    if (acc.filter((a) => a.courier === r.courier).length < 2) acc.push(r);
    return acc;
  }, []);

  /* THE ORDERS, COUNTED (H285), the owner's way — all from Shopify, each order
     in one card only, so Pending + Dispatched + Returned + Cancelled = Total:
       Returned  = fulfilled in Shopify, then cancelled
       Cancelled = cancelled without ever being fulfilled */
  const cards = [
    { label: "Total orders", value: M.total.toLocaleString(), sub: "in period", Icon: ShoppingBag, bg: "bg-periwinkle-soft" },
    { label: "Pending", value: M.pending.toLocaleString(), sub: `${pct(M.pending)}% · not fulfilled yet`, Icon: Clock, bg: "bg-amber-soft" },
    { label: "Dispatched", value: M.dispatched.toLocaleString(), sub: `${pct(M.dispatched)}% · fulfilled in Shopify`, Icon: Truck, bg: "bg-success-soft" },
    { label: "Returned", value: M.returned.toLocaleString(), sub: `${pct(M.returned)}% · fulfilled, then cancelled`, Icon: Undo2, bg: "bg-salmon-soft" },
    { label: "Cancelled", value: M.cancelled.toLocaleString(), sub: `${pct(M.cancelled)}% · cancelled before fulfilment`, Icon: Ban, bg: "bg-pink-soft" },
  ];
  const money = [
    { label: "Order value", value: rs(M.totalAmt), sub: "every order except cancelled", Icon: Wallet, tone: "text-ink dark:text-[#f4f1ea]" },
    { label: "Average order", value: rs(M.avgAmt), sub: "per order", Icon: TrendingUp, tone: "text-ink dark:text-[#f4f1ea]" },
    { label: "Delivery rate", value: `${M.deliveryRate.toFixed(1)}%`, sub: `${M.delivered.toLocaleString()} delivered`, Icon: Truck, tone: "text-success" },
  ];

  return (
    /* H306: tighter page padding and spacing on a phone — the dashboard is a
       sea of numbers, so every extra pixel of chrome is one fewer number on
       screen without scrolling. Desktop (md:) keeps the roomy layout. */
    <div className="px-3 py-3 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          {/* H306: title is now visible on a phone too, just smaller — a page
             with no title reads as "where am I". */}
          <h1 className="text-[17px] font-extrabold tracking-tight text-ink md:text-[22px] dark:text-[#f4f1ea]">Dashboard</h1>
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted md:mt-1 md:text-[13px] dark:text-[#a89f93]">
            <span className="hidden md:inline">Orders, delivery performance &amp; COD across all three stores.</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${live ? "bg-success-soft text-success dark:bg-white/[0.08]" : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-success" : "bg-muted"}`} />
              {live ? "Live" : "Not live"}
            </span>
          </p>
        </div>
        <PageActions>
          <button onClick={() => load()} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={
          <select value={store} onChange={(e) => setStore(e.target.value)} className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {STORES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        } />

      {/* H306: tighter card paddings and gaps on a phone — one more row fits
          on screen. Desktop (sm:/lg:) is unchanged. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-5 sm:gap-3 lg:grid-cols-5">
        {cards.map(({ label, value, sub, Icon, bg }, i) => (
          <div key={label} className={`min-w-0 rounded-card border border-line ${bg} p-2.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${i === 0 ? "col-span-2 lg:col-span-1" : ""}`}>
            <span className="hidden h-9 w-9 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><Icon size={16} /></span>
            <div className="max-sm:truncate text-[15px] font-extrabold tabular-nums text-ink sm:mt-3 sm:text-[18px] dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
            <div className="text-[11.5px] font-medium text-muted sm:text-[12px] dark:text-[#a89f93]">{label}</div>
            <div className="mt-0.5 text-[10.5px] leading-tight text-hint sm:text-[11px] dark:text-[#8a8175]">{loading ? "" : sub}</div>
          </div>
        ))}
      </div>

      <p className="mt-1.5 px-1 text-[10.5px] text-hint sm:mt-2 sm:text-[11.5px] dark:text-[#8a8175]">
        From Shopify: Pending + Dispatched + Returned + Cancelled = Total orders · each order under the day it was placed.
      </p>

      {/* H287 — WHAT SHOPIFY CANCELLED IN THESE DATES, by the day it was
          cancelled. Most cancellations are older orders, so the cards above
          (by the day an order was placed) can read 2 on a day Shopify
          cancelled 38. This row is the number to compare with Shopify. */}
      {cancels && (() => {
        const when = preset === "today" ? "today" : preset === "yesterday" ? "yesterday" : "in these dates";
        const before = preset === "today" ? "before today" : preset === "yesterday" ? "before yesterday" : "before these dates";
        const n = (v: number) => Number(v || 0).toLocaleString();
        return (
          <div className="mt-2 min-w-0 rounded-card border border-line bg-surface px-3.5 py-2.5 dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink dark:text-[#f4f1ea]">
                <Ban size={13} className="shrink-0 self-center" /> Cancelled in Shopify {when}
              </span>
              <b className="text-[14px] tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : n(cancels.cancelled)}</b>
              {!loading && (
                <span className="text-muted dark:text-[#a89f93]">
                  {n(cancels.not_fulfilled)} never fulfilled · {n(cancels.fulfilled)} after fulfilment
                  {Number(cancels.placed_earlier) > 0 && ` · ${n(cancels.placed_earlier)} placed ${before}`}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-hint dark:text-[#8a8175]">
              Counted on the day Shopify cancelled them — compare this with Shopify. The cards above count by the day an order was placed.
            </div>
          </div>
        );
      })()}

      {/* The money behind those orders — one row, under the counts. */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:mt-3 sm:gap-3 sm:grid-cols-3">
        {money.map(({ label, value, sub, Icon, tone }, i) => (
          <div key={label} className={`min-w-0 rounded-card border border-line bg-surface p-2.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${i === 2 ? "col-span-2 sm:col-span-1" : ""}`}>
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted sm:gap-2 sm:text-[12px] dark:text-[#a89f93]"><Icon size={13} className="shrink-0 sm:hidden" /><Icon size={14} className="shrink-0 max-sm:hidden" /> {label}</div>
            <div className={`mt-1 max-sm:truncate text-[16px] font-extrabold tabular-nums sm:text-[19px] ${tone}`}>{loading ? "—" : value}</div>
            <div className="mt-0.5 text-[10.5px] leading-tight text-hint sm:text-[11px] dark:text-[#8a8175]">{loading ? "" : sub}</div>
          </div>
        ))}
      </div>

      {/* RETURN RATE BY COURIER — this month against last.
          The card above counts returns. This says whether the rate is rising,
          which is the part anyone can act on: OwnEx ran 14.5% in June, 25.2% in
          July and 14.9% in August, a swing worth about Rs 190,000. */}
      {rateCards.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {["PostEx", "OwnEx"].map((cr) => {
            const rows = rateCards.filter((x) => x.courier === cr);
            const now = rows[0], prev = rows[1];
            if (!now) return null;
            const p = Number(now.return_pct ?? 0);
            const d = prev ? p - Number(prev.return_pct ?? 0) : null;
            return (
              <div key={cr} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-bold text-ink dark:text-[#f4f1ea]">{cr} returns</span>
                  <span className="text-[11.5px] text-hint dark:text-[#8a8175]">{now.month_label}</span>
                </div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[24px] font-extrabold tabular-nums leading-none text-ink dark:text-[#f4f1ea]">
                    {loading ? "—" : `${p.toFixed(1)}%`}
                  </span>
                  {d !== null && !loading && (
                    /* Fewer returns is better, so a fall is the green one. */
                    <span className={`text-[12px] font-bold tabular-nums ${d <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {d > 0 ? "+" : ""}{d.toFixed(1)} pts
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-muted dark:text-[#a89f93]">
                  {now.returned} came back · {rs(Number(now.cod_returned ?? 0))} of COD
                  {prev && <> · {Number(prev.return_pct ?? 0).toFixed(1)}% in {prev.month_label}</>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rates.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowMonths((v) => !v)}
                  className="min-h-[40px] text-[12.5px] font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline md:min-h-0 dark:text-[#a89f93] dark:hover:text-white">
            {showMonths ? "Hide month by month" : "Return rate month by month"}
          </button>
          {showMonths && phone && (
            <div className="mt-2 divide-y divide-line rounded-card border border-line bg-surface dark:divide-white/[0.06] dark:border-white/[0.06] dark:bg-[#201c17]">
              {[...new Set(rates.map((x) => x.month_label))].map((m) => (
                <div key={m} className="px-4 py-2.5">
                  <div className="text-[12.5px] font-bold text-ink dark:text-[#f4f1ea]">{m}{rates.find((x) => x.month_label === m)?.is_part_month && <span className="ml-2 rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-hint dark:bg-white/[0.06]">still running</span>}</div>
                  {rates.filter((x) => x.month_label === m && (x.courier === "PostEx" || x.courier === "OwnEx")).map((x) => {
                    const d = x.change_pts === null ? null : Number(x.change_pts);
                    return (
                      <div key={x.courier} className="mt-1 flex items-baseline gap-2 text-[12.5px]">
                        <span className="w-14 shrink-0 text-muted dark:text-[#a89f93]">{x.courier}</span>
                        <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{Number(x.return_pct ?? 0).toFixed(1)}%</b>
                        <span className={`tabular-nums ${d === null ? "text-hint" : d <= 0 ? "text-emerald-700" : "text-red-700"}`}>{d === null ? "" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}</span>
                        <span className="ml-auto truncate tabular-nums text-muted dark:text-[#a89f93]">{x.returned} back · {rs(Number(x.cod_returned ?? 0))}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {showMonths && !phone && (
            <div className="mt-2 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Month</th>
                    <th className="px-4 py-2.5 font-semibold">Courier</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Returned</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Rate</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Change</th>
                    <th className="px-4 py-2.5 text-right font-semibold">COD returned</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line dark:divide-white/[0.06]">
                  {rates.filter((x) => x.courier === "PostEx" || x.courier === "OwnEx").map((x, i) => {
                    const pc = Number(x.return_pct ?? 0);
                    const d = x.change_pts === null ? null : Number(x.change_pts);
                    return (
                      <tr key={i} className="text-ink dark:text-[#e7e2d8]">
                        <td className="px-4 py-2.5">
                          {x.month_label}
                          {x.is_part_month && (
                            <span className="ml-2 rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-hint dark:bg-white/[0.06]">still running</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">{x.courier}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{x.returned}</td>
                        <td className="px-4 py-2.5 text-right font-bold tabular-nums">{pc.toFixed(1)}%</td>
                        <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${
                          d === null ? "text-hint" : d <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted dark:text-[#a89f93]">
                          {rs(Number(x.cod_returned ?? 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* COD money row */}
      <div className="mt-3 grid gap-2 sm:mt-4 sm:gap-3 sm:grid-cols-3">
        <div className="rounded-card border border-line bg-surface p-2.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="text-[11.5px] font-medium text-muted sm:text-[12px] dark:text-[#a89f93]">COD received</div>
          <div className="mt-1 text-[16px] font-extrabold tabular-nums text-success sm:text-[19px]">{loading ? "—" : rs(M.received)}</div>
          <div className="mt-0.5 text-[10.5px] text-hint sm:text-[11px] dark:text-[#8a8175]">collected by the courier and paid to you</div>
        </div>
        <div className="rounded-card border border-line bg-surface p-2.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="text-[11.5px] font-medium text-muted sm:text-[12px] dark:text-[#a89f93]">COD receivable (delivered, unpaid)</div>
          <div className="mt-1 text-[16px] font-extrabold tabular-nums text-amber-strong sm:text-[19px] dark:text-amber">{loading ? "—" : rs(M.receivable)}</div>
          <div className="mt-0.5 text-[10.5px] text-hint sm:text-[11px] dark:text-[#8a8175]">{loading ? "" : `${M.receivableCount.toLocaleString()} parcels the courier still owes for`}</div>
        </div>
        <div className="rounded-card border border-line bg-surface p-2.5 sm:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="text-[11.5px] font-medium text-muted sm:text-[12px] dark:text-[#a89f93]">In transit</div>
          <div className="mt-1 text-[16px] font-extrabold tabular-nums text-ink sm:text-[19px] dark:text-[#f4f1ea]">{loading ? "—" : M.transit.toLocaleString()}</div>
        </div>
      </div>

      {/* ── SALES BY STORE ─────────────────────────────────────────────────
          Stores across, the life of an order down. Read a column top to bottom
          and it adds up: Total sales splits into not-dispatched and dispatched,
          and dispatched splits into in transit, delivered & paid, delivered but
          unpaid, and returned. Cancelled sits under the line because it never
          left the building.
          THE COURIER DECIDES, NOT SHOPIFY. 145 of 227 parcels that came back in
          30 days were then cancelled in Shopify; reading Shopify first would
          call a return a cancellation. */}
      {/* H308 (2 Nov 2026) — SHOPIFY SALES BREAKDOWN.
          The six figures Zeeshan reads off Shopify's own finance report, in
          one block, from the same Shopify data we already store. Hidden if the
          H308 migration hasn't landed yet (sales stays null). Mobile: 2-column
          grid; tablet: 3; desktop: 6 across so the whole breakdown reads as
          one row. The order is deliberate: Gross → Discounts → Returns →
          Cancellations → Shipping → Net, matching Shopify's layout so the
          numbers line up with what the owner sees on Shopify itself. */}
      {sales && (
        <div className="mt-3 rounded-card border border-line bg-surface sm:mt-5 dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pb-2 pt-3 sm:px-5 sm:pt-5">
            <h3 className="text-[13.5px] font-bold text-ink sm:text-[14px] dark:text-[#f4f1ea]">
              Shopify sales {store !== "ALL" && <span className="font-normal text-muted dark:text-[#a89f93]">· {STORES.find((s) => s.code === store)?.label ?? store}</span>}
            </h3>
            <span className="text-[11px] text-hint sm:text-[11.5px] dark:text-[#8a8175]">
              exact figures from Shopify · gross − discounts − returns − cancellations = net
            </span>
          </div>
          <div className="grid grid-cols-2 gap-0 border-t border-line sm:grid-cols-3 lg:grid-cols-6 dark:border-white/[0.06]">
            {([
              { label: "Gross sales",      value: sales.gross_sales,      Icon: Wallet,     tone: "text-ink dark:text-[#f4f1ea]",         sub: `${sales.order_count.toLocaleString()} orders`,                                                neg: false, bold: false },
              { label: "Discounts",        value: sales.discounts,        Icon: Tag,        tone: "text-amber-strong dark:text-amber",    sub: "promo codes & line discounts",                                                                neg: true,  bold: false },
              { label: "Returns",          value: sales.returns_amount,   Icon: Undo2,      tone: "text-red-700 dark:text-salmon",        sub: `${sales.returns_count.toLocaleString()} cancelled after fulfilment`,                          neg: true,  bold: false },
              { label: "Cancellations",    value: sales.cancellations,    Icon: XCircle,    tone: "text-red-700 dark:text-salmon",        sub: `${sales.cancellations_count.toLocaleString()} cancelled before fulfilment`,                   neg: true,  bold: false },
              { label: "Shipping charges", value: sales.shipping_charges, Icon: Truck,      tone: "text-ink dark:text-[#f4f1ea]",         sub: "what customers paid for delivery",                                                            neg: false, bold: false },
              { label: "Net sales",        value: sales.net_sales,        Icon: Receipt,    tone: "text-success font-extrabold",          sub: "what became a sale",                                                                          neg: false, bold: true  },
            ]).map((m, i) => (
              <div key={m.label}
                className={`min-w-0 border-line p-2.5 sm:p-4 dark:border-white/[0.06]
                  ${i % 2 === 0 ? "border-r" : ""}
                  ${i >= 2 ? "border-t sm:border-t" : ""}
                  sm:[&:nth-child(3n)]:border-r-0 sm:[&:nth-child(3)]:border-t-0
                  sm:[&:nth-child(n+4)]:border-t
                  lg:border-t-0 lg:[&:not(:last-child)]:border-r lg:[&:nth-child(3n)]:border-r
                  ${m.bold ? "bg-success-soft/40 dark:bg-white/[0.03]" : ""}`}>
                <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted sm:text-[12px] dark:text-[#a89f93]">
                  <m.Icon size={13} className="shrink-0" /> {m.label}
                </div>
                <div className={`mt-1 max-sm:truncate text-[15.5px] tabular-nums sm:text-[18px] ${m.bold ? "font-extrabold" : "font-bold"} ${m.tone}`}>
                  {loading ? "—" : (m.neg && Number(m.value) > 0 ? "−" : "") + rs(Number(m.value))}
                </div>
                <div className="mt-0.5 text-[10.5px] leading-tight text-hint sm:text-[11px] dark:text-[#8a8175]">
                  {loading ? "" : m.sub}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-card border border-line bg-surface sm:mt-5 dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pb-2 pt-3 sm:px-5 sm:pt-5">
          <h3 className="text-[13.5px] font-bold text-ink sm:text-[14px] dark:text-[#f4f1ea]">Sales by store</h3>
          <span className="text-[11px] text-hint sm:text-[11.5px] dark:text-[#8a8175]">order value · every column adds up</span>
        </div>
        {loading ? (
          <div className="py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">Loading…</div>
        ) : phone ? (() => {
          const s = M.storeCols.find((x) => (col === "ALL" ? x.is_total : x.store_code === col)) ?? M.storeCols[M.storeCols.length - 1];
          return (
            <div className="px-3 pb-3">
              <Segmented value={col} onChange={setCol}
                options={[{ key: "ALL", label: "All" }, ...M.storeCols.filter((x) => !x.is_total).map((x) => ({ key: x.store_code, label: x.store_code }))]} />
              {s && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 px-1 pb-1 pt-1 text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">
                    {!s.is_total && <span className="h-2 w-2 rounded-full" style={{ background: STORES.find((x) => x.code === s.store_code)?.color }} />}
                    {s.is_total ? "All three stores" : STORES.find((x) => x.code === s.store_code)?.label ?? s.store_code}
                  </div>
                  {LADDER.map((row) => {
                    const v = Number(s[row.v] ?? 0), n = Number(s[row.n] ?? 0);
                    const share = !row.below && row.key !== "sale" && s.sale_value > 0 ? Math.round((v / s.sale_value) * 100) : null;
                    return (
                      /* H306: tighter rows on a phone — the ladder has 8 rows
                         and py-2.5 pushed Delivery rate off a 6" screen. */
                      <div key={row.key} className={`flex items-center gap-2 py-2 ${row.below ? "mt-1 border-t-2 border-line dark:border-white/[0.10]" : "border-t border-line/60 first:border-0 dark:border-white/[0.04]"}`}
                        style={{ paddingLeft: `${4 + row.indent * 12}px` }}>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] ${row.strong ? "font-bold text-ink dark:text-[#f4f1ea]" : "font-medium text-ink dark:text-[#e7e2d8]"} ${row.tone ? TONE_TXT[row.tone] : ""}`}>{row.label}</div>
                          {row.hint && <div className="truncate text-[10.5px] text-hint dark:text-[#8a8175]">{row.hint}</div>}
                        </div>
                        <div className="shrink-0 text-right tabular-nums">
                          <div className={`whitespace-nowrap ${row.strong ? "text-[14px] font-extrabold" : "text-[13px] font-semibold"} ${row.tone ? TONE_TXT[row.tone] : "text-ink dark:text-[#f4f1ea]"}`}>{rs(v)}</div>
                          <div className="whitespace-nowrap text-[10.5px] text-hint dark:text-[#8a8175]">{n.toLocaleString()} {n === 1 ? "order" : "orders"}{share !== null && ` · ${share}%`}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between border-t border-line pt-2.5 text-[13.5px] dark:border-white/[0.06]">
                    <span className="font-medium text-ink dark:text-[#e7e2d8]">Delivery rate</span>
                    <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{s.delivery_rate == null ? "—" : `${Number(s.delivery_rate).toFixed(1)}%`}</b>
                  </div>
                </div>
              )}
            </div>
          );
        })() : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
                  <th className="sticky left-0 z-10 bg-surface px-5 py-2.5 font-semibold dark:bg-[#201c17]" />
                  {M.storeCols.map((s) => {
                    const meta = STORES.find((x) => x.code === s.store_code);
                    return (
                      <th key={s.store_code} className={`whitespace-nowrap px-4 py-2.5 text-right font-semibold ${s.is_total ? "bg-panel/60 text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]" : ""}`}>
                        <span className="inline-flex items-center gap-1.5">
                          {!s.is_total && <span className="h-2 w-2 rounded-full" style={{ background: meta?.color }} />}
                          {meta?.label ?? s.store_code}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {LADDER.map((row) => (
                  <tr key={row.key}
                    className={`${row.below ? "border-t-2 border-line dark:border-white/[0.10]" : "border-t border-line/60 dark:border-white/[0.04]"}`}>
                    <td className="sticky left-0 z-10 bg-surface py-2.5 pr-3 dark:bg-[#201c17]"
                      style={{ paddingLeft: `${20 + row.indent * 16}px` }}>
                      <div className={`${row.strong ? "font-bold text-ink dark:text-[#f4f1ea]" : "font-medium text-ink dark:text-[#e7e2d8]"} ${row.tone ? TONE_TXT[row.tone] : ""}`}>
                        {row.label}
                      </div>
                      {row.hint && <div className="hidden text-[11px] text-hint sm:block dark:text-[#8a8175]">{row.hint}</div>}
                    </td>
                    {M.storeCols.map((s) => {
                      const v = Number(s[row.v] ?? 0);
                      const n = Number(s[row.n] ?? 0);
                      /* Share of that store's sales — except for cancelled, which
                         is not part of sales, so a percentage of them would be a
                         percentage of the wrong thing. */
                      const share = !row.below && row.key !== "sale" && s.sale_value > 0
                        ? Math.round((v / s.sale_value) * 100) : null;
                      return (
                        <td key={s.store_code} className={`px-4 py-2.5 text-right tabular-nums ${s.is_total ? "bg-panel/60 dark:bg-white/[0.04]" : ""}`}>
                          <div className={`whitespace-nowrap ${row.strong ? "text-[14px] font-extrabold" : "font-semibold"} ${row.tone ? TONE_TXT[row.tone] : "text-ink dark:text-[#f4f1ea]"}`}>
                            {rs(v)}
                          </div>
                          <div className="whitespace-nowrap text-[11px] text-hint dark:text-[#8a8175]">
                            {n.toLocaleString()} {n === 1 ? "order" : "orders"}{share !== null && ` · ${share}%`}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-line dark:border-white/[0.06]">
                  <td className="sticky left-0 z-10 bg-surface px-5 py-2.5 dark:bg-[#201c17]">
                    <div className="font-medium text-ink dark:text-[#e7e2d8]">Delivery rate</div>
                    <div className="hidden text-[11px] text-hint sm:block dark:text-[#8a8175]">delivered ÷ (delivered + returned)</div>
                  </td>
                  {M.storeCols.map((s) => (
                    <td key={s.store_code} className={`px-4 py-2.5 text-right font-bold tabular-nums text-ink dark:text-[#f4f1ea] ${s.is_total ? "bg-panel/60 dark:bg-white/[0.04]" : ""}`}>
                      {s.delivery_rate == null ? "—" : `${Number(s.delivery_rate).toFixed(1)}%`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-card border border-line bg-surface p-4 sm:p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
          <h3 className="mb-4 flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]"><MapPin size={16} /> Top cities</h3>
          {loading ? <div className="py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">Loading…</div> : <Pie data={M.cities} />}
        </div>

        {/* Dispatched parcels per courier in the chosen dates. The old chips
            counted the first 1,000 parcels of all time, whatever dates were set. */}
        <div className="min-w-0 rounded-card border border-line bg-surface p-4 sm:p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
          <h3 className="mb-4 flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]"><Truck size={16} /> By courier</h3>
          {loading ? <div className="py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">Loading…</div>
          : M.couriers.length === 0 ? <div className="py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">Nothing dispatched in this period.</div>
          : (
            <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full text-[13px] sm:min-w-[300px]">
              <thead className="text-[11.5px] uppercase tracking-wide text-muted dark:text-[#a89f93]">
                <tr>
                  <th className="pb-2 text-left font-semibold">Courier</th>
                  <th className="pb-2 text-right font-semibold">Dispatched</th>
                  <th className="pb-2 text-right font-semibold">Delivered</th>
                  <th className="pb-2 text-right font-semibold">Returned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.06]">
                {M.couriers.map((c) => (
                  <tr key={c.courier} className="text-ink dark:text-[#e7e2d8]">
                    <td className="py-2.5 font-semibold">{c.courier}</td>
                    <td className="py-2.5 text-right tabular-nums">{c.dispatched.toLocaleString()}</td>
                    <td className="py-2.5 text-right tabular-nums text-success">{c.delivered.toLocaleString()}</td>
                    <td className="py-2.5 text-right tabular-nums text-red-700 dark:text-salmon">{c.returned.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {err && <p className="mt-4 text-[12.5px] font-medium text-danger">Couldn&apos;t load: {err}</p>}
      {!isSupabaseConfigured && <p className="mt-4 text-center text-[12px] text-hint dark:text-[#8a8175]">Preview build · connect Supabase to load live figures.</p>}
    </div>
  );
}
