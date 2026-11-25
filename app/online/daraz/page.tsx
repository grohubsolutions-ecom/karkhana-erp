"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShoppingBag, Clock, Truck, CheckCircle2, Undo2, Ban, Wallet, TrendingUp, Search, RefreshCw, Upload, Download, ChevronRight, Phone, MessageCircle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { HubRange, PageActions, useIsPhone, Sheet, Detail, waNumber } from "@/components/HubUI";
import { rangeDates, num, rs } from "@/lib/dateRange";
import { exportCSV } from "@/lib/export";
import { groupClass, settleClass } from "@/lib/daraz";
import { usePermissions } from "@/lib/usePermissions";

type Row = Record<string, unknown>;
type Summary = {
  orders: number; items: number; gross: number; avg_order: number;
  pending: number; shipped: number; delivered: number; cancelled: number; returned: number;
  delivered_value: number; delivery_rate: number;
  net_payout: number; fees: number; paid_net: number; unpaid_net: number;
  awaiting_count: number; awaiting_value: number;
};

const GROUPS = ["All", "Pending", "Shipped", "Delivered", "Returned", "Cancelled"];
const SETTLE = ["Any payout", "Paid", "Part paid", "In statement · unpaid", "Not in statement"];
const COLS = "order_number,order_date,customer_name,phone,city,items,skus,paid_value,status,status_group,settlement,net_payout,fees,tracking_code,shipping_provider,payment_method";

/* DARAZ ORDERS — the same job as the Shopify Orders page, fed by the uploaded
   Seller Center export instead of a sync. Cards are counted in the database
   (daraz_summary); the table is one page of rows. */
export default function DarazOrdersPage() {
  const phone = useIsPhone();
  const { can } = usePermissions();
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [S, setS] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [group, setGroup] = useState("All");
  const [settle, setSettle] = useState("Any payout");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const [detail, setDetail] = useState<{ items: Row[]; lines: Row[] } | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const [from, to] = rangeDates(preset, cf, ct);
    const term = q.trim().replace(/^#/, "").replace(/["\\]/g, "");
    let qq = supabase.from("daraz_orders_v").select(COLS, { count: "exact" })
      .order("order_date", { ascending: false, nullsFirst: false }).order("order_number", { ascending: false }).limit(500);
    if (!term) { if (from) qq = qq.gte("order_date", from); if (to) qq = qq.lte("order_date", to); }
    if (group !== "All") qq = qq.eq("status_group", group);
    if (settle !== "Any payout") qq = qq.eq("settlement", settle);
    if (term) { const v = `"%${term}%"`; qq = qq.or(`order_number.ilike.${v},customer_name.ilike.${v},phone.ilike.${v},city.ilike.${v},skus.ilike.${v},tracking_code.ilike.${v}`); }
    const [r, s] = await Promise.all([qq, supabase.rpc("daraz_summary", { p_from: from, p_to: to })]);
    if (my !== reqId.current) return;
    if (r.error || s.error) setErr((r.error ?? s.error)!.message);
    setRows((r.data as Row[]) ?? []); setCount(r.count ?? null);
    setS((s.data as Summary[])?.[0] ?? null);
    setLoading(false);
  }, [preset, cf, ct, group, settle, q]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setDetail(null);
    if (!open || !supabase) return;
    let live = true;
    const on = String(open.order_number);
    Promise.all([
      supabase.from("daraz_order_items").select("order_item_id,seller_sku,item_name,variation,unit_price,paid_price,status,reason,address").eq("order_number", on),
      supabase.from("daraz_statement_lines").select("txn_date,fee_name,amount,paid_status,statement").eq("order_number", on).order("txn_date"),
    ]).then(([a, b]) => { if (live) setDetail({ items: (a.data as Row[]) ?? [], lines: (b.data as Row[]) ?? [] }); });
    return () => { live = false; };
  }, [open]);

  const cards = [
    { label: "Orders", value: (S?.orders ?? 0).toLocaleString(), Icon: ShoppingBag, bg: "bg-periwinkle-soft", g: "All" },
    { label: "Pending", value: (S?.pending ?? 0).toLocaleString(), Icon: Clock, bg: "bg-amber-soft", g: "Pending" },
    { label: "Shipped", value: (S?.shipped ?? 0).toLocaleString(), Icon: Truck, bg: "bg-lavender-soft", g: "Shipped" },
    { label: "Delivered", value: (S?.delivered ?? 0).toLocaleString(), Icon: CheckCircle2, bg: "bg-success-soft", g: "Delivered" },
    { label: "Returned / failed", value: (S?.returned ?? 0).toLocaleString(), Icon: Undo2, bg: "bg-salmon-soft", g: "Returned" },
    { label: "Cancelled", value: (S?.cancelled ?? 0).toLocaleString(), Icon: Ban, bg: "bg-pink-soft", g: "Cancelled" },
  ];
  const money = [
    { label: "Order value", value: rs(num(S?.gross)), sub: `Avg ${rs(num(S?.avg_order))}` },
    { label: "Delivered value", value: rs(num(S?.delivered_value)), sub: `Delivery rate ${num(S?.delivery_rate)}%` },
    { label: "Net payout (statement)", value: rs(num(S?.net_payout)), sub: `Fees ${rs(num(S?.fees))}` },
    { label: "Paid out / unpaid", value: rs(num(S?.paid_net)), sub: `Unpaid ${rs(num(S?.unpaid_net))}` },
    { label: "Delivered, not in statement", value: rs(num(S?.awaiting_value)), sub: `${num(S?.awaiting_count)} orders` },
  ];

  function doExport() {
    exportCSV({ title: "Daraz orders", headers: ["Order #", "Date", "Customer", "City", "Items", "SKUs", "Value", "Status", "Daraz status", "Payout", "Net payout", "Fees", "Tracking"],
      rows: rows.map((o) => [String(o.order_number), String(o.order_date ?? ""), String(o.customer_name ?? ""), String(o.city ?? ""), num(o.items), String(o.skus ?? ""), num(o.paid_value), String(o.status_group), String(o.status ?? ""), String(o.settlement), num(o.net_payout), num(o.fees), String(o.tracking_code ?? "")]) });
  }

  const sel = "rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white";
  const pill = (t: string, cls: string) => <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${cls}`}>{t}</span>;

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Daraz · Orders</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">From the Seller Center orders export. Payout columns come from uploaded account statements.</p>
        </div>
        <PageActions>
          {can(["hub.daraz.manage"]) && <Link href="/online/daraz/import" className="flex items-center justify-center gap-2 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white dark:bg-white dark:text-[#141414]"><Upload size={14} /> Upload files</Link>}
          <button onClick={doExport} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white"><Download size={14} /> Export</button>
          <button onClick={load} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
        </PageActions>
      </div>

      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={<>
          <select value={group} onChange={(e) => setGroup(e.target.value)} className={sel}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select>
          <select value={settle} onChange={(e) => setSettle(e.target.value)} className={sel}>{SETTLE.map((g) => <option key={g}>{g}</option>)}</select>
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 dark:border-white/10 dark:bg-white/[0.05]">
            <Search size={15} className="text-hint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order, name, phone, SKU" className="w-44 bg-transparent text-[13px] outline-none placeholder:text-hint dark:text-[#f4f1ea]" />
          </div>
        </>} />

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {cards.map(({ label, value, Icon, bg, g }) => (
          <button key={label} type="button" onClick={() => setGroup(g)}
            className={`rounded-card border p-3.5 text-left sm:p-4 dark:bg-[#201c17] ${bg} ${group === g ? "border-ink dark:border-white/40" : "border-line dark:border-white/[0.06]"}`}>
            <div className="flex items-center gap-2.5 sm:block">
              <span className="hidden h-9 w-9 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><Icon size={15} /></span>
              <div className="min-w-0 sm:mt-3">
                <div className="text-[15px] font-extrabold tabular-nums text-ink sm:text-[18px] dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
                <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{label}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {money.map((m) => (
          <div key={m.label} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted dark:text-[#a89f93]"><Wallet size={13} /> {m.label}</div>
            <div className="mt-1 text-[18px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : m.value}</div>
            <div className="text-[12px] text-hint dark:text-[#8a8175]"><TrendingUp size={11} className="mr-1 inline" />{m.sub}</div>
          </div>
        ))}
      </div>

      {phone ? (
        <div className="mt-4 space-y-2">
          {loading ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[76px] animate-pulse rounded-xl2 bg-panel/70" />)
            : err ? <p className="py-10 text-center text-[13px] text-danger">{err}</p>
            : rows.length === 0 ? <p className="py-14 text-center text-[13px] text-muted">No Daraz orders here yet — upload the orders export.</p>
            : rows.map((o) => (
              <button key={String(o.order_number)} type="button" onClick={() => setOpen(o)}
                className="flex w-full items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3 text-left active:bg-panel dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{String(o.order_number)}</span>
                    <span className="ml-auto text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(num(o.paid_value))}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{String(o.customer_name ?? "—")} · {String(o.city ?? "—")}</span>
                    {pill(String(o.status_group), groupClass(String(o.status_group)))}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    <span>{String(o.order_date ?? "—")}</span><span className="ml-auto">{pill(String(o.settlement), settleClass(String(o.settlement)))}</span>
                  </div>
                </div>
                <ChevronRight size={16} className="text-hint" />
              </button>
            ))}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                <th className="px-4 py-3">Order #</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">City</th>
                <th className="px-4 py-3">Items</th><th className="px-4 py-3 text-right">Value</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Payout</th><th className="px-4 py-3 text-right">Fees</th><th className="px-4 py-3 text-right">Net payout</th>
              </tr></thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                {loading ? Array.from({ length: 8 }).map((_, i) => <tr key={i}><td colSpan={10} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70" /></td></tr>)
                  : err ? <tr><td colSpan={10} className="px-4 py-12 text-center text-danger">Couldn&apos;t load Daraz orders: {err}</td></tr>
                  : rows.length === 0 ? <tr><td colSpan={10} className="px-4 py-16 text-center text-muted">No Daraz orders in this period — upload the orders export.</td></tr>
                  : rows.map((o) => (
                    <tr key={String(o.order_number)} onClick={() => setOpen(o)} className="cursor-pointer text-ink hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                      <td className="px-4 py-3 font-semibold">{String(o.order_number)}</td>
                      <td className="px-4 py-3 text-muted">{String(o.order_date ?? "—")}</td>
                      <td className="px-4 py-3">{String(o.customer_name ?? "—")}</td>
                      <td className="px-4 py-3 text-muted">{String(o.city ?? "—")}</td>
                      <td className="max-w-[220px] truncate px-4 py-3 text-muted" title={String(o.skus ?? "")}>{num(o.items)} · {String(o.skus ?? "")}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{rs(num(o.paid_value))}</td>
                      <td className="px-4 py-3" title={String(o.status ?? "")}>{pill(String(o.status_group), groupClass(String(o.status_group)))}</td>
                      <td className="px-4 py-3">{pill(String(o.settlement), settleClass(String(o.settlement)))}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">{num(o.fees) ? rs(num(o.fees)) : "—"}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{num(o.net_payout) ? rs(num(o.net_payout)) : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!loading && rows.length > 0 && <div className="border-t border-line px-4 py-3 text-[12px] text-hint dark:border-white/[0.06]">Showing {rows.length.toLocaleString()} of {(count ?? rows.length).toLocaleString()} orders</div>}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)}
        title={<span className="flex items-center gap-2">{String(open?.order_number ?? "")} {open && pill(String(open.status_group), groupClass(String(open.status_group)))}</span>}
        subtitle={`Daraz · ${String(open?.order_date ?? "")}`}
        footer={open && waNumber(open.phone) ? (
          <div className="grid grid-cols-2 gap-2">
            <a href={`tel:${String(open.phone)}`} className="flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[14px] font-semibold text-white dark:bg-white dark:text-[#141414]"><Phone size={17} /> Call</a>
            <a href={`https://wa.me/${waNumber(open.phone)}`} target="_blank" rel="noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-full border border-line text-[14px] font-semibold"><MessageCircle size={17} /> WhatsApp</a>
          </div>) : undefined}>
        {open && (
          <div>
            <Detail label="Customer">{String(open.customer_name ?? "—")}</Detail>
            <Detail label="City">{String(open.city ?? "—")}</Detail>
            <Detail label="Address">{detail ? String(detail.items[0]?.address ?? "—") : "…"}</Detail>
            <Detail label="Payment">{String(open.payment_method ?? "—")}</Detail>
            <Detail label="Tracking">{`${String(open.shipping_provider ?? "")} ${String(open.tracking_code ?? "—")}`}</Detail>
            <Detail label="Daraz status">{String(open.status ?? "—")}</Detail>
            <Detail label="Order value">{rs(num(open.paid_value))}</Detail>
            <Detail label="Payout">{String(open.settlement)} · {rs(num(open.net_payout))}</Detail>
            <div className="mt-3 text-[12px] font-bold uppercase tracking-wide text-hint">Items</div>
            {(detail?.items ?? []).map((it) => (
              <Detail key={String(it.order_item_id)} label={`${String(it.seller_sku ?? "")} ${String(it.variation ?? "")}`.trim() || "Item"}>
                {rs(num(it.paid_price))} · {String(it.status ?? "")}{it.reason ? ` · ${String(it.reason)}` : ""}
              </Detail>
            ))}
            <div className="mt-3 text-[12px] font-bold uppercase tracking-wide text-hint">Statement lines</div>
            {detail && detail.lines.length === 0 && <p className="py-2 text-[13px] text-muted">Not in any uploaded statement yet.</p>}
            {(detail?.lines ?? []).map((l, i) => (
              <Detail key={i} label={`${String(l.txn_date ?? "")} · ${String(l.fee_name ?? "")}`}>
                {rs(num(l.amount))} <span className="text-[11.5px] font-normal text-muted">{String(l.paid_status ?? "")}</span>
              </Detail>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
