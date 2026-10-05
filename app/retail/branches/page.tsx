"use client";
/* BRANCHES — the admin screen for the shops, with their numbers beside them.
 *
 * WHY THIS SCREEN HAS TO BE EDITABLE  (it was a read-only report, and that was
 * a hole with money falling through it)
 *   `nimbus_name` is how the importer resolves a shop: the sales file carries a
 *   store name as free text, the importer normalises it and looks for a branch
 *   whose nimbus_name matches. No match, no branch, and every line for that
 *   store is SKIPPED. The Import screen says so in as many words — "set the
 *   shop's Nimbus name on the Branches screen first" — and until this screen
 *   could write that field there was nowhere to do it. A new shop, or a shop
 *   Nimbus renamed, silently dropped its sales and the only symptom was a
 *   branch that looked quiet.
 *
 * THE NIMBUS NAME IS NORMALISED ON SAVE
 *   Upper-cased, inner whitespace collapsed, trimmed — exactly what normStore
 *   does to the store name coming out of the file, because the importer
 *   compares normStore(file) against normStore(branch) and a value stored as
 *   "Top Shop  Fortress" would never match "TOP SHOP FORTRESS". Blank is
 *   stored as NULL, not as "": the importer tests for a truthy nimbus_name, and
 *   an empty string is a value that looks set and matches nothing.
 *
 * WHY SAVING CLEARS needs_review
 *   The importer auto-creates a branch when it meets a store it cannot resolve,
 *   and flags it needs_review=true. That row is a placeholder: a name guessed
 *   from a spreadsheet, no colour, and a nimbus_name nobody has confirmed. The
 *   flag means "a human has not looked at this yet", so a human looking at it
 *   and saving IS the review — there is no separate approve button, because a
 *   second step people have to remember is a step that stays undone and leaves
 *   the banner up forever. Opening the dialog and cancelling changes nothing.
 *
 * THE PERFORMANCE COLUMNS STAY
 *   Sales, margin, expenses, net and receipts for the chosen period. They are
 *   the per-branch table the Dashboard sends people here for, and taking them
 *   away to make room for admin fields would move a used report to nowhere.
 *
 *   The sale lines used to be PAGED down the wire a thousand at a time and added
 *   up here, for the reason that is still true and still worth knowing:
 *   PostgREST caps a response at 1000 rows and `.limit(5000)` does not raise it
 *   — it just returns what it returns, and a branch's sales total that is
 *   quietly a lower bound is worse than one that errors, because nobody
 *   re-checks a number that looks plausible.
 *
 *   What changed is WHERE the adding happens. This screen only ever wanted five
 *   figures per branch, so it now asks `retail_sales_rollup` for exactly those
 *   and gets one row per shop instead of sixty thousand line items over a
 *   phone's connection. The sums are the same sums — sales_amount, gross_margin,
 *   quantity, and the distinct receipt count the Set was building by hand.
 *   EXPENSES still page, because the roll-up reads sale lines only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, CheckCircle2, AlertTriangle, TrendingUp, Plus, Pencil } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { rangeDates } from "@/lib/dateRange";
import {
  RetailRange,
  Shell, PageHeader, StatCards, DataTable, Pill, PreviewNote, SourceNote,
  money, num, fetchAll, type Row, type Col, type Branch,
} from "@/components/retail/kit";

/** Ported verbatim from normStore in the original, and the same as the copy in
 *  lib/nimbus that the importer uses on the file side. Both sides of the
 *  comparison have to be normalised the same way or nothing ever matches. */
const normStore = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

const BLANK = { name: "", code: "", chain: "", nimbus_name: "", color: "#EBA98F", business: "", active: true };

type Perf = { sales: number; margin: number; qty: number; exp: number; receipts: number };
const EMPTY_PERF: Perf = { sales: 0, margin: 0, qty: 0, exp: 0, receipts: 0 };

/** One row of `retail_sales_rollup` grouped on branch_id. The dimensions that
 *  were not grouped (sale_date, payment_method, salesperson, department) come
 *  back null and this screen has no use for them, so they are not typed here. */
type Rollup = {
  branch_id: number | null;
  sales: number | null; margin: number | null; qty: number | null; receipts: number | null;
};

/* ── the old path, kept as a fallback ────────────────────────────────────────
 * This is what this screen did before migration 0125: page every sale line of
 * the period down the wire a thousand at a time and add them up here. It is slow
 * — upwards of 150,000 rows for "all time" — and that slowness is the whole
 * reason the roll-up exists.
 *
 * It stays because the roll-up can be MISSING: this frontend can be deployed
 * before 0125 has been run against the database, and then the RPC is a 404. That
 * failure used to be written into `err`, which DataTable renders INSTEAD of the
 * rows, so the failure of a turnover column blanked the branch list with it.
 * `nimbus_name` lives on that list, and a shop with no Nimbus name has every one
 * of its lines skipped on every import: the one control that fixes it was being
 * hidden by a column nobody opened the screen to read.
 *
 * It is NOT a way around the permission. retail_sales_rollup returns no rows to a
 * caller holding neither `retail.sales.view` nor `retail.dashboard.view` — no
 * error, so this fallback is not even reached — and 0120's RLS gates
 * retail_sale_lines on the same `retail.sales.view`, so reading the lines by hand
 * would return nothing either. Such a person sees zeroes in the turnover columns
 * and the branch admin they do have permission for, which is the right outcome.
 *
 * It MUST produce the same figures as the roll-up, so every expression here is
 * the one the server computes: Σ sales_amount, Σ gross_margin, Σ quantity, and a
 * distinct receipt count keyed on branch + receipt_txn / receipt_no / id, in that
 * fallback order. It is shaped as Rollup[] on purpose — the screen's `perf` then
 * cannot tell the two producers apart and cannot drift between them.
 */
async function loadPerfByPaging(from: string | null, to: string | null):
  Promise<{ rollup: Rollup[]; err: string; truncated: boolean }> {
  /* Ordered on `id`, like every other paged read in this department: .range() is
     LIMIT/OFFSET over separate requests, and without a unique total order
     Postgres may hand the same row back on two pages or on none — which on this
     screen would double or drop part of a shop's turnover. */
  const { rows, error, truncated } = await fetchAll<Row>((lo, hi) => {
    let q = supabase!.from("retail_sale_lines")
      .select("branch_id,sales_amount,gross_margin,quantity,receipt_txn,receipt_no,id");
    if (from) q = q.gte("sale_date", from);
    if (to) q = q.lte("sale_date", to);
    return q.order("id", { ascending: true }).range(lo, hi);
  });

  const agg: Record<string, Rollup> = {};
  /* One Set per branch, because the server's distinct key carries the branch —
     two shops can print the same receipt number on the same day. */
  const seen: Record<string, Set<string>> = {};
  rows.forEach((r) => {
    const k = String(r.branch_id);
    /* A line with no branch keeps its own bucket under "null", exactly as a
       roll-up row with a null branch_id would — it then matches no shop and is
       ignored by `perf`, rather than being folded into some other shop's total. */
    const a = (agg[k] ||= {
      branch_id: r.branch_id == null ? null : Number(r.branch_id),
      sales: 0, margin: 0, qty: 0, receipts: 0,
    });
    a.sales = num(a.sales) + num(r.sales_amount);
    a.margin = num(a.margin) + num(r.gross_margin);
    a.qty = num(a.qty) + num(r.quantity);
    (seen[k] ||= new Set()).add(String(r.receipt_txn || r.receipt_no || r.id));
  });
  Object.keys(seen).forEach((k) => { agg[k].receipts = seen[k].size; });

  return { rollup: Object.values(agg), err: error, truncated };
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [rollup, setRollup] = useState<Rollup[]>([]);
  const [expenses, setExpenses] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  /* `err` BLANKS THE TABLE — DataTable draws it instead of the rows — so only a
     failure that leaves nothing to draw may be written to it: the branch list
     itself, and the save dialog's own errors. */
  const [err, setErr] = useState("");
  /* A performance figure that could not be loaded is NOT that. The branch list
     loaded, the Nimbus store name is editable, and the admin half of this screen
     works — so the turnover columns say so in a note of their own and the rows
     stay on screen. */
  const [perfErr, setPerfErr] = useState("");
  /* The paged fallback has a 200,000-row ceiling. Crossing it makes the turnover
     columns a lower bound rather than unavailable, which is a different sentence. */
  const [perfCut, setPerfCut] = useState(false);
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr(""); setPerfErr(""); setPerfCut(false);
    const [from, to] = rangeDates(preset, cf, ct);

    /* nimbus_name and needs_review are the point of this screen, so they are
       selected here rather than through the kit's useBranches, which reads the
       short list every screen needs to name a row. */
    const [b, s, e] = await Promise.all([
      supabase.from("retail_branches")
        .select("id,code,name,chain,business,active,color,nimbus_name,needs_review")
        .order("chain").order("name"),
      /* THE SERVER ADDS THE SALES UP. This screen wants five numbers per shop,
         not the lines behind them — so it asks for the five. `p_branch: null` is
         every branch and `p_by: ["branch_id"]` is one row each; every other
         dimension comes back null and is ignored.

         Nothing is computed differently: `sales` is Σ sales_amount, `margin` is
         Σ gross_margin, `qty` is Σ quantity, and `receipts` is the same distinct
         count on branch|receipt_txn/receipt_no/id that the Set here was doing a
         row at a time. */
      supabase.rpc("retail_sales_rollup", {
        p_from: from, p_to: to, p_branch: null, p_by: ["branch_id"],
      }),
      /* Expenses are not in the roll-up — it reads sale lines. So these still
         page, for the PostgREST reason in the note at the top of the file. */
      fetchAll<Row>((a, z) => {
        let q = supabase!.from("retail_expenses").select("branch_id,amount,txn_type");
        if (from) q = q.gte("expense_date", from);
        if (to) q = q.lte("expense_date", to);
        return q.order("id", { ascending: true }).range(a, z);
      }),
    ]);
    /* ONLY THE BRANCH LIST MAY BLANK THIS SCREEN.
       These three failures are not the same failure. Without the branch list there
       is nothing to draw, so that one goes to `err`. Without the roll-up, or
       without the expenses, every ADMIN field is still there and still saveable —
       and `nimbus_name` is the field that decides whether a shop's sales are
       imported at all, so it must not be reachable only on the days a turnover
       column happens to work. */
    if (b.error) setErr(b.error.message);
    setBranches((b.data as Branch[]) ?? []);
    setExpenses(e.rows);

    /* Expenses cost only the Expenses and Net columns, so they never blank
       anything either — they join the performance note. */
    let perfMsg = e.error;
    let cut = e.truncated;

    if (s.error) {
      /* THE ROLL-UP MIGHT NOT BE THERE. 0125 may not have run against this
         database yet, in which case the RPC is a 404. Read the lines the old way
         instead: slow and right beats a Postgres error where the shop list
         should be. */
      const fb = await loadPerfByPaging(from, to);
      cut = cut || fb.truncated;
      /* Only a SECOND failure means there are no sales figures. The roll-up
         erroring is what sent us down this path; the fallback answering means the
         columns are filled and there is nothing to report. A half-read period is
         not a figure, so it is dropped rather than shown as a total. */
      if (fb.err) { setRollup([]); perfMsg = fb.err; } else setRollup(fb.rollup);
    } else {
      setRollup((s.data as Rollup[]) ?? []);
    }

    setPerfErr(perfMsg);
    setPerfCut(cut);
    setLoading(false);
  }, [preset, cf, ct]);
  useEffect(() => { load(); }, [load]);

  const perf = useMemo(() => {
    const m: Record<string, Perf> = {};
    /* `p_by: ["branch_id"]` gives exactly one row per branch, so each += here
       runs once. That grouping is not a convenience: `sales`, `margin` and `qty`
       would add up across a finer grouping, but `receipts` is a DISTINCT count
       and distinct counts do not add. Asking for branch_id alone is what makes
       the receipt figure the same number the Set used to produce. */
    rollup.forEach((r) => {
      const k = String(r.branch_id);
      (m[k] ||= { sales: 0, margin: 0, qty: 0, exp: 0, receipts: 0 });
      m[k].sales += num(r.sales); m[k].margin += num(r.margin); m[k].qty += num(r.qty);
      m[k].receipts += num(r.receipts);
    });
    expenses.forEach((r) => {
      const k = String(r.branch_id);
      (m[k] ||= { sales: 0, margin: 0, qty: 0, exp: 0, receipts: 0 });
      /* Income is the same table with txn_type flipped, so it comes off the
         expense figure rather than being counted as one. */
      m[k].exp += r.txn_type === "income" ? -num(r.amount) : num(r.amount);
    });
    return m;
  }, [rollup, expenses]);

  const totalSales = useMemo(() => Object.values(perf).reduce((a, v) => a + v.sales, 0), [perf]);
  const maxSales = useMemo(() => Math.max(...Object.values(perf).map((v) => v.sales), 1), [perf]);
  const needsReview = useMemo(() => branches.filter((b) => b.needs_review), [branches]);

  /** The chains and businesses that exist, for the pickers. Taken from the data
   *  rather than hardcoded: the original's dialog offered exactly two chains,
   *  which quietly rewrites the chain of any branch that is neither — Head
   *  Office among them, and Head Office is told apart by its chain. */
  const chains = useMemo(
    () => [...new Set(branches.map((b) => b.chain).filter(Boolean))] as string[],
    [branches]
  );
  const businesses = useMemo(
    () => [...new Set(branches.map((b) => b.business).filter(Boolean))] as string[],
    [branches]
  );

  const stats = [
    { label: "Branches", value: String(branches.length), Icon: Building2 },
    { label: "Active", value: String(branches.filter((b) => b.active !== false).length), Icon: CheckCircle2 },
    { label: "Needs review", value: String(needsReview.length), Icon: AlertTriangle },
    { label: "Period sales", value: money(totalSales), Icon: TrendingUp },
  ];

  function startAdd() {
    setEditing(null);
    setForm({
      ...BLANK,
      chain: chains[0] ?? "",
      /* A new branch belongs to whatever business the existing ones do. Getting
         this wrong files a shop where nobody looking for it will see it. */
      business: businesses[0] ?? "",
    });
    setErr(""); setOpen(true);
  }

  function startEdit(b: Branch) {
    setEditing(b);
    setForm({
      name: b.name ?? "", code: b.code ?? "", chain: b.chain ?? "",
      nimbus_name: b.nimbus_name ?? "", color: b.color || "#EBA98F",
      business: b.business ?? "", active: b.active !== false,
    });
    setErr(""); setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) { setErr("A branch name is required."); return; }
    if (!supabase) { setErr("Not connected."); return; }
    setSaving(true); setErr("");
    const payload = {
      name: form.name.trim(),
      chain: form.chain.trim() || null,
      color: form.color || null,
      /* Normalised on the way in, NULL when blank — see the note at the top.
         The importer matches normStore(file) against this value. */
      nimbus_name: form.nimbus_name.trim() ? normStore(form.nimbus_name) : null,
      active: form.active,
      /* Saving IS the review: somebody has now looked at this row and confirmed
         its name and its Nimbus name, which is the whole meaning of the flag. */
      needs_review: false,
    };
    const { error } = editing
      ? await supabase.from("retail_branches").update(payload).eq("id", editing.id)
      : await supabase.from("retail_branches").insert({
          ...payload,
          code: form.code.trim() || null,
          business: form.business.trim() || null,
        });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setOpen(false); load();
  }

  const cols: Col<Branch>[] = [
    { head: "Branch", cell: (b) => {
        const p = perf[String(b.id)] ?? EMPTY_PERF;
        return (
          <div>
            <span className="flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b.color || "#EBA98F" }} />
              {b.name}
            </span>
            <span className="mt-1 block h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]">
              <span className="block h-full rounded-full" style={{ width: `${Math.max((p.sales / maxSales) * 100, 1)}%`, background: b.color || "#EBA98F" }} />
            </span>
          </div>
        );
      } },
    { head: "Chain", muted: true, cell: (b) => b.chain || "—" },
    { head: "Nimbus store name", cell: (b) => (
        b.nimbus_name
          ? <span className="font-medium text-muted dark:text-[#a89f93]">{b.nimbus_name}</span>
          /* Not a dash. A branch with no Nimbus name is not missing a label,
             it is a branch whose sales are being skipped on every import. */
          : <Pill tone="bad">Not set</Pill>
      ) },
    { head: "Status", cell: (b) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {b.active !== false ? <Pill tone="good">Active</Pill> : <Pill>Inactive</Pill>}
          {b.needs_review ? <Pill tone="warn">Needs review</Pill> : null}
        </span>
      ) },
    { head: "Sales", right: true, bold: true, cell: (b) => money((perf[String(b.id)] ?? EMPTY_PERF).sales) },
    { head: "Margin", right: true, cell: (b) => money((perf[String(b.id)] ?? EMPTY_PERF).margin) },
    { head: "Expenses", right: true, cell: (b) => money((perf[String(b.id)] ?? EMPTY_PERF).exp) },
    { head: "Net", right: true, cell: (b) => {
        const p = perf[String(b.id)] ?? EMPTY_PERF;
        const net = p.margin - p.exp;
        return <span className={`font-semibold ${net < 0 ? "text-danger" : "text-success"}`}>{money(net)}</span>;
      } },
    { head: "Receipts", right: true, cell: (b) => (perf[String(b.id)] ?? EMPTY_PERF).receipts.toLocaleString() },
    { head: "", right: true, cell: (b) => (
        <button onClick={() => startEdit(b)}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
          <Pencil size={13} /> Edit
        </button>
      ) },
  ];

  return (
    <Shell>
      <PageHeader
        title="Branches"
        subtitle="Rename a shop, set its Nimbus store name so imports land, and see how each performed."
        onRefresh={load} loading={loading}
      >
        <button onClick={startAdd} className={btnPrimary}><Plus size={15} /> Add branch</button>
      </PageHeader>

      {/* A branch the importer invented is useless until somebody confirms its
          Nimbus name, and nobody goes looking for a flag they cannot see. */}
      {needsReview.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2 rounded-card border border-amber-strong/40 bg-amber-soft px-4 py-3 text-[13px] text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <AlertTriangle size={16} className="shrink-0 text-amber-strong" />
          <span>
            <strong>{needsReview.length}</strong>{" "}
            {needsReview.length === 1 ? "branch was" : "branches were"} created automatically by an import and
            {" "}{needsReview.length === 1 ? "has" : "have"} not been checked:{" "}
            <strong>{needsReview.map((b) => b.name).join(", ")}</strong>. Open{" "}
            {needsReview.length === 1 ? "it" : "each"} and save to confirm the name and the Nimbus store name.
          </span>
        </div>
      )}

      <StatCards stats={stats} loading={loading} />

      <RetailRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} />

      {/* WHEN THE TURNOVER COLUMNS COULD NOT BE FILLED, THEY SAY SO HERE — and
          the branch rows stay on screen behind this note, which is the entire
          point of it. It appears only on a failure, so an ordinary day is the
          screen that was always here. */}
      {!loading && !err && (perfErr || perfCut) && (
        <p className="mt-4 flex items-start gap-2 rounded-card border border-amber-strong/40 bg-amber-soft px-4 py-3 text-[12.5px] leading-snug text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-strong dark:text-amber" />
          {/* Deliberately not "the sales figures": this one note covers the
              roll-up and its fallback both failing AND the expenses read failing,
              and naming the wrong half of the table would be its own small lie. */}
          {perfErr ? (
            <span>
              <strong>Some of this period&apos;s figures could not be loaded</strong> — the Sales, Margin,
              Expenses, Net and Receipts columns, and the Period sales card, may read zero as a result.
              Everything else on this screen is live, including the Nimbus store name, which can still
              be set and saved. ({perfErr})
            </span>
          ) : (
            <span>
              <strong>This period was too large to add up line by line</strong>, so Sales, Margin and
              Receipts are a lower bound rather than the period&apos;s total. A shorter range gives the
              complete figure.
            </span>
          )}
        </p>
      )}

      {/* THE PHONE CARD, written out rather than left to the kit's automatic one.
          The computer's row is ten columns across 1,180px and the EIGHTH of them
          is the Nimbus store name — the one field on this screen that decides
          whether a shop's sales exist at all. The automatic card would have made
          it a truncated labelled pair somewhere under the fold, two cells along
          from the Edit button rendered as a pair with no label.

          So: the shop's name is the title, its turnover is the figure on the
          right, and the Nimbus name is its own tappable block with the empty
          case written as a sentence instead of a pill you have to know how to
          read. "Active" is not printed — every shop is active and a badge on
          every card says nothing; only Inactive and Needs review show.
          `card` is used by DataTable below 768px only, so the table above is
          exactly the table that was there. */}
      <DataTable cols={cols} rows={branches} loading={loading} err={err} minWidth={1180}
        empty="No branches yet — add the first one above, or let an import create it and confirm it here."
        card={(b) => {
          const p = perf[String(b.id)] ?? EMPTY_PERF;
          const net = p.margin - p.exp;
          return (
            <div className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b.color || "#EBA98F" }} />
                    <span className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{b.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-muted dark:text-[#a89f93]">{b.chain || "—"}</div>
                </div>
                <div className="flex-none text-right">
                  <div className="text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(p.sales)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Sales</div>
                </div>
              </div>

              <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]">
                <span className="block h-full rounded-full" style={{ width: `${Math.max((p.sales / maxSales) * 100, 1)}%`, background: b.color || "#EBA98F" }} />
              </span>

              {(b.active === false || b.needs_review) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {b.active === false ? <Pill>Inactive</Pill> : null}
                  {b.needs_review ? <Pill tone="warn">Needs review</Pill> : null}
                </div>
              )}

              {/* A blank Nimbus name is not a missing label. It is a shop whose
                  every line is skipped on every import, and whose only symptom is
                  looking quiet — so it is said in words, in amber, with the tap
                  that fixes it on the same block. */}
              <button type="button" onClick={() => startEdit(b)}
                className={`mt-2.5 flex w-full items-start gap-2.5 rounded-xl2 border p-2.5 text-left ${b.nimbus_name
                  ? "border-line bg-panel/50 dark:border-white/[0.06] dark:bg-white/[0.03]"
                  : "border-amber-strong/40 bg-amber-soft dark:border-white/[0.10] dark:bg-amber/10"}`}>
                {!b.nimbus_name && <AlertTriangle size={15} className="mt-0.5 flex-none text-amber-strong dark:text-amber" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Nimbus store name</span>
                  {b.nimbus_name
                    ? <span className="mt-0.5 block break-words text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">{b.nimbus_name}</span>
                    : <span className="mt-0.5 block text-[12.5px] font-semibold leading-snug text-ink dark:text-[#e7e2d8]">
                        Not set — every line for this shop is skipped on import. Tap to set it.
                      </span>}
                </span>
                <Pencil size={14} className="mt-0.5 flex-none text-muted dark:text-[#a89f93]" />
              </button>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line pt-2.5 dark:border-white/[0.06]">
                <div className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Margin</dt>
                  <dd className="truncate text-[13px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{money(p.margin)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Expenses</dt>
                  <dd className="truncate text-[13px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{money(p.exp)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Net</dt>
                  <dd className={`truncate text-[13px] font-semibold tabular-nums ${net < 0 ? "text-danger" : "text-success"}`}>{money(net)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Receipts</dt>
                  <dd className="truncate text-[13px] font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{p.receipts.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          );
        }} />

      <SourceNote>
        <strong>Nimbus store name</strong> is the exact text the POS export uses for this shop. The importer
        upper-cases it and collapses its spaces before matching, and this screen stores it the same way, so
        the two can agree. A branch with no Nimbus name has every one of its lines skipped on import — the
        shop simply looks quiet. Sales, margin and expenses are for the period chosen above; net is margin
        less expenses.
      </SourceNote>

      <Modal open={open} onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : "Add branch"}
        subtitle={editing?.needs_review
          ? "This branch was created by an import. Saving confirms it and clears the review flag."
          : "The Nimbus store name is what makes imported sales land on this shop."}>
        <div className="space-y-3.5">
          <Field label="Branch name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} autoFocus /></Field>
          {/* One column on a phone. Two 165px fields side by side with a 16px
              font is two fields you cannot read what you typed into. */}
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            <Field label="Chain">
              {/* A list of what already exists, and still typeable: a new chain
                  is a real thing, and a fixed two-item dropdown would rewrite
                  the chain of anything that is neither. */}
              <input value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })} list="rt-branch-chains" className={inputCls} placeholder="e.g. Topshop" />
              <datalist id="rt-branch-chains">{chains.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="Colour">
              <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}
                className="h-[38px] w-full rounded-xl2 border border-line bg-canvas px-1.5 py-1 dark:border-white/10 dark:bg-white/[0.04]" />
            </Field>
          </div>
          <Field label="Nimbus store name (exact text from the export)">
            {/* AUTOCORRECT OFF, AND NO AUTOMATIC CAPITAL LETTER. This field is
                matched character for character against the store name in the
                file. A phone keyboard that "corrects" FORTRESS to Fortress's, or
                capitalises only the first word, writes a value that looks right
                and matches nothing — and the symptom is a shop that goes quiet,
                not an error. Desktop browsers ignore all three attributes, so
                the computer site is unchanged. */}
            <input value={form.nimbus_name} onChange={(e) => setForm({ ...form, nimbus_name: e.target.value })}
              className={inputCls} placeholder="e.g. TOP SHOP FORTRESS"
              autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
          </Field>
          {form.nimbus_name.trim() && normStore(form.nimbus_name) !== form.nimbus_name && (
            <p className="text-[12px] text-muted dark:text-[#a89f93]">
              Saved as <strong>{normStore(form.nimbus_name)}</strong> — the importer matches on the
              upper-cased, single-spaced form.
            </p>
          )}
          {!editing && (
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Field label="Code"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} placeholder="short code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></Field>
              <Field label="Business">
                <input value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} list="rt-branch-biz" className={inputCls} />
                <datalist id="rt-branch-biz">{businesses.map((x) => <option key={x} value={x} />)}</datalist>
              </Field>
            </div>
          )}
          <label className="flex items-center gap-2.5 text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="h-4 w-4 accent-[#141414] dark:accent-white" />
            Open for business
          </label>
          {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}
          {/* Stacked and full width on a phone, Save at the bottom where the
              thumb already is. The dialog CSS gives both 44px. */}
          <div className="flex justify-end gap-2 pt-1 max-md:flex-col max-md:[&>button]:w-full">
            <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add branch"}
            </button>
          </div>
          {!isSupabaseConfigured && <p className="text-center text-[12px] text-hint">Preview build — nothing will be saved.</p>}
        </div>
      </Modal>

      <PreviewNote />
    </Shell>
  );
}
