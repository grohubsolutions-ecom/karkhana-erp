"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveTables } from "@/lib/useLiveTables";
import { Package, Truck, CheckCircle2, Undo2, Percent, Wallet, Search, RefreshCw, XCircle, Clock, TrendingUp, ChevronRight } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { HubRange, Segmented, PageActions, useIsPhone, Sheet, Detail } from "@/components/HubUI";
import { rangeDates, num, rs } from "@/lib/dateRange";
import { AddShipment } from "@/components/LogisticsEntry";
import CourierSync from "@/components/CourierSync";
import SmartImport from "@/components/SmartImport";
import HealthCheck from "@/components/HealthCheck";

type Logi = Record<string, unknown>;
type View = "list" | "couriers" | "status";

const STORES = [
  { code: "ALL", label: "All stores" }, { code: "LM", label: "Little Minors" },
  { code: "TS", label: "TopShop" }, { code: "TRZ", label: "Trenzee" },
];
const COURIERS = ["All couriers", "PostEx", "OwnEx"];
const VIEWS: { key: View; label: string; short: string }[] = [
  { key: "list", label: "Shipments", short: "Parcels" }, { key: "couriers", label: "Courier performance", short: "Couriers" }, { key: "status", label: "By Status", short: "Status" },
];

function deliveryClass(s: string) {
  switch (s) {
    case "Delivered": return "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success";
    case "RTS": case "Returned": return "bg-danger-soft text-danger dark:bg-white/[0.08] dark:text-danger";
    case "In Transit": return "bg-periwinkle-soft text-periwinkle-strong dark:bg-white/[0.08] dark:text-periwinkle";
    // Amber, not blue: an unbooked parcel is waiting on somebody here, not on
    // the courier. It should not look like the ones that need nothing.
    case "Unbooked": return "bg-amber-soft text-amber-900 dark:bg-amber-400/15 dark:text-amber-200";
    case "Cancelled": return "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]";
    default: return "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber";
  }
}
type Summary = {
  total: number; active: number; transit: number; transit_portal: number;
  delivered: number; rts: number; returned_received: number; out_for_return: number;
  cancelled: number; delivery_rate: number;
  cod: number; receivable: number; receivable_count: number; fees: number;
};

type CourierRow = {
  courier: string; total: number; transit: number; transit_portal: number;
  delivered: number; rts: number; returned_received: number; out_for_return: number;
  cancelled: number; delivery_rate: number;
  cod: number; receivable: number; receivable_count: number; fees: number;
};

type StatusRow = { raw_status: string; delivery_status: string; parcels: number };


export default function LogisticsPage() {
  const [rows, setRows] = useState<Logi[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trendRows, setTrendRows] = useState<{ day: string; delivered: number }[]>([]);
  const [courierSplit, setCourierSplit] = useState<CourierRow[]>([]);
  const [statusCounts, setStatusCounts] = useState<StatusRow[]>([]);
  const [rawStatus, setRawStatus] = useState("All statuses");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [store, setStore] = useState("ALL");
  const [courier, setCourier] = useState("All couriers");
  const [statusFilter, setStatusFilter] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("list");
  const phone = useIsPhone();
  /* One parcel, in full — on a phone the table's seven columns do not fit. */
  const [open, setOpen] = useState<Logi | null>(null);
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  /* The search box updates `q` on every key; the database is only asked once
     typing pauses, so a tracking number is one request, not fifteen. */
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  /* How many shipments really match — the list itself stops at 1,000. */
  const [matchCount, setMatchCount] = useState<number | null>(null);

  /* Every fetch carries a sequence number and only the newest one may write to
     state.
     WHY: `load` is rebuilt whenever preset/store/courier changes, so switching
     Today -> Yesterday can leave two queries in the air at once. Without this
     guard whichever FINISHES last wins — and that is often the OLDER one, which
     is why the range button and the figures on screen could disagree. Blocking
     the second request instead is not the answer either: that leaves the
     previous period's numbers sitting under the newly pressed button.
     `silent` skips the spinner so an automatic refresh does not flash the page.
     Both are refs, not state, so they cannot themselves cause a render. */
  const reqId = useRef(0);
  const lastLoadAt = useRef(0);

  /* `figuresOnly` is what a live update uses.
     The cards, the chart and the courier split are database aggregates — small,
     cheap, and the numbers people actually watch. The 1,000-row table is the
     expensive part of this page and the part that changes least: a courier sync
     moves a handful of statuses, not the list.
     So a realtime refresh brings the FIGURES up to date and leaves the list
     alone; Refresh, or any filter change, pulls the rows. Live numbers, cheap. */
  const load = useCallback(async (opts?: { silent?: boolean; figuresOnly?: boolean }) => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const myReq = ++reqId.current;
    if (!opts?.silent) setLoading(true);
    setErr("");
    const [from, to] = rangeDates(preset, cf, ct);
    let q2 = supabase.from("online_logistics")
      .select("id,order_number,store_code,courier,tracking_id,dispatch_date,delivery_status,delivery_date,cod_amount,cpr_net_amount,courier_fee,payment_status,rts,rts_reason", { count: "exact" })
      .order("dispatch_date", { ascending: false, nullsFirst: false })
      /* 1000, not 5000. PostgREST caps a response at 1000 rows however large
         the limit, so asking for 5000 fetched 1000 and quietly implied the page
         held five times more than it did. Every TOTAL on this page comes from
         hub_logistics_summary and is unaffected; this is the visible list. */
      .limit(1000);
    /* A search ignores the dates — somebody pasting a tracking number wants
       that parcel, whenever it was dispatched. */
    if (!term) {
      if (from) q2 = q2.gte("dispatch_date", from);
      if (to) q2 = q2.lte("dispatch_date", to);
    }
    if (store !== "ALL") q2 = q2.eq("store_code", store);
    if (courier !== "All couriers") q2 = q2.eq("courier", courier);
    if (rawStatus !== "All statuses") q2 = q2.eq("raw_status", rawStatus);
    /* THE CARD FILTER AND THE SEARCH RUN IN THE DATABASE.
       Both used to filter the 1,000 rows already loaded, so a parcel outside
       them showed "Nothing matches these filters" — indistinguishable from
       the parcel not existing. Every card filter value is a delivery_status. */
    if (statusFilter) q2 = q2.eq("delivery_status", statusFilter);
    if (term) {
      const v = `"%${term.replace(/^#/, "").replace(/["\\]/g, "")}%"`;
      q2 = q2.or(`order_number.ilike.${v},tracking_id.ilike.${v}`);
    }
    // Rows are for the table only. The cards and the chart come from database
    // aggregates, because PostgREST caps a response at 1,000 rows and counting
    // a truncated page understated every total (see migration 0051).
    const args = {
      p_from: from ?? null, p_to: to ?? null,
      p_store: store === "ALL" ? null : store,
      p_courier: courier === "All couriers" ? null : courier,
    };
    const [rowsRes, sumRes, trendRes, courierRes, statusRes] = await Promise.all([
      opts?.figuresOnly ? Promise.resolve({ data: null, error: null, count: null }) : q2,
      supabase.rpc("hub_logistics_summary", args),
      supabase.rpc("hub_logistics_trend", { ...args, p_days: 14 }),
      supabase.rpc("hub_logistics_by_courier", { p_from: args.p_from, p_to: args.p_to, p_store: args.p_store }),
      supabase.rpc("hub_logistics_status_counts", args),
    ]);
    // a newer request has started since this one left — throw the answer away
    // rather than painting stale figures under a freshly pressed button
    if (myReq !== reqId.current) return;

    /* Any failure is SAID. A failed summary used to fall back quietly to
       counting the 1,000 loaded rows, which looked like real figures. */
    const firstErr = rowsRes.error ?? sumRes.error ?? trendRes.error ?? courierRes.error ?? statusRes.error;
    if (firstErr) setErr(firstErr.message);
    // figuresOnly leaves the existing table in place rather than blanking it
    if (!opts?.figuresOnly) {
      setRows((rowsRes.data as Logi[]) ?? []);
      setMatchCount(typeof rowsRes.count === "number" ? rowsRes.count : null);
    }
    setSummary((sumRes.data as Summary[])?.[0] ?? null);
    setTrendRows((trendRes.data as { day: string; delivered: number }[]) ?? []);
    // when one courier is selected the comparison is meaningless — show that
    // courier alone, so the table and the cards always agree
    const split = (courierRes.data as CourierRow[]) ?? [];
    setCourierSplit(courier === "All couriers" ? split : split.filter((c) => c.courier === courier));
    setStatusCounts((statusRes.data as StatusRow[]) ?? []);
    setLoading(false);
    lastLoadAt.current = Date.now();
  }, [preset, cf, ct, store, courier, rawStatus, statusFilter, term]);
  useEffect(() => { load(); }, [load]);

  /* Live. The couriers push (PostEx webhook) or are polled (OwnEx), both of
     which write straight to online_logistics — this repaints the page when they
     do, so nobody has to press Refresh to find out a parcel was delivered. */
  /* online_orders was in this list and is never read on this page, so every
     Shopify webhook triggered a full logistics refetch for nothing. */
  const { live, lastChange } = useLiveTables(
    ["online_logistics"],
    useCallback(() => load({ silent: true, figuresOnly: true }), [load]),
  );

  /* Any click on a control in this section refreshes the data — but only if
     nothing else already did.
     The range and filter buttons change state, which changes load()'s identity
     and reloads through the effect below. Firing a second fetch on top of that
     is what made the page blink twice for one click. So: wait, then check
     whether a load has happened in the meantime, and stay out of the way if it
     has. Refreshes triggered this way are silent — the numbers change, the
     spinner does not. */
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* THE BUG THIS REF FIXES — "click 30 days, see 7 days"
     This handler used to close over `load` directly. Clicking a range button
     changes `preset`, which rebuilds `load` — but the handler already bound to
     the PREVIOUS one. Half a second later it fired the OLD load, which fetched
     the OLD range and bumped the request token, discarding the correct 30-day
     answer still in flight. Clicking again worked because by then the handler
     had caught up. A stale closure, not a race in the query.
     Holding the latest `load` in a ref means the timer always calls the current
     one, whatever it was bound to at click time. */
  const loadRef = useRef(load);
  loadRef.current = load;

  const refreshOnClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.("button, select, [role='tab'], [role='option']")) return;
    /* Switching the view or opening a parcel changes nothing the database
       needs to answer. On a phone every such tap used to pull the whole list
       again 600ms later and repaint it under the thumb. */
    if (t.closest("[data-no-refresh]")) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      if (Date.now() - lastLoadAt.current < 2500) return;   // something already refreshed
      loadRef.current({ silent: true });
    }, 600);
  }, []);

  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current); }, []);

  /* The database filtered store, courier, status, card and search — the rows
     that came back ARE the matches. */
  const filtered = rows;

  /* EVERY CARD FROM THE DATABASE, never from the loaded rows.
     "Not collected" read 0 on every load: the summary function has no Unbooked
     figure and only the fallback below it computed one — a fallback that could
     only run when the summary had failed. It now comes from the status counts,
     which are counted over every parcel in the period. */
  const M = useMemo(() => {
    const n = (v: unknown) => Number(v ?? 0);
    const unbooked = statusCounts
      .filter((r) => r.delivery_status === "Unbooked")
      .reduce((a, r) => a + n(r.parcels), 0);
    const S = summary;
    return {
      total: n(S?.total), active: n(S?.active), transit: n(S?.transit),
      transitPortal: n(S?.transit_portal), unbooked,
      delivered: n(S?.delivered), rts: n(S?.rts),
      returnedReceived: n(S?.returned_received), outForReturn: n(S?.out_for_return),
      cancelled: n(S?.cancelled),
      rate: n(S?.delivery_rate), cod: n(S?.cod),
      receivable: n(S?.receivable), receivableCount: n(S?.receivable_count),
      fees: n(S?.fees),
    };
  }, [summary, statusCounts]);

  // 14-day delivered trend, counted in the database
  const trend = useMemo(() =>
    [...trendRows].sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => ({ date: r.day, count: Number(r.delivered ?? 0) })),
  [trendRows]);

  const cards = [
    { label: "Active shipments", value: M.active.toLocaleString(), sub: M.cancelled ? `${M.total.toLocaleString()} incl. cancelled` : undefined, Icon: Package, bg: "bg-periwinkle-soft" },
    { label: "Not collected", filter: "Unbooked", value: (M.unbooked ?? 0).toLocaleString(),
      sub: (M.unbooked ?? 0) ? "still with us — chase the pickup" : undefined,
      Icon: Package, bg: "bg-amber-soft" },
    { label: "In transit", filter: "In Transit", value: (M.transitPortal || M.transit).toLocaleString(),
      sub: M.outForReturn ? `incl. ${M.outForReturn} coming back` : undefined,
      Icon: Truck, bg: "bg-amber-soft" },
    { label: "Delivered", filter: "Delivered", value: M.delivered.toLocaleString(), Icon: CheckCircle2, bg: "bg-success-soft" },
    // split the way the courier portals do: a parcel travelling back is still
    // moving, only a received one is a finished return
    { label: "Returned", filter: "Returned", value: (M.returnedReceived ?? M.rts).toLocaleString(),
      sub: "back with us", Icon: Undo2, bg: "bg-salmon-soft" },
    { label: "Out for return", filter: "RTS", value: M.outForReturn.toLocaleString(),
      sub: M.outForReturn ? "counted in transit" : "none", Icon: Undo2, bg: "bg-panel" },
    { label: "Cancelled", filter: "Cancelled", value: M.cancelled.toLocaleString(), Icon: XCircle, bg: "bg-panel" },
    { label: "Delivery rate", value: `${M.rate.toFixed(1)}%`, Icon: Percent, bg: "bg-lavender-soft" },
    { label: "COD delivered", value: rs(M.cod), Icon: Wallet, bg: "bg-pink-soft" },
    { label: "COD receivable", value: rs(M.receivable), sub: M.receivableCount ? `${M.receivableCount.toLocaleString()} parcels unpaid` : "all settled", Icon: Clock, bg: "bg-success-soft", warn: M.receivable > 0 },
  ];

  // Counted in the database (0052). The previous version tallied the rows the
  // browser happened to receive, which PostgREST caps at 1,000 — so on wide
  // ranges this table under-reported exactly like the cards did.
  const byCourier = useMemo(() =>
    courierSplit.filter((c) => c.courier !== "TOTAL").map((c) => ({
      name: c.courier, total: Number(c.total), delivered: Number(c.delivered),
      rts: Number(c.returned_received ?? c.rts), outForReturn: Number(c.out_for_return ?? 0),
      transit: Number(c.transit_portal ?? c.transit), cancelled: Number(c.cancelled),
      cod: Number(c.cod), receivable: Number(c.receivable), fees: Number(c.fees),
      rate: Number(c.delivery_rate),
    })), [courierSplit]);

  /* BY STATUS counts every parcel in the period — it tallied the 1,000 loaded
     rows before, although the full counts were already on hand. */
  const byStatus = useMemo(() => {
    const m: Record<string, number> = {};
    statusCounts.forEach((r) => { const k = String(r.delivery_status || "—"); m[k] = (m[k] || 0) + Number(r.parcels ?? 0); });
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [statusCounts]);
  const maxStatus = Math.max(...byStatus.map((s) => s.count), 1);

  return (
    <div onClickCapture={refreshOnClick} className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="hidden text-[22px] font-extrabold tracking-tight text-ink md:block dark:text-[#f4f1ea]">Logistics</h1>
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted md:mt-1 dark:text-[#a89f93]">
            <span className="hidden md:inline">PostEx / OwnEx tracking, delivery performance &amp; RTS.</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${live ? "bg-success-soft text-success dark:bg-white/[0.08]" : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-success" : "bg-muted"}`} />
              {live ? "Live" : "Not live"}
              {lastChange && live ? ` \u00b7 updated ${lastChange.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
            </span>
          </p>
        </div>
        <PageActions>
          <SmartImport onDone={load} />
          <HealthCheck />
          <CourierSync onDone={load} />
          <AddShipment onDone={load} />
          <button onClick={() => load()} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={
          <>
            <select value={store} onChange={(e) => setStore(e.target.value)} className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
              {STORES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
            <select value={courier}
              onChange={(e) => { setCourier(e.target.value); setRawStatus("All statuses"); }}
              className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
              {COURIERS.map((c) => <option key={c}>{c}</option>)}
            </select>

            {/* the courier's own statuses — Booked, Out For Delivery, Attempted
                and the rest — built from the data, so a new one appears by itself */}
            <select value={rawStatus} onChange={(e) => setRawStatus(e.target.value)}
              className="max-w-[220px] rounded-full max-md:max-w-none border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
              <option>All statuses</option>
              {[...new Map(statusCounts.map((r) => [r.raw_status, r])).values()]
                .sort((a, b) => Number(b.parcels) - Number(a.parcels))
                .map((r) => (
                  <option key={r.raw_status} value={r.raw_status}>
                    {r.raw_status} ({Number(r.parcels).toLocaleString()})
                  </option>
                ))}
            </select>
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 dark:border-white/10 dark:bg-white/[0.05]">
              <Search size={15} className="text-hint dark:text-[#8a8175]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order or tracking" className="w-40 bg-transparent text-[13px] outline-none placeholder:text-hint sm:w-44 dark:text-[#f4f1ea] dark:placeholder:text-[#6f675c]" />
            </div>
          </>
        } />

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-9">
        {cards.map(({ label, value, sub, Icon, bg, warn, filter }) => {
          const clickable = filter !== undefined;
          const active = clickable && statusFilter === filter && !(filter === "" && !statusFilter);
          return (
          <button key={label} type="button"
            onClick={() => clickable && setStatusFilter(statusFilter === filter ? "" : (filter as string))}
            disabled={!clickable}
            title={clickable ? `Show only ${label.toLowerCase()}` : undefined}
            className={`rounded-card border ${active ? "border-ink ring-2 ring-ink/20 dark:border-white/40" : "border-line dark:border-white/[0.06]"} ${bg} p-3.5 text-left transition sm:p-4 ${clickable ? "cursor-pointer hover:brightness-95 active:scale-[0.98] dark:hover:brightness-110" : "cursor-default"} dark:bg-[#201c17]`}>
            <div className="flex items-center gap-2.5 sm:block">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><Icon size={15} /></span>
              <div className="min-w-0 sm:mt-3">
                <div className={`max-sm:truncate text-[15px] font-extrabold tabular-nums sm:text-[17px] ${warn ? "text-amber-strong dark:text-amber" : "text-ink dark:text-[#f4f1ea]"}`}>{loading ? "—" : value}</div>
                <div className="text-[12px] font-medium max-sm:truncate text-muted dark:text-[#a89f93]">{label}</div>
              </div>
            </div>
            {sub && <div className="mt-1 text-[10.5px] leading-tight text-hint dark:text-[#8a8175]">{sub}</div>}
          </button>
          );
        })}
      </div>

      {statusFilter && (
        <button onClick={() => setStatusFilter("")}
          className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-white md:min-h-0 dark:bg-white dark:text-[#141414]">
          Showing {statusFilter} only · clear
        </button>
      )}

      {/* per-courier split — reconciling against a courier portal needs their
          share, not a combined figure. Counted in the database (0052). */}
      {courierSplit.length > 1 && phone && (
        <div className="mt-4 space-y-2">
          {courierSplit.map((c) => {
            const isTotal = c.courier === "TOTAL";
            const cell = (label: string, v: string, cls = "") => (
              <div className="min-w-0"><div className={`max-sm:truncate text-[14px] font-bold tabular-nums ${cls || "text-ink dark:text-[#f4f1ea]"}`}>{v}</div><div className="truncate text-[11px] text-muted dark:text-[#a89f93]">{label}</div></div>);
            return (
              <div key={c.courier} className={`rounded-xl2 border border-line px-4 py-3 dark:border-white/[0.06] ${isTotal ? "bg-panel dark:bg-white/[0.06]" : "bg-surface dark:bg-[#201c17]"}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14.5px] font-extrabold text-ink dark:text-[#f4f1ea]">{isTotal ? "All couriers" : c.courier}</span>
                  <span className="text-[13px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{Number(c.delivery_rate).toFixed(1)}% <span className="font-medium text-muted dark:text-[#a89f93]">delivered</span></span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
                  {cell("Total", Number(c.total).toLocaleString())}
                  {cell("In transit", Number(c.transit_portal ?? c.transit).toLocaleString())}
                  {cell("Delivered", Number(c.delivered).toLocaleString(), "text-success")}
                  {cell("Returned", Number(c.returned_received ?? c.rts).toLocaleString(), "text-danger")}
                  {cell("Out for return", Number(c.out_for_return ?? 0).toLocaleString())}
                  {cell("Cancelled", Number(c.cancelled).toLocaleString())}
                  <div className="col-span-3 flex justify-between gap-3 border-t border-line pt-2 text-[12.5px] dark:border-white/[0.06]">
                    <span className="text-muted dark:text-[#a89f93]">COD delivered <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{rs(Number(c.cod))}</b></span>
                    <span className="text-muted dark:text-[#a89f93]">Due <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{Number(c.receivable) > 0 ? rs(Number(c.receivable)) : "—"}</b></span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {courierSplit.length > 1 && !phone && (
        <div className="mt-4 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead className="text-left text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">
              <tr className="border-b border-line dark:border-white/[0.06]">
                <th className="px-4 py-2.5">Courier</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5 text-right">In transit</th>
                <th className="px-4 py-2.5 text-right">Delivered</th>
                <th className="px-4 py-2.5 text-right">Returned</th>
                <th className="px-4 py-2.5 text-right">Out for return</th>
                <th className="px-4 py-2.5 text-right">Cancelled</th>
                <th className="px-4 py-2.5 text-right">Rate</th>
                <th className="px-4 py-2.5 text-right">COD delivered</th>
                <th className="px-4 py-2.5 text-right">Receivable</th>
              </tr>
            </thead>
            <tbody>
              {courierSplit.map((c) => {
                const isTotal = c.courier === "TOTAL";
                return (
                  <tr key={c.courier} className={`border-b border-line last:border-0 dark:border-white/[0.06] ${isTotal ? "bg-panel font-bold dark:bg-white/[0.06]" : "text-ink dark:text-[#e7e2d8]"}`}>
                    <td className="px-4 py-2.5 font-semibold text-ink dark:text-[#f4f1ea]">{c.courier}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(c.total).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(c.transit_portal ?? c.transit).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-success">{Number(c.delivered).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-danger">{Number(c.returned_received ?? c.rts).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted dark:text-[#a89f93]">{Number(c.out_for_return ?? 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted dark:text-[#a89f93]">{Number(c.cancelled).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(c.delivery_rate).toFixed(1)}%</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rs(Number(c.cod))}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(c.receivable) > 0 ? rs(Number(c.receivable)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* delivered trend — the courier portals show this, so we do too */}
      {!loading && trend.length > 1 && (
        <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
          <h3 className="mb-3 flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]"><TrendingUp size={16} /> Delivered per day</h3>
          <div className="flex h-28 items-end gap-1 sm:gap-1.5">
            {trend.map((d) => {
              const max = Math.max(...trend.map((x) => x.count), 1);
              return (
                <div key={d.date} className="group flex flex-1 flex-col items-center gap-1">
                  <span className="text-[9.5px] font-semibold tabular-nums text-muted opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 dark:text-[#a89f93]">{d.count}</span>
                  <div className="w-full rounded-t bg-success transition hover:opacity-80" style={{ height: `${Math.max((d.count / max) * 80, 3)}px` }} title={`${d.date}: ${d.count} delivered`} />
                  <span className="text-[9.5px] text-hint dark:text-[#8a8175]">{d.date.slice(8)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div data-no-refresh><Segmented className="mt-5" value={view} onChange={setView} options={VIEWS} /></div>

      {phone ? (
        <div data-no-refresh className="mt-3 space-y-2">
          {loading ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[72px] animate-pulse rounded-xl2 bg-panel/70 dark:bg-white/[0.05]" />)
          : err ? <p className="px-4 py-10 text-center text-[13px] text-danger">Couldn&apos;t load logistics: {err}</p>
          : (view === "list" ? filtered.length === 0 : view === "couriers" ? byCourier.length === 0 : byStatus.length === 0)
            ? <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">{statusFilter || term || rawStatus !== "All statuses" ? "Nothing matches these filters." : "No shipments in this period."}</p>
          : view === "list" ? filtered.slice(0, 500).map((l, i) => (
              <button key={i} type="button" onClick={() => setOpen(l)}
                className="flex w-full items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3 text-left transition active:scale-[0.99] active:bg-panel dark:border-white/[0.06] dark:bg-[#201c17] dark:active:bg-white/[0.05]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{String(l.order_number ?? "—")}</span>
                    <span className="shrink-0 rounded-md bg-panel px-1.5 py-0.5 text-[10.5px] font-bold text-muted dark:bg-white/[0.06] dark:text-[#a89f93]">{String(l.store_code ?? "")}</span>
                    <span className="ml-auto shrink-0 text-[14.5px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{l.cod_amount == null ? "—" : rs(num(l.cod_amount))}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted dark:text-[#a89f93]">{String(l.courier ?? "—")} · {String(l.tracking_id ?? "—")}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${deliveryClass(String(l.delivery_status))}`}>{String(l.delivery_status ?? "—")}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-hint dark:text-[#8a8175]">Dispatched {String(l.dispatch_date ?? "—")}{l.delivery_date ? ` · delivered ${String(l.delivery_date)}` : ""}</div>
                </div>
                <ChevronRight size={16} className="shrink-0 text-hint" />
              </button>
            ))
          : view === "couriers" ? byCourier.map((c) => (
              <div key={c.name} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-baseline justify-between"><span className="text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{c.name}</span><span className="text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{c.rate.toFixed(1)}%</span></div>
                <div className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">{c.total.toLocaleString()} shipments · <span className="text-success">{c.delivered.toLocaleString()} delivered</span> · <span className="text-danger">{c.rts.toLocaleString()} RTS</span></div>
                <div className="mt-0.5 text-[12.5px] text-muted dark:text-[#a89f93]">COD {rs(c.cod)} · fees {rs(c.fees)}</div>
              </div>
            ))
          : byStatus.map((st) => (
              <div key={st.name} className="rounded-xl2 border border-line bg-surface px-4 py-3 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-center justify-between gap-3">
                  <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${deliveryClass(st.name)}`}>{st.name}</span>
                  <span className="text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{st.count.toLocaleString()}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]"><div className="h-full rounded-full bg-periwinkle" style={{ width: `${Math.max((st.count / maxStatus) * 100, 2)}%` }} /></div>
              </div>
            ))}
          {!loading && !err && filtered.length > 0 && view === "list" && (
            <p className="px-1 pt-1 text-[12px] text-hint dark:text-[#8a8175]">Showing {Math.min(filtered.length, 500).toLocaleString()} of {(matchCount ?? filtered.length).toLocaleString()} shipments{(matchCount ?? 0) > 500 && " — narrow the dates or search to see the rest"}</p>
          )}
        </div>
      ) : (
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                {view === "list" && <><th className="px-4 py-3 font-semibold">Order #</th><th className="px-4 py-3 font-semibold">Store</th><th className="px-4 py-3 font-semibold">Courier</th><th className="px-4 py-3 font-semibold">Tracking</th><th className="px-4 py-3 font-semibold">Dispatched</th><th className="px-4 py-3 text-right font-semibold">COD</th><th className="px-4 py-3 font-semibold">Delivery</th></>}
                {view === "couriers" && <><th className="px-4 py-3 font-semibold">Courier</th><th className="px-4 py-3 text-right font-semibold">Shipments</th><th className="px-4 py-3 text-right font-semibold">Delivered</th><th className="px-4 py-3 text-right font-semibold">RTS</th><th className="px-4 py-3 text-right font-semibold">Rate</th><th className="px-4 py-3 text-right font-semibold">COD</th><th className="px-4 py-3 text-right font-semibold">Fees</th></>}
                {view === "status" && <><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 text-right font-semibold">Shipments</th><th className="hidden px-4 py-3 font-semibold sm:table-cell">Share</th></>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-white/[0.05]">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>)
              ) : err ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load logistics: {err}</td></tr>
              ) : (view === "list" ? filtered.length === 0 : view === "couriers" ? byCourier.length === 0 : byStatus.length === 0) ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">{statusFilter || term || rawStatus !== "All statuses" ? "Nothing matches these filters." : "No shipments in this period."}</td></tr>
              ) : view === "list" ? (
                filtered.slice(0, 500).map((l, i) => (
                  <tr key={i} className="text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-semibold">{String(l.order_number ?? "—")}</td>
                    <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(l.store_code ?? "—")}</td>
                    <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(l.courier ?? "—")}</td>
                    <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(l.tracking_id ?? "—")}</td>
                    <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{String(l.dispatch_date ?? "—")}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{l.cod_amount == null ? "—" : rs(num(l.cod_amount))}</td>
                    <td className="px-4 py-3"><span className={`inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${deliveryClass(String(l.delivery_status))}`}>{String(l.delivery_status ?? "—")}</span></td>
                  </tr>
                ))
              ) : view === "couriers" ? (
                byCourier.map((c) => (
                  <tr key={c.name} className="text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-semibold">{c.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.total.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-success">{c.delivered.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-danger">{c.rts.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">{c.rate.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right tabular-nums">{rs(c.cod)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">{rs(c.fees)}</td>
                  </tr>
                ))
              ) : (
                byStatus.map((s) => (
                  <tr key={s.name} className="text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                    <td className="px-4 py-3"><span className={`inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${deliveryClass(s.name)}`}>{s.name}</span></td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{s.count.toLocaleString()}</td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <div className="h-2 w-full max-w-[160px] overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]">
                        <div className="h-full rounded-full bg-periwinkle" style={{ width: `${Math.max((s.count / maxStatus) * 100, 2)}%` }} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && !err && filtered.length > 0 && view === "list" && (
          <div className="border-t border-line px-4 py-3 text-[12px] text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
            Showing {Math.min(filtered.length, 500).toLocaleString()} of {(matchCount ?? filtered.length).toLocaleString()} shipments
            {(matchCount ?? 0) > 500 && " — narrow the dates or search to see the rest"}
          </div>
        )}
      </div>
      )}

      <div data-no-refresh>
        <Sheet open={!!open} onClose={() => setOpen(null)}
          title={<span className="flex items-center gap-2">{String(open?.order_number ?? "")}<span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${deliveryClass(String(open?.delivery_status))}`}>{String(open?.delivery_status ?? "")}</span></span>}
          subtitle={`${String(open?.store_code ?? "")} · ${String(open?.courier ?? "")}`}>
          {open && (
            <div>
              <Detail label="Tracking">{String(open.tracking_id ?? "—")}</Detail>
              <Detail label="Dispatched">{String(open.dispatch_date ?? "—")}</Detail>
              <Detail label="Delivered">{String(open.delivery_date ?? "—")}</Detail>
              <Detail label="COD">{open.cod_amount == null ? "—" : rs(num(open.cod_amount))}</Detail>
              <Detail label="Courier fee">{open.courier_fee == null ? "—" : rs(num(open.courier_fee))}</Detail>
              <Detail label="Paid to us">{open.cpr_net_amount == null ? "—" : rs(num(open.cpr_net_amount))}</Detail>
              <Detail label="Payment">{String(open.payment_status ?? "—")}</Detail>
              {open.rts ? <Detail label="Return">{String(open.rts_reason ?? open.rts)}</Detail> : null}
            </div>
          )}
        </Sheet>
      </div>
      {!isSupabaseConfigured && <p className="mt-4 text-center text-[12px] text-hint dark:text-[#8a8175]">Preview build · connect Supabase to load live shipments.</p>}
    </div>
  );
}
