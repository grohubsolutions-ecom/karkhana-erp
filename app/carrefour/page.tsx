"use client";
/* CARREFOUR — STOCK & SALES (K192)
 *
 * Carrefour sends a stock report for its shops. Each upload is filed under
 * the date it is for. This screen puts a shop's latest report beside the one
 * before it and says, per article:
 *
 *   previous   what the shop held at the last report
 *   sent       what the warehouse delivered to that shop in between — the
 *              STR lines already recorded against the Carrefour branch
 *   current    what the shop holds now
 *   sold       previous + sent − current
 *
 * "Sold" counts the deliveries. Previous 100, current 80 looks like 20 sold;
 * if 50 were delivered meanwhile, 70 were sold.
 *
 * A shop with only one report has nothing to compare against yet: its
 * previous and sold columns stay empty rather than pretend.
 *
 * FOUR WAYS TO LOOK AT IT
 *   Shop by shop every article down the side, and for EACH shop three
 *                columns side by side: old stock · current stock ·
 *                difference (old − current) — the owner's own sheet layout
 *                (27 Oct). The default.
 *   Shops        one line per shop — the totals
 *   Articles     every article in every shop (or one shop)
 *   Warehouse    one line per article across all shops, beside what the
 *                warehouse still holds — the comparison with the warehouse
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ShoppingCart, Download, Printer, Upload, Loader2 } from "lucide-react";
import Topbar from "@/components/Topbar";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { exportCSV, exportExcel, exportPDF, printTable, type ExportTable } from "@/lib/export";

type Row = {
  branch_id: string; shop: string; prev_date: string | null; curr_date: string;
  item_id: string | null; barcode: string | null; article: string | null;
  prev_qty: number | null; sent_qty: number | null; curr_qty: number; sold_qty: number | null;
  retail_price: number | null; sold_value: number | null;
};
type Shop = { branch_id: string; name: string; last_report: string | null; reports: number };
type View = "matrix" | "shops" | "articles" | "warehouse";
type Only = "all" | "sold" | "restocked" | "out" | "unknown";

const num = (v: unknown) => Number(v ?? 0) || 0;
const n = (v: number | null | undefined) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const rs = (v: number | null | undefined) => v == null ? "—" : "Rs " + Math.round(Number(v)).toLocaleString();
const day = (v: string | null) => v ? new Date(v + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const today = () => new Date().toLocaleDateString("en-CA");
const short = (v: string | null) => v ? new Date(v + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
type Cell = { p: number | null; c: number };
const diffOf = (x?: Cell) => x == null || x.p == null ? null : x.p - x.c;

export default function CarrefourPage() {
  const { can } = usePermissions();
  const canUpload = can(["carrefour.upload"]);

  const [shops, setShops] = useState<Shop[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [view, setView] = useState<View>("matrix");
  const [shopId, setShopId] = useState("");          // "" = every shop
  const [asOf, setAsOf] = useState("");              // "" = latest
  const [from, setFrom] = useState("");              // "" = the report just before
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<Only>("all");

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) { setLoading(false); return; }
    setLoading(true); setErr("");
    const [s, c, w] = await Promise.all([
      supabase.rpc("carrefour_shops"),
      supabase.rpc("carrefour_compare", { p_branch: null, p_as_of: asOf || null, p_from: from || null }),
      supabase.from("v_khana_stock").select("item_id, quantity"),
    ]);
    if (s.error || c.error) { setErr((s.error ?? c.error)!.message); setLoading(false); return; }
    setShops((s.data ?? []) as Shop[]);
    setRows(((c.data ?? []) as Row[]).map((r) => ({
      ...r,
      prev_qty: r.prev_qty == null ? null : num(r.prev_qty), sent_qty: r.sent_qty == null ? null : num(r.sent_qty),
      curr_qty: num(r.curr_qty), sold_qty: r.sold_qty == null ? null : num(r.sold_qty),
      retail_price: r.retail_price == null ? null : num(r.retail_price), sold_value: r.sold_value == null ? null : num(r.sold_value),
    })));
    const m: Record<string, number> = {};
    ((w.data ?? []) as { item_id: string; quantity: number }[]).forEach((x) => { m[x.item_id] = num(x.quantity); });
    setStock(m);
    setLoading(false);
  }, [asOf, from]);
  useEffect(() => { load(); }, [load]);

  /* Article rows after the shop, search and "only" filters. */
  const lines = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (shopId && r.branch_id !== shopId) return false;
      if (t && ![r.article, r.barcode, r.shop].some((x) => String(x ?? "").toLowerCase().includes(t))) return false;
      if (only === "sold" && !(num(r.sold_qty) > 0)) return false;
      if (only === "restocked" && !(num(r.sent_qty) > 0)) return false;
      if (only === "out" && !(r.curr_qty <= 0 && (num(r.prev_qty) > 0 || num(r.sent_qty) > 0))) return false;
      if (only === "unknown" && r.item_id) return false;
      return true;
    });
  }, [rows, shopId, q, only]);

  /* One line per shop. */
  const perShop = useMemo(() => {
    const m = new Map<string, { id: string; shop: string; prev_date: string | null; curr_date: string;
      prev: number | null; sent: number | null; curr: number; sold: number | null; value: number | null; articles: number }>();
    lines.forEach((r) => {
      const x = m.get(r.branch_id) ?? { id: r.branch_id, shop: r.shop, prev_date: r.prev_date, curr_date: r.curr_date,
        prev: r.prev_date ? 0 : null, sent: r.prev_date ? 0 : null, curr: 0, sold: r.prev_date ? 0 : null,
        value: r.prev_date ? 0 : null, articles: 0 };
      if (x.prev != null) { x.prev += num(r.prev_qty); x.sent! += num(r.sent_qty); x.sold! += num(r.sold_qty); x.value! += num(r.sold_value); }
      x.curr += r.curr_qty; x.articles += 1;
      m.set(r.branch_id, x);
    });
    return [...m.values()].sort((a, b) => a.shop.localeCompare(b.shop));
  }, [lines]);

  /* One line per article across the shops, beside the warehouse. */
  const perArticle = useMemo(() => {
    const m = new Map<string, { key: string; item_id: string | null; barcode: string | null; article: string | null;
      prev: number; sent: number; curr: number; sold: number; value: number; comparable: boolean; shops: number }>();
    lines.forEach((r) => {
      const k = r.item_id ?? "bc:" + r.barcode;
      const x = m.get(k) ?? { key: k, item_id: r.item_id, barcode: r.barcode, article: r.article,
        prev: 0, sent: 0, curr: 0, sold: 0, value: 0, comparable: false, shops: 0 };
      x.prev += num(r.prev_qty); x.sent += num(r.sent_qty); x.curr += r.curr_qty;
      x.sold += num(r.sold_qty); x.value += num(r.sold_value);
      x.comparable = x.comparable || r.prev_date != null; x.shops += 1;
      m.set(k, x);
    });
    return [...m.values()].sort((a, b) => b.sold - a.sold || String(a.article).localeCompare(String(b.article)));
  }, [lines]);

  /* Shop by shop: one row per article, a cell per shop. */
  const matrix = useMemo(() => {
    const m = new Map<string, { key: string; barcode: string | null; article: string | null; cells: Record<string, Cell> }>();
    lines.forEach((r) => {
      const k = r.item_id ?? "bc:" + r.barcode;
      const x = m.get(k) ?? { key: k, barcode: r.barcode, article: r.article, cells: {} };
      x.cells[r.branch_id] = { p: r.prev_qty, c: r.curr_qty };
      m.set(k, x);
    });
    return [...m.values()].sort((a, b) => String(a.article).localeCompare(String(b.article)));
  }, [lines]);
  const rowTotal = (cells: Record<string, Cell>): Cell => {
    const xs = perShop.map((s) => cells[s.id]).filter(Boolean) as Cell[];
    const comparable = perShop.some((s) => s.prev_date);
    return { p: comparable ? xs.reduce((a, x) => a + num(x.p), 0) : null, c: xs.reduce((a, x) => a + x.c, 0) };
  };
  const colTotal = (id: string): Cell => {
    const s = perShop.find((x) => x.id === id);
    return { p: s?.prev ?? null, c: s?.curr ?? 0 };
  };
  const grand: Cell = { p: perShop.some((s) => s.prev != null) ? perShop.reduce((a, s) => a + num(s.prev), 0) : null,
                        c: perShop.reduce((a, s) => a + s.curr, 0) };

  const anyCompare = lines.some((r) => r.prev_date != null);
  const tot = useMemo(() => ({
    curr: lines.reduce((a, r) => a + r.curr_qty, 0),
    sent: lines.reduce((a, r) => a + num(r.sent_qty), 0),
    sold: lines.reduce((a, r) => a + num(r.sold_qty), 0),
    value: lines.reduce((a, r) => a + num(r.sold_value), 0),
  }), [lines]);

  const shopName = shopId ? shops.find((s) => s.branch_id === shopId)?.name ?? "" : "All shops";
  const asOfLabel = (from ? `from ${day(from)} ` : "") + (asOf ? `to ${day(asOf)}` : "latest reports");

  const table = (): ExportTable => {
    if (view === "matrix") {
      const multi = perShop.length > 1;
      const trio = (x: Cell | undefined) => x == null ? ["", "", ""] : [x.p ?? "", x.c, diffOf(x) ?? ""];
      return {
        title: `Carrefour — shop by shop — ${shopName} — ${asOfLabel}`,
        headers: ["Barcode", "Article",
          ...perShop.flatMap((s) => [`${s.shop} old (${short(s.prev_date)})`, `${s.shop} current (${short(s.curr_date)})`, `${s.shop} difference`]),
          ...(multi ? ["All shops old", "All shops current", "All shops difference"] : [])],
        rows: [
          ...matrix.map((a) => [a.barcode ?? "", a.article ?? "",
            ...perShop.flatMap((s) => trio(a.cells[s.id])), ...(multi ? trio(rowTotal(a.cells)) : [])]),
          ["", "Total", ...perShop.flatMap((s) => trio(colTotal(s.id))), ...(multi ? trio(grand) : [])],
        ],
      };
    }
    if (view === "shops") return {
      title: `Carrefour — shops — ${asOfLabel}`,
      headers: ["Shop", "Previous report", "Current report", "Previous stock", "Sent from warehouse", "Current stock", "Sold", "Sold value"],
      rows: perShop.map((s) => [s.shop, day(s.prev_date), day(s.curr_date), s.prev ?? "", s.sent ?? "", s.curr, s.sold ?? "", s.value == null ? "" : Math.round(s.value)]),
    };
    if (view === "warehouse") return {
      title: `Carrefour vs warehouse — ${shopName} — ${asOfLabel}`,
      headers: ["Barcode", "Article", "Carrefour previous", "Sent", "Carrefour current", "Sold", "Sold value", "Warehouse holds"],
      rows: perArticle.map((a) => [a.barcode ?? "", a.article ?? "", a.comparable ? a.prev : "", a.comparable ? a.sent : "", a.curr,
        a.comparable ? a.sold : "", a.comparable ? Math.round(a.value) : "", a.item_id ? stock[a.item_id] ?? 0 : ""]),
    };
    return {
      title: `Carrefour — ${shopName} — ${asOfLabel}`,
      headers: ["Shop", "Barcode", "Article", "Previous", "Sent", "Current", "Sold", "Price", "Sold value"],
      rows: lines.map((r) => [r.shop, r.barcode ?? "", r.article ?? "", r.prev_qty ?? "", r.sent_qty ?? "", r.curr_qty,
        r.sold_qty ?? "", r.retail_price ?? "", r.sold_value == null ? "" : Math.round(r.sold_value)]),
    };
  };

  const chip = (on: boolean) => `rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${on ? "bg-ink text-white" : "border border-line text-ink/70 hover:bg-panel"}`;
  const th = "px-4 py-3 font-bold";
  const thr = "px-4 py-3 text-right font-bold";
  const td = "px-4 py-2.5";
  const tdr = "px-4 py-2.5 text-right tnum";

  return (
    <>
      <Topbar title="Carrefour — stock & sales" subtitle="Each shop's latest stock report against the one before, with what the warehouse sent in between" />
      <div className="space-y-4 px-6 pb-12">
        {err && <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-card bg-periwinkle-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">In Carrefour now</p>
            <p className="mt-1.5 text-[30px] font-extrabold leading-none tracking-tight text-ink">{n(tot.curr)}</p>
            <p className="mt-1 text-[12px] text-ink/60">{shopName} · {asOfLabel}</p>
          </div>
          <div className="rounded-card bg-amber-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Sent from warehouse</p>
            <p className="mt-1.5 text-[30px] font-extrabold leading-none tracking-tight text-ink">{anyCompare ? n(tot.sent) : "—"}</p>
            <p className="mt-1 text-[12px] text-ink/60">between the two reports</p>
          </div>
          <div className="rounded-card bg-success-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Sold</p>
            <p className="mt-1.5 text-[30px] font-extrabold leading-none tracking-tight text-ink">{anyCompare ? n(tot.sold) : "—"}</p>
            <p className="mt-1 text-[12px] text-ink/60">previous + sent − current</p>
          </div>
          <div className="rounded-card bg-lavender-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Sold value</p>
            <p className="mt-1.5 text-[30px] font-extrabold leading-none tracking-tight text-ink">{anyCompare ? rs(tot.value) : "—"}</p>
            <p className="mt-1 text-[12px] text-ink/60">at Carrefour&apos;s price</p>
          </div>
        </div>

        {!loading && rows.length > 0 && !anyCompare && (
          <div className="rounded-xl2 border border-amber-strong/50 bg-amber-soft/50 px-4 py-3 text-[13px] text-ink">
            Each shop has only <b>one</b> report so far, so there is nothing to compare against yet. Upload the next
            report and the sold figures appear.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setView("matrix")} className={chip(view === "matrix")}>Shop by shop</button>
          <button onClick={() => setView("shops")} className={chip(view === "shops")}>Shops</button>
          <button onClick={() => setView("articles")} className={chip(view === "articles")}>Articles</button>
          <button onClick={() => setView("warehouse")} className={chip(view === "warehouse")}>Compare with warehouse</button>
          <span className="mx-1 h-5 w-px bg-line" />
          <select value={shopId} onChange={(e) => setShopId(e.target.value)}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none">
            <option value="">All shops</option>
            {shops.map((s) => <option key={s.branch_id} value={s.branch_id}>{s.name}{s.reports ? "" : " (no report)"}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-hint">
            old report
            <input type="date" value={from} max={asOf || today()} onChange={(e) => setFrom(e.target.value)}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink outline-none" />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-hint">
            current report
            <input type="date" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink outline-none" />
          </label>
          {(asOf || from) && <button onClick={() => { setAsOf(""); setFrom(""); }} className={chip(false)}>Latest two</button>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search article, barcode, shop…"
            className="w-full max-w-xs rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {([["all", "Everything"], ["sold", "Sold something"], ["restocked", "Restocked"], ["out", "Sold out"], ["unknown", "Barcode not in system"]] as [Only, string][])
            .map(([k, l]) => <button key={k} onClick={() => setOnly(k)} className={chip(only === k)}>{l}</button>)}
          <span className="ml-auto" />
          <button onClick={() => exportCSV(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Download size={13} /> CSV</button>
          <button onClick={() => exportExcel(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">Excel</button>
          <button onClick={() => exportPDF(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">PDF</button>
          <button onClick={() => printTable(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Printer size={13} /> Print</button>
          {canUpload && (
            <Link href="/carrefour/upload" className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white">
              <Upload size={14} /> Upload report
            </Link>
          )}
        </div>

        {loading && <p className="flex items-center gap-2 text-[13px] text-hint"><Loader2 size={14} className="animate-spin" /> Loading…</p>}

        {!loading && rows.length === 0 && (
          <div className="rounded-card border border-line bg-surface p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-panel text-ink"><ShoppingCart size={24} /></span>
            <p className="mt-3 text-[15px] font-semibold text-ink">No Carrefour report yet{asOf ? " on or before that date" : ""}</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
              Upload Carrefour&apos;s stock file with the date it is for. The second upload is where sold figures start.
            </p>
          </div>
        )}

        {/* ─────────── SHOP BY SHOP ─────────── */}
        {!loading && rows.length > 0 && view === "matrix" && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <p className="border-b border-line bg-panel/50 px-4 py-2 text-[12px] text-ink/70">
              For each shop: <b>old</b> stock on the earlier report, <b>current</b> stock on the later one, and the
              <b> difference</b> (old − current). Positive = stock went down; <span className="text-amber-strong font-semibold">negative</span> = stock went up (restocked).
            </p>
            <div className="max-h-[70vh] overflow-auto"><table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                  <th rowSpan={2} className="sticky left-0 z-20 min-w-[240px] border-r border-line bg-surface px-3 py-2 font-bold">Article</th>
                  {perShop.map((s) => <th key={s.id} colSpan={3} className="border-r border-line px-3 py-2 text-center font-bold text-ink">{s.shop}</th>)}
                  {perShop.length > 1 && <th colSpan={3} className="bg-panel/60 px-3 py-2 text-center font-bold text-ink">All shops</th>}
                </tr>
                <tr className="border-b border-line text-[10.5px] uppercase tracking-wide text-hint">
                  {perShop.flatMap((s) => [
                    <th key={s.id + "o"} className="whitespace-nowrap px-2 py-1.5 text-right font-bold">Old<span className="block normal-case font-normal">{short(s.prev_date)}</span></th>,
                    <th key={s.id + "c"} className="whitespace-nowrap px-2 py-1.5 text-right font-bold">Current<span className="block normal-case font-normal">{short(s.curr_date)}</span></th>,
                    <th key={s.id + "d"} className="whitespace-nowrap border-r border-line px-2 py-1.5 text-right font-bold text-ink">Diff</th>,
                  ])}
                  {perShop.length > 1 && <>
                    <th className="whitespace-nowrap bg-panel/60 px-2 py-1.5 text-right font-bold">Old</th>
                    <th className="whitespace-nowrap bg-panel/60 px-2 py-1.5 text-right font-bold">Current</th>
                    <th className="whitespace-nowrap bg-panel/60 px-2 py-1.5 text-right font-bold text-ink">Diff</th></>}
                </tr>
              </thead>
              <tbody>
                {matrix.map((a) => (
                  <tr key={a.key} className="border-b border-line/60 last:border-0 hover:bg-panel/30">
                    <td className="sticky left-0 border-r border-line bg-surface px-3 py-2">
                      <span className="font-semibold text-ink">{a.article ?? "—"}</span>
                      <span className="block font-mono text-[10.5px] text-hint">{a.barcode}</span>
                    </td>
                    {perShop.map((s) => <Trio key={s.id} x={a.cells[s.id]} />)}
                    {perShop.length > 1 && <Trio x={rowTotal(a.cells)} shade />}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-panel"><tr className="border-t border-line font-bold text-ink">
                <td className="sticky left-0 border-r border-line bg-panel px-3 py-2">Total · {matrix.length} articles</td>
                {perShop.map((s) => <Trio key={s.id} x={colTotal(s.id)} bold />)}
                {perShop.length > 1 && <Trio x={grand} shade bold />}
              </tr></tfoot>
            </table></div>
            {matrix.length === 0 && <p className="p-6 text-center text-[13px] text-muted">Nothing matches these filters.</p>}
          </div>
        )}

        {/* ─────────── SHOPS ─────────── */}
        {!loading && rows.length > 0 && view === "shops" && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className={th}>Shop</th><th className={th}>Previous → current report</th>
                <th className={thr}>Previous</th><th className={thr}>Sent</th><th className={thr}>Current</th>
                <th className={thr}>Sold</th><th className={thr}>Sold value</th><th className="px-4 py-3" />
              </tr></thead>
              <tbody>
                {perShop.map((s) => (
                  <tr key={s.id} className="border-b border-line/60 last:border-0 hover:bg-panel/40">
                    <td className={`${td} font-semibold text-ink`}>{s.shop}<span className="block text-[11px] font-normal text-hint">{s.articles} articles</span></td>
                    <td className={`${td} text-ink/75`}>{s.prev_date ? <>{day(s.prev_date)} → <b>{day(s.curr_date)}</b></> : <><b>{day(s.curr_date)}</b> <span className="text-hint">· first report</span></>}</td>
                    <td className={tdr}>{n(s.prev)}</td><td className={tdr}>{n(s.sent)}</td>
                    <td className={`${tdr} font-semibold`}>{n(s.curr)}</td>
                    <td className={`${tdr} text-[15px] font-extrabold text-ink`}>{n(s.sold)}</td>
                    <td className={tdr}>{rs(s.value)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => { setShopId(s.id); setView("articles"); }}
                        className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-ink/70 hover:bg-panel">articles</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {perShop.length > 1 && (
                <tfoot><tr className="border-t border-line bg-panel/40 font-bold text-ink">
                  <td className={td} colSpan={2}>All shops</td>
                  <td className={tdr}>{anyCompare ? n(perShop.reduce((a, s) => a + num(s.prev), 0)) : "—"}</td>
                  <td className={tdr}>{anyCompare ? n(tot.sent) : "—"}</td>
                  <td className={tdr}>{n(tot.curr)}</td>
                  <td className={tdr}>{anyCompare ? n(tot.sold) : "—"}</td>
                  <td className={tdr}>{anyCompare ? rs(tot.value) : "—"}</td><td />
                </tr></tfoot>
              )}
            </table></div>
          </div>
        )}

        {/* ─────────── ARTICLES ─────────── */}
        {!loading && rows.length > 0 && view === "articles" && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                {!shopId && <th className={th}>Shop</th>}
                <th className={th}>Article</th>
                <th className={thr}>Previous</th><th className={thr}>Sent</th><th className={thr}>Current</th>
                <th className={thr}>Sold</th><th className={thr}>Price</th><th className={thr}>Sold value</th>
              </tr></thead>
              <tbody>
                {lines.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 last:border-0">
                    {!shopId && <td className={`${td} text-ink/80`}>{r.shop}</td>}
                    <td className={td}>
                      <span className="font-semibold text-ink">{r.article ?? "—"}</span>
                      <span className="block font-mono text-[11px] text-hint">{r.barcode}
                        {!r.item_id && <span className="ml-1.5 rounded-full bg-amber-soft px-1.5 py-0.5 font-sans text-[10px] font-semibold text-ink/70">not in our products</span>}
                      </span>
                    </td>
                    <td className={tdr}>{n(r.prev_qty)}</td><td className={tdr}>{n(r.sent_qty)}</td>
                    <td className={`${tdr} font-semibold`}>{n(r.curr_qty)}</td>
                    <td className={`${tdr} font-extrabold text-ink`}>{n(r.sold_qty)}</td>
                    <td className={`${tdr} text-ink/60`}>{n(r.retail_price)}</td>
                    <td className={tdr}>{rs(r.sold_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            {lines.length === 0 && <p className="p-6 text-center text-[13px] text-muted">Nothing matches these filters.</p>}
          </div>
        )}

        {/* ─────────── WAREHOUSE ─────────── */}
        {!loading && rows.length > 0 && view === "warehouse" && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <p className="border-b border-line bg-panel/50 px-4 py-2 text-[12px] text-ink/70">
              One line per article across {shopName.toLowerCase()}. <b>Sent</b> is the warehouse STR to Carrefour between the
              reports; <b>warehouse holds</b> is what is still in our warehouse today.
            </p>
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className={th}>Article</th>
                <th className={thr}>Carrefour previous</th><th className={thr}>Sent</th><th className={thr}>Carrefour current</th>
                <th className={thr}>Sold</th><th className={thr}>Sold value</th><th className={thr}>Warehouse holds</th>
              </tr></thead>
              <tbody>
                {perArticle.map((a) => (
                  <tr key={a.key} className="border-b border-line/60 last:border-0">
                    <td className={td}><span className="font-semibold text-ink">{a.article ?? "—"}</span>
                      <span className="block font-mono text-[11px] text-hint">{a.barcode} · {a.shops} shop{a.shops === 1 ? "" : "s"}</span></td>
                    <td className={tdr}>{a.comparable ? n(a.prev) : "—"}</td>
                    <td className={tdr}>{a.comparable ? n(a.sent) : "—"}</td>
                    <td className={`${tdr} font-semibold`}>{n(a.curr)}</td>
                    <td className={`${tdr} font-extrabold text-ink`}>{a.comparable ? n(a.sold) : "—"}</td>
                    <td className={tdr}>{a.comparable ? rs(a.value) : "—"}</td>
                    <td className={`${tdr} font-semibold ${a.item_id && (stock[a.item_id] ?? 0) <= 0 ? "text-danger" : "text-ink"}`}>
                      {a.item_id ? n(stock[a.item_id] ?? 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </>
  );
}

/* Old · current · difference for one shop, one article. */
function Trio({ x, shade, bold }: { x?: Cell; shade?: boolean; bold?: boolean }) {
  const d = diffOf(x);
  const base = `px-2 py-2 text-right tnum ${shade ? "bg-panel/40" : ""} ${bold ? "font-bold" : ""}`;
  if (!x) return <><td className={`${base} text-hint`}>·</td><td className={`${base} text-hint`}>·</td><td className={`${base} border-r border-line text-hint`}>·</td></>;
  return (
    <>
      <td className={`${base} text-ink/70`}>{n(x.p)}</td>
      <td className={`${base} text-ink`}>{n(x.c)}</td>
      <td className={`${base} border-r border-line font-bold ${d == null || d === 0 ? "text-hint" : d < 0 ? "text-amber-strong" : "text-ink"}`}>
        {d == null ? "—" : d > 0 ? n(d) : d < 0 ? "−" + n(-d) : "0"}
      </td>
    </>
  );
}
