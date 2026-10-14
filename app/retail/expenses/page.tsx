"use client";
/* Expenses & income — the three-level drill-down, ported from the Grohub app.
 *
 * WHY ONE SCREEN FOR BOTH
 *   A shop's day produces a handful of outgoings and, occasionally, money
 *   coming in that is not a sale: a refund from a supplier, a deposit returned.
 *   Splitting them into two screens means the second one is opened twice a
 *   month and forgotten, and the cash book then disagrees with the till by an
 *   amount nobody can find.
 *
 * WHY THREE LEVELS AND NOT ONE FLAT TABLE
 *   A month across nine shops is a few thousand rows. Flat, that is a list
 *   nobody reads and a total nobody can take apart. The question people
 *   actually arrive with is always the same shape — "which shop, and paid with
 *   what?" — so the screen answers it in that order:
 *     1. STORES        one row per branch, grouped under its chain
 *     2. PAYMENT METHOD one tile per paid_via for the chosen branch
 *     3. TRANSACTIONS   the rows behind that one tile, editable
 *   Every figure is one tap from the rows that make it up, which is the only
 *   reason anybody believes a total.
 *
 * NET IS EXPENSES MINUS INCOME — NOT THE OTHER WAY ROUND
 *   This screen is about what the shops SPEND. `income` here is the occasional
 *   non-sale receipt, not turnover. So a positive Net means "money went out",
 *   which is the normal case and how the old app read it. Computing
 *   `income - expenses` instead flips the sign on a card labelled "Net": a
 *   normal month reads as a large negative number, and the one month that
 *   actually reads positive is the month somebody should be worried about.
 *   Every Net on this page is expenses − income. There are no exceptions.
 *
 * NIMBUS ROWS ARE READ-ONLY
 *   Rows with source='nimbus' came from the POS import and carry a dedupe_key.
 *   The import clears and re-writes exactly the ground it covers, so an edit
 *   made here would be silently reverted at the next import. Change it in
 *   Nimbus and re-import. Manual rows are fully editable.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NotebookPen, Plus, ArrowUpRight, ArrowDownRight, Scale, ChevronLeft, ChevronRight,
  Pencil, Banknote, Smartphone, CreditCard, Landmark, MoreHorizontal, TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { rangeDates } from "@/lib/dateRange";
import {
  RetailRange,
  Shell, PageHeader, StatCards, DataTable, Pill, ImportButton, PreviewNote, SourceNote,
  CardList, RowCard, useIsPhone,
  useBranches, money, num, text, today, fetchAll, type Col,
} from "@/components/retail/kit";
import { ImportPanel } from "@/components/retail/ImportPanel";
import { useShopScope } from "@/lib/retailShop";

type Exp = {
  id: number;
  branch_id: number | null;
  expense_date: string | null;
  category: string | null;
  description: string | null;
  amount: number | null;
  paid_via: string | null;
  txn_type: string | null;
  source: string | null;
};

/* The order is fixed and deliberately NOT "biggest first": the tiles sit in the
   same place every day, so the eye learns where Cash is and stops reading. It
   mirrors the retail_expenses.paid_via check constraint exactly. */
const PAID_ORDER = ["cash", "jazzcash", "meezan_card", "bank", "other"];
const PAID_LABEL: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", meezan_card: "Card", bank: "Bank", other: "Other",
};
const PAID_ICON: Record<string, LucideIcon> = {
  cash: Banknote, jazzcash: Smartphone, meezan_card: CreditCard, bank: Landmark, other: MoreHorizontal,
};
/* A colour per method, so a tile is recognisable before it is read. Palette
   tokens only — the old app's raw hexes do not survive dark mode. */
const PAID_EDGE: Record<string, string> = {
  cash: "border-l-success", jazzcash: "border-l-salmon-strong",
  meezan_card: "border-l-periwinkle-strong", bank: "border-l-lavender-strong",
  other: "border-l-hint",
};

/** Level 3's pseudo-method. Misc income has no paid_via worth splitting on —
 *  it is a handful of rows a month — so it gets one tile of its own. */
const INCOME_KEY = "__income__";

/** Anything outside the five known methods is shown as Other rather than
 *  dropped. The old app filtered the tile list to the known keys, which meant
 *  a row with an unexpected paid_via vanished from the drill-down while still
 *  counting in the total above it — a branch whose tiles do not add up. */
const payKey = (v: unknown) => (PAID_ORDER.includes(String(v)) ? String(v) : "other");

type Agg = { exp: number; inc: number; n: number };
const ZERO: Agg = { exp: 0, inc: 0, n: 0 };
const addTo = (g: Agg, r: Exp): Agg => ({
  exp: g.exp + (String(r.txn_type) === "income" ? 0 : num(r.amount)),
  inc: g.inc + (String(r.txn_type) === "income" ? num(r.amount) : 0),
  n: g.n + 1,
});

type L1Row =
  | { kind: "chain"; key: string; label: string; g: Agg }
  /** `indent` is set only for a store that sits under a chain heading, so the
   *  rows that have no heading above them are not indented under nothing. */
  | { kind: "store"; key: string; label: string; g: Agg; id: string; indent: boolean };

const blankForm = () => ({
  id: null as number | null,
  branch_id: "",
  expense_date: today(),
  txn_type: "expense",
  category: "",
  description: "",
  amount: "",
  paid_via: "cash",
});

export default function ExpensesPage() {
  const { branches, branchName } = useBranches();
  const phone = useIsPhone();

  /* THE SHOP comes from the menu and is shared with every other screen, so
     arriving from "FC DHA ▸ Expenses" lands on FC DHA. */
  const shop = useShopScope(branches);

  /* These two pieces of state ARE the three levels:
       branch === null                → level 1, all stores
       branch !== null && pm === null → level 2, payment methods for that store
       branch !== null && pm !== null → level 3, the transactions behind a tile
     `branch` is a branch id as a string, or the literal "none" for the rows
     with branch_id IS NULL.

     It is derived from the shop, with ONE local addition: "none" — the
     business-wide rows that belong to no branch at all. The shop model has no
     word for that and should not grow one, so it lives here, and choosing any
     real shop clears it. */
  const [unassigned, setUnassigned] = useState(false);
  /* THE UPLOADER, OPENED FROM THIS SCREEN. No separate Import page: a file goes
     in while you are looking at the figures it changes. */
  const [importOpen, setImportOpen] = useState(false);
  /* Choosing a shop overrides the unassigned view rather than fighting it:
     those rows belong to no branch, so they are not inside any shop. */
  const branch: string | null = unassigned && !shop.key ? "none" : (shop.single || null);
  const setBranch = useCallback((v: string | null) => {
    setUnassigned(v === "none");
    if (v === "none") return;
    if (v === null) shop.back(); else shop.set(v);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [shop.key]);
  const [pm, setPm] = useState<string | null>(null);

  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [rows, setRows] = useState<Exp[]>([]);
  const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fErr, setFErr] = useState("");
  const [form, setForm] = useState(blankForm);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.from("retail_expense_categories").select("id,name").eq("active", true).order("sort_order")
      .then(({ data }) => setCats((data as { id: number; name: string }[]) ?? []));
  }, []);

  /* One fetch for the whole range, then every level is a filter over it in the
     browser. Drilling in and back out is instant and costs nothing, which is
     the difference between a drill-down people use and one they avoid. */
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const db = supabase;
    setLoading(true); setErr("");
    const [from, to] = rangeDates(preset, cf, ct);
    /* Paged, NOT .limit(1000). PostgREST caps a response at 1000 rows and a
       bigger .limit() does not raise that cap — it silently returns less. The
       stat cards at the top are sums of exactly these rows, so a truncated
       fetch is a wrong total that looks entirely plausible, and nobody checks
       a plausible number. Ordered by id because an unordered .range() may
       repeat or skip rows between pages. */
    const { rows: got, error } = await fetchAll<Exp>((lo, hi) => {
      let q = db.from("retail_expenses")
        .select("id,branch_id,expense_date,category,description,amount,paid_via,txn_type,source");
      /* Scoped to the chosen shop, so the stat cards above the table are that
         shop's spend and not the whole business's. Top Shop is six branches,
         hence .in() rather than .eq(). */
      if (shop.ids) q = q.in("branch_id", shop.ids);
      if (from) q = q.gte("expense_date", from);
      if (to) q = q.lte("expense_date", to);
      return q.order("id", { ascending: true }).range(lo, hi);
    });
    if (error) setErr(error);
    setRows(got);
    setLoading(false);
  }, [preset, cf, ct, shop.key]);
  useEffect(() => { load(); }, [load]);

  /* ── level 1: stores, grouped under chains ─────────────────────────────── */

  /* Only the shop you are in: with Top Shop chosen this is its chain alone,
     so the table cannot list Fashion Collection at zero underneath. */
  const inScope = useCallback(
    (b: { id: number }) => !shop.ids || shop.ids.includes(b.id),
    [shop.ids]);
  const chains = useMemo(
    () => [...new Set(branches.filter(inScope).map((b) => String(b.chain ?? "")).filter(Boolean))],
    [branches, inScope]
  );
  /* Chain headings only earn their row when there is more than one chain.
     A single-chain business does not need to be told it has one chain. */
  const multiChain = chains.length > 1;

  const byBranch = useMemo(() => {
    const m = new Map<string, Agg>();
    rows.forEach((r) => {
      const k = r.branch_id == null ? "none" : String(r.branch_id);
      m.set(k, addTo(m.get(k) ?? ZERO, r));
    });
    return m;
  }, [rows]);

  const l1: L1Row[] = useMemo(() => {
    const out: L1Row[] = [];
    const seen = new Set<string>();
    chains.forEach((ch) => {
      const stores = branches
        .filter((b) => inScope(b) && String(b.chain ?? "") === ch && byBranch.has(String(b.id)))
        .map((b) => ({ id: String(b.id), label: b.name, g: byBranch.get(String(b.id)) ?? ZERO }))
        /* Sorted by EXPENSE descending: the shop spending the most is the one
           worth looking at first, and alphabetical order buries it. */
        .sort((a, b) => b.g.exp - a.g.exp);
      if (!stores.length) return;
      if (multiChain) {
        const g = stores.reduce<Agg>(
          (t, s) => ({ exp: t.exp + s.g.exp, inc: t.inc + s.g.inc, n: t.n + s.g.n }), ZERO);
        out.push({ kind: "chain", key: "c:" + ch, label: ch, g });
      }
      stores.forEach((s) => {
        seen.add(s.id);
        out.push({ kind: "store", key: "b:" + s.id, label: s.label, g: s.g, id: s.id, indent: multiChain });
      });
    });
    /* Anything the chain walk above did not reach still gets a row. A branch
       with no chain, one deleted from retail_branches after its expenses were
       filed, or simply the half-second before useBranches() answers — the old
       app iterated the branch list and let those rows fall out of the table
       while they kept counting in the total underneath it, which is a table
       whose own footer disagrees with it. */
    [...byBranch.keys()]
      .filter((k) => k !== "none" && !seen.has(k))
      .sort((a, b) => (byBranch.get(b)?.exp ?? 0) - (byBranch.get(a)?.exp ?? 0))
      .forEach((k) => out.push({
        kind: "store", key: "b:" + k, id: k, g: byBranch.get(k) ?? ZERO, indent: false,
        label: branchName(k) === "—" ? `Branch #${k}` : branchName(k),
      }));
    /* Business-wide rows — central rent, a head-office purchase — have no
       branch. They are real money, so they get their own row rather than being
       silently dropped, and they go last so they cannot be read as a shop. */
    const none = byBranch.get("none");
    if (none) out.push({ kind: "store", key: "b:none", label: "General / unassigned", g: none, id: "none", indent: false });
    return out;
  }, [chains, branches, byBranch, multiChain, branchName, inScope]);

  /* ── level 2 & 3: one branch ───────────────────────────────────────────── */

  const branchRows = useMemo(() => {
    if (branch === null) return [];
    return branch === "none"
      ? rows.filter((r) => r.branch_id == null)
      : rows.filter((r) => String(r.branch_id) === branch);
  }, [rows, branch]);

  const branchLabel =
    branch === null ? shop.label : branch === "none" ? "General / unassigned" : branchName(branch);

  const payAgg = useMemo(() => {
    const m = new Map<string, { amt: number; n: number }>();
    branchRows.filter((r) => String(r.txn_type) !== "income").forEach((r) => {
      const k = payKey(r.paid_via);
      const g = m.get(k) ?? { amt: 0, n: 0 };
      m.set(k, { amt: g.amt + num(r.amount), n: g.n + 1 });
    });
    return m;
  }, [branchRows]);

  const branchInc = useMemo(
    () => branchRows.filter((r) => String(r.txn_type) === "income"),
    [branchRows]
  );

  const txnRows = useMemo(() => {
    if (branch === null || pm === null) return [];
    const isInc = pm === INCOME_KEY;
    const out = branchRows.filter((r) =>
      isInc
        ? String(r.txn_type) === "income"
        : String(r.txn_type) !== "income" && payKey(r.paid_via) === pm
    );
    /* Date descending — the newest entry is the one somebody is looking for,
       because it is the one they just typed in or just questioned. */
    return [...out].sort((a, b) =>
      String(b.expense_date ?? "").localeCompare(String(a.expense_date ?? "")));
  }, [branchRows, branch, pm]);

  /* ── the tiles ─────────────────────────────────────────────────────────── */

  /* The stat cards always describe what is on screen: everything at level 1,
     one branch at level 2, one tile's rows at level 3. A header that keeps
     showing the whole-company total while you are three taps deep is a header
     people stop reading. */
  const scope = pm !== null ? txnRows : branch !== null ? branchRows : rows;
  const tot = useMemo(() => {
    const out = scope.filter((r) => String(r.txn_type) !== "income").reduce((t, r) => t + num(r.amount), 0);
    const inn = scope.filter((r) => String(r.txn_type) === "income").reduce((t, r) => t + num(r.amount), 0);
    /* NET = EXPENSES − INCOME. See the header of this file. Do not flip it. */
    return { out, inn, net: out - inn, n: scope.length };
  }, [scope]);

  const stats = [
    { label: "Total expenses", value: money(tot.out), Icon: ArrowUpRight },
    { label: "Misc income", value: money(tot.inn), Icon: ArrowDownRight },
    { label: "Net (expenses − income)", value: money(tot.net), Icon: Scale },
    { label: "Entries", value: tot.n.toLocaleString(), Icon: NotebookPen },
  ];

  /* ── add / edit / delete ───────────────────────────────────────────────── */

  function openAdd() {
    setForm({
      ...blankForm(),
      /* Pre-filled from wherever the user is standing, but NOT forced. The old
         screen made a branch mandatory, which meant a business-wide expense
         could not be entered at all and ended up filed against whichever shop
         happened to be open. "" here means branch_id NULL. */
      branch_id: branch && branch !== "none" ? branch : "",
      category: cats[0]?.name ?? "",
      paid_via: pm && pm !== INCOME_KEY ? pm : "cash",
      txn_type: pm === INCOME_KEY ? "income" : "expense",
    });
    setFErr(""); setOpen(true);
  }

  function openEdit(r: Exp) {
    /* Nimbus rows never open the editor — see remove()/save() for the second
       guard that holds even if this one is bypassed. */
    if (String(r.source) === "nimbus") return;
    setForm({
      id: Number(r.id),
      branch_id: r.branch_id == null ? "" : String(r.branch_id),
      expense_date: String(r.expense_date ?? today()),
      txn_type: String(r.txn_type) === "income" ? "income" : "expense",
      category: String(r.category ?? ""),
      description: String(r.description ?? ""),
      amount: r.amount == null ? "" : String(r.amount),
      paid_via: payKey(r.paid_via),
    });
    setFErr(""); setOpen(true);
  }

  /* FORCE-PREPEND the row's own category when it is not in the standard list.
     Two ways a row gets one: the Nimbus import writes its own names ("Head
     Office", "Purchasing", "Expense"), and a category can be retired from
     retail_expense_categories long after rows were filed against it. Without
     this, opening such a row and pressing Save would quietly rewrite its
     category to whatever happened to be first in the dropdown — a silent
     recategorisation that changes a number on a report and leaves no trace. */
  const catOptions = useMemo(() => {
    const names = cats.map((c) => c.name);
    return form.category && !names.includes(form.category) ? [form.category, ...names] : names;
  }, [cats, form.category]);

  async function save() {
    const amt = Number(form.amount);
    if (!form.expense_date) { setFErr("Pick a date."); return; }
    if (!amt || amt <= 0) { setFErr("Enter an amount above zero."); return; }
    if (!form.category) { setFErr("Pick a category."); return; }
    if (!supabase) { setFErr("Not connected."); return; }
    setSaving(true); setFErr("");
    const rec = {
      /* NULL branch is allowed and meaningful: "All / business-wide". */
      branch_id: form.branch_id ? Number(form.branch_id) : null,
      expense_date: form.expense_date,
      category: form.category,
      description: form.description.trim() || null,
      amount: amt,
      paid_via: form.paid_via,
      txn_type: form.txn_type,
    };
    const { error } =
      form.id == null
        ? await supabase.from("retail_expenses").insert({
            ...rec,
            source: "manual",
            /* No dedupe_key on a manual row, deliberately. Two identical Rs 500
               tea expenses on the same day are two real expenses; the partial
               unique index only covers source='nimbus' for exactly that. */
          })
        /* .eq("source","manual") is the second guard on the Nimbus rule: even
           if something bypassed the UI, this statement cannot touch an
           imported row. */
        : await supabase.from("retail_expenses").update(rec).eq("id", form.id).eq("source", "manual");
    setSaving(false);
    if (error) { setFErr(error.message); return; }
    setOpen(false);
    load();
  }

  async function remove() {
    if (form.id == null || !supabase) return;
    if (!window.confirm("Delete this entry? This cannot be undone.")) return;
    setSaving(true); setFErr("");
    const { error } = await supabase.from("retail_expenses").delete().eq("id", form.id).eq("source", "manual");
    setSaving(false);
    if (error) { setFErr(error.message); return; }
    setOpen(false);
    load();
  }

  /* ── level 3 columns ───────────────────────────────────────────────────── */

  const isIncomeLevel = pm === INCOME_KEY;
  const txnCols: Col<Exp>[] = [
    { head: "Date", muted: true, cell: (r) => text(r.expense_date) },
    { head: "Category", cell: (r) => text(r.category) },
    {
      head: "Details / note", muted: true,
      cell: (r) => (r.description ? String(r.description) : <span className="text-hint">no note</span>),
    },
    {
      head: "Amount", right: true, bold: true,
      cell: (r) => (
        <span className={isIncomeLevel ? "text-success" : undefined}>
          {isIncomeLevel ? "+" : "−"}{money(r.amount)}
        </span>
      ),
    },
    {
      head: "", right: true,
      cell: (r) =>
        String(r.source) === "nimbus" ? (
          <Pill tone="info">Nimbus</Pill>
        ) : (
          <button onClick={() => openEdit(r)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <Pencil size={13} /> Edit
          </button>
        ),
    },
  ];

  /* ── render ────────────────────────────────────────────────────────────── */

  const crumbChip = "inline-flex items-center rounded-full bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink dark:bg-white/[0.06] dark:text-[#e7e2d8]";
  const backBtn = "inline-flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]";

  return (
    <Shell>
      <PageHeader
        title="Expenses"
        subtitle="Shop outgoings and the money that comes in without being a sale."
        onRefresh={load} loading={loading}
      >
        <ImportButton onClick={() => setImportOpen(true)} />
        <button onClick={openAdd} className={btnPrimary}><Plus size={15} /> New entry</button>
      </PageHeader>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} wide
        title="Import" subtitle="Drop any NimbusRMS export — CSV, Excel or PDF. The file says what it is.">
        <ImportPanel onDone={() => load()} />
      </Modal>

      <RetailRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} />

      {/* The breadcrumb IS the navigation. There is no branch dropdown on this
          screen on purpose: level 1 is the branch picker, and having both means
          two controls that can disagree about which branch you are looking at. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {branch === null ? (
          <span className={crumbChip}>{shop.label}</span>
        ) : (
          <>
            <button onClick={() => { setBranch(null); setPm(null); }} className={backBtn}>
              {/* One step out, not all the way: from one Top Shop branch this
                  goes back to Top Shop, which is where you came from. */}
              <ChevronLeft size={14} /> {unassigned ? "All stores" : shop.backLabel}
            </button>
            {pm === null ? (
              <span className={crumbChip}>{branchLabel}</span>
            ) : (
              <>
                <button onClick={() => setPm(null)} className={backBtn}>
                  <ChevronLeft size={14} /> {branchLabel}
                </button>
                <span className={crumbChip}>
                  {pm === INCOME_KEY ? "Misc income" : PAID_LABEL[pm] ?? pm}
                </span>
              </>
            )}
          </>
        )}
      </div>

      <StatCards stats={stats} loading={loading} />

      {/* ── LEVEL 1 ─────────────────────────────────────────────────────── */}
      {branch === null && (
        <>
          {/* ON A PHONE this five-column 720px table becomes one card per shop.
              It is not just a table: it IS the branch picker, the first thing
              anybody taps on this screen. Dragged sideways to reach the Net
              column, the shop name has scrolled out of sight by the time you
              get there — so you read a number without knowing whose it is.
              Tapping the card drills in, same as tapping the row.
              Above 767.98px the table below renders exactly as it always has. */}
          {phone ? (
            <CardList
              rows={l1} loading={loading} err={err}
              empty="No entries in this range. Import a Nimbus account-transaction file, or add one."
              footer={
                <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-panel/60 px-3.5 py-3 dark:border-white/[0.06] dark:bg-white/[0.04]">
                  <div className="min-w-0">
                    <div className="text-[13px] font-extrabold text-ink dark:text-[#f4f1ea]">All stores</div>
                    <div className="text-[11.5px] text-muted dark:text-[#a89f93]">
                      {rows.length.toLocaleString()} entr{rows.length === 1 ? "y" : "ies"} · net {money(tot.net)}
                    </div>
                  </div>
                  <div className="flex-none text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(tot.out)}</div>
                </div>
              }
              render={(r) =>
                r.kind === "chain" ? (
                  /* A chain stays a heading and not a card, because it is not
                     tappable — dressing it as one invites a tap that does
                     nothing, which is how people decide a screen is broken. */
                  <div key={r.key} className="flex items-baseline justify-between gap-3 px-1 pt-2 text-[12px] font-extrabold uppercase tracking-wide text-hint dark:text-[#8a8175]">
                    <span className="truncate">{r.label}</span>
                    <span className="flex-none tabular-nums">{money(r.g.exp)}</span>
                  </div>
                ) : (
                  <RowCard
                    key={r.key}
                    title={r.label}
                    meta={`${r.g.n.toLocaleString()} entr${r.g.n === 1 ? "y" : "ies"}`}
                    right={money(r.g.exp)}
                    /* Income and Net only earn the space when there IS income:
                       with none, Net equals the figure already on the right, so
                       the pair row would say the same thing twice. */
                    pairs={r.g.inc ? [
                      { k: "Income", v: money(r.g.inc) },
                      /* Net = expenses − income, as everywhere on this screen. */
                      { k: "Net", v: money(r.g.exp - r.g.inc) },
                    ] : undefined}
                    onTap={() => { setBranch(r.id); setPm(null); }}
                  />
                )
              }
            />
          ) : (
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                    <th className="px-4 py-3 font-semibold">Store</th>
                    <th className="px-4 py-3 text-right font-semibold">Entries</th>
                    <th className="px-4 py-3 text-right font-semibold">Expenses</th>
                    <th className="px-4 py-3 text-right font-semibold">Income</th>
                    <th className="px-4 py-3 text-right font-semibold">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                  {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}><td colSpan={5} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>
                    ))
                  ) : err ? (
                    <tr><td colSpan={5} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load: {err}</td></tr>
                  ) : l1.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-16 text-center text-[13px] text-muted dark:text-[#a89f93]">
                      No entries in this range. Import a Nimbus account-transaction file, or add one.
                    </td></tr>
                  ) : (
                    l1.map((r) =>
                      r.kind === "chain" ? (
                        <tr key={r.key} className="bg-periwinkle-soft text-ink dark:bg-white/[0.05] dark:text-[#f4f1ea]">
                          <td className="px-4 py-2.5 font-extrabold">{r.label}</td>
                          <td className="px-4 py-2.5 text-right font-bold tabular-nums">{r.g.n.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right font-bold tabular-nums">{money(r.g.exp)}</td>
                          <td className="px-4 py-2.5 text-right font-bold tabular-nums">{money(r.g.inc)}</td>
                          {/* Net = expenses − income, at every level of this table. */}
                          <td className="px-4 py-2.5 text-right font-extrabold tabular-nums">{money(r.g.exp - r.g.inc)}</td>
                        </tr>
                      ) : (
                        <tr key={r.key} onClick={() => { setBranch(r.id); setPm(null); }}
                          className="cursor-pointer text-ink transition hover:bg-panel/50 dark:text-[#e7e2d8] dark:hover:bg-white/[0.03]">
                          <td className={`px-4 py-3 font-semibold ${r.indent ? "pl-8" : ""}`}>
                            <span className="inline-flex items-center gap-1.5">
                              {r.label}
                              <ChevronRight size={14} className="text-hint" />
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">{r.g.n.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.g.exp)}</td>
                          <td className={`px-4 py-3 text-right tabular-nums ${r.g.inc ? "text-success" : "text-muted dark:text-[#a89f93]"}`}>{money(r.g.inc)}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.g.exp - r.g.inc)}</td>
                        </tr>
                      )
                    )
                  )}
                </tbody>
                {!loading && !err && l1.length > 0 && (
                  <tfoot className="border-t-2 border-line dark:border-white/[0.08]">
                    <tr className="bg-panel/70 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                      <td className="px-4 py-3">All stores</td>
                      <td className="px-4 py-3 text-right tabular-nums">{rows.length.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(tot.out)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(tot.inn)}</td>
                      <td className="px-4 py-3 text-right font-extrabold tabular-nums">{money(tot.net)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
          )}
          <p className="mt-3 text-[12px] text-muted dark:text-[#a89f93]">Tap a store to see how it paid.</p>
        </>
      )}

      {/* ── LEVEL 2 ─────────────────────────────────────────────────────── */}
      {branch !== null && pm === null && (
        <>
          <div className="mt-4 rounded-card border border-line bg-surface p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{branchLabel} — expenses</div>
            <div className="mt-1 text-[24px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">
              {loading ? "—" : money(tot.out)}
            </div>
            <div className="mt-1 text-[12px] text-muted dark:text-[#a89f93]">
              {branchRows.length.toLocaleString()} entr{branchRows.length === 1 ? "y" : "ies"} · net {money(tot.net)} (expenses − income)
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PAID_ORDER.filter((k) => payAgg.has(k)).map((k) => {
              const g = payAgg.get(k) ?? { amt: 0, n: 0 };
              const Icon = PAID_ICON[k] ?? MoreHorizontal;
              return (
                <button key={k} onClick={() => setPm(k)}
                  className={`rounded-card border border-line border-l-[6px] ${PAID_EDGE[k]} bg-surface p-4 text-left transition hover:bg-panel/60 dark:border-white/[0.06] dark:bg-[#201c17] dark:hover:bg-white/[0.04]`}>
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-panel text-ink dark:bg-white/[0.08] dark:text-white"><Icon size={15} /></span>
                    <span className="text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">{PAID_LABEL[k] ?? k}</span>
                  </div>
                  <div className="mt-3 text-[20px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(g.amt)}</div>
                  <div className="mt-1 flex items-center gap-1 text-[11.5px] font-medium text-muted dark:text-[#a89f93]">
                    {g.n.toLocaleString()} entr{g.n === 1 ? "y" : "ies"} · tap to view <ChevronRight size={12} />
                  </div>
                </button>
              );
            })}

            {/* Misc income is not a payment method, so it is not in the fixed
                order — it is its own tile and only appears when there is any. */}
            {branchInc.length > 0 && (
              <button onClick={() => setPm(INCOME_KEY)}
                className="rounded-card border border-line border-l-[6px] border-l-success bg-success-soft p-4 text-left transition hover:opacity-90 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-panel text-ink dark:bg-white/[0.08] dark:text-white"><TrendingUp size={15} /></span>
                  <span className="text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">Misc income</span>
                </div>
                <div className="mt-3 text-[20px] font-extrabold tabular-nums text-success">{money(tot.inn)}</div>
                <div className="mt-1 flex items-center gap-1 text-[11.5px] font-medium text-muted dark:text-[#a89f93]">
                  {branchInc.length.toLocaleString()} entr{branchInc.length === 1 ? "y" : "ies"} · tap to view <ChevronRight size={12} />
                </div>
              </button>
            )}
          </div>

          {!loading && payAgg.size === 0 && branchInc.length === 0 && (
            <p className="mt-6 text-center text-[13px] text-muted dark:text-[#a89f93]">
              Nothing recorded for {branchLabel} in this range.
            </p>
          )}
        </>
      )}

      {/* ── LEVEL 3 ─────────────────────────────────────────────────────── */}
      {branch !== null && pm !== null && (
        <DataTable
          cols={txnCols} rows={txnRows} loading={loading} err={err} minWidth={820}
          empty={`No ${pm === INCOME_KEY ? "misc income" : (PAID_LABEL[pm] ?? pm)} entries for ${branchLabel} in this range.`}
          /* THE AUTOMATIC CARD IS WRONG FOR THIS TABLE, in two ways worth the
             override:
               · It would title the card with the DATE, because that is the
                 first plain column. Nobody looks for an expense by date — they
                 look for "the sign painter" or "tea". The title is therefore
                 what the money was spent on: the note, or the category when
                 there is no note.
               · Expenses and income share this table and are told apart only by
                 txn_type. On the computer that is a + or a − in one column; on
                 a phone a sign alone is a glyph nobody reads, so the direction
                 is also the card's left edge — red out, green in — via `tone`.
             Read from the ROW's own txn_type rather than the tile, so a stray
             income row inside a payment-method tile still shows as income
             instead of inheriting the tile's direction.
             Tapping the card edits it, which is the whole card instead of a
             28px "Edit" pill. Nimbus rows have no tap: they are read-only, and
             the pill says so rather than opening an editor that cannot save. */
          card={(r, i) => {
            const inc = String(r.txn_type) === "income";
            const nimbus = String(r.source) === "nimbus";
            return (
              <RowCard
                key={i}
                title={r.description ? String(r.description) : text(r.category)}
                meta={r.description ? `${text(r.expense_date)} · ${text(r.category)}` : text(r.expense_date)}
                right={<span className={inc ? "text-success" : undefined}>{inc ? "+" : "−"}{money(r.amount)}</span>}
                tone={inc ? "good" : "bad"}
                pills={nimbus ? <Pill tone="info">Nimbus · edit it in Nimbus</Pill> : undefined}
                onTap={nimbus ? undefined : () => openEdit(r)}
              />
            );
          }}
          footer={
            <tr className="bg-panel/70 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
              <td className="px-4 py-3" colSpan={3}>Total · {txnRows.length} entr{txnRows.length === 1 ? "y" : "ies"}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(txnRows.reduce((t, r) => t + num(r.amount), 0))}
              </td>
              <td className="px-4 py-3" />
            </tr>
          }
        />
      )}

      <SourceNote>
        <strong>Net is expenses minus income</strong>, not the other way round — this screen counts what
        the shops spend, and &ldquo;income&rdquo; here is the occasional non-sale receipt, not turnover.
        Rows marked <strong>Nimbus</strong> came from the POS import and cannot be edited or deleted here:
        the next import clears and rewrites exactly the dates it covers, so a change made on this screen
        would be reverted without telling anyone. Fix it in Nimbus and re-import. Manual entries can be
        edited and deleted freely, and may be left branch-less when the money is business-wide.
      </SourceNote>

      <Modal
        open={open} onClose={() => setOpen(false)}
        title={form.id == null ? "New entry" : "Edit entry"}
        subtitle="Expense or income, on one day, for one branch — or for the business as a whole."
      >
        {/* THE DIALOG IS THE SCREEN, on a phone. Everything else here is
            reading; this is the one thing a shop person does standing up, and
            it is done several times a day.
              · ONE COLUMN below 768px (`grid-cols-1 md:grid-cols-2`). Two
                half-width fields at 390px are two 150px controls, and a date
                input that narrow hides its own value.
              · Every picker is a NATIVE <select>, not a styled dropdown: it
                opens as the phone's own wheel, which is the fastest control on
                the device and already thumb-sized. The shared mobile CSS sets
                16px on it so iOS does not zoom the page on focus.
              · The date already defaults to today (blankForm), so the common
                case — an expense being entered as it happens — is no taps.
            Above 767.98px every one of these is the two-column form it was. */}
        <div className="space-y-3.5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Branch">
              <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} className={inputCls}>
                {/* "" → branch_id NULL. Central rent and head-office purchases
                    belong to no shop, and forcing one files them as a lie. */}
                <option value="">All / business-wide</option>
                {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Type">
              <select value={form.txn_type} onChange={(e) => setForm({ ...form, txn_type: e.target.value })} className={inputCls}>
                <option value="expense">Expense — money out</option>
                <option value="income">Income — money in</option>
              </select>
            </Field>
            <Field label="Category">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
                <option value="">Pick a category</option>
                {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Description">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="What it was for" />
          </Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Amount">
              {/* inputMode="decimal" gives the phone's numeric keypad instead of
                  the full QWERTY — the amount is the field that gets typed every
                  single time, and hunting for digits above letters is where the
                  typos come from. type="number" is kept so the computer keeps
                  its spinner and its validation. */}
              <input type="number" step="1" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} autoFocus />
            </Field>
            <Field label="Paid via">
              <select value={form.paid_via} onChange={(e) => setForm({ ...form, paid_via: e.target.value })} className={inputCls}>
                {PAID_ORDER.map((p) => <option key={p} value={p}>{PAID_LABEL[p]}</option>)}
              </select>
            </Field>
          </div>
          {fErr && <p className="text-[12.5px] font-semibold text-danger">{fErr}</p>}
          {/* ON A PHONE the three buttons stack full width, and `flex-col-reverse`
              reverses the DOM order so Save sits on top and Delete at the
              bottom — furthest from the thumb, which is where a button that
              destroys a row belongs. The shared mobile CSS already gives every
              button inside a dialog a 44px minimum height. */}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1 max-md:flex-col-reverse max-md:flex-nowrap max-md:items-stretch max-md:[&>*]:w-full">
            {form.id != null && (
              <button onClick={remove} disabled={saving}
                className="mr-auto flex items-center justify-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger transition hover:opacity-90 disabled:opacity-50 max-md:mr-0 dark:border-white/10 dark:bg-white/[0.06]">
                Delete
              </button>
            )}
            <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? "Saving…" : form.id == null ? "Add entry" : "Save changes"}
            </button>
          </div>
        </div>
      </Modal>

      <PreviewNote />
    </Shell>
  );
}
