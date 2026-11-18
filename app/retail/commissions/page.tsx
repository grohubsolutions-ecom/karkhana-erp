"use client";
/* COMMISSIONS — what each SHOP is owed, per shop per day.
 *
 * WHO GETS PAID
 *   A shop-day, not a person. The original keys every figure on
 *   `branch_id | sale_date` and pays the shop; `salesperson` is recorded on the
 *   line and is never a payee. An earlier port of this screen grouped by
 *   `salesperson` instead — that is a different payroll, not a refactor, and
 *   because the column is nullable a Nimbus export without it collapsed the
 *   whole company into one "—" row. So this screen is a GRID: days down,
 *   branches across, one table per chain, column totals, row totals, grand
 *   total. Tap any figure for the receipts behind it.
 *
 * THE THREE RULES THAT CARRY MONEY
 *
 *   1. PER-PIECE RATE IS ALWAYS retail_price × percentage / 100 × quantity.
 *      `retail_commission_master.commission` is a REFERENCE column — the rate
 *      sheet prints it, the importer fills it, and no payout has ever read it.
 *      Paying `commission × quantity` (as the previous port did whenever that
 *      column was non-zero, which the importer makes the common case) pays a
 *      completely different number from the one the shops have been agreeing
 *      to for years. It is displayed below, greyed, and never multiplied.
 *
 *   2. FC DHA IS A FLAT PER-BARCODE SHEET AND RETURNS EARLY.
 *      A DHA line adds fc_dha_comm[item_code] × quantity and the function
 *      returns. Three things follow, and all three are the point:
 *        · no fallback to the master rate — an unlisted DHA barcode earns
 *          exactly 0, because DHA's agreement is the rate sheet and nothing
 *          else;
 *        · the line never reaches the receipt or day sales totals;
 *        · therefore FC DHA can NEVER earn a bonus.
 *      Removing the early return quietly gives DHA both a Top Shop rate and a
 *      bonus it has never been owed.
 *
 *   3. THE BONUS IS FED RUPEES, NEVER A COUNT.
 *      commBonus() slabs a RUPEE total: Rs 50 for every Rs 5,000. The previous
 *      port passed it `receipts.size` — a count — so a shop needed 5,000
 *      receipts to earn Rs 50 and the Bonus column read Rs 0 forever with
 *      nothing on screen saying why. `bonus_basis` decides which rupee figure:
 *        'receipt' → run commBonus per receipt_txn and SUM (+=) into the day
 *        'day'     → run commBonus once on the day's sales total and ASSIGN (=)
 *      There is no 'sales' basis and no 'round' mode. Both were invented by the
 *      port; the formula cannot read them, so offering them in Settings only
 *      lets somebody switch the bonus off by accident.
 *
 * WHY EVERY FIGURE IS PAGED
 *   PostgREST caps a response at 1000 rows and `.limit(5000)` does not raise
 *   that — it returns what it returns. A commission total that is quietly a
 *   lower bound is worse than one that errors, because nobody re-checks a
 *   number that looks plausible. Sale lines, the master and the DHA sheet all
 *   go through fetchAll.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Coins, Percent, Gift, Plus, Search, Save, Trash2, AlertTriangle, Pencil, Share2, LayoutGrid, ReceiptText } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import {
  Shell, PageHeader, StatCards, DataTable, Tabs, Pill, Select, PreviewNote, SourceNote, ImportButton,
  money, num, text, today, addDays, fetchAll, fetchKeyset, commBonus,
  useIsPhone, RowCard, useBranches,
  type CommCfg, type Row, type Col,
} from "@/components/retail/kit";
import { useStaleRates, reloadStale, staleSeen, markStaleSeen, findDhaBranch, findOtherDhaBranches } from "@/lib/retailStale";
import { useShopScope } from "@/lib/retailShop";
import { shareOrCopy } from "@/lib/retailShare";
import { StatementButton } from "@/components/retail/StatementSheet";
/* THE RATE SHEET ARRIVES AS A FILE, NOT AS TYPING.
 *
 * Item Rates is a table of thousands of barcodes and there was no way to get a
 * file into it from this screen — only "Add item", one barcode at a time. The
 * importer has read the commission master since the port (header test: Item
 * Code + Commission + Percentage; CSV, Excel and PDF all go through
 * lib/readGrid), so the only thing missing here was the button that opens it.
 * It is the same panel the Sales and Expenses screens open, so a file dropped
 * on the wrong screen still lands in the right table — the file says what it
 * is, the screen does not. */
import { ImportPanel } from "@/components/retail/ImportPanel";

/* ── types ───────────────────────────────────────────────────────────────── */

type Tab = "grid" | "rates" | "fcdha" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "grid", label: "Commissions" },
  { key: "rates", label: "Item Rates" },
  { key: "fcdha", label: "FC DHA" },
  { key: "settings", label: "Settings" },
];

type Branch = { id: number; name: string; code?: string | null; chain?: string | null; active?: boolean | null };
type Master = { item_code: string; item_name?: string | null; retail_price?: number | null; commission?: number | null; percentage?: number | null };
type FcRate = { item_code: string; commission: number | null };
type Stale = { item_code: string; commission: number | null; last_sold: string | null };
/** One shop-day, as retail_commission_calc returns it. */
type CalcRow = { branch_id: number; sale_date: string; per_piece: number | null; bonus: number | null };

/** One shop-day. `pp` is per-piece money, `bonus` is slab money; the payout is
 *  Math.round(pp + bonus) and nothing else. */
type Cell = { pp: number; bonus: number };
type DayRow = { ds: string; vals: number[]; total: number };
/** One receipt in the drill-down — the audit trail for a payout dispute. */
type Rec = { no: string; short: number; pp: number; total: number; codes: string[]; comm: number };

/* ── small local helpers ─────────────────────────────────────────────────── */

/* Next calendar day now comes from the kit's `addDays`, which does the whole
   thing from the string's own parts — Date.UTC in, getUTC* out, no local
   midnight ever formed. The version that used to live here parsed as UTC and
   formatted as UTC so the two agreed, which was right only as long as `iso()`
   was also UTC. `iso()` is now the local calendar day (it had been reporting
   yesterday between midnight and 5am in Karachi), so this had to stop depending
   on it. Same result in Pakistan, and now the same result everywhere. */
/** Grid cells are dense; "Rs" in every one of them is noise. Totals keep it. */
const n0 = (v: number) => Math.round(v).toLocaleString("en-PK");
const dayLabel = (ds: string) => `${ds.slice(8, 10)}/${ds.slice(5, 7)}`;
/** A grid column is 108px wide, so a day there is "05/10". A phone card has the
 *  whole screen, and somebody checking their own shop's money reads a weekday.
 *  Parsed AND formatted in UTC so the two agree: a date string has no
 *  timezone, so reading it as UTC and printing it as UTC is the only pair that
 *  cannot name a different day than the string does. */
const dayFull = (ds: string) => new Date(ds + "T00:00:00Z")
  .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Which shop a phone was last looking at. A COLUMN CHOICE, not a figure —
 *  nothing that carries money goes near storage, and if it comes back empty or
 *  blocked the first shop is used instead. */
const PHONE_BRANCH_KEY = "fs.commissions.phoneBranch";

/** A typo'd year ("2026" → "2016") would otherwise ask the database for a
 *  decade of sale lines and the browser for 3,600 table rows. */
const MAX_DAYS = 400;

const pillCls = "rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink outline-none transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white";

/** Column headers repeat the chain otherwise: "Top Shop Tariq Road" ×6. */
const shortName = (name: string, chain?: string | null) => {
  let s = String(name ?? "");
  const c = String(chain ?? "").trim();
  if (c && s.toLowerCase().startsWith(c.toLowerCase())) s = s.slice(c.length).trim();
  return (s || String(name ?? "")).replace(/Fashion Collection/i, "FC");
};

/* Top Shop first, then alphabetical — it is the biggest chain and the one
   people open this screen to look at. */
const chainRank = (s: string) => (/top\s*shop/i.test(s) ? 0 : 1);

const DEFAULT_CFG: CommCfg = { bonus_mode: "floor", bonus_basis: "receipt", bonus_slab: 5000, bonus_per_slab: 50 };

type RateForm = { isEdit: boolean; item_code: string; item_name: string; retail_price: string; commission: string; percentage: string };
type DhaForm = { isEdit: boolean; item_code: string; commission: string };

/* ── page ────────────────────────────────────────────────────────────────── */

export default function CommissionsPage() {
  const phone = useIsPhone();
  const [tab, setTab] = useState<Tab>("grid");
  const [loading, setLoading] = useState(true);
  const [refLoading, setRefLoading] = useState(true);
  const [err, setErr] = useState("");

  /* reference data.
     Branches come from the shared cache, not from a fetch of this screen's
     own — nine rows that every screen in the department asks for, and asking
     again on every mount is what made moving between screens feel slow. */
  const { branches } = useBranches();
  const [master, setMaster] = useState<Master[]>([]);
  const [fc, setFc] = useState<FcRate[]>([]);
  const [cfg, setCfg] = useState<CommCfg>(DEFAULT_CFG);

  /* the grid */
  const t0 = today();
  const [from, setFrom] = useState(t0.slice(0, 8) + "01"); // month-to-date, like the original
  const [to, setTo] = useState(t0);
  const [chainFilter, setChainFilter] = useState("");

  /* The shop from the left menu. `ids` is null for "every shop", which is what
     the RPC wants too, so it passes straight through. A stable string key for
     the dependency array — the array itself is a new object every render. */
  const shop = useShopScope(branches);
  const scopeIds = shop.ids;
  const [cells, setCells] = useState<CalcRow[]>([]);
  /* Reads storage in the initialiser, inside a try, so a private window or
     blocked site data just starts on the first shop. Only ever rendered under
     `phone`, which is false on the server, so there is nothing to mismatch. */
  const [phoneBid, setPhoneBid] = useState<string>(() => {
    try { return localStorage.getItem(PHONE_BRANCH_KEY) ?? ""; } catch { return ""; }
  });
  const pickPhoneBranch = (v: string) => {
    setPhoneBid(v);
    try { localStorage.setItem(PHONE_BRANCH_KEY, v); } catch { /* the pick just won't stick */ }
  };

  /* drill-down */
  const [drill, setDrill] = useState<{ bid: number; ds: string; name: string } | null>(null);
  const [drillRows, setDrillRows] = useState<Rec[] | null>(null);

  /* editors */
  const [q, setQ] = useState("");
  const [rateForm, setRateForm] = useState<RateForm | null>(null);
  const [dhaForm, setDhaForm] = useState<DhaForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCfg, setSavedCfg] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  /* Statement first. The grid is still one tap away, but "what do I owe each
     shop" is the question this screen gets opened for. */
  const [view, setView] = useState<"statement" | "days">("statement");
  const [shareNote, setShareNote] = useState("");

  /* stale DHA rates */
  const [staleOpen, setStaleOpen] = useState(false);
  const [staleSel, setStaleSel] = useState<string[]>([]);
  const [staleBusy, setStaleBusy] = useState(false);

  /* ── FC DHA, resolved from the data ────────────────────────────────────
   * ONE implementation, in lib/retailStale.ts, called from here. It used to be
   * written out twice — once there, once here — with the same regex, and two
   * copies of a rule that decides who gets paid is two copies that can drift.
   *
   * The rule itself changed because the old one had already failed: "any
   * branch named DHA, lowest id wins" quietly handed the Fashion Collection
   * flat rate sheet to TOP SHOP DHA when that shop opened, because its id (6)
   * sorts before Fashion Collection DHA's (11). Top Shop DHA then earned Rs 0
   * on Rs 2.5m of sales. The note in lib/retailStale.ts has the full account.
   *
   * `otherDha` is every other shop with DHA in its name. It is not a leftover
   * — it is printed on screen, so the next time two shops share a word nobody
   * has to work out which one the money went to. */
  const dhaBranch = useMemo(() => findDhaBranch(branches), [branches]);
  const otherDha = useMemo(() => findOtherDhaBranches(branches), [branches]);
  const dhaId = dhaBranch ? Number(dhaBranch.id) : null;

  /* ── loaders ───────────────────────────────────────────────────────────── */

  const loadRef = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setRefLoading(false); return; }
    setRefLoading(true);
    const db = supabase;
    const [c] = await Promise.all([
      db.from("retail_commission_config").select("bonus_mode,bonus_basis,bonus_slab,bonus_per_slab").eq("id", 1).maybeSingle(),
    ]);
    /* Both rate sheets are paged. An un-paged master stops at row 1000 and
       every item past it silently earns nothing — the failure looks exactly
       like "that article has no commission set".

       These two need no `id` tiebreak and must not be given one: `item_code` is
       the PRIMARY KEY of both tables — there is no `id` column to order by — so
       `.order("item_code")` is already a unique total order and the pages cannot
       repeat or skip a row. */
    const [m, f] = await Promise.all([
      fetchAll<Master>((lo, hi) => db.from("retail_commission_master")
        .select("item_code,item_name,retail_price,commission,percentage").order("item_code").range(lo, hi)),
      fetchAll<FcRate>((lo, hi) => db.from("retail_fc_dha_comm")
        .select("item_code,commission").order("item_code").range(lo, hi)),
    ]);
    setCfg((c.data as CommCfg) ?? DEFAULT_CFG);
    setMaster(m.rows); setFc(f.rows);
    const e = m.error || f.error || "";
    if (e) setErr(e);
    setRefLoading(false);
  }, []);
  useEffect(() => { loadRef(); }, [loadRef]);

  /* The rendered window: clamped to today, then capped. The query uses the
     capped end too, so the tiles can never total days the grid does not show. */
  const dTo = to > t0 ? t0 : to;
  const days = useMemo(() => {
    const out: string[] = [];
    if (!from || !dTo || from > dTo) return out;
    for (let ds = from; ds <= dTo && out.length < MAX_DAYS; ds = addDays(ds, 1)) out.push(ds);
    return out;
  }, [from, dTo]);
  const capped = days.length === MAX_DAYS && days[days.length - 1] < dTo;
  const qTo = days.length ? days[days.length - 1] : dTo;
  const hasDays = days.length > 0;

  /* ── THE CALCULATION NOW HAPPENS WHERE THE DATA IS ───────────────────────
   *
   * This screen used to page every sale line in the range down to the browser
   * and add them up here. Measured on the live database, a 30-day range is
   * 13,360 lines — FOURTEEN sequential requests from Lahore, and this query was
   * the single heaviest statement in the whole project at 4,639 ms mean. The
   * same answer from `retail_commission_calc` is ONE call of 70 ms returning
   * 184 rows.
   *
   * The function is a line-for-line translation of the arithmetic that used to
   * live below, and it was checked against it over all 58,303 lines before this
   * screen was changed to use it: 783 shop-days each side, 0 differing, and the
   * same Rs 335,137 total. Migration 0131 carries that proof in its comments.
   *
   * The rate sheets are still loaded (loadRef) because the DRILL-DOWN computes
   * per receipt in the browser, and because the Rates and FC DHA tabs list
   * them. Only the grid moved. */
  const loadCells = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    if (!hasDays) { setCells([]); setLoading(false); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("retail_commission_calc", {
      p_from: from, p_to: qTo,
      /* null means every shop. A chosen shop is its branch ids — Top Shop is
         six of them, which is why this takes an array. */
      p_branches: scopeIds,
    });
    if (error) setErr(error.message);
    setCells((data as CalcRow[]) ?? []);
    setLoading(false);
  }, [from, qTo, hasDays, shop.key]);
  useEffect(() => { loadCells(); }, [loadCells]);

  /* ── the calculation, ported line for line ─────────────────────────────── */

  const masterMap = useMemo(() => {
    const m = new Map<string, Master>();
    master.forEach((r) => m.set(String(r.item_code), r));
    return m;
  }, [master]);
  const fcMap = useMemo(() => {
    const m = new Map<string, number>();
    fc.forEach((r) => m.set(String(r.item_code), num(r.commission)));
    return m;
  }, [fc]);

  /* Keyed exactly as before — "<branch>|<date>" — so everything downstream of
     here (the grid, the tiles, the share card) is untouched. */
  const cell = useMemo(() => {
    const out: Record<string, Cell> = {};
    cells.forEach((r) => {
      out[`${Number(r.branch_id)}|${String(r.sale_date)}`] =
        { pp: num(r.per_piece), bonus: num(r.bonus) };
    });
    return out;
  }, [cells]);

  /* ── grid shape ────────────────────────────────────────────────────────── */

  /* A closed shop keeps its history: a branch is shown if it is still active or
     if it sold anything in this window. Dropping a closed shop would make an
     old month re-read lower than it was actually paid. */
  const shownBranches = useMemo(() => {
    const traded = new Set<string>();
    Object.keys(cell).forEach((k) => traded.add(k.split("|")[0]));
    /* Only the shop on the left menu. Without this, choosing FC DHA would still
       print the six Top Shop columns at zero beside it, which reads as "Top Shop
       earned no commission" about shops you are not looking at. */
    const inScope = (b: { id: number }) => !scopeIds || scopeIds.includes(b.id);
    return branches.filter((b) => inScope(b) && (b.active !== false || traded.has(String(b.id))));
  }, [branches, cell, scopeIds]);

  const chains = useMemo(() => {
    const set = new Set(shownBranches.map((b) => String(b.chain ?? "").trim() || "Other"));
    return [...set].sort((a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b));
  }, [shownBranches]);

  const blocks = useMemo(() => {
    return chains
      .filter((chn) => !chainFilter || chn === chainFilter)
      .map((chn) => {
        const brs = shownBranches
          .filter((b) => (String(b.chain ?? "").trim() || "Other") === chn)
          .sort((a, b) => a.id - b.id);
        const rows: DayRow[] = days.map((ds) => {
          const vals = brs.map((b) => {
            const c = cell[`${b.id}|${ds}`];
            return c ? Math.round(c.pp + c.bonus) : 0; // the payout, per the original
          });
          return { ds, vals, total: vals.reduce((a, x) => a + x, 0) };
        });
        const colTot = brs.map((_, i) => rows.reduce((a, r) => a + r.vals[i], 0));
        return { chain: chn, brs, rows, colTot, grand: colTot.reduce((a, x) => a + x, 0) };
      })
      .filter((blk) => blk.brs.length > 0);
  }, [chains, chainFilter, shownBranches, days, cell]);

  /* ── ONE COLUMN OF THE GRID, FOR A PHONE ───────────────────────────────
   * The grid is days down and branches across: with nine shops it is 1,162px
   * wide, and a phone is 390. A matrix cannot be flattened into a list without
   * losing the thing it is for, so a phone shows ONE SHOP at a time and lays
   * its days out as cards instead.
   *
   * It is read straight off `blocks` — the same rows, the same `vals[i]`, the
   * same `colTot[i]` the computer grid draws — so the figure a shop reads on a
   * phone cannot differ from the figure head office reads at a desk. Nothing
   * about the payout is recalculated here.
   */
  const phoneBranches = useMemo(() => blocks.flatMap((blk) => blk.brs), [blocks]);
  const phoneSel = phoneBranches.some((b) => String(b.id) === phoneBid)
    ? phoneBid
    : (phoneBranches[0] ? String(phoneBranches[0].id) : "");
  const phoneCol = useMemo(() => {
    for (const blk of blocks) {
      const i = blk.brs.findIndex((b) => String(b.id) === phoneSel);
      if (i >= 0) return { chain: blk.chain, br: blk.brs[i], rows: blk.rows, i, total: blk.colTot[i] };
    }
    return null;
  }, [blocks, phoneSel]);

  /* Tiles sum the raw pp/bonus, as the original does, so Per-piece + Bonus is
     exactly Total. The grid rounds each cell, so the two can differ by a rupee
     or two over a long range. The cell is the payout; the tile is the summary. */
  const totals = useMemo(() => {
    let pp = 0, bonus = 0;
    blocks.forEach((blk) => blk.brs.forEach((b) => days.forEach((ds) => {
      const c = cell[`${b.id}|${ds}`];
      if (c) { pp += c.pp; bonus += c.bonus; }
    })));
    return { pp, bonus, total: pp + bonus };
  }, [blocks, days, cell]);

  const stats = [
    { label: "Total commission", value: money(totals.total), Icon: Coins },
    { label: "Per-piece", value: money(totals.pp), Icon: Percent },
    { label: "Bonus", value: money(totals.bonus), Icon: Gift },
  ];

  /* ── THE STATEMENT ─────────────────────────────────────────────────────
   * The grid is days down and shops across. That is the right shape for
   * "which day was odd", and the wrong shape for the question actually asked
   * at the end of a week: what do I owe each shop? Nobody adds up a column of
   * a matrix in their head to find out.
   *
   * So this is the same numbers as a statement: a heading with the dates, one
   * line per shop with its figure, and a total at the bottom. Every value is
   * read off the SAME `blocks` and `cell` the grid draws — `total` is literally
   * `blk.colTot[i]`, the grid's own column total — so the statement and the
   * grid cannot disagree. Nothing is recalculated here. */
  const statement = useMemo(() => blocks.map((blk) => ({
    chain: blk.chain,
    total: blk.grand,
    shops: blk.brs.map((b, i) => {
      let pp = 0, bonus = 0, dayCount = 0;
      days.forEach((ds) => {
        const c = cell[`${b.id}|${ds}`];
        if (c) { pp += c.pp; bonus += c.bonus; if (c.pp + c.bonus >= 0.5) dayCount++; }
      });
      return { id: b.id, name: b.name, pp, bonus, dayCount, total: blk.colTot[i] };
    }),
  })), [blocks, days, cell]);

  /** "19 Oct 2026", or "19 – 20 Oct 2026" for a range. The heading he reads
   *  first, so it says the dates in words rather than 2026-10-19. */
  const dayWords = (ds: string) => {
    const [y, m, d] = ds.split("-");
    return `${Number(d)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${y}`;
  };
  const rangeWords = from === qTo ? dayWords(from) : `${dayWords(from)} — ${dayWords(qTo)}`;

  /* The same statement as text, for WhatsApp. The figures are taken from the
     rendered rows, not recomputed, so what he sends is what he saw. */
  async function shareStatement() {
    const lines: string[] = [`*Commission*`, rangeWords, ""];
    statement.forEach((blk) => {
      lines.push(`*${blk.chain}*`);
      blk.shops.forEach((s) => lines.push(`${shortName(s.name, blk.chain)}: ${money(s.total)}`));
      if (statement.length > 1) lines.push(`${blk.chain} total: ${money(blk.total)}`);
      lines.push("");
    });
    lines.push(`*Total commission: ${money(totals.total)}*`);
    lines.push(`Per-piece ${money(totals.pp)} · Bonus ${money(totals.bonus)}`);
    const r = await shareOrCopy(lines.join("\n"), "Commission");
    if (r === "cancelled") return;
    setShareNote(r === "shared" ? "Sent." : r === "copied" ? "Copied — paste it into WhatsApp." : "Could not share.");
    setTimeout(() => setShareNote(""), 4000);
  }

  /* ── drill-down: the receipts behind one cell ──────────────────────────── */

  useEffect(() => {
    if (!drill) { setDrillRows(null); return; }
    let live = true;
    (async () => {
      if (!isSupabaseConfigured || !supabase) { setDrillRows([]); return; }
      const db = supabase;
      setDrillRows(null);
      /* Ordered on id for the same reason as the grid read above. One shop and
         one day is rarely more than a page, so this one is unlikely to be bitten
         — but "unlikely" is not a property of a paged read, and the figure this
         drill-down shows is the one somebody checks a payout against. */
      const { rows, error } = await fetchAll<Row>((lo, hi) => db.from("retail_sale_lines")
        .select("receipt_no,receipt_txn,item_code,quantity,sales_amount")
        .eq("branch_id", drill.bid).eq("sale_date", drill.ds).order("id").range(lo, hi));
      if (!live) return;
      if (error) { setErr(error); setDrillRows([]); return; }

      const isDHA = dhaId != null && drill.bid === dhaId;
      const recs: Record<string, Rec> = {};
      rows.forEach((l) => {
        /* Blank falls through to the next candidate, as in the original — a
           receipt keyed on "" would merge unrelated bills into one row. */
        const key = text(l.receipt_txn, text(l.receipt_no, "?"));
        const r = (recs[key] ??= {
          no: text(l.receipt_no, key), short: parseInt(text(l.receipt_no, "0"), 10) || 0,
          pp: 0, total: 0, codes: [], comm: 0,
        });
        r.total += num(l.sales_amount);
        const code = String(l.item_code ?? "");
        if (isDHA) {
          const cm = fcMap.get(code);
          if (cm != null) { r.pp += cm * num(l.quantity); if (!r.codes.includes(code)) r.codes.push(code); }
        } else {
          const m = masterMap.get(code);
          if (m) { r.pp += num(m.retail_price) * (num(m.percentage) / 100) * num(l.quantity); if (!r.codes.includes(code)) r.codes.push(code); }
        }
      });
      /* FC DHA never gets a bonus here either — same rule, same reason. */
      const out = Object.values(recs)
        .map((r) => ({ ...r, comm: Math.round(r.pp + (!isDHA && cfg.bonus_basis === "receipt" ? commBonus(r.total, cfg) : 0)) }))
        .filter((r) => r.comm !== 0)
        .sort((a, b) => b.short - a.short);

      /* ON 'day' BASIS THE BONUS BELONGS TO NO RECEIPT, so the old app simply
         left it out and the drill-down silently failed to add up to the cell it
         was opened from — rows totalling less than the figure somebody tapped,
         with nothing saying why. It gets its own row instead, which is what it
         is: one bonus, earned by the day rather than by any one bill. */
      if (!isDHA && cfg.bonus_basis === "day") {
        const dayTotal = rows.reduce((t, l) => t + num(l.sales_amount), 0);
        const dayBonus = Math.round(commBonus(dayTotal, cfg));
        if (dayBonus !== 0) {
          out.push({ no: "Day bonus", short: -1, pp: 0, total: dayTotal, codes: [], comm: dayBonus });
        }
      }
      setDrillRows(out);
    })();
    return () => { live = false; };
  }, [drill, dhaId, fcMap, masterMap, cfg]);

  /* ── stale FC DHA rates ────────────────────────────────────────────────── */

  /* Shared with the Dashboard banner through lib/retailStale.ts, so the two
     cannot show different counts, the question is asked once per page load, and
     the three-months-of-history guard lives in one place. */
  const { stale, wholeSheetStale } = useStaleRates(branches);

  /* OPEN IT BY ITSELF, ONCE. The old app did this and it is the only reason the
     cleanup ever happened — but once per session, not once per navigation: a
     dialog that reappears every time you touch this tab is a dialog people
     learn to dismiss without reading. Arriving from the dashboard banner
     (?stale=1) always opens it, because that is what was pressed. */
  useEffect(() => {
    if (!stale?.length) return;
    const asked = typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("stale") === "1";
    if (asked) { setStaleOpen(true); markStaleSeen(); return; }
    if (!staleSeen()) { setStaleOpen(true); markStaleSeen(); }
  }, [stale]);

  async function deleteCodes(codes: string[]) {
    if (!supabase || !codes.length) return;
    setStaleBusy(true); setErr("");
    /* 100 at a time: `delete().in(...)` puts every value in the query string,
       and a few thousand barcodes is a URL the server refuses outright. */
    for (let i = 0; i < codes.length; i += 100) {
      const { error } = await supabase.from("retail_fc_dha_comm").delete().in("item_code", codes.slice(i, i + 100));
      if (error) { setErr(error.message); setStaleBusy(false); return; }
    }
    const gone = new Set(codes);
    reloadStale(dhaId);
    setFc((s) => s.filter((r) => !gone.has(String(r.item_code))));
    setStaleSel([]);
    setStaleBusy(false);
    if ((stale ?? []).length <= codes.length) setStaleOpen(false);
  }

  /* ── rate editing ──────────────────────────────────────────────────────── */

  async function saveRate() {
    if (!supabase || !rateForm) return;
    const code = rateForm.item_code.trim();
    if (!code) { setErr("Item code is required."); return; }
    setSaving(true); setErr("");
    const { error } = await supabase.from("retail_commission_master").upsert({
      item_code: code,
      item_name: rateForm.item_name.trim() || null,
      retail_price: num(rateForm.retail_price),
      commission: num(rateForm.commission),
      /* 5 is the house rate. A blank percentage saved as 0 would silently take
         the item off commission while still looking like it is on the list. */
      percentage: num(rateForm.percentage) || 5,
    }, { onConflict: "item_code" });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setRateForm(null);
    loadRef();
  }

  async function deleteRate(code: string) {
    if (!supabase || !window.confirm(`Delete ${code} from the commission master?`)) return;
    setSaving(true);
    const { error } = await supabase.from("retail_commission_master").delete().eq("item_code", code);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setRateForm(null);
    loadRef();
  }

  async function saveDha() {
    if (!supabase || !dhaForm) return;
    const code = dhaForm.item_code.trim();
    if (!code) { setErr("Barcode is required."); return; }
    setSaving(true); setErr("");
    const { error } = await supabase.from("retail_fc_dha_comm")
      .upsert({ item_code: code, commission: num(dhaForm.commission) }, { onConflict: "item_code" });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setDhaForm(null);
    loadRef();
  }

  async function deleteDha(code: string) {
    if (!supabase || !window.confirm(`Delete ${code} from the FC DHA rate sheet?`)) return;
    setSaving(true);
    const { error } = await supabase.from("retail_fc_dha_comm").delete().eq("item_code", code);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setDhaForm(null);
    loadRef();
  }

  async function saveCfg() {
    if (!supabase) return;
    setSavedCfg("saving");
    /* upsert, not update: on a fresh database row 1 does not exist yet and an
       update would report success while changing nothing. */
    const { error } = await supabase.from("retail_commission_config").upsert({
      id: 1,
      bonus_mode: cfg.bonus_mode, bonus_basis: cfg.bonus_basis,
      bonus_slab: num(cfg.bonus_slab), bonus_per_slab: num(cfg.bonus_per_slab),
    }, { onConflict: "id" });
    setSavedCfg(error ? "error" : "saved");
    if (error) setErr(error.message);
    setTimeout(() => setSavedCfg(""), 2500);
  }

  /* ── filtered lists ────────────────────────────────────────────────────── */

  const filteredMaster = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return master;
    return master.filter((m) => `${m.item_code} ${m.item_name ?? ""}`.toLowerCase().includes(n));
  }, [master, q]);
  const filteredFc = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return fc;
    return fc.filter((f) => String(f.item_code).toLowerCase().includes(n));
  }, [fc, q]);

  /* ── columns ───────────────────────────────────────────────────────────── */

  /* The editors, as functions rather than inline handlers, because on a phone
     the whole card opens them and on a computer the pencil does — one place to
     read, so the two cannot drift apart. */
  const editRate = (r: Master) => setRateForm({
    isEdit: true, item_code: String(r.item_code), item_name: String(r.item_name ?? ""),
    retail_price: String(r.retail_price ?? ""), commission: String(r.commission ?? ""),
    percentage: String(r.percentage ?? 5),
  });
  const editDha = (r: FcRate) => setDhaForm({
    isEdit: true, item_code: String(r.item_code), commission: String(r.commission ?? ""),
  });

  const rateCols: Col<Master>[] = [
    { head: "Item code", bold: true, cell: (r) => r.item_code },
    { head: "Name", muted: true, cell: (r) => text(r.item_name) },
    { head: "Retail price", right: true, cell: (r) => money(r.retail_price) },
    { head: "%", right: true, bold: true, cell: (r) => `${num(r.percentage)}%` },
    /* The big figure on a phone card is what the item PAYS, not its percentage:
       the percentage is how the payout is worked out, "Earns / piece" is the
       payout, and that is what somebody checks a rate sheet for. */
    { head: "Earns / piece", right: true, phone: "lead", cell: (r) => money(num(r.retail_price) * (num(r.percentage) / 100)) },
    { head: "Comm. column", right: true, muted: true, cell: (r) => <span title="Reference only — never used in a payout">{money(r.commission)}</span> },
    /* Hidden on a phone, where tapping the card itself opens the editor — a
       pencil in the card's figure slot reads as the row's value. */
    { head: "", right: true, phone: "hide", cell: (r) => (
        <button onClick={() => editRate(r)}
          className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="Edit"><Pencil size={14} /></button>
      ) },
  ];

  const fcCols: Col<FcRate>[] = [
    { head: "Barcode", bold: true, cell: (r) => r.item_code },
    { head: "Commission per piece", right: true, cell: (r) => money(r.commission) },
    { head: "", right: true, phone: "hide", cell: (r) => (
        <button onClick={() => editDha(r)}
          className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="Edit"><Pencil size={14} /></button>
      ) },
  ];

  const drillCols: Col<Rec>[] = [
    { head: "Receipt", bold: true, cell: (r) => r.no },
    { head: "Total amount", right: true, cell: (r) => money(r.total) },
    { head: "Commissionable items", muted: true, cell: (r) => (r.codes.length ? r.codes.join(", ") : "—") },
    { head: "Commission", right: true, bold: true, cell: (r) => (
        <span className={r.comm < 0 ? "text-danger" : undefined}>{money(r.comm)}</span>
      ) },
  ];

  const staleCols: Col<Stale>[] = [
    { head: "", cell: (r) => (
        <input type="checkbox" checked={staleSel.includes(String(r.item_code))}
          onChange={(e) => setStaleSel((s) => e.target.checked ? [...s, String(r.item_code)] : s.filter((x) => x !== String(r.item_code)))}
          className="h-4 w-4 accent-current" />
      ) },
    { head: "Barcode", bold: true, cell: (r) => r.item_code },
    { head: "Rate", right: true, cell: (r) => money(r.commission) },
    { head: "Last sold", muted: true, cell: (r) => (r.last_sold ? String(r.last_sold) : "never sold") },
    { head: "", right: true, cell: (r) => (
        <button disabled={staleBusy} onClick={() => deleteCodes([String(r.item_code)])}
          className="rounded-full p-1.5 text-muted transition hover:bg-danger-soft hover:text-danger disabled:opacity-40 dark:text-[#a89f93]" aria-label="Delete"><Trash2 size={14} /></button>
      ) },
  ];

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <Shell>
      <PageHeader
        title="Commissions"
        subtitle="Per-piece from the rate sheet plus the slab bonus, minus returns — per shop, per day."
        onRefresh={() => { loadRef(); loadCells(); reloadStale(dhaId); }}
        loading={loading || refLoading}
      >
        {/* On every tab, not just Item Rates. Somebody holding the new rate
            sheet is looking at the commission figures it is going to change,
            and being sent to another tab to find the button is how the sheet
            stays unimported. */}
        <StatementButton kind="commission" branchIds={shop.ids} branches={branches} />
        <ImportButton onClick={() => setImportOpen(true)} />
        {tab === "rates" && (
          <button onClick={() => setRateForm({ isEdit: false, item_code: "", item_name: "", retail_price: "", commission: "", percentage: "5" })} className={btnPrimary}>
            <Plus size={15} /> Add item
          </button>
        )}
        {tab === "fcdha" && (
          <button onClick={() => setDhaForm({ isEdit: false, item_code: "", commission: "" })} className={btnPrimary}>
            <Plus size={15} /> Add barcode
          </button>
        )}
      </PageHeader>

      {/* `inShop` is the shop from the left menu, passed so a single-store file
          needs no dropdown. A rate sheet is company-wide — retail_commission_master
          has no branch_id and every shop is paid from the same row — so the shop
          changes nothing for THIS file. It is passed anyway because this is the
          one shared panel: a sales or expense file dropped here is still that
          shop's file, and the panel has to be told which shop that is.

          onDone reloads both halves: the rate sheet itself, and the grid, whose
          every figure is retail_price × percentage. Reloading the rates and
          leaving the grid showing the old money is the version of this that
          makes somebody import the file a second time. */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} wide
        title="Import" subtitle="Drop any NimbusRMS export — CSV, Excel or PDF. The file says what it is.">
        <ImportPanel inShopKey={shop.key} inShop={shop.single ? Number(shop.single) : null}
          onDone={() => { loadRef(); loadCells(); }} />
      </Modal>

      <Tabs tabs={TABS} value={tab} onChange={(t) => { setTab(t); setQ(""); }} />

      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">{err}</p>}

      {/* ══ THE GRID ══════════════════════════════════════════════════════ */}
      {tab === "grid" && (
        <>
          {/* Each label and its date input are one group, so on a phone the pair
              takes a full row and the input fills it. Two 16px date fields side
              by side at 390px is a field you cannot read the year in. At 1024px
              and up the groups sit in the same flex row with the same 8px gap,
              so the row is unchanged. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 max-md:w-full">
              <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">From</span>
              <input type="date" value={from} max={t0} onChange={(e) => setFrom(e.target.value)} className={`${pillCls} max-md:flex-1`} />
            </div>
            <div className="flex items-center gap-2 max-md:w-full">
              <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">To</span>
              {/* Clamped to today: a range ending in the future adds empty rows
                  and invites somebody to read them as "no commission earned". */}
              <input type="date" value={dTo} max={t0} onChange={(e) => setTo(e.target.value)} className={`${pillCls} max-md:flex-1`} />
            </div>
            {chains.length > 1 && (
              <Select value={chainFilter} onChange={setChainFilter} className="ml-auto max-md:ml-0 max-md:w-full">
                <option value="">All chains</option>
                {chains.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </div>

          {from > dTo && <p className="mt-3 text-[12.5px] font-semibold text-danger">From is after To — nothing to show.</p>}
          {capped && (
            <p className="mt-3 text-[12.5px] font-semibold text-amber-strong dark:text-amber">
              Showing the first {MAX_DAYS} days ({from} to {qTo}). Narrow the range to see the rest.
            </p>
          )}

          {/* STATEMENT or DAY BY DAY. Two readings of one set of numbers. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-line bg-surface p-1 dark:border-white/10 dark:bg-white/[0.06]">
              {([["statement", "Statement", ReceiptText], ["days", "Day by day", LayoutGrid]] as const).map(([v, label, Icon]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition ${
                    view === v ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted dark:text-[#a89f93]"}`}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
            {view === "statement" && !loading && blocks.length > 0 && (
              <button onClick={shareStatement} className={`${pillCls} inline-flex items-center gap-1.5`}>
                <Share2 size={14} /> Share
              </button>
            )}
            {shareNote && <span className="text-[12.5px] font-semibold text-success">{shareNote}</span>}
          </div>

          <StatCards stats={stats} loading={loading} />

          {!loading && master.length === 0 && (
            <div className="mt-4 flex items-start gap-3 rounded-card border border-amber/30 bg-amber-soft p-4 dark:border-amber/30 dark:bg-amber/10">
              <AlertTriangle size={17} className="mt-0.5 flex-none text-amber-strong dark:text-amber" />
              <p className="text-[13px] text-ink dark:text-[#e7e2d8]">
                The commission master is empty, so no Top Shop line can earn a per-piece rate.
                Import a Commission Master CSV from the Import screen, or add items under <strong>Item Rates</strong>.
              </p>
            </div>
          )}

          {/* ── THE PHONE VIEW: ONE SHOP, ITS DAYS AS CARDS ───────────────
              The shop is picked from a native select (grouped by chain, so six
              Top Shop branches and two FC shops stay told apart), and every
              figure comes off the same `blocks` the matrix below draws.

              Per-piece and bonus are printed under each day because a phone card
              has room for them and the grid cell never did — which is the one
              question a shop actually asks about a commission figure, after the
              bonus spent a release reading zero. Tapping a day still opens the
              receipt-by-receipt audit trail. */}
          {view === "statement" ? (
            loading ? (
              <div className="mt-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[58px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)}
              </div>
            ) : blocks.length === 0 ? (
              <p className="mt-6 text-center text-[13px] text-muted dark:text-[#a89f93]">No shops to show for this chain filter.</p>
            ) : (
              <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
                {/* The heading says the dates in words. 2026-10-19 is a key;
                    "19 Oct 2026" is what somebody reads out on the phone. */}
                <div className="border-b border-line px-5 py-4 dark:border-white/[0.08]">
                  <h2 className="text-[17px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Commission</h2>
                  <p className="mt-0.5 text-[13px] text-muted dark:text-[#a89f93]">
                    {rangeWords}{days.length > 1 && <> · {days.length} days</>}
                  </p>
                </div>

                {statement.map((blk) => (
                  <div key={blk.chain} className="border-b border-line last:border-b-0 dark:border-white/[0.08]">
                    {statement.length > 1 && (
                      <div className="flex items-center justify-between gap-3 bg-panel/60 px-5 py-2 dark:bg-white/[0.04]">
                        <span className="text-[11.5px] font-bold uppercase tracking-wide text-muted dark:text-[#a89f93]">{blk.chain}</span>
                        <span className="text-[12.5px] font-bold tabular-nums text-muted dark:text-[#a89f93]">{money(blk.total)}</span>
                      </div>
                    )}
                    {blk.shops.map((s) => (
                      <button key={s.id} onClick={() => setView("days")}
                        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-panel/60 dark:hover:bg-white/[0.04]">
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-semibold text-ink dark:text-[#e7e2d8]">{s.name}</span>
                          {/* Per-piece and bonus under the name. A commission
                              figure nobody can break into its two halves is a
                              figure nobody argues with — or trusts. */}
                          <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">
                            Per-piece {money(s.pp)}
                            {s.bonus > 0 ? <> · Bonus {money(s.bonus)}</> : <> · no bonus</>}
                            {s.dayCount > 0 && <> · {s.dayCount} day{s.dayCount === 1 ? "" : "s"}</>}
                          </span>
                        </span>
                        <span className={`flex-none text-[17px] font-extrabold tabular-nums ${s.total > 0 ? "text-ink dark:text-[#f4f1ea]" : "text-hint dark:text-[#6f675c]"}`}>
                          {money(s.total)}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}

                <div className="flex items-center justify-between gap-3 bg-ink px-5 py-4 text-white dark:bg-white dark:text-[#141414]">
                  <span className="text-[13.5px] font-bold">Total commission</span>
                  <span className="text-[22px] font-extrabold tabular-nums">{money(totals.total)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-2.5 text-[12px] text-muted dark:text-[#a89f93]">
                  <span>Per-piece {money(totals.pp)}</span>
                  <span>Bonus {money(totals.bonus)}</span>
                </div>
              </div>
            )
          ) : phone ? (
            <>
              {phoneBranches.length > 1 && (
                <select value={phoneSel} onChange={(e) => pickPhoneBranch(e.target.value)} aria-label="Shop"
                  className="mt-4 w-full rounded-xl2 border border-line bg-surface px-3.5 py-3 font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
                  {blocks.map((blk) => (
                    <optgroup key={blk.chain} label={blk.chain}>
                      {blk.brs.map((b) => <option key={b.id} value={String(b.id)}>{shortName(b.name, b.chain)}</option>)}
                    </optgroup>
                  ))}
                </select>
              )}

              {phoneCol && (
                <>
                  <div className="mt-3 rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
                    <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{phoneCol.br.name} · {phoneCol.chain}</div>
                    <div className="mt-1 text-[24px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(phoneCol.total)}</div>
                    <div className="mt-0.5 text-[12px] text-hint dark:text-[#8a8175]">
                      {from} to {qTo} · {days.length} day{days.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  {loading ? (
                    <div className="mt-3 space-y-2">
                      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[66px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)}
                    </div>
                  ) : phoneCol.rows.length === 0 ? (
                    <p className="mt-3 rounded-card border border-line bg-surface p-8 text-center text-[13px] text-muted dark:border-white/[0.06] dark:bg-[#201c17] dark:text-[#a89f93]">
                      Pick a date range to see the days.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {phoneCol.rows.map((r) => {
                        const v = r.vals[phoneCol.i];
                        const c = cell[`${phoneCol.br.id}|${r.ds}`];
                        return (
                          <RowCard key={r.ds}
                            title={dayFull(r.ds)}
                            meta={c && (c.pp || c.bonus)
                              ? <>Per-piece {money(c.pp)} · bonus {money(c.bonus)}</>
                              : undefined}
                            right={<span className={v < 0 ? "text-danger" : undefined}>{money(v)}</span>}
                            /* Tappable only when there is something behind it —
                               the same test the grid uses to make a cell a button. */
                            onTap={v ? () => setDrill({ bid: phoneCol.br.id, ds: r.ds, name: phoneCol.br.name }) : undefined}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          ) : blocks.map((blk) => {
            const cols: Col<DayRow>[] = [
              { head: "Date", muted: true, cell: (r) => dayLabel(r.ds) },
              ...blk.brs.map((b, i): Col<DayRow> => ({
                head: shortName(b.name, b.chain),
                right: true,
                cell: (r) => r.vals[i]
                  ? (
                    <button
                      onClick={() => setDrill({ bid: b.id, ds: r.ds, name: b.name })}
                      className={`border-b border-dotted border-current font-semibold underline-offset-2 transition hover:opacity-70 ${r.vals[i] < 0 ? "text-danger" : "text-ink dark:text-[#f4f1ea]"}`}
                      title="Show the receipts behind this figure"
                    >{n0(r.vals[i])}</button>
                  )
                  : <span className="text-hint dark:text-[#6f675c]">·</span>,
              })),
              { head: "Total", right: true, bold: true, cell: (r) => (r.total ? n0(r.total) : "") },
            ];
            const footer = (
              <tr className="bg-panel/70 text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                <td className="px-4 py-3 text-[12.5px] font-bold">Total</td>
                {blk.colTot.map((v, i) => <td key={i} className="px-4 py-3 text-right text-[12.5px] font-bold tabular-nums">{money(v)}</td>)}
                <td className="px-4 py-3 text-right text-[12.5px] font-extrabold tabular-nums">{money(blk.grand)}</td>
              </tr>
            );
            return (
              <section key={blk.chain} className="mt-7">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{blk.chain}</h2>
                  <span className="text-[13px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{money(blk.grand)}</span>
                </div>
                <DataTable cols={cols} rows={blk.rows} loading={loading} minWidth={Math.max(560, 190 + blk.brs.length * 108)}
                  empty="Pick a date range to see the days." footer={footer} />
              </section>
            );
          })}

          {!loading && blocks.length === 0 && (
            <p className="mt-6 text-center text-[13px] text-muted dark:text-[#a89f93]">No shops to show for this chain filter.</p>
          )}

          <SourceNote>
            Per-piece is <strong>retail price × percentage ÷ 100 × quantity</strong> from{" "}
            <code>retail_commission_master</code>. The <code>commission</code> column on that table
            is printed on the rate sheet and is <strong>never</strong> multiplied into a payout — paying it
            instead would pay a different number from the one the shops agreed to.{" "}
            {dhaBranch
              ? <><strong>{dhaBranch.name}</strong> is paid from the flat per-barcode sheet only: an unlisted barcode
                earns Rs 0, and because its lines never reach a receipt or day total it <strong>never earns a bonus</strong>.</>
              : <>No Fashion Collection DHA branch was found in <code>retail_branches</code>, so every shop is on the master rate.</>}{" "}
            {/* SAID OUT LOUD, because not saying it cost Top Shop DHA Rs 64,931.
                Any other shop with DHA in its name is on the master rate like
                everybody else, and this names it so nobody has to guess which
                DHA a figure belongs to. */}
            {otherDha.length > 0 && (
              <><strong>{otherDha.map((b) => b.name).join(", ")}</strong>{" "}
              {otherDha.length === 1 ? "has" : "have"} DHA in the name but {otherDha.length === 1 ? "is" : "are"} not
              the flat-sheet shop — {otherDha.length === 1 ? "it is" : "they are"} paid the master percentage and
              {otherDha.length === 1 ? " earns" : " earn"} the bonus, like every other shop.{" "}</>
            )}
            The bonus slabs <strong>rupees</strong> — {money(cfg.bonus_per_slab)} per {money(cfg.bonus_slab)} of sales,
            {cfg.bonus_basis === "day" ? " on the day's total" : " on each receipt"} — never a receipt count.
            Each cell is <code>Math.round(per-piece + bonus)</code>, added up by the database
            (<code>retail_commission_calc</code>) rather than in this browser, so no figure here is a lower bound.
          </SourceNote>
        </>
      )}

      {/* ══ ITEM RATES ════════════════════════════════════════════════════ */}
      {tab === "rates" && (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12.5px] text-muted dark:text-[#a89f93]">
              {master.length.toLocaleString()} items{q && ` · ${filteredMaster.length.toLocaleString()} matching`}
            </div>
            {/* Full width on a phone: a 192px field inside a 358px row leaves a
                dead strip you keep tapping by mistake. */}
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 max-md:w-full dark:border-white/10 dark:bg-white/[0.05]">
              <Search size={15} className="flex-none text-hint dark:text-[#8a8175]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or name"
                className="w-48 bg-transparent text-[13px] outline-none placeholder:text-hint max-md:w-full max-md:flex-1 dark:text-[#f4f1ea] dark:placeholder:text-[#6f675c]" />
            </div>
          </div>
          <DataTable cols={rateCols} rows={filteredMaster.slice(0, 600)} loading={refLoading} minWidth={880}
            empty="No item rates yet — add one, or import a Commission Master CSV."
            onRowTap={editRate} />
          {filteredMaster.length > 600 && (
            <p className="mt-2 text-[12px] text-hint dark:text-[#8a8175]">
              Showing the first 600 of {filteredMaster.length.toLocaleString()} — search for a specific code.
            </p>
          )}
          <SourceNote>
            <strong>Earns / piece</strong> is what actually gets paid: retail price × percentage.
            <strong> Comm. column</strong> is the figure the rate sheet prints; it is stored, shown and edited here for
            reference and no calculation reads it. A new item with a blank percentage is saved at 5%.
          </SourceNote>
        </>
      )}

      {/* ══ FC DHA ════════════════════════════════════════════════════════ */}
      {tab === "fcdha" && (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted dark:text-[#a89f93]">
              <span>{fc.length.toLocaleString()} barcodes{q && ` · ${filteredFc.length.toLocaleString()} matching`}</span>
              {dhaBranch
                ? <Pill tone="info">{dhaBranch.name} · id {dhaBranch.id}</Pill>
                : <Pill tone="bad">no DHA branch found</Pill>}
              {/* The old pill counted every branch matching "DHA" and said
                  nothing about which one was chosen — it was showing "2
                  branches match" while Top Shop DHA quietly held the sheet.
                  It names them now, and says they are on the master rate. */}
              {otherDha.map((b) => (
                <Pill key={b.id} tone="warn">{b.name} · master rate</Pill>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 max-md:w-full dark:border-white/10 dark:bg-white/[0.05]">
              <Search size={15} className="flex-none text-hint dark:text-[#8a8175]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search barcode"
                className="w-48 bg-transparent text-[13px] outline-none placeholder:text-hint max-md:w-full max-md:flex-1 dark:text-[#f4f1ea] dark:placeholder:text-[#6f675c]" />
            </div>
          </div>

          {/* Stale rates. Barcodes still on the sheet that have earned nothing
              for three months are dead weight: they make the sheet unreadable
              and hide the articles that are actually selling. */}
          {stale && stale.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-amber/30 bg-amber-soft p-4 dark:border-amber/30 dark:bg-amber/10">
              <AlertTriangle size={17} className="flex-none text-amber-strong dark:text-amber" />
              <p className="flex-1 text-[13px] text-ink dark:text-[#e7e2d8]">
                <strong>{stale.length}</strong> barcode{stale.length > 1 ? "s have" : " has"} earned no commission at{" "}
                {dhaBranch?.name ?? "FC DHA"} in the last 3 months.
              </p>
              <button onClick={() => { setStaleSel([]); setStaleOpen(true); }} className={`${btnGhost} max-md:w-full`}>Review &amp; clean up</button>
            </div>
          )}

          {/* NOT A CLEANUP — A WIRING FAULT. Nothing is offered for deletion
              when the whole sheet looks stale, because that is what it looked
              like when the sheet was being compared against the wrong shop. */}
          {wholeSheetStale && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-danger/30 bg-danger-soft p-4">
              <AlertTriangle size={17} className="flex-none text-danger" />
              <p className="flex-1 text-[13px] text-ink dark:text-[#e7e2d8]">
                <strong>Every barcode on this sheet looks unsold.</strong> That almost always means the
                sheet is being measured against the wrong shop rather than that the whole agreement
                has lapsed, so nothing is being offered for deletion. Check that{" "}
                <strong>{dhaBranch?.name ?? "the flat-rate shop"}</strong> is the shop this sheet belongs to.
              </p>
            </div>
          )}

          <DataTable cols={fcCols} rows={filteredFc.slice(0, 600)} loading={refLoading} minWidth={560}
            empty="No FC DHA barcodes yet — add one, or import the DHA rate sheet."
            onRowTap={editDha} />
          {filteredFc.length > 600 && (
            <p className="mt-2 text-[12px] text-hint dark:text-[#8a8175]">
              Showing the first 600 of {filteredFc.length.toLocaleString()} — search for a specific barcode.
            </p>
          )}
          <SourceNote>
            FC DHA is paid a flat amount per barcode, not a percentage. A barcode that is not on this
            sheet earns <strong>Rs 0</strong> at DHA — there is deliberately no fallback to the Top Shop
            master, because DHA&apos;s agreement is this sheet. DHA sales also never enter a receipt or day
            total, so DHA never earns the slab bonus.
          </SourceNote>
        </>
      )}

      {/* ══ SETTINGS ══════════════════════════════════════════════════════ */}
      {tab === "settings" && (
        <div className="mt-5 max-w-2xl rounded-card border border-line bg-surface p-6 max-md:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
          <h2 className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Bonus rules</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted dark:text-[#a89f93]">
            The bonus is slabbed on <strong>rupees of sales</strong>, on top of the per-piece rate. It is
            never a count of receipts — {money(cfg.bonus_per_slab)} per {money(cfg.bonus_slab)} of sales is the
            rule, and feeding the slab a receipt count would mean a shop needed {num(cfg.bonus_slab).toLocaleString()} bills
            to earn {money(cfg.bonus_per_slab)}.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Bonus basis">
              <select value={cfg.bonus_basis ?? "receipt"} onChange={(e) => setCfg({ ...cfg, bonus_basis: e.target.value })} className={inputCls}>
                <option value="receipt">Per receipt</option>
                <option value="day">Per shop-day</option>
              </select>
            </Field>
            <Field label="Slab mode">
              <select value={cfg.bonus_mode ?? "floor"} onChange={(e) => setCfg({ ...cfg, bonus_mode: e.target.value })} className={inputCls}>
                <option value="floor">Floor — every completed slab</option>
                <option value="exact">Exact — only exact multiples</option>
              </select>
            </Field>
            {/* inputMode="decimal" gives the phone's number pad instead of the
                full keyboard. Rupee fields get it everywhere on these two
                screens — it is the difference between two taps and six. */}
            <Field label="Slab size (Rs of sales)">
              <input type="number" inputMode="decimal" value={String(cfg.bonus_slab ?? "")} onChange={(e) => setCfg({ ...cfg, bonus_slab: Number(e.target.value) })} className={inputCls} />
            </Field>
            <Field label="Bonus per slab (Rs)">
              <input type="number" inputMode="decimal" value={String(cfg.bonus_per_slab ?? "")} onChange={(e) => setCfg({ ...cfg, bonus_per_slab: Number(e.target.value) })} className={inputCls} />
            </Field>
          </div>

          <div className="mt-5 space-y-2.5 rounded-xl2 border border-line bg-panel/60 px-3.5 py-3 text-[12px] leading-relaxed text-muted dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[#a89f93]">
            <p><strong className="text-ink dark:text-[#e7e2d8]">Per receipt</strong> runs the slab on each bill and adds the results up over the day —
              a shop with two Rs 5,000 bills earns two bonuses. <strong className="text-ink dark:text-[#e7e2d8]">Per shop-day</strong> runs it once on the
              day&apos;s whole sales total, so how the sales were split across bills makes no difference.</p>
            <p><strong className="text-ink dark:text-[#e7e2d8]">Floor</strong> pays every completed slab: Rs 12,400 of sales at a Rs 5,000 slab pays two.
              <strong className="text-ink dark:text-[#e7e2d8]"> Exact</strong> pays only when the total is an exact multiple — Rs 10,000 pays two, Rs 12,400 pays
              nothing. It looks like a bug and is not; it is a rule some shops run, and floor would overpay them on every bill that lands between slabs.</p>
            <p>There is no &ldquo;per sales amount&rdquo; basis and no &ldquo;round nearest&rdquo; mode. Both were invented by an earlier
              version of this screen; the formula cannot read either, so offering them only let somebody switch the bonus off by accident.</p>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button onClick={saveCfg} className={btnPrimary}><Save size={14} /> Save rules</button>
            {savedCfg === "saved" && <span className="text-[13px] font-semibold text-success">Saved</span>}
            {savedCfg === "saving" && <span className="text-[13px] text-muted dark:text-[#a89f93]">Saving…</span>}
            {savedCfg === "error" && <span className="text-[13px] font-semibold text-danger">Couldn&apos;t save</span>}
          </div>
        </div>
      )}

      {/* ══ DRILL-DOWN ════════════════════════════════════════════════════ */}
      <Modal open={!!drill} onClose={() => setDrill(null)} wide
        title={drill ? `${drill.name} — ${drill.ds}` : ""}
        subtitle="Receipt by receipt. This is the audit trail behind that figure.">
        <DataTable cols={drillCols} rows={drillRows ?? []} loading={drillRows === null} minWidth={640}
          empty="No commission earned on this day."
          /* Two cells on a phone. The kit keeps this row when the table becomes
             cards — it is the figure the day is being checked against — but four
             cells of padding plus two rupee totals is wider than a 390px dialog,
             and the box clips instead of scrolling, so the commission total
             would be the part cut off. */
          footer={phone ? (
            <tr className="bg-panel/70 text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
              <td className="px-3.5 py-3 text-[12.5px] font-bold">
                {(drillRows ?? []).length} bill{(drillRows ?? []).length === 1 ? "" : "s"} · {money((drillRows ?? []).reduce((a, r) => a + r.total, 0))}
              </td>
              <td className="px-3.5 py-3 text-right text-[12.5px] font-extrabold tabular-nums">{money((drillRows ?? []).reduce((a, r) => a + r.comm, 0))}</td>
            </tr>
          ) : (
            <tr className="bg-panel/70 text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
              <td className="px-4 py-3 text-[12.5px] font-bold">{(drillRows ?? []).length} bill{(drillRows ?? []).length === 1 ? "" : "s"}</td>
              <td className="px-4 py-3 text-right text-[12.5px] font-bold tabular-nums">{money((drillRows ?? []).reduce((a, r) => a + r.total, 0))}</td>
              <td />
              <td className="px-4 py-3 text-right text-[12.5px] font-extrabold tabular-nums">{money((drillRows ?? []).reduce((a, r) => a + r.comm, 0))}</td>
            </tr>
          )} />
        <p className="mt-3 text-[12px] leading-relaxed text-muted dark:text-[#a89f93]">
          Receipts that earned nothing are left out. <strong>Commission</strong> is this bill&apos;s per-piece total
          {cfg.bonus_basis === "receipt" ? " plus its slab bonus" : ""}, rounded — the day figure in the grid is the sum of these
          {cfg.bonus_basis === "day" ? ", plus one slab bonus on the day's sales total" : ""}.
        </p>
        <div className="mt-4 flex justify-end"><button onClick={() => setDrill(null)} className={`${btnGhost} max-md:w-full`}>Close</button></div>
      </Modal>

      {/* ══ ITEM RATE EDITOR ══════════════════════════════════════════════ */}
      <Modal open={!!rateForm} onClose={() => setRateForm(null)}
        title={rateForm?.isEdit ? "Edit commission item" : "Add commission item"}
        subtitle="What gets paid is retail price × percentage × quantity.">
        {rateForm && (
          <div className="space-y-3.5">
            {/* One field per row on a phone. Two 16px inputs side by side in a
                310px dialog leaves ~140px each, which is not enough to see what
                you typed into a price. */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Item code">
                <input value={rateForm.item_code} readOnly={rateForm.isEdit}
                  onChange={(e) => setRateForm({ ...rateForm, item_code: e.target.value })}
                  className={`${inputCls} ${rateForm.isEdit ? "opacity-60" : ""}`} autoFocus={!rateForm.isEdit} />
              </Field>
              <Field label="Retail price">
                <input type="number" inputMode="decimal" value={rateForm.retail_price} onChange={(e) => setRateForm({ ...rateForm, retail_price: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <Field label="Item name">
              <input value={rateForm.item_name} onChange={(e) => setRateForm({ ...rateForm, item_name: e.target.value })} className={inputCls} />
            </Field>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Percentage (this is what pays)">
                <input type="number" inputMode="decimal" value={rateForm.percentage} onChange={(e) => setRateForm({ ...rateForm, percentage: e.target.value })} className={inputCls} placeholder="5" />
              </Field>
              <Field label="Commission column (reference only)">
                <input type="number" inputMode="decimal" value={rateForm.commission} onChange={(e) => setRateForm({ ...rateForm, commission: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <p className="rounded-xl2 border border-line bg-panel/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[#a89f93]">
              This item earns <strong className="text-ink dark:text-[#e7e2d8]">{money(num(rateForm.retail_price) * ((num(rateForm.percentage) || 5) / 100))}</strong> per piece.
              The commission column is stored for the printed rate sheet and never enters a payout. A blank percentage saves as 5%.
            </p>
            {/* Three buttons at 390px: each takes an equal share of the row and
                the shared phone CSS already gives everything in a dialog 44px. */}
            <div className="flex flex-wrap justify-end gap-2 pt-1 max-md:[&>*]:flex-1">
              {rateForm.isEdit && (
                <button onClick={() => deleteRate(rateForm.item_code)} disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger transition hover:opacity-90 disabled:opacity-50 dark:border-danger/30 dark:bg-danger/10">
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button onClick={() => setRateForm(null)} className={btnGhost}>Cancel</button>
              <button onClick={saveRate} disabled={saving} className={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ══ FC DHA EDITOR ═════════════════════════════════════════════════ */}
      <Modal open={!!dhaForm} onClose={() => setDhaForm(null)}
        title={dhaForm?.isEdit ? "Edit FC DHA rate" : "Add FC DHA rate"}
        subtitle="A flat amount per barcode. Not on this sheet means Rs 0 at DHA.">
        {dhaForm && (
          <div className="space-y-3.5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Barcode">
                <input value={dhaForm.item_code} readOnly={dhaForm.isEdit}
                  onChange={(e) => setDhaForm({ ...dhaForm, item_code: e.target.value })}
                  className={`${inputCls} ${dhaForm.isEdit ? "opacity-60" : ""}`} autoFocus={!dhaForm.isEdit} />
              </Field>
              <Field label="Commission (Rs per piece)">
                <input type="number" inputMode="decimal" value={dhaForm.commission} onChange={(e) => setDhaForm({ ...dhaForm, commission: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-1 max-md:[&>*]:flex-1">
              {dhaForm.isEdit && (
                <button onClick={() => deleteDha(dhaForm.item_code)} disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger transition hover:opacity-90 disabled:opacity-50 dark:border-danger/30 dark:bg-danger/10">
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button onClick={() => setDhaForm(null)} className={btnGhost}>Cancel</button>
              <button onClick={saveDha} disabled={saving} className={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ══ STALE FC DHA CLEAN-UP ═════════════════════════════════════════ */}
      <Modal open={staleOpen} onClose={() => setStaleOpen(false)} wide
        title={`Stale FC DHA rates — ${(stale ?? []).length}`}
        subtitle="On the rate sheet, but earned nothing at DHA in the last 3 months.">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">
            <input type="checkbox"
              checked={(stale ?? []).length > 0 && staleSel.length === (stale ?? []).length}
              onChange={(e) => setStaleSel(e.target.checked ? (stale ?? []).map((r) => String(r.item_code)) : [])}
              className="h-4 w-4 accent-current" />
            Select all
          </label>
          <span className="text-[12.5px] text-muted dark:text-[#a89f93]">{staleSel.length} selected</span>
          {/* Both delete buttons take half the row on a phone instead of
              trailing off the edge of a 358px dialog. */}
          <div className="ml-auto flex gap-2 max-md:ml-0 max-md:w-full max-md:[&>*]:flex-1">
            <button disabled={staleBusy || !staleSel.length}
              onClick={() => { if (window.confirm(`Delete ${staleSel.length} barcode(s) from the FC DHA rate sheet?`)) deleteCodes(staleSel); }}
              className="flex items-center justify-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger transition hover:opacity-90 disabled:opacity-40 dark:border-danger/30 dark:bg-danger/10">
              <Trash2 size={14} /> Delete selected
            </button>
            <button disabled={staleBusy || !(stale ?? []).length}
              onClick={() => { const all = (stale ?? []).map((r) => String(r.item_code)); if (window.confirm(`Delete ALL ${all.length} stale barcodes? This cannot be undone.`)) deleteCodes(all); }}
              className="flex items-center justify-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger transition hover:opacity-90 disabled:opacity-40 dark:border-danger/30 dark:bg-danger/10">
              <Trash2 size={14} /> Delete all
            </button>
          </div>
        </div>
        {/* THE AUTOMATIC CARD IS WRONG FOR THIS ONE. Its first plain column is
            the tick box, so the card title would be a bare checkbox and the big
            right-hand figure would be the delete button.

            So the phone card is the standard select-a-row pattern instead: the
            whole row is the tick box's label, and the per-row trash can is left
            off deliberately. On a computer it deletes a rate with no
            confirmation, which is fine beside a mouse pointer and is a mis-tap
            next to a thumb-sized label. Select the row and use Delete selected,
            which does confirm — same capability, one deliberate step. */}
        <DataTable cols={staleCols} rows={stale ?? []} loading={staleBusy} minWidth={620}
          empty="Nothing stale — every barcode on the sheet has sold recently."
          card={(r) => {
            const code = String(r.item_code);
            const on = staleSel.includes(code);
            return (
              <label className={`flex items-center gap-3 rounded-card border bg-surface p-3.5 dark:bg-[#201c17] ${on ? "border-ink dark:border-white/40" : "border-line dark:border-white/[0.06]"}`}>
                <input type="checkbox" checked={on}
                  onChange={(e) => setStaleSel((s) => e.target.checked ? [...s, code] : s.filter((x) => x !== code))}
                  className="h-5 w-5 flex-none accent-current" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{code}</span>
                  <span className="block truncate text-[12.5px] text-muted dark:text-[#a89f93]">
                    {money(r.commission)} per piece · {r.last_sold ? `last sold ${r.last_sold}` : "never sold"}
                  </span>
                </span>
              </label>
            );
          }} />
        <p className="mt-3 text-[12px] leading-relaxed text-muted dark:text-[#a89f93]">
          Deleting a barcode only removes its rate; the sales history stays. Removals go 100 at a time because a
          delete that lists thousands of barcodes builds a URL the server refuses.
        </p>
        <div className="mt-4 flex justify-end"><button onClick={() => setStaleOpen(false)} className={`${btnGhost} max-md:w-full`}>Close</button></div>
      </Modal>

      <PreviewNote />
    </Shell>
  );
}
