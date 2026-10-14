"use client";
/* Non-cash — everything that was sold but did not go into the till.
 *
 * WHY THIS SCREEN EXISTS AT ALL
 *   Two jobs, and only one of them is reading.
 *
 *   1. CARD SETTLEMENT PREVIEW. A day's card sales are recorded GROSS at the
 *      till; the acquirer credits NET, a day or so later, into one pooled
 *      account with no shop name on it. So the question "how much should land
 *      tomorrow?" has to be answered here before anybody can tell whether it
 *      did. Without the charge applied, ~1.28% of card turnover reads as
 *      permanently missing money.
 *
 *   2. TAGGING UNCLASSIFIED RECEIPTS. This is the important half, and it is
 *      the reason the screen is not read-only. Nothing else anywhere in the
 *      app can set `payment_method`. A sale line that arrives as
 *      'unclassified' — the import could not tell what it was — therefore
 *      stays unclassified for ever: it is real revenue that never lands in a
 *      payment bucket, never reconciles against the bank, and never shows up
 *      as either cash or card. The Dashboard already tells the user to "tag
 *      them as JazzCash or Card to sharpen the payment split" and until this
 *      screen existed there was nowhere to do it. The four buttons below are
 *      that nowhere.
 *
 * THE RULE THAT COST MONEY
 *   Nimbus MOP "Credit" is UDHAAR — goods taken on account by a customer, to
 *   be paid later. It is NOT a credit card. Counting it as card is what made
 *   FC DHA's 1 Sep card figure read 36,100 instead of 33,400. Card is
 *   payment_method='meezan_card' and nothing else, and only the two Fashion
 *   Collection shops take credit sales at all. Every button and label on this
 *   page spells "Credit (udhaar)" in full for that reason.
 *
 * AMOUNTS COME FROM sales_amount, WITH NO FALLBACK
 *   Not `sales_amount || net_sales`. A line whose sales_amount is genuinely
 *   zero — a full return, a zero-value exchange — is zero, and substituting a
 *   different column because the first one looked falsy invents revenue out of
 *   a discount field.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight, CreditCard, Smartphone, Globe, Users, Banknote, HelpCircle, CheckCircle2, Circle,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { rangeDates } from "@/lib/dateRange";
import {
  RetailRange,
  Shell, PageHeader, StatCards, DataTable, Pill, ShopSelect, ImportButton, PreviewNote, SourceNote,
  ActionBar, CardList, RowCard, useIsPhone,
  useBranches, money, num, text, today, addDays, fetchAll, fetchKeyset, CARD_RATE_PCT, cardExpected,
  type Row, type Col,
} from "@/components/retail/kit";
import { ImportPanel } from "@/components/retail/ImportPanel";
import Modal from "@/components/Modal";
import { useShopScope } from "@/lib/retailShop";

/* 'cash' is deliberately absent from the mix below — this screen is the other
   side of it. 'unclassified' IS here, because a row nobody has categorised is
   a row nobody is chasing, and hiding it would make the totals look tidier
   than they are. */
const METHODS = [
  { key: "meezan_card", label: "Card", Icon: CreditCard, tone: "info" as const },
  { key: "jazzcash", label: "JazzCash", Icon: Smartphone, tone: "warn" as const },
  { key: "online", label: "Online", Icon: Globe, tone: "info" as const },
  { key: "credit", label: "Credit (udhaar)", Icon: Users, tone: "bad" as const },
  { key: "other", label: "Other", Icon: ArrowLeftRight, tone: "neutral" as const },
  { key: "unclassified", label: "Unclassified", Icon: HelpCircle, tone: "neutral" as const },
];
const LABEL = Object.fromEntries(METHODS.map((m) => [m.key, m.label]));
const TONE = Object.fromEntries(METHODS.map((m) => [m.key, m.tone]));

/* The four things an untagged receipt can turn out to be. 'credit' is udhaar
   and is labelled in full so that nobody tags a Visa payment with it — the two
   are one click apart and the mistake is invisible afterwards. */
const CLASSIFY_AS = [
  { pm: "jazzcash", label: "JazzCash", cls: "bg-amber-soft text-amber-strong hover:opacity-90" },
  { pm: "meezan_card", label: "Card", cls: "bg-periwinkle-soft text-periwinkle-strong hover:opacity-90" },
  { pm: "credit", label: "Credit (udhaar)", cls: "bg-salmon-soft text-salmon-strong hover:opacity-90" },
  { pm: "cash", label: "Cash", cls: "bg-success-soft text-success hover:opacity-90" },
];

/* `addDays` now comes from the kit. It was hand-rolled here because the kit's
   `iso()` used to go through toISOString(), which converts to UTC — in Pakistan
   (UTC+5) that turns local midnight into the previous day, and a settlement date
   one day early is worse than no settlement date at all. `iso()` has since been
   fixed to report the local calendar day and the kit's `addDays` works from the
   string's own parts, so there is nothing left for a local copy to protect
   against. One implementation, and a settlement day that cannot disagree with
   the day the cash book shows. */

type UncLine = {
  id: number; branch_id: number | null; sale_date: string | null; sale_time: string | null;
  receipt_no: string | null; receipt_txn: string | null; sales_amount: number | null;
};
/** One physical receipt: every line the customer paid for in one go. Tagging is
 *  per receipt, never per line — half a bill on card and half on cash is not a
 *  thing that happens, and offering it would only create wrong data. */
type UncGroup = {
  key: string; branch_id: number | null; date: string; time: string;
  receipt: string; amt: number; ids: number[];
};

type Agg = { branch_id: number; method: string; amount: number; lines: number };

const dateInputCls =
  "rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink outline-none transition dark:border-white/10 dark:bg-white/[0.06] dark:text-white";

export default function NonCashPage() {
  const { branches, branchName } = useBranches();
  const phone = useIsPhone();
  /* The shop, shared with the left menu and every other screen — not this
     screen's own dropdown state. See lib/retailShop.ts. */
  const scope = useShopScope(branches);
  /* THE UPLOADER, OPENED FROM THIS SCREEN. No separate Import page: a file goes
     in while you are looking at the figures it changes. */
  const [importOpen, setImportOpen] = useState(false);
  const branch = scope.single;

  /* ── section 1 state: one day, one rate ────────────────────────────────── */
  const [day, setDay] = useState(() => addDays(today(), -1));
  /* Editable, because an acquirer's rate is renegotiated and a screen that
     hard-codes it becomes wrong quietly. Defaults to the one constant the
     whole app agrees on. */
  const [rate, setRate] = useState(String(CARD_RATE_PCT));
  const [cardRows, setCardRows] = useState<Row[]>([]);
  const [loadingCard, setLoadingCard] = useState(true);
  const [errCard, setErrCard] = useState("");

  /* ── section 2 state: the backlog ──────────────────────────────────────── */
  const [unc, setUnc] = useState<UncGroup[]>([]);
  const [loadingUnc, setLoadingUnc] = useState(true);
  const [errUnc, setErrUnc] = useState("");
  const [busy, setBusy] = useState("");
  /* TICKED RECEIPTS, phone only. The computer tags one receipt at a time from
     its own row of buttons — four buttons per row is fine when the row is
     860px wide. On a phone those four buttons have to live somewhere, and
     putting them on every card turns a 60px card into a 140px one, so the
     backlog becomes four receipts a screen. Instead the card is a tick and the
     four buttons move to one bar at the bottom. Keyed by UncGroup.key, so a
     tick survives the list re-ordering. */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });

  /* ── section 3 state: the mix over a range ─────────────────────────────── */
  const [preset, setPreset] = useState("30d");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [mix, setMix] = useState<Row[]>([]);
  const [loadingMix, setLoadingMix] = useState(true);
  const [errMix, setErrMix] = useState("");

  /* ── 1. card settlement preview ────────────────────────────────────────── */

  const loadCard = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoadingCard(false); return; }
    const db = supabase;
    setLoadingCard(true); setErrCard("");
    const { rows, error } = await fetchAll<Row>((lo, hi) => {
      let q = db.from("retail_sale_lines")
        .select("branch_id,sales_amount")
        /* 'meezan_card' and nothing else. Widening this to "anything that
           looks like a card" is exactly how the FC DHA figure went wrong. */
        .eq("payment_method", "meezan_card")
        .eq("sale_date", day);
      if (scope.ids) q = q.in("branch_id", scope.ids);
      return q.order("id", { ascending: true }).range(lo, hi);
    });
    if (error) setErrCard(error);
    setCardRows(rows);
    setLoadingCard(false);
  }, [day, scope.key]);
  useEffect(() => { loadCard(); }, [loadCard]);

  const ratePct = num(rate);

  const cardByBranch = useMemo(() => {
    const m = new Map<string, number>();
    cardRows.forEach((r) => {
      const k = String(r.branch_id);
      m.set(k, (m.get(k) ?? 0) + num(r.sales_amount));
    });
    return m;
  }, [cardRows]);

  const chains = useMemo(
    () => [...new Set(branches.map((b) => String(b.chain ?? "")).filter(Boolean))],
    [branches]
  );
  const multiChain = chains.length > 1;

  type CardRow =
    | { kind: "chain"; key: string; label: string; gross: number; net: number }
    | { kind: "store"; key: string; label: string; gross: number; net: number };

  const cardTable = useMemo(() => {
    const out: CardRow[] = [];
    let gross = 0, net = 0;
    chains.forEach((ch) => {
      const stores = branches
        .filter((b) => String(b.chain ?? "") === ch && (cardByBranch.get(String(b.id)) ?? 0) !== 0)
        .map((b) => {
          const g = cardByBranch.get(String(b.id)) ?? 0;
          /* net = gross × (1 − rate/100), straight from the kit so this screen
             and the card-reconciliation screen cannot drift apart. The charge
             column is the difference, never a second multiplication. */
          return { key: "b:" + b.id, label: b.name, gross: g, net: cardExpected(g, ratePct) };
        });
      if (!stores.length) return;
      const cg = stores.reduce((t, s) => t + s.gross, 0);
      const cn = stores.reduce((t, s) => t + s.net, 0);
      if (multiChain) out.push({ kind: "chain", key: "c:" + ch, label: ch, gross: cg, net: cn });
      stores.forEach((s) => out.push({ kind: "store", ...s }));
      gross += cg; net += cn;
    });
    return { out, gross, net };
  }, [chains, branches, cardByBranch, ratePct, multiChain]);

  /* ── 2. receipts still to classify ─────────────────────────────────────── */

  /* Deliberately NOT bounded by the range bar. An unclassified line from three
     months ago is still stuck revenue, and a date filter that hides it is a
     filter that makes the backlog look finished. */
  const loadUnc = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoadingUnc(false); return; }
    const db = supabase;
    setLoadingUnc(true); setErrUnc("");
    /* Ticks are dropped on every reload — switching branch replaces the list,
       and a tick left behind would be an invisible receipt in the bar's count
       that the operator can no longer see or untick. */
    setSel(new Set());
    /* Keyset, because this read is deliberately unbounded (see the note above)
       and an unbounded OFFSET pager is the one that degrades fastest: its cost
       is the square of the backlog. By key it is flat, whatever the backlog. */
    const { rows, error } = await fetchKeyset<UncLine>((afterId) => {
      let q = db.from("retail_sale_lines")
        .select("id,branch_id,sale_date,sale_time,receipt_no,receipt_txn,sales_amount")
        /* NULL and the literal both mean nobody has said what this money was.
           Only the literal was matched before, so a line that arrived with no
           payment_method at all was stuck revenue this screen could not show.
           Written to match the predicate of retail_sale_lines_unclassified_idx,
           which is what keeps this an index-only scan instead of a 1.3-second
           sequential scan of every line ever imported. */
        .or("payment_method.is.null,payment_method.eq.unclassified")
        .gt("id", afterId);
      if (scope.ids) q = q.in("branch_id", scope.ids);
      return q.order("id", { ascending: true }).limit(1000);
    });
    if (error) { setErrUnc(error); setLoadingUnc(false); return; }

    /* Grouped by branch + receipt + date, exactly as the old app did. The
       fallback to the line's own id matters: a line with no receipt_txn is its
       own receipt, and collapsing all of them into one key would offer a
       single button that retags an entire day. */
    const m = new Map<string, UncGroup>();
    rows.forEach((r) => {
      const k = `${r.branch_id}|${r.receipt_txn || r.id}|${r.sale_date}`;
      const g = m.get(k) ?? {
        key: k, branch_id: r.branch_id,
        date: String(r.sale_date ?? ""), time: String(r.sale_time ?? ""),
        receipt: String(r.receipt_no ?? r.receipt_txn ?? ""),
        amt: 0, ids: [],
      };
      g.amt += num(r.sales_amount);
      g.ids.push(Number(r.id));
      m.set(k, g);
    });
    const groups = [...m.values()].sort((a, b) => b.date.localeCompare(a.date));
    setUnc(groups);
    setLoadingUnc(false);
  }, [scope.key]);
  useEffect(() => { loadUnc(); }, [loadUnc]);

  /** The write, and the only one on this screen. Both the computer's per-row
   *  buttons and the phone's bottom bar go through here, so the two cannot
   *  drift apart. Returns "" on success, the message on failure.
   *
   *  Chunked at 300 ids. PostgREST turns .in() into a query-string list, and
   *  a busy receipt can be dozens of lines — a large group sent in one go
   *  trips the URL length limit and comes back as a 414 that reads like a
   *  network blip. Chunking also means a partial failure leaves a visibly
   *  half-tagged receipt rather than silently doing nothing. */
  async function setMethod(g: UncGroup, pm: string): Promise<string> {
    if (!supabase) return "Not connected.";
    for (let i = 0; i < g.ids.length; i += 300) {
      const chunk = g.ids.slice(i, i + 300);
      const { error } = await supabase.from("retail_sale_lines")
        .update({ payment_method: pm }).in("id", chunk);
      if (error) return error.message;
    }
    return "";
  }

  async function classify(g: UncGroup, pm: string) {
    if (!supabase) return;
    setBusy(g.key); setErrUnc("");
    const e = await setMethod(g, pm);
    if (e) { setErrUnc(e); setBusy(""); return; }
    /* Removed from the list rather than re-fetched: the row is done, and a
       full reload here would scroll the operator away from the next one. */
    setUnc((gs) => gs.filter((x) => x.key !== g.key));
    setBusy("");
    loadMix();
  }

  /** The ticked receipts, all tagged the same way. One receipt at a time is
   *  what the computer does; a phone operator working through a backlog of
   *  forty JazzCash receipts should not press forty buttons.
   *
   *  Receipt by receipt, NOT one .in() over every id: a receipt is the unit
   *  that succeeds or fails, and the ones that went through stay gone from the
   *  list while the ones that did not stay ticked, ready to retry. A single
   *  statement across all of them would, on a failure halfway, leave nobody
   *  able to say which receipts were written. */
  async function classifySelected(pm: string) {
    const picked = unc.filter((g) => sel.has(g.key));
    if (!picked.length || !supabase) return;
    setBusy("bulk"); setErrUnc("");
    const done = new Set<string>();
    for (const g of picked) {
      const e = await setMethod(g, pm);
      if (e) { setErrUnc(e); break; }
      done.add(g.key);
    }
    setUnc((gs) => gs.filter((x) => !done.has(x.key)));
    setSel((s) => new Set([...s].filter((k) => !done.has(k))));
    setBusy("");
    loadMix();
  }

  const uncTotal = useMemo(() => unc.reduce((t, g) => t + g.amt, 0), [unc]);
  /* What the bottom bar is about to write, in rupees. A bulk action with no
     figure on it is a bulk action nobody checks before pressing. */
  const selTotal = useMemo(
    () => unc.filter((g) => sel.has(g.key)).reduce((t, g) => t + g.amt, 0),
    [unc, sel]
  );

  /* ── 3. the mix over a range ───────────────────────────────────────────── */

  const loadMix = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoadingMix(false); return; }
    const db = supabase;
    setLoadingMix(true); setErrMix("");
    const [from, to] = rangeDates(preset, cf, ct);
    /* Paged, not .limit(20000): PostgREST caps a response at 1000 rows
       whatever the limit says, and a share bar computed off a silently
       truncated fetch is a percentage of the wrong denominator.
       The .or() rather than a plain .neq('cash') is because `neq` drops NULLs
       in SQL, and a line with no payment_method at all is precisely the kind
       of row this screen is supposed to surface. */
    /* THIS SCREEN ONLY EVER WANTED SUMS, so the database does them now.
       Reading the lines was one of the four statements that was timing out
       (measured 7,406 ms worst). retail_sales_agg groups by branch and method
       and returns about fifty rows instead of tens of thousands — same
       arithmetic, done where the rows are.

       `cash` is dropped here rather than in the query because the point of this
       screen is the NON-cash mix. The old `.or(neq.cash, is.null)` existed
       because SQL's `neq` drops NULLs and a line with no method at all is
       exactly what this screen surfaces; grouping keeps the null group, so
       filtering on the result keeps that behaviour without the filter. */
    const { data, error } = await db.rpc("retail_sales_agg", {
      p_from: from, p_to: to,
      p_branch: branch ? Number(branch) : null,
      p_by: ["branch_id", "payment_method"],
    });
    if (error) { setErrMix(error.message); setMix([]); setLoadingMix(false); return; }
    const agg = ((data as Row[]) ?? [])
      .filter((r) => String(r.payment_method ?? "") !== "cash")
      .map((r) => ({ branch_id: r.branch_id, payment_method: r.payment_method,
                     sales_amount: r.sales, lines: r.lines })) as Row[];
    setMix(agg);
    setLoadingMix(false);
  }, [preset, cf, ct, scope.key]);
  useEffect(() => { loadMix(); }, [loadMix]);

  /* The rows arriving here are already one per (branch, method) — the database
     grouped them, because reading the lines to do it in the browser was one of
     the four statements that was timing out. The reduce stays because null and
     '' both mean "unclassified" and come back as separate groups, exactly as
     they did as separate lines, so they still have to be merged into one.

     `lines` is TAKEN FROM THE ROW, not counted as one per row. Each row is a
     group now, so `+= 1` would have reported every method as a single line and
     the "lines" figure beside each shop would read 1 for a thousand sales. */
  const agg: Agg[] = useMemo(() => {
    const map = new Map<string, Agg>();
    mix.forEach((r) => {
      const bid = Number(r.branch_id);
      const m = String(r.payment_method || "unclassified");
      const k = `${bid}:${m}`;
      /* sales_amount only — see the note at the top of this file. */
      const amt = num(r.sales_amount);
      const cur = map.get(k) ?? { branch_id: bid, method: m, amount: 0, lines: 0 };
      cur.amount += amt;
      cur.lines += r.lines === undefined ? 1 : num(r.lines);
      map.set(k, cur);
    });
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [mix]);

  const byMethod = useMemo(() => {
    const m = new Map<string, number>();
    agg.forEach((a) => m.set(a.method, (m.get(a.method) ?? 0) + a.amount));
    return m;
  }, [agg]);

  const total = useMemo(() => [...byMethod.values()].reduce((t, v) => t + v, 0), [byMethod]);

  const stats = [
    { label: `To classify · ${unc.length} receipt${unc.length === 1 ? "" : "s"}`, value: money(uncTotal), Icon: HelpCircle },
    { label: "Card", value: money(byMethod.get("meezan_card") ?? 0), Icon: CreditCard },
    { label: "JazzCash", value: money(byMethod.get("jazzcash") ?? 0), Icon: Smartphone },
    { label: "Credit (udhaar)", value: money(byMethod.get("credit") ?? 0), Icon: Users },
  ];

  const cols: Col<Agg>[] = [
    { head: "Branch", bold: true, cell: (a) => branchName(a.branch_id) },
    { head: "Method", cell: (a) => <Pill tone={TONE[a.method] ?? "neutral"}>{LABEL[a.method] ?? text(a.method)}</Pill> },
    { head: "Lines", right: true, muted: true, cell: (a) => a.lines.toLocaleString() },
    { head: "Amount", right: true, bold: true, cell: (a) => money(a.amount) },
    { head: "Share", right: true, muted: true, cell: (a) => (total ? ((a.amount / total) * 100).toFixed(1) + "%" : "—") },
  ];

  const refreshAll = () => { loadCard(); loadUnc(); loadMix(); };

  return (
    <Shell>
      <PageHeader title="Non-cash" subtitle="Card, JazzCash, online and udhaar — sales that never reached the till."
        onRefresh={refreshAll} loading={loadingCard || loadingUnc || loadingMix}>
        <ShopSelect branches={branches} scope={scope} className="max-md:hidden" />
        <ImportButton onClick={() => setImportOpen(true)} />
      </PageHeader>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} wide
        title="Import" subtitle="Drop any NimbusRMS export — CSV, Excel or PDF. The file says what it is.">
        <ImportPanel onDone={() => refreshAll()} />
      </Modal>

      <StatCards stats={stats} loading={loadingUnc || loadingMix} />

      {/* ── 1. CARD SETTLEMENT PREVIEW ──────────────────────────────────── */}
      <section className="mt-7">
        <h2 className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Card settlement preview</h2>
        <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
          Card sales per shop for one day. The till records gross; the acquirer credits net, so this is
          what should actually arrive.
        </p>

        {/* Two label-plus-input pairs sit side by side on a computer. On a phone
            each takes a full-width line with the label left and the control
            right, because at 390px — and the shared CSS makes every input 16px
            so iOS cannot zoom the page — the pair after the first one wraps to a
            half-orphaned line that looks like a glitch. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12.5px] font-semibold text-muted max-md:w-full max-md:justify-between dark:text-[#a89f93]">
            Day
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={dateInputCls} />
          </label>
          <label className="flex items-center gap-2 text-[12.5px] font-semibold text-muted max-md:w-full max-md:justify-between dark:text-[#a89f93]">
            Bank charge %
            {/* inputMode="decimal" for the phone's numeric keypad — the rate is
                typed as 1.276, and hunting a decimal point on a QWERTY keyboard
                is how it becomes 1276. */}
            <input type="number" step="0.001" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)}
              className={`${dateInputCls} w-[92px] tabular-nums`} />
          </label>
        </div>

        {/* ON A PHONE one card per shop, with Net expected as the figure on the
            right — that is the number the screen was opened for, and in the
            640px table it is the last of four columns, which on a 390px display
            means dragging past the shop name to reach it. Gross and the charge
            stay on the card as a pair, so the net can still be checked rather
            than taken on trust. The computer keeps the table below, unchanged. */}
        {phone ? (
          <CardList
            rows={cardTable.out} loading={loadingCard} err={errCard}
            empty={`No card sales on ${day}.`}
            footer={
              <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-panel/60 px-3.5 py-3 dark:border-white/[0.06] dark:bg-white/[0.04]">
                <div className="min-w-0">
                  <div className="text-[13px] font-extrabold text-ink dark:text-[#f4f1ea]">All stores</div>
                  <div className="text-[11.5px] text-muted dark:text-[#a89f93]">gross {money(cardTable.gross)}</div>
                </div>
                <div className="flex-none text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(cardTable.net)}</div>
              </div>
            }
            render={(r) =>
              r.kind === "chain" ? (
                <div key={r.key} className="flex items-baseline justify-between gap-3 px-1 pt-2 text-[12px] font-extrabold uppercase tracking-wide text-hint dark:text-[#8a8175]">
                  <span className="truncate">{r.label}</span>
                  <span className="flex-none tabular-nums">{money(r.net)}</span>
                </div>
              ) : (
                <RowCard
                  key={r.key}
                  title={r.label}
                  /* Spelled out, because a big figure on a card gives no clue
                     whether it is the gross at the till or the net from the
                     bank, and those two are the whole point of this section. */
                  meta="net expected"
                  right={money(r.net)}
                  pairs={[
                    { k: "Card sales (gross)", v: money(r.gross) },
                    { k: `Bank charge ${ratePct}%`, v: <span className="text-danger">−{money(r.gross - r.net)}</span> },
                  ]}
                />
              )
            }
          />
        ) : (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                  <th className="px-4 py-3 font-semibold">Store</th>
                  <th className="px-4 py-3 text-right font-semibold">Card sales (gross)</th>
                  <th className="px-4 py-3 text-right font-semibold">Bank charge {ratePct}%</th>
                  <th className="px-4 py-3 text-right font-semibold">Net expected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                {loadingCard ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}><td colSpan={4} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>
                  ))
                ) : errCard ? (
                  <tr><td colSpan={4} className="px-4 py-12 text-center text-[13px] text-danger">Couldn&apos;t load: {errCard}</td></tr>
                ) : cardTable.out.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">No card sales on {day}.</td></tr>
                ) : (
                  cardTable.out.map((r) =>
                    r.kind === "chain" ? (
                      <tr key={r.key} className="bg-periwinkle-soft text-ink dark:bg-white/[0.05] dark:text-[#f4f1ea]">
                        <td className="px-4 py-2.5 font-extrabold">{r.label}</td>
                        <td className="px-4 py-2.5 text-right font-bold tabular-nums">{money(r.gross)}</td>
                        <td className="px-4 py-2.5 text-right font-bold tabular-nums text-danger">−{money(r.gross - r.net)}</td>
                        <td className="px-4 py-2.5 text-right font-extrabold tabular-nums">{money(r.net)}</td>
                      </tr>
                    ) : (
                      <tr key={r.key} className="text-ink dark:text-[#e7e2d8]">
                        <td className={`px-4 py-3 font-semibold ${multiChain ? "pl-8" : ""}`}>{r.label}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{money(r.gross)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-danger">−{money(r.gross - r.net)}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.net)}</td>
                      </tr>
                    )
                  )
                )}
              </tbody>
              {!loadingCard && !errCard && cardTable.out.length > 0 && (
                <tfoot className="border-t-2 border-line dark:border-white/[0.08]">
                  <tr className="bg-panel/70 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                    <td className="px-4 py-3">All stores</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(cardTable.gross)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-danger">−{money(cardTable.gross - cardTable.net)}</td>
                    <td className="px-4 py-3 text-right font-extrabold tabular-nums">{money(cardTable.net)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        )}

        {!loadingCard && cardTable.net > 0 && (
          <div className="mt-3 rounded-card border border-line bg-periwinkle-soft px-4 py-3 text-[13px] text-ink dark:border-white/[0.06] dark:bg-white/[0.05] dark:text-[#e7e2d8]">
            Net card expected for <strong>{day}</strong>: <strong className="tabular-nums">{money(cardTable.net)}</strong>
            {" "}— this should settle into the account on <strong>{addDays(day, 1)}</strong>.
          </div>
        )}
      </section>

      {/* ── 2. RECEIPTS STILL TO CLASSIFY ───────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Receipts still to classify</h2>
        <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
          Sales the import could not tag. Nothing else in the app can set a payment method, so until one
          of these buttons is pressed this money belongs to no bucket at all — it is neither cash nor
          card, and it reconciles against nothing. Not filtered by any date range on purpose.
        </p>

        {errUnc && <p className="mt-3 text-[12.5px] font-semibold text-danger">Couldn&apos;t update: {errUnc}</p>}

        {/* ON A PHONE: TICK, THEN TAG. This is the one screen in the department
            where somebody works through a list doing the same thing to row after
            row, and the 860px table it is on the computer cannot be that: seven
            columns to drag past, and four tagging buttons squeezed into the last
            of them.

            So the receipt becomes a card whose WHOLE SURFACE is the tick — a
            16px checkbox is a mis-tap, and a mis-tap here either tags the wrong
            receipt or scrolls the list — and the four buttons move to one bar
            above the tab bar, where they are full-sized and in one place instead
            of repeated on every card.

            Two taps per receipt become one, and a run of forty JazzCash
            receipts becomes forty ticks and a single button.

            `ActionBar` sits at bottom-[60px+safe-area] so it never covers the
            tab bar, and the list is padded by pb-24 while it is up so the last
            card is not underneath it. */}
        {phone ? (
          <>
            <div className={sel.size ? "pb-24" : ""}>
              <CardList
                rows={unc} loading={loadingUnc}
                empty="Nothing to classify — every non-cash sale is already tagged."
                footer={
                  <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-panel/60 px-3.5 py-3 dark:border-white/[0.06] dark:bg-white/[0.04]">
                    <div className="min-w-0">
                      <div className="text-[13px] font-extrabold text-ink dark:text-[#f4f1ea]">
                        {unc.length} receipt{unc.length === 1 ? "" : "s"} waiting
                      </div>
                      <div className="text-[11.5px] text-muted dark:text-[#a89f93]">
                        {unc.reduce((t, g) => t + g.ids.length, 0).toLocaleString()} lines · tap to tick
                      </div>
                    </div>
                    <div className="flex-none text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(uncTotal)}</div>
                  </div>
                }
                render={(g) => {
                  const on = sel.has(g.key);
                  const dim = busy === g.key || (busy === "bulk" && on);
                  return (
                    <button
                      key={g.key} type="button" aria-pressed={on} disabled={!!busy}
                      onClick={() => toggle(g.key)}
                      className={`flex w-full items-start gap-3 rounded-card border p-3.5 text-left transition ${
                        on ? "border-ink bg-panel/70 dark:border-white/30 dark:bg-white/[0.08]"
                           : "border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]"
                      } ${dim ? "opacity-40" : ""}`}
                    >
                      <span className="mt-0.5 flex-none">
                        {on ? <CheckCircle2 size={22} className="text-ink dark:text-white" /> : <Circle size={22} className="text-hint" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{branchName(g.branch_id)}</span>
                        <span className="block truncate text-[12.5px] text-muted dark:text-[#a89f93]">
                          {text(g.date)}{g.time ? ` ${g.time}` : ""} · {g.receipt ? `#${g.receipt}` : "no receipt number"}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">
                          {g.ids.length} line{g.ids.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="flex-none text-right text-[15px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(g.amt)}</span>
                    </button>
                  );
                }}
              />
            </div>

            {sel.size > 0 && (
              <ActionBar>
                {/* One child, laid out inside: the four labels do not fit across
                    a 390px row, and "Credit (udhaar)" is never shortened — the
                    whole reason it is spelled out is that it is not a card. */}
                <div className="w-full">
                  <div className="flex items-center justify-between gap-2 pb-2">
                    <span className="text-[12px] font-semibold text-ink dark:text-[#e7e2d8]">
                      {busy === "bulk"
                        ? "Tagging… one receipt at a time"
                        : `${sel.size} receipt${sel.size === 1 ? "" : "s"} · ${money(selTotal)} — set as`}
                    </span>
                    {/* A pill, not underlined text: 'Clear' after twenty ticks
                        has to be hittable, and the shared CSS gives every
                        rounded-full button in here a 40px minimum. */}
                    <button type="button" onClick={() => setSel(new Set())} disabled={!!busy}
                      className="flex-none rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-muted transition disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-[#a89f93]">
                      Clear
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {CLASSIFY_AS.map((c) => (
                      <button key={c.pm} onClick={() => classifySelected(c.pm)} disabled={!!busy}
                        className={`rounded-full px-3 py-2.5 text-[12.5px] font-semibold transition disabled:opacity-50 dark:bg-white/[0.08] dark:text-white ${c.cls}`}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </ActionBar>
            )}
          </>
        ) : (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06] dark:text-[#8a8175]">
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Time</th>
                  <th className="px-4 py-3 font-semibold">Branch</th>
                  <th className="px-4 py-3 font-semibold">Receipt</th>
                  <th className="px-4 py-3 text-right font-semibold">Amount</th>
                  <th className="px-4 py-3 text-right font-semibold">Lines</th>
                  <th className="px-4 py-3 font-semibold">Set as</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.05]">
                {loadingUnc ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-panel/70 dark:bg-white/[0.05]" /></td></tr>
                  ))
                ) : unc.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
                    <span className="inline-flex items-center gap-2 font-semibold text-success"><CheckCircle2 size={16} /> Nothing to classify</span>
                    <span className="mt-1 block">Every non-cash sale is tagged.</span>
                  </td></tr>
                ) : (
                  unc.map((g) => (
                    <tr key={g.key} className={`text-ink transition dark:text-[#e7e2d8] ${busy === g.key ? "opacity-40" : "hover:bg-panel/50 dark:hover:bg-white/[0.03]"}`}>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{text(g.date)}</td>
                      <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{text(g.time)}</td>
                      <td className="px-4 py-3 font-semibold">{branchName(g.branch_id)}</td>
                      <td className="px-4 py-3">{text(g.receipt)}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(g.amt)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted dark:text-[#a89f93]">{g.ids.length}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1.5">
                          {CLASSIFY_AS.map((c) => (
                            <button key={c.pm} onClick={() => classify(g, c.pm)} disabled={busy === g.key}
                              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50 dark:bg-white/[0.08] dark:text-white ${c.cls}`}>
                              {c.label}
                            </button>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {!loadingUnc && unc.length > 0 && (
                <tfoot className="border-t-2 border-line dark:border-white/[0.08]">
                  <tr className="bg-panel/70 font-bold text-ink dark:bg-white/[0.04] dark:text-[#f4f1ea]">
                    <td className="px-4 py-3" colSpan={4}>{unc.length} receipt{unc.length === 1 ? "" : "s"} waiting</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(uncTotal)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{unc.reduce((t, g) => t + g.ids.length, 0).toLocaleString()}</td>
                    <td className="px-4 py-3" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        )}

        <SourceNote>
          <strong>&ldquo;Credit&rdquo; here means udhaar — goods taken on account, to be paid later. It is
          not a credit card.</strong> A card payment is <code>meezan_card</code> and nothing else. The two
          buttons sit next to each other and the mistake leaves no trace afterwards, which is how FC
          DHA&apos;s 1 Sep card figure came to read 36,100 instead of 33,400. Only the two Fashion
          Collection shops take credit sales at all. Tagging writes to every line on the receipt at once,
          because half a bill on card and half on cash is not a thing that happens.
        </SourceNote>
      </section>

      {/* ── 3. THE MIX ──────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Where the non-cash money went</h2>
        <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
          The split across methods for a range, and the same numbers broken out per shop below.
        </p>

        <RetailRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt} />

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METHODS.map(({ key, label, Icon }) => {
            const v = byMethod.get(key) ?? 0;
            const pct = total ? (v / total) * 100 : 0;
            return (
              <div key={key} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-panel text-ink dark:bg-white/[0.08] dark:text-white"><Icon size={15} /></span>
                  <span className="text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">{label}</span>
                  <span className="ml-auto text-[13px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loadingMix ? "—" : money(v)}</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel dark:bg-white/[0.06]">
                  <div className="h-full rounded-full bg-ink dark:bg-white" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <div className="mt-1.5 text-[11.5px] font-medium text-muted dark:text-[#a89f93]">{pct.toFixed(1)}% of non-cash</div>
              </div>
            );
          })}
        </div>

        <DataTable cols={cols} rows={agg} loading={loadingMix} err={errMix} minWidth={720}
          empty="No non-cash sales in this range." />
      </section>

      <SourceNote>
        Amounts come from <code>sales_amount</code> only, with no fallback to <code>net_sales</code> — a
        line that is genuinely zero is zero, and substituting a different column because the first looked
        falsy invents revenue. None of these figures move the cash book, because none of this money
        enters the till. <Banknote size={12} className="inline align-[-1px]" /> Cash is the other side of
        this screen and lives in the cash book.
      </SourceNote>

      <PreviewNote />
    </Shell>
  );
}
