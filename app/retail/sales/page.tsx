"use client";
/* SALES — three levels down, from every shop to a single bill.
 *
 * THE SHAPE, PORTED FROM renderSales
 *   Level 1  STORES     one row per branch, grouped under its chain, with an
 *                       all-stores footer. Tap a store to go down.
 *   Level 2  PAYMENTS   that store's takings split by how it was paid, one
 *                       tile per method. Tap a method to go down.
 *   Level 3  BILLS      the receipts behind that one method, rolled up from
 *                       the lines, newest receipt first, with a total.
 *
 *   This is how the question actually gets asked: "we're short on cash" → which
 *   shop → how much of that shop was cash → which bills. A flat line list
 *   cannot answer any step of it without a spreadsheet.
 *
 *   The three level-1/2/3 states are the BRANCH and PAYMENT-METHOD filters
 *   themselves, so the branch dropdown and the drill-down are one control and
 *   cannot disagree about where you are.
 *
 * WHY LEVEL 3 HAS A PARTY COLUMN ON CREDIT
 *   `credit` is UDHAAR — a sale handed over with the money still owed. The list
 *   of credit bills IS the debtor list, and without the customer name on it
 *   there is nowhere in this app that says who owes on account. The column is
 *   only shown for credit because on a cash bill the customer field is noise.
 *   On a phone the party is the card TITLE, for the same reason: on a debtor
 *   list the name is the thing you are looking for, not the receipt number.
 *
 * WHY THE PAGING (fetchAll)
 *   PostgREST caps a response at 1000 rows; `.limit(5000)` does not raise the
 *   cap, it only stops asking. This screen at least admitted it ("capped at
 *   5,000 lines"), but a total that is a lower bound is still a wrong total.
 *
 *   The paging has a ceiling of its own — 200,000 rows — and it used to be
 *   crossed in silence. `fetchAll` now reports it as `truncated`, this screen
 *   keeps it in state, and the note under the table stops claiming completeness
 *   when it is set. The claim and the figures have to agree: if the period could
 *   not be read in full then every total on the page is a lower bound, and the
 *   screen says exactly that instead of printing "all N are in every total".
 *
 * WHY THE DATABASE ADDS UP INSTEAD  (Oct 2026, widened to every device)
 *   Levels 1 and 2, and the By Department / By Salesperson views, are pure
 *   sums — nothing on them needs an individual line. A 30-day range is 13,360
 *   lines, which is FOURTEEN sequential requests from Lahore to produce nine
 *   figures; "all time" is upwards of 150,000 rows. So those states call
 *   `retail_sales_agg_m`, which returns one row per branch (or per method /
 *   department / salesperson) and counts receipts on the same
 *   `branch|receipt_txn/receipt_no/id` key this file builds by hand.
 *
 *   This began as a phone-only concession, on the reasoning that a computer
 *   could afford the rows. It cannot: the first of those fourteen requests
 *   measured 1,076 ms because it walks the primary key from id 1 and discards
 *   44,943 rows to reach the range. A laptop is not a reason to send it 13,000
 *   rows; it is just a bigger screen. Every device uses the roll-up now.
 *
 *   Four rules keep that from quietly becoming a different screen:
 *     · NO FIGURE IS SILENTLY DROPPED. The diagnostics row has a `discount`
 *       total the aggregate has no column for, so it comes from
 *       `retail_sales_discount` asked for in the same batch. That tile would
 *       otherwise have read Rs 0 — a plausible wrong number beside four right
 *       ones, which is the exact failure this department keeps being audited
 *       for.
 *     · ANYTHING THAT NEEDS A LINE STILL READS LINES — level 3 (bills), the
 *       Lines view, By Item (there is deliberately no item dimension), and the
 *       moment anybody types in the search box, because no roll-up can search
 *       receipt numbers, item names and customers.
 *     · IF THE ROLL-UP ERRORS, THE LINES ARE READ. A slow right total beats a
 *       fast missing one, and this is also the fallback if the function is not
 *       deployed yet.
 *     · RECEIPTS DO NOT ADD UP ACROSS PAYMENT METHODS. A bill settled half cash
 *       half card is one receipt in each method's count — exactly what counting
 *       the lines did too. So the store's bill count comes from the per-branch
 *       roll-up and never from totalling the method tiles.
 *
 *   Both producers fill the same `Agg` shape and every figure below reads that,
 *   so the two cannot drift into disagreeing about how a figure is built.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Receipt, TrendingUp, Layers, Tag, ScrollText, Search, ChevronRight, ChevronLeft,
  Store, Rows3,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { rangeDates } from "@/lib/dateRange";
import {
  RetailRange,
  Shell, PageHeader, StatCards, DataTable, Tabs, Pill, ShopSelect, ImportButton,
  PreviewNote, SourceNote, useBranches, money, num, text, sum, fetchAll, fetchKeyset,
  useIsPhone, RowCard, ActionBar,
  type Branch, type Row, type Col,
} from "@/components/retail/kit";
import { useShopScope } from "@/lib/retailShop";

/* The seven strings the importer actually writes, and the CHECK constraint on
   retail_sale_lines. `credit` is udhaar, not a credit card — labelling it
   "Card" is what made FC DHA's 1 Sep card figure read 36,100 instead of
   33,400. The ORDER is the order the tiles appear in: cash first because it is
   the one that has to be counted, unclassified last because it is a to-do. */
const PM_ORDER = ["cash", "meezan_card", "jazzcash", "credit", "online", "other", "unclassified"];
const PM: Record<string, { label: string; color: string }> = {
  cash:         { label: "Cash",            color: "#7FC489" },
  meezan_card:  { label: "Card",            color: "#A6C0E6" },
  jazzcash:     { label: "JazzCash",        color: "#EDA6D0" },
  credit:       { label: "Credit (udhaar)", color: "#E4B47E" },
  online:       { label: "Online",          color: "#D2B9EA" },
  other:        { label: "Other",           color: "#EBA98F" },
  unclassified: { label: "Unclassified",    color: "#B4ABA0" },
};
const pmLabel = (k: string) => PM[k]?.label ?? text(k);
const pmColor = (k: string) => PM[k]?.color ?? "#B4ABA0";

/** "Topshop" is one word in the database and two everywhere a person reads it. */
const bizLabel = (c?: string | null) => (c === "Topshop" ? "Top Shop" : c || "—");

/** One receipt is many lines. Group on receipt_txn — the transaction id the POS
 *  gave it — and fall back to the printed number, then the row id, because an
 *  older import has no txn and two shops can print the same receipt number on
 *  the same day. */
const recKey = (r: Row) => String(r.receipt_txn || r.receipt_no || r.id);

type View = "stores" | "lines" | "items" | "departments" | "salespeople";
const VIEWS: { key: View; label: string }[] = [
  { key: "stores", label: "Stores" },
  { key: "lines", label: "Lines" },
  { key: "items", label: "By Item" },
  { key: "departments", label: "By Department" },
  { key: "salespeople", label: "By Salesperson" },
];

type StoreRow =
  | { kind: "chain"; name: string; recs: number; qty: number; amt: number; id?: undefined }
  | { kind: "store"; name: string; recs: number; qty: number; amt: number; id: number };
type Bill = { key: string; no: string; date: string; party: string; qty: number; amt: number; short: number };
type GroupRow = { name: string; qty: number; amt: number; margin: number; lines: number };

/** One group's figures, however they were produced. `recs` is a COUNT, not a
 *  set: the roll-up can only hand back a count, so the line path collapses its
 *  sets to counts at the end and both sides end up the same shape. */
type Agg = { amt: number; qty: number; margin: number; lines: number; recs: number };

/** A row of `retail_sales_rollup`. Dimensions not grouped by come back null,
 *  and the measures arrive as PostgREST numerics — `num()` on every one. */
type RollRow = {
  branch_id: number | null; sale_date: string | null; payment_method: string | null;
  salesperson: string | null; department: string | null;
  sales: unknown; margin: unknown; qty: unknown; lines: unknown; receipts: unknown;
};
/** What the database answered, kept with the dimension it was asked for so a
 *  half-finished view switch cannot read last view's rows under this view's
 *  heading. */
type Srv = {
  branches: RollRow[];
  methods: RollRow[] | null;
  groups: RollRow[] | null;
  dim: "department" | "salesperson" | null;
};

const aggOf = (r: RollRow): Agg => ({
  amt: num(r.sales), qty: num(r.qty), margin: num(r.margin),
  lines: num(r.lines), recs: num(r.receipts),
});

export default function RetailSalesPage() {
  const phone = useIsPhone();
  const { branches } = useBranches();
  const [rows, setRows] = useState<Row[]>([]);
  const [srv, setSrv] = useState<Srv | null>(null);
  /* Discounts are the one tile the aggregate has no column for — see migration
     0132. Asked for alongside it, so it costs no extra wall-clock. */
  const [srvDiscount, setSrvDiscount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  /* TRUE WHEN THE LINE READ HIT fetchAll's 200,000-ROW CEILING.
     It used to be crossed silently: the loop stopped and the screen carried on as
     though it had read the period, which makes every total below a lower bound
     presented as a total. The department is already around 150,000 lines for "all
     time", so this is reachable, not theoretical — and the note under the table
     is only honest if it knows. */
  const [truncated, setTruncated] = useState(false);
  /* WHICH SHOP. Not this screen's own state any more: the left menu, the
     dropdown here and the drill-down all write one shared value, so arriving
     from "FC DHA ▸ Sales" lands on FC DHA and moving on to Expenses stays
     there. See lib/retailShop.ts for why there is only one of these.
     Level 1 is no single branch. Level 2 is one branch, no method chosen.
     Level 3 is both. */
  const scope = useShopScope(branches);
  const branch = scope.single;
  const [pm, setPm] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("stores");
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");

  const branchById = useCallback((id: unknown) => branches.find((b) => b.id === Number(id)), [branches]);
  const branchName = useCallback((id: unknown) => branchById(id)?.name ?? "—", [branchById]);

  /* Changing branch always drops the method: the methods on screen belong to
     the shop you were in, and carrying "cash" across to another shop would show
     that shop's cash bills under the previous shop's heading. */
  const goBranch = useCallback((v: string) => { scope.set(v); setPm(null); },
    /* eslint-disable-next-line react-hooks/exhaustive-deps */ []);

  /* Which grouped view is on screen. `items` is absent on purpose: the roll-up
     has no item dimension, so By Item always reads lines. */
  const groupDim: "department" | "salesperson" | null =
    view === "departments" ? "department" : view === "salespeople" ? "salesperson" : null;

  /* THE ONE PLACE THAT DECIDES WHETHER THIS SCREEN READS LINES.
   *
   * It used to say `if (!phone) return null` — the roll-up was a phone
   * concession and every computer read the whole range. That was backwards.
   * Measured on the live database, a 30-day range is 13,360 sale lines, which
   * is FOURTEEN sequential requests from Lahore, the first of them 1,076 ms
   * because it walks the primary key from id 1 and discards 44,943 rows to
   * reach the range. The same question answered server-side is ONE call of
   * ~300 ms returning eight rows. A laptop is not a reason to send it 13,000
   * rows; it is just a bigger screen.
   *
   * So the roll-up now serves every device for every state that is a pure sum.
   * What still reads lines, because it genuinely needs them: the Lines view,
   * By Item, any search, and level 3 (one shop, one payment method) — the
   * places that show individual bills rather than totals.
   *
   * Top Shop is no longer an exception either: retail_sales_agg_m takes an
   * ARRAY of branch ids (migration 0131), so six branches are one call. Before
   * that it had to fall back to reading lines, because the single-branch
   * roll-up could not say "these six and not the other three" and totalling
   * all nine would have quietly included Fashion Collection. */
  const srvPlan = useMemo(() => {
    const summable = view === "stores" ? !pm : groupDim !== null;
    if (q.trim() || !summable) return null;
    return { dim: groupDim, branch };
  }, [q, view, pm, groupDim, branch]);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const db = supabase;
    const [from, to] = rangeDates(preset, cf, ct);
    const ids = scope.ids;

    if (srvPlan) {
      /* The whole shop, not one branch of it. null means every shop. */
      const ask = (by: string[]) =>
        db.rpc("retail_sales_agg_m", { p_from: from, p_to: to, p_branches: ids, p_by: by });
      /* Per-branch always: it carries the headline figures AND the store's own
         bill count, which must not be totalled off the method tiles. */
      /* 'receipts' is a flag, not a dimension: the distinct-count it turns on
         is the expensive part of this function, so it is asked for only where
         a bill count is actually shown. */
      const jobs = [ask(["branch_id", "receipts"])];
      if (srvPlan.dim) jobs.push(ask([srvPlan.dim, "receipts"]));
      else if (srvPlan.branch) jobs.push(ask(["branch_id", "payment_method"]));
      const [res, disc] = await Promise.all([
        Promise.all(jobs),
        db.rpc("retail_sales_discount", { p_from: from, p_to: to, p_branches: ids }),
      ]);
      const bad = res.find((g) => g.error);
      if (!bad) {
        const base = (res[0].data as RollRow[]) ?? [];
        const extra = res[1] ? ((res[1].data as RollRow[]) ?? []) : null;
        setSrv({
          branches: base,
          methods: srvPlan.dim ? null : extra,
          groups: srvPlan.dim ? extra : null,
          dim: srvPlan.dim,
        });
        setRows([]);
        setSrvDiscount(((disc.data as { discount: unknown }[]) ?? [])
          .reduce((t, r) => t + num(r.discount), 0));
        /* The database did the adding up, so no ceiling was involved and there is
           nothing to warn about. Cleared explicitly — a stale `true` from a
           previous range would put a lower-bound warning under figures that are
           complete, which is its own kind of lie. */
        setTruncated(false);
        setLoading(false);
        return;
      }
      /* The roll-up could not answer — fall through and read the lines. Slow
         and right beats fast and missing, and this is also what happens if the
         function has not been deployed to this database yet. */
    }

    /* KEYSET, ORDERED BY `id` ALONE — AND THE SECOND SORT KEY HAD TO GO.
       The note that used to sit here was right about the danger and wrong about
       the cure. `sale_date` IS a tie — a day of trading is thousands of lines
       carrying the same date — and paging on a tie really can return a line
       twice or lose it. But adding `id` as a tiebreak to an OFFSET pager does
       not fix that cheaply: it makes every page re-sort the whole filtered range
       AND still reads and discards every row it skips. Measured on this table at
       58,303 lines: 307 ms for one page at offset 55,000 against 8 ms for the
       same page by key, and the cost of the whole range is the sum of every
       page — about 1.7 million row visits. This exact query shape was the
       slowest statement in the project (7,404 ms worst, against an 8-second
       timeout), and on a computer `srvPlan` is always null so the computer
       ALWAYS took it.

       A keyset cursor is itself a total order, so there is nothing left to
       tiebreak and nothing to re-sort: `id` is unique, ever-increasing, and
       appended last. Newest-day-first is restored below, in memory, where it is
       free — the rows are already here by then. */
    const { rows: got, error, truncated: cut } = await fetchKeyset<Row>((afterId) => {
      let sq = db.from("retail_sale_lines")
        .select("id,branch_id,sale_date,receipt_no,receipt_txn,item_code,item_name,department,salesperson,customer,quantity,net_sales,sales_amount,gross_margin,discount,payment_method")
        .gt("id", afterId);
      if (from) sq = sq.gte("sale_date", from);
      if (to) sq = sq.lte("sale_date", to);
      /* .in() for every case including the single-branch one: one code path
         means Top Shop cannot be the case somebody forgot to handle. */
      if (ids) sq = sq.in("branch_id", ids);
      return sq.order("id", { ascending: true }).limit(1000);
    });
    if (error) setErr(error);
    setSrv(null);
    /* The order the screen displays, applied once instead of per page. Same
       comparison the query used to ask the database for: newest sale_date first,
       then id ascending within a day. */
    got.sort((a: Row, b: Row) => {
      const da = String(a.sale_date ?? ""), dbb = String(b.sale_date ?? "");
      if (da !== dbb) return da < dbb ? 1 : -1;
      return Number(a.id) - Number(b.id);
    });
    setRows(got);
    setTruncated(cut);
    setLoading(false);
    /* scope.key, not scope.ids: the ids array is a new object every render and
       would re-run this on every keystroke. The key is a string. */
  }, [preset, cf, ct, scope.key, srvPlan]);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) => [r.receipt_no, r.item_name, r.item_code, r.customer, r.salesperson]
      .some((v) => String(v ?? "").toLowerCase().includes(n)));
  }, [rows, q]);

  const receiptCount = useMemo(
    () => new Set(filtered.map((r) => `${r.branch_id}|${recKey(r)}`)).size, [filtered]);
  const totalSales = useMemo(() => sum(filtered, "sales_amount"), [filtered]);

  /* ── one figure set, two producers ──────────────────────────────────────
     Per branch, keyed the way the store table and the footer both want it.
     A receipt key already carries its branch, so a branch's distinct count and
     the sum of the branches' distinct counts are the same number — which is
     why the headline bill count below can add these up. */
  const byBranch = useMemo(() => {
    const out: Record<string, Agg> = {};
    if (srv) {
      srv.branches.forEach((r) => { out[String(r.branch_id)] = aggOf(r); });
      return out;
    }
    const recs: Record<string, Set<string>> = {};
    filtered.forEach((r) => {
      const id = String(r.branch_id);
      const a = (out[id] ||= { amt: 0, qty: 0, margin: 0, lines: 0, recs: 0 });
      a.amt += num(r.sales_amount); a.qty += num(r.quantity);
      a.margin += num(r.gross_margin); a.lines += 1;
      (recs[id] ||= new Set()).add(recKey(r));
    });
    Object.keys(out).forEach((id) => { out[id].recs = recs[id].size; });
    return out;
  }, [filtered, srv]);

  /* The figures across the top. On the line path these are byte for byte what
     the screen computed before; on the roll-up path they are the same sums done
     in the database. `discount` is deliberately absent — the roll-up has no
     such measure, and the row that shows it is a computer-only row. */
  const totals = useMemo(() => {
    if (srv) {
      const rs = srv.branches;
      return {
        sales: rs.reduce((t, r) => t + num(r.sales), 0),
        margin: rs.reduce((t, r) => t + num(r.margin), 0),
        qty: rs.reduce((t, r) => t + num(r.qty), 0),
        recs: rs.reduce((t, r) => t + num(r.receipts), 0),
      };
    }
    return {
      sales: totalSales, margin: sum(filtered, "gross_margin"),
      qty: sum(filtered, "quantity"), recs: receiptCount,
    };
  }, [srv, filtered, totalSales, receiptCount]);

  const headline = [
    { label: "Total sales", value: money(totals.sales), Icon: Receipt, bg: "bg-salmon-soft" },
    { label: "Gross margin", value: money(totals.margin), Icon: TrendingUp, bg: "bg-success-soft" },
    { label: "Receipts", value: totals.recs.toLocaleString(), Icon: ScrollText, bg: "bg-periwinkle-soft" },
    { label: "Avg receipt", value: money(totals.recs ? totals.sales / totals.recs : 0), Icon: Layers, bg: "bg-lavender-soft" },
  ];
  /* The diagnostics row. COMPUTER ONLY: eight tiles at two per row push the
     actual list a screen and a half down a 390px phone. The four figures above
     answer "how did we do"; these four answer "is the import sane", which is a
     desk question.
     Each one reads whichever source actually loaded — the roll-up or the lines.
     When this screen stopped reading raw lines on a computer these would have
     silently gone to zero, four plausible wrong numbers under four right ones. */
  const secondary = (() => {
    const rs = srv?.branches ?? null;
    const items = rs ? rs.reduce((t, r) => t + num(r.qty), 0) : sum(filtered, "quantity");
    const lineN = rs ? rs.reduce((t, r) => t + num(r.lines), 0) : filtered.length;
    const shops = rs
      ? rs.filter((r) => num(r.sales) !== 0 || num(r.lines) !== 0).length
      : new Set(filtered.map((r) => String(r.branch_id))).size;
    return [
      { label: "Items sold", value: Math.round(items).toLocaleString(), Icon: Layers, bg: "bg-amber-soft" },
      { label: "Discounts", value: money(rs ? srvDiscount : sum(filtered, "discount")), Icon: Tag, bg: "bg-pink-soft" },
      { label: "Sale lines", value: Math.round(lineN).toLocaleString(), Icon: Rows3, bg: "bg-panel" },
      { label: "Shops selling", value: shops.toLocaleString(), Icon: Store, bg: "bg-panel" },
    ];
  })();

  /* ── LEVEL 1 · stores ───────────────────────────────────────────────────
     Every trading branch is listed, not only the ones with sales, because a
     shop that sold nothing all week is the single most interesting row on the
     screen and dropping it hides exactly that. */
  const storeRows: StoreRow[] = useMemo(() => {
    const agg = byBranch;
    /* Only the shop you are in. With Top Shop chosen this is its six branches —
       listing the Fashion Collection shops at zero underneath would read as
       "FC sold nothing today", which is a lie about a shop you are not looking
       at. `ids` null means every shop, and then every branch belongs. */
    const inScope = (b: Branch) => !scope.ids || scope.ids.includes(b.id);
    const live: Branch[] = branches.filter(
      (b) => inScope(b) && (b.active !== false || agg[String(b.id)]));
    const chains = [...new Set(live.map((b) => b.chain || "—"))];
    const multi = chains.length > 1;
    const out: StoreRow[] = [];
    const zero: Agg = { amt: 0, qty: 0, margin: 0, lines: 0, recs: 0 };
    chains.forEach((ch) => {
      const stores = live.filter((b) => (b.chain || "—") === ch)
        .map((b) => ({ b, g: agg[String(b.id)] ?? zero }))
        .sort((x, y) => y.g.amt - x.g.amt);
      if (multi) {
        out.push({
          kind: "chain", name: bizLabel(ch),
          recs: stores.reduce((t, x) => t + x.g.recs, 0),
          qty: stores.reduce((t, x) => t + x.g.qty, 0),
          amt: stores.reduce((t, x) => t + x.g.amt, 0),
        });
      }
      stores.forEach((x) => out.push({
        kind: "store", id: x.b.id, name: x.b.name,
        recs: x.g.recs, qty: x.g.qty, amt: x.g.amt,
      }));
    });
    /* Sales whose branch_id matches no branch row — a branch deleted after its
       sales were imported. They are listed rather than dropped, because the
       footer totals include them and a table whose rows do not add up to its
       own total is the exact failure this screen is supposed to prevent. */
    const seen = new Set(live.map((b) => String(b.id)));
    Object.keys(agg).filter((id) => !seen.has(id)).forEach((id) => out.push({
      kind: "store", id: Number(id), name: `Unknown branch #${id}`,
      recs: agg[id].recs, qty: agg[id].qty, amt: agg[id].amt,
    }));
    return out;
  }, [byBranch, branches, scope.ids]);

  const storeCols: Col<StoreRow>[] = [
    { head: "Store", cell: (r) =>
        r.kind === "chain"
          ? <span className="text-[11.5px] font-extrabold uppercase tracking-wide text-hint dark:text-[#8a8175]">{r.name}</span>
          : (
            <button onClick={() => goBranch(String(r.id))}
              className="flex w-full items-center gap-1.5 pl-2 text-left font-semibold text-ink transition hover:text-salmon-strong dark:text-[#e7e2d8] dark:hover:text-salmon">
              {r.name} <ChevronRight size={14} className="text-hint" />
            </button>
          ) },
    { head: "Receipts", right: true, cell: (r) => <span className={r.kind === "chain" ? "font-extrabold" : ""}>{r.recs.toLocaleString()}</span> },
    { head: "Items", right: true, cell: (r) => <span className={r.kind === "chain" ? "font-extrabold" : ""}>{Math.round(r.qty).toLocaleString()}</span> },
    { head: "Total sales", right: true, cell: (r) => <span className={r.kind === "chain" ? "font-extrabold" : "font-semibold"}>{money(r.amt)}</span> },
  ];

  /* ── LEVEL 2 · payment methods for one store ──────────────────────────────
     The tiles are per method, so their bill counts are per method: a bill
     settled half cash half card is counted in both, and totalling them would
     overstate the shop. The shop's own count is `totals.recs`. */
  const pmTiles = useMemo(() => {
    const agg: Record<string, { amt: number; bills: number }> = {};
    if (srv?.methods) {
      /* null and '' come back as separate rows and both mean "unclassified",
         so they are merged here exactly as the line path merges them. */
      srv.methods.forEach((r) => {
        const k = String(r.payment_method || "unclassified");
        const a = (agg[k] ||= { amt: 0, bills: 0 });
        a.amt += num(r.sales); a.bills += num(r.receipts);
      });
    } else {
      const sets: Record<string, Set<string>> = {};
      filtered.forEach((r) => {
        const k = String(r.payment_method || "unclassified");
        (agg[k] ||= { amt: 0, bills: 0 }).amt += num(r.sales_amount);
        (sets[k] ||= new Set()).add(recKey(r));
      });
      Object.keys(agg).forEach((k) => { agg[k].bills = sets[k].size; });
    }
    const known = PM_ORDER.filter((k) => agg[k]);
    const rest = Object.keys(agg).filter((k) => !PM_ORDER.includes(k));
    return [...known, ...rest].map((k) => ({ k, amt: agg[k].amt, bills: agg[k].bills }));
  }, [filtered, srv]);

  /* ── LEVEL 3 · the bills behind one method ──────────────────────────────
     Rolled up from the lines, because a receipt is not a row anywhere — it is
     however many lines share a transaction id. Sorted by receipt NUMBER
     descending, which is the order the shop wrote them, not by amount. */
  const bills: Bill[] = useMemo(() => {
    if (!pm) return [];
    const m: Record<string, Bill> = {};
    filtered.filter((r) => String(r.payment_method || "unclassified") === pm).forEach((r) => {
      const key = recKey(r);
      const b = (m[key] ||= {
        key, no: String(r.receipt_no || key), date: String(r.sale_date ?? ""),
        party: "", qty: 0, amt: 0,
        short: parseInt(String(r.receipt_no ?? "0"), 10) || 0,
      });
      b.qty += num(r.quantity); b.amt += num(r.sales_amount);
      if (r.customer && !b.party) b.party = String(r.customer);
    });
    return Object.values(m).sort((a, b) => b.short - a.short);
  }, [filtered, pm]);

  const showParty = pm === "credit";
  const billCols: Col<Bill>[] = [
    /* The date is the small grey line on a phone, not the card title — a bill is
       identified by its number, and on credit by who owes. */
    { head: "Date", muted: true, phone: "meta", cell: (r) => text(r.date) },
    { head: "Receipt", bold: true, cell: (r) => text(r.no) },
    ...(showParty ? [{
      head: "Party", phone: "title",
      cell: (r: Bill) => (r.party ? text(r.party) : <span className="text-muted dark:text-[#a89f93]">—</span>),
    } as Col<Bill>] : []),
    { head: "Items", right: true, cell: (r) => Math.round(r.qty).toLocaleString() },
    { head: "Amount", right: true, bold: true, cell: (r) => money(r.amt) },
  ];

  /* ── the flat views, kept as extra tabs ─────────────────────────────────── */
  const grouped: GroupRow[] = useMemo(() => {
    const dim = srv?.dim;
    if (srv?.groups && dim) {
      /* Same "—" bucket as the line path, and merged on the label, because the
         database answers null and '' as two rows and both read "—". */
      const m: Record<string, GroupRow> = {};
      srv.groups.forEach((r) => {
        const k = String((r as unknown as Record<string, unknown>)[dim] || "—");
        const g = (m[k] ||= { name: k, qty: 0, amt: 0, margin: 0, lines: 0 });
        g.qty += num(r.qty); g.amt += num(r.sales); g.margin += num(r.margin); g.lines += num(r.lines);
      });
      return Object.values(m).sort((a, b) => b.amt - a.amt).slice(0, 300);
    }
    const key = view === "items" ? "item_name" : view === "departments" ? "department" : view === "salespeople" ? "salesperson" : null;
    if (!key) return [];
    const m: Record<string, GroupRow> = {};
    filtered.forEach((r) => {
      const k = String(r[key] || "—");
      const g = (m[k] ||= { name: k, qty: 0, amt: 0, margin: 0, lines: 0 });
      g.qty += num(r.quantity); g.amt += num(r.sales_amount); g.margin += num(r.gross_margin); g.lines += 1;
    });
    return Object.values(m).sort((a, b) => b.amt - a.amt).slice(0, 300);
  }, [filtered, view, srv]);

  const maxAmt = Math.max(...grouped.map((g) => g.amt), 1);
  const groupCols: Col<GroupRow>[] = [
    { head: view === "items" ? "Item" : view === "departments" ? "Department" : "Salesperson", bold: true, cell: (r) => r.name },
    { head: "Lines", right: true, muted: true, cell: (r) => r.lines.toLocaleString() },
    { head: "Qty", right: true, cell: (r) => Math.round(r.qty).toLocaleString() },
    { head: "Sales", right: true, bold: true, cell: (r) => money(r.amt) },
    { head: "Margin", right: true, cell: (r) => money(r.margin) },
    /* A bar measured against the biggest row needs a wide row to mean anything,
       and on a card it would land where the second identifier goes. The figure
       beside it already says the same thing. */
    { head: "Share", phone: "hide", cell: (r) => (
        <div className="h-2 w-full max-w-[140px] overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]">
          <div className="h-full rounded-full bg-salmon" style={{ width: `${Math.max((r.amt / maxAmt) * 100, 2)}%` }} />
        </div>
      ) },
  ];

  const lineCols: Col<Row>[] = [
    { head: "Date", muted: true, cell: (r) => text(r.sale_date) },
    /* What was sold identifies the line; which shop sold it is the second
       thing you want when the list spans all of them. */
    { head: "Branch", bold: true, phone: "meta", cell: (r) => branchName(r.branch_id) },
    { head: "Receipt", muted: true, cell: (r) => text(r.receipt_no) },
    { head: "Item", phone: "title", cell: (r) => text(r.item_name) },
    { head: "Qty", right: true, cell: (r) => num(r.quantity).toLocaleString() },
    { head: "Amount", right: true, bold: true, cell: (r) => money(r.sales_amount) },
    { head: "Payment", muted: true, cell: (r) => pmLabel(String(r.payment_method || "unclassified")) },
  ];

  /* 500 cards on a phone is sixty thousand pixels of scrolling and several
     thousand DOM nodes before the first paint finishes. The totals above are
     unaffected either way — this is only how many rows get drawn. */
  const lineCap = phone ? 150 : 500;

  /* The shop's own name — "Top Shop", not "All stores" — so the heading above
     the figures says which shop they belong to. */
  const here = scope.label;

  return (
    <Shell>
      <PageHeader title="Sales" subtitle="Every shop, then every payment method, then every bill."
        onRefresh={load} loading={loading}>
        {/* The day's figures are short? The next move is always the same file.
            See ImportButton in the kit. */}
        <ImportButton />
      </PageHeader>

      <RetailRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={
          <>
            {/* Hidden on a phone: the header already carries the shop pill, and
                two controls for one value in 390px is one too many. */}
            <ShopSelect branches={branches} scope={scope} allLabel="All stores" className="max-md:hidden" />
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 dark:border-white/10 dark:bg-white/[0.05]">
              <Search size={15} className="text-hint dark:text-[#8a8175]" />
              {/* On a phone this box is the full width of the screen, so the
                  input has to grow into it instead of sitting in 160px of it. */}
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search receipt, item, staff"
                className="w-40 bg-transparent text-[13px] outline-none placeholder:text-hint sm:w-48 max-md:flex-1 dark:text-[#f4f1ea] dark:placeholder:text-[#6f675c]" />
            </div>
          </>
        } />

      <StatCards stats={headline} loading={loading} />
      {!phone && <StatCards stats={secondary} loading={loading} />}

      <Tabs tabs={VIEWS} value={view} onChange={setView} />

      {view === "stores" ? (
        <>
          {/* Where you are. The back control itself is the pill on a computer and
              a bar above the thumb on a phone — see ActionBar at the bottom. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {branch && (
              <button onClick={() => (pm ? setPm(null) : goBranch(""))}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel max-md:hidden dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
                <ChevronLeft size={14} /> {pm ? here : "All stores"}
              </button>
            )}
            <Pill tone="info">{here}</Pill>
            {pm && <Pill tone="neutral">{pmLabel(pm)}</Pill>}
          </div>

          {!branch ? (
            /* LEVEL 1 */
            <>
              <DataTable cols={storeCols} rows={storeRows} loading={loading} err={err} minWidth={620}
                empty="No sales in this period — this fills when shop sales are brought in."
                card={(r) =>
                  r.kind === "chain" ? (
                    /* A chain is a heading on a phone, not a card. Dressing it
                       like the shops under it invites a tap that does nothing. */
                    <div className="flex items-baseline justify-between gap-3 px-1 pb-0.5 pt-3">
                      <span className="text-[11.5px] font-extrabold uppercase tracking-wide text-hint dark:text-[#8a8175]">{r.name}</span>
                      <span className="text-[13px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{money(r.amt)}</span>
                    </div>
                  ) : (
                    <RowCard title={r.name} right={money(r.amt)}
                      meta={`${r.recs.toLocaleString()} bill${r.recs === 1 ? "" : "s"} · ${Math.round(r.qty).toLocaleString()} items`}
                      onTap={() => goBranch(String(r.id))} />
                  )
                }
                /* FOUR CELLS DO NOT FIT ON A PHONE. The kit keeps the totals row
                   when a table becomes cards, which is right — it is the row
                   people came for — but "All stores" plus three figures plus
                   four cells of padding is wider than 390px, and the box it
                   sits in clips rather than scrolls, so the grand total would be
                   the part cut off. Two cells, same figures. */
                footer={phone ? (
                  <tr className="bg-panel/60 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                    <td className="px-3.5 py-3">All stores · {totals.recs.toLocaleString()} bill{totals.recs === 1 ? "" : "s"}</td>
                    <td className="px-3.5 py-3 text-right tabular-nums">{money(totals.sales)}</td>
                  </tr>
                ) : (
                  <tr className="bg-panel/60 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                    <td className="px-4 py-3">All stores</td>
                    <td className="px-4 py-3 text-right tabular-nums">{totals.recs.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{Math.round(totals.qty).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(totals.sales)}</td>
                  </tr>
                )} />
              <p className="mt-2 text-[12px] text-hint dark:text-[#8a8175]">Tap a store to see its Cash / Card / JazzCash breakdown.</p>
            </>
          ) : !pm ? (
            /* LEVEL 2 — padded on a phone to clear the fixed back bar. */
            <div className="max-md:pb-24">
              {/* WHILE THE ANSWER IS STILL COMING, A PHONE SHOWS NOTHING RATHER
                  THAN THE PREVIOUS SHOP'S. Walking into a store carries the old
                  figures for as long as the fetch takes, and a shop total that
                  is really the all-stores total — with nothing on screen saying
                  so — is the one mistake this screen exists to prevent. The
                  tiles below are the same markup they always were, so a computer
                  takes the second branch every time and is unchanged. */}
              {phone && loading ? (
                <div className="mt-4 space-y-3">
                  <div className="h-[92px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />
                  <div className="grid grid-cols-2 gap-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="h-[92px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />
                    ))}
                  </div>
                </div>
              ) : (
              <>
              <div className="mt-4 rounded-card border border-line bg-surface p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{here} — total</div>
                <div className="mt-1 text-[24px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(totals.sales)}</div>
                <div className="mt-0.5 text-[12px] text-hint dark:text-[#8a8175]">{totals.recs.toLocaleString()} bill{totals.recs === 1 ? "" : "s"}</div>
              </div>
              {pmTiles.length === 0 ? (
                <div className="mt-3 rounded-card border border-line bg-surface px-4 py-16 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">
                  No sales for this store in this period.
                </div>
              ) : (
                /* Two tiles to a row on a phone, four on a computer. Seven
                   methods across a 390px screen would be a sideways drag. */
                <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {pmTiles.map((t) => (
                    <button key={t.k} onClick={() => setPm(t.k)}
                      style={{ borderLeftColor: pmColor(t.k) }}
                      className="rounded-card border border-line border-l-[6px] bg-surface p-4 text-left transition hover:bg-panel/60 dark:border-white/[0.06] dark:bg-[#201c17] dark:hover:bg-white/[0.05]">
                      <div className="text-[12px] font-semibold text-muted dark:text-[#a89f93]">{pmLabel(t.k)}</div>
                      <div className="mt-1.5 text-[19px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(t.amt)}</div>
                      <div className="mt-1 flex items-center gap-1 text-[11.5px] text-hint dark:text-[#8a8175]">
                        {t.bills.toLocaleString()} bill{t.bills === 1 ? "" : "s"} · tap to view <ChevronRight size={12} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
              </>
              )}
            </div>
          ) : (
            /* LEVEL 3 */
            <div className="max-md:pb-24">
              <DataTable cols={billCols} rows={bills} loading={loading} err={err} minWidth={showParty ? 680 : 560}
                empty={`No ${pmLabel(pm)} bills for this store in this period.`}
                footer={
                  <tr className="bg-panel/60 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                    <td className="px-4 py-3" colSpan={showParty ? 4 : 3}>Total · {bills.length.toLocaleString()} bill{bills.length === 1 ? "" : "s"}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(bills.reduce((t, b) => t + b.amt, 0))}</td>
                  </tr>
                } />
              {showParty && (
                <SourceNote>
                  <strong>Credit is udhaar</strong> — the goods left the shop, the money did not arrive with
                  them. Every party named here owes that amount on account.
                </SourceNote>
              )}
            </div>
          )}

          {/* THE BACK CONTROL ON A PHONE. Fixed above the tab bar, so it is
              under the thumb at the bottom of a two-hundred-bill list instead of
              a chevron somewhere above the scroll. */}
          {phone && branch && (
            <ActionBar>
              <button onClick={() => (pm ? setPm(null) : goBranch(""))}
                className="flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-3 text-[14px] font-bold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
                <ChevronLeft size={17} /> Back to {pm ? here : "all stores"}
              </button>
            </ActionBar>
          )}
        </>
      ) : view === "lines" ? (
        <DataTable cols={lineCols} rows={filtered.slice(0, lineCap)} loading={loading} err={err} minWidth={820}
          empty={rows.length === 0 ? "No sales in this period — this fills when shop sales are brought in." : "Nothing matches this search."} />
      ) : (
        <DataTable cols={groupCols} rows={grouped} loading={loading} err={err} minWidth={740}
          empty={rows.length === 0 ? "No sales in this period — this fills when shop sales are brought in." : "Nothing matches this search."} />
      )}

      {/* THE DRAWING CAP, AND THE ONE CASE WHERE IT MAY NOT SAY "ALL".
          Normally the cut really is only on how many rows are DRAWN — every line
          read is in every total — and that sentence is kept word for word,
          because it is the one that is true on every ordinary day and a string
          that changes is a change on a 1280px screen.
          When the read itself was cut short, the same sentence becomes a false
          claim about money, so the completeness half of it is dropped and the
          warning below says what actually happened. */}
      {view === "lines" && !loading && !err && filtered.length > lineCap && (
        <p className="mt-2 text-[12px] text-hint dark:text-[#8a8175]">
          {truncated ? (
            <>Showing the first {lineCap} of the {filtered.length.toLocaleString()} lines that were read.</>
          ) : (
            <>Showing the first {lineCap} of {filtered.length.toLocaleString()} lines. All {filtered.length.toLocaleString()} are
            in every total on this page — the cut is only on how many rows are drawn.</>
          )}
        </p>
      )}

      {/* THE CEILING, SAID OUT LOUD. Only ever on screen when the period really
          was too big to read, so nothing about an ordinary day changes. */}
      {!loading && !err && truncated && (
        <p className="mt-2 rounded-card border border-amber-strong/40 bg-amber-soft px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          This period is too large to total line by line. Reading stopped at{" "}
          {rows.length.toLocaleString()} lines, so every figure on this page — sales, margin, receipts,
          every store and every method — is a <strong>lower bound</strong> and not the period&apos;s total.
          Choose a shorter range for a figure that is complete, or read the period off the Dashboard,
          which asks the database for the totals and has no such ceiling.
        </p>
      )}

      <SourceNote>
        {/* The same completeness claim as the cap note above, and the same single
            exception: when the read was cut short these totals are NOT the whole
            period, and this note sits directly under the warning that says so. */}
        {truncated ? (
          <>Sale lines are read a page at a time, up to a ceiling this period went past — see the note
          above before using any figure here.</>
        ) : (
          <>Sale lines are read a page at a time until the database stops returning rows, so these totals
          are the whole period and not the first thousand lines of it.</>
        )}{" "}
        A <b>receipt</b> is counted by its
        transaction id, so a bill with nine items is one receipt, not nine.
        {srv && <> On a phone, the store and payment totals are added up <strong>by the database</strong> rather
          than by downloading every line — the same sums, on the same receipt key. Search a receipt or a
          customer, or open a bill list, and the lines are read in full as usual.</>}
      </SourceNote>

      <PreviewNote />
    </Shell>
  );
}
