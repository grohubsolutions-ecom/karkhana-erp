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
 *   Warehouse vs Carrefour — every article in the warehouse: what the
 *                warehouse holds now, and what each Carrefour shop holds on
 *                its latest report, side by side, biggest first. (29 Oct)
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
type Only = "all" | "sold" | "restocked" | "out" | "unknown" | "both" | "whonly" | "cfonly";
type WItem = { item_id: string; name: string | null; barcode: string | null; manual_barcode: string | null; quantity: number; is_active: boolean | null };

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
  const [witems, setWitems] = useState<WItem[]>([]);
  const [sortBy, setSortBy] = useState<"wh" | "cf" | "name">("wh");
  /* Carrefour's own short code for each shop (GUJ, WTC, EMP …), as it heads
     the columns of Carrefour's Excel — used for column headings. */
  const [codes, setCodes] = useState<Record<string, string>>({});
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
    const [s, c, w, al] = await Promise.all([
      supabase.rpc("carrefour_shops"),
      supabase.rpc("carrefour_compare", { p_branch: null, p_as_of: asOf || null, p_from: from || null }),
      supabase.from("v_khana_stock").select("item_id, name, barcode, manual_barcode, quantity, is_active"),
      supabase.from("carrefour_shop_aliases").select("alias, branch_id"),
    ]);
    {
      const m: Record<string, string> = {};
      ((al.data ?? []) as { alias: string; branch_id: string }[])
        .filter((a) => /^[A-Za-z0-9]{2,5}$/.test(a.alias.trim()))
        .forEach((a) => { const c = a.alias.trim().toUpperCase(); if (!m[a.branch_id] || c.length < m[a.branch_id].length) m[a.branch_id] = c; });
      setCodes(m);
    }
    if (s.error || c.error) { setErr((s.error ?? c.error)!.message); setLoading(false); return; }
    setShops((s.data ?? []) as Shop[]);
    setRows(((c.data ?? []) as Row[]).map((r) => ({
      ...r,
      prev_qty: r.prev_qty == null ? null : num(r.prev_qty), sent_qty: r.sent_qty == null ? null : num(r.sent_qty),
      curr_qty: num(r.curr_qty), sold_qty: r.sold_qty == null ? null : num(r.sold_qty),
      retail_price: r.retail_price == null ? null : num(r.retail_price), sold_value: r.sold_value == null ? null : num(r.sold_value),
    })));
    const m: Record<string, number> = {};
    ((w.data ?? []) as WItem[]).forEach((x) => { m[x.item_id] = num(x.quantity); });
    setStock(m);
    setWitems(((w.data ?? []) as WItem[]).map((x) => ({ ...x, quantity: num(x.quantity) })));
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

  /* Warehouse vs Carrefour: every article in the warehouse, how many the
     warehouse holds, and how many each Carrefour shop holds on its latest
     report — side by side, biggest first. */
  const wShops = useMemo(() => {
    const m = new Map<string, { id: string; shop: string; report_date: string | null }>();
    rows.forEach((r) => { if (r.curr_date && (!shopId || r.branch_id === shopId)) m.set(r.branch_id, { id: r.branch_id, shop: r.shop, report_date: r.curr_date }); });
    return [...m.values()].sort((a, b) => a.shop.localeCompare(b.shop));
  }, [rows, shopId]);
  const wTable = useMemo(() => {
    const m = new Map<string, { key: string; item_id: string | null; article: string | null; barcode: string | null; wh: number | null; at: Record<string, number> }>();
    witems.forEach((i) => m.set(i.item_id, { key: i.item_id, item_id: i.item_id, article: i.name,
      barcode: i.manual_barcode || i.barcode, wh: i.quantity, at: {} }));
    const ids = new Set(wShops.map((s) => s.id));
    /* Each shop's stock on its latest report — the same rows the other tabs use. */
    rows.forEach((r) => {
      if (!ids.has(r.branch_id)) return;
      const k = r.item_id ?? "bc:" + r.barcode;
      const x = m.get(k) ?? { key: k, item_id: r.item_id, article: r.article, barcode: r.barcode, wh: r.item_id ? 0 : null, at: {} };
      x.at[r.branch_id] = (x.at[r.branch_id] ?? 0) + r.curr_qty;
      m.set(k, x);
    });
    const t = q.trim().toLowerCase();
    const cfOf = (x: { at: Record<string, number> }) => Object.values(x.at).reduce((a, v) => a + v, 0);
    return [...m.values()].map((x) => ({ ...x, cf: cfOf(x) })).filter((x) => {
      if (only === "unknown") { if (x.item_id) return false; }
      else if (!x.item_id) return false;
      if (num(x.wh) === 0 && x.cf === 0) return false;
      if (t && ![x.article, x.barcode].some((v) => String(v ?? "").toLowerCase().includes(t))) return false;
      if (only === "both" && !(num(x.wh) > 0 && x.cf > 0)) return false;
      if (only === "whonly" && !(num(x.wh) > 0 && x.cf <= 0)) return false;
      if (only === "cfonly" && !(x.cf > 0 && num(x.wh) <= 0)) return false;
      return true;
    }).sort((a, b) => sortBy === "name" ? String(a.article).localeCompare(String(b.article))
      : sortBy === "cf" ? b.cf - a.cf || num(b.wh) - num(a.wh) : num(b.wh) - num(a.wh) || b.cf - a.cf);
  }, [witems, rows, wShops, q, only, sortBy]);
  const wTot = useMemo(() => ({
    wh: wTable.reduce((a, x) => a + num(x.wh), 0),
    cf: wTable.reduce((a, x) => a + x.cf, 0),
    at: Object.fromEntries(wShops.map((s) => [s.id, wTable.reduce((a, x) => a + (x.at[s.id] ?? 0), 0)])) as Record<string, number>,
  }), [wTable, wShops]);

  const anyCompare = lines.some((r) => r.prev_date != null);
  const tot = useMemo(() => ({
    curr: lines.reduce((a, r) => a + r.curr_qty, 0),
    sent: lines.reduce((a, r) => a + num(r.sent_qty), 0),
    sold: lines.reduce((a, r) => a + num(r.sold_qty), 0),
    value: lines.reduce((a, r) => a + num(r.sold_value), 0),
  }), [lines]);

  const code = (id: string, name: string) => codes[id] ?? name;
  const shopName = shopId ? shops.find((s) => s.branch_id === shopId)?.name ?? "" : "All shops";
  const asOfLabel = (from ? `from ${day(from)} ` : "") + (asOf ? `to ${day(asOf)}` : "latest reports");

  const table = (): ExportTable => {
    if (view === "matrix") {
      const multi = perShop.length > 1;
      const trio = (x: Cell | undefined) => x == null ? ["", "", ""] : [x.p ?? "", x.c, diffOf(x) ?? ""];
      const sameDates = perShop.length > 0 && perShop.every((s) => s.prev_date === perShop[0].prev_date && s.curr_date === perShop[0].curr_date);
      return {
        /* The dates go in the title when every shop compares the same two
           reports, so the column headings stay short: 24 columns must fit. */
        title: `Carrefour — shop by shop — ${shopName} — ${sameDates
          ? `old ${day(perShop[0].prev_date)} vs current ${day(perShop[0].curr_date)}` : asOfLabel}`,
        look: { bold: [0], wide: [1], left: [1] },
        headers: ["Barcode", "Article",
          ...perShop.flatMap((s) => { const c = code(s.id, s.shop); return sameDates ? [`${c} old`, `${c} current`, `${c} diff`]
            : [`${c} old ${short(s.prev_date)}`, `${c} current ${short(s.curr_date)}`, `${c} diff`]; }),
          ...(multi ? ["All shops old", "All shops current", "All shops diff"] : [])],
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
    const sameW = wShops.length > 0 && wShops.every((s) => s.report_date === wShops[0].report_date);
    if (view === "warehouse") return {
      title: `Warehouse (WH) vs Carrefour (CR) — ${shopName} — ${sameW ? "CR report " + day(wShops[0].report_date) : asOf ? "as of " + day(asOf) : "latest reports"}`,
      look: { bold: [0], wide: [1], left: [1] },
      headers: ["Barcode", "Article", "WH", ...wShops.map((s) => sameW ? code(s.id, s.shop) : `${code(s.id, s.shop)} ${short(s.report_date)}`), "CR total", "WH + CR"],
      rows: [
        ...wTable.map((x) => [x.barcode ?? "", x.article ?? "", x.wh ?? "", ...wShops.map((s) => x.at[s.id] ?? 0), x.cf, num(x.wh) + x.cf]),
        ["", "Total", wTot.wh, ...wShops.map((s) => wTot.at[s.id]), wTot.cf, wTot.wh + wTot.cf],
      ],
    };
    return {
      title: `Carrefour — ${shopName} — ${asOfLabel}`,
      look: { bold: [1], wide: [2], left: [2] },
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
          <button onClick={() => { setView("matrix"); if (["both", "whonly", "cfonly"].includes(only)) setOnly("all"); }} className={chip(view === "matrix")}>Shop by shop</button>
          <button onClick={() => { setView("shops"); if (["both", "whonly", "cfonly"].includes(only)) setOnly("all"); }} className={chip(view === "shops")}>Shops</button>
          <button onClick={() => { setView("articles"); if (["both", "whonly", "cfonly"].includes(only)) setOnly("all"); }} className={chip(view === "articles")}>Articles</button>
          <button onClick={() => { setView("warehouse"); setOnly("all"); }} className={chip(view === "warehouse")}>Warehouse vs Carrefour</button>
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
          {((view === "warehouse"
            ? [["all", "Everything"], ["both", "In warehouse & Carrefour"], ["whonly", "Only in warehouse"], ["cfonly", "Only in Carrefour"], ["unknown", "Barcode not in system"]]
            : [["all", "Everything"], ["sold", "Sold something"], ["restocked", "Restocked"], ["out", "Sold out"], ["unknown", "Barcode not in system"]]) as [Only, string][])
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
                  {perShop.map((s) => <th key={s.id} colSpan={3} title={s.shop} className="border-r border-line px-3 py-2 text-center font-bold text-ink">{code(s.id, s.shop)}</th>)}
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
                    <td className={`${td} font-semibold text-ink`}>{s.shop}{codes[s.id] && <span className="ml-1.5 font-mono text-[11px] text-hint">{codes[s.id]}</span>}<span className="block text-[11px] font-normal text-hint">{s.articles} articles</span></td>
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

        {/* ─────────── WAREHOUSE vs CARREFOUR ─────────── */}
        {!loading && view === "warehouse" && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel/50 px-4 py-2 text-[12px] text-ink/70">
              <span><b className="text-ink">WH (warehouse) {n(wTot.wh)}</b> pcs · <b className="text-ink">CR (Carrefour) {n(wTot.cf)}</b> pcs ({wShops.length} shop{wShops.length === 1 ? "" : "s"}, latest report each) · {wTable.length} articles</span>
              <span className="ml-auto flex items-center gap-1">sort
                {([["wh", "WH ↓"], ["cf", "CR ↓"], ["name", "A–Z"]] as ["wh" | "cf" | "name", string][]).map(([k, l]) =>
                  <button key={k} onClick={() => setSortBy(k)} className={chip(sortBy === k)}>{l}</button>)}
              </span>
              {witems.length === 0 && <span className="w-full font-semibold text-danger">Warehouse stock is not visible to you — it needs the warehouse view permission.</span>}
            </div>
            <div className="max-h-[70vh] overflow-auto"><table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-surface"><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className="sticky left-0 z-20 min-w-[240px] border-r border-line bg-surface px-3 py-2 font-bold">Article</th>
                <th className="whitespace-nowrap border-r border-line bg-periwinkle-soft/60 px-3 py-2 text-right font-bold text-ink">WH</th>
                {wShops.map((s) => <th key={s.id} title={s.shop} className="whitespace-nowrap px-3 py-2 text-right font-bold">{code(s.id, s.shop)}<span className="block normal-case font-normal">{short(s.report_date)}</span></th>)}
                <th className="whitespace-nowrap border-l border-line bg-panel/60 px-3 py-2 text-right font-bold text-ink">CR total</th>
                <th className="whitespace-nowrap bg-panel/60 px-3 py-2 text-right font-bold">WH + CR</th>
              </tr></thead>
              <tbody>
                {wTable.map((x) => (
                  <tr key={x.key} className="border-b border-line/60 last:border-0 hover:bg-panel/30">
                    <td className="sticky left-0 border-r border-line bg-surface px-3 py-2">
                      <span className="font-semibold text-ink">{x.article ?? "—"}</span>
                      <span className="block font-mono text-[10.5px] text-hint">{x.barcode}
                        {!x.item_id && <span className="ml-1.5 rounded-full bg-amber-soft px-1.5 py-0.5 font-sans text-[10px] font-semibold text-ink/70">not in our products</span>}
                      </span>
                    </td>
                    <td className={`border-r border-line bg-periwinkle-soft/30 px-3 py-2 text-right tnum font-bold ${x.wh != null && x.wh <= 0 ? "text-danger" : "text-ink"}`}>{x.wh == null ? "—" : n(x.wh)}</td>
                    {wShops.map((s) => { const v = x.at[s.id] ?? 0;
                      return <td key={s.id} className={`px-3 py-2 text-right tnum ${v ? "text-ink" : "text-hint"}`}>{n(v)}</td>; })}
                    <td className="border-l border-line bg-panel/40 px-3 py-2 text-right tnum font-bold text-ink">{n(x.cf)}</td>
                    <td className="bg-panel/40 px-3 py-2 text-right tnum text-ink/75">{n(num(x.wh) + x.cf)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-panel"><tr className="border-t border-line font-bold text-ink">
                <td className="sticky left-0 border-r border-line bg-panel px-3 py-2">Total · {wTable.length} articles</td>
                <td className="border-r border-line px-3 py-2 text-right tnum">{n(wTot.wh)}</td>
                {wShops.map((s) => <td key={s.id} className="px-3 py-2 text-right tnum">{n(wTot.at[s.id])}</td>)}
                <td className="border-l border-line px-3 py-2 text-right tnum">{n(wTot.cf)}</td>
                <td className="px-3 py-2 text-right tnum">{n(wTot.wh + wTot.cf)}</td>
              </tr></tfoot>
            </table></div>
            {wTable.length === 0 && <p className="p-6 text-center text-[13px] text-muted">Nothing matches these filters.</p>}
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
