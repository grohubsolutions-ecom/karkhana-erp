"use client";
/* DAY CLOSE — the evening routine as one screen.
 *
 * WHY THIS SCREEN IS NEW
 *   Nothing in the old system was wrong about closing a day. The problem was that
 *   closing a day meant visiting five screens in the right order and remembering
 *   which ones you had already done: import the Nimbus files, check the sales
 *   landed, enter the day's expenses, count the drawer in the cash book, and
 *   record the card money. Miss one and nothing complains — the figures are just
 *   quietly short, and the person who finds out is whoever reconciles the month.
 *
 *   So this screen does not hold any new data and does not write anything of its
 *   own. It asks the database the same questions a person would have had to visit
 *   five screens to ask, says which of the five steps are done, and sends you
 *   straight to the one that is not. Every "do it" button is a link to the screen
 *   that actually owns that number.
 *
 * WHY IT IS ONE DATABASE CALL
 *   `retail_day_summary(date, branch)` (migration 0125) answers all of it server
 *   side and returns one JSON object. This screen is opened on a phone, standing
 *   in a shop, on mobile data. Eight round trips is eight chances to stall; one
 *   is one.
 *
 * WHY YESTERDAY IS THE DEFAULT
 *   The same reason the dashboard's upload reminder excludes today: the day is
 *   not over, so nothing is late yet, and a checklist that is red every morning
 *   until lunchtime is a checklist people stop looking at. The date box still
 *   goes to today for a shop that closes early.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not mark anything done. "Done" is derived, every time, from the data
 *   itself — a tick that is stored can disagree with the figures, and then the
 *   tick is worse than nothing. The one exception is the upload log, which the
 *   importer already writes and the dashboard already lets you stamp for a closed
 *   shop; this screen links there rather than duplicating it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ListChecks, Upload, Receipt, NotebookPen, Wallet, CreditCard, Share2, Check,
  AlertTriangle, ChevronRight, CircleDashed, Banknote,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import {
  Shell, PageHeader, Pill, Select, PreviewNote, SourceNote, Sheet, Detail,
  useBranches, money, moneyOrDash, num, today, addDays, unitForBranch,
  type Branch,
} from "@/components/retail/kit";
import { useScopedBranchId } from "@/lib/retailShop";
import { shopSummary, shareOrCopy, dayLabel } from "@/lib/retailShare";

/* ── the shape retail_day_summary returns ─────────────────────────────────── */

type DaySales = {
  gross: number; net: number; margin: number; qty: number;
  lines: number; receipts: number; returns: number;
  by_method: Record<string, number>;
};
type DayExp = { paid: number; income: number; ho: number; rows: number };
type DayBook = {
  opening_balance?: number | null; cash_sale?: number | null; split_cash?: number | null;
  card_sale?: number | null; jazz_sale?: number | null; credit_sale?: number | null;
  online_sale?: number | null; gross_sale?: number | null; net_sale?: number | null;
  ho_payment?: number | null; expense?: number | null; party_payment?: number | null;
  physical_cash?: number | null; note?: string | null;
} | null;
type DaySummary = {
  date: string; branch_id: number; unit: string;
  sales: DaySales; expenses: DayExp; book: DayBook;
  uploaded: string[];
  /** null when the person is not allowed to see card settlements (owner tier).
   *  Day Close is still useful without it, so the figure is left out rather than
   *  the whole call refused. */
  card_settled: number | null;
  bank_settled: number | null;
};

/* The three files a shop-day needs, and the labels the importer uses. Same list
   and same order as the dashboard's reminder, so the two cannot disagree about
   what "uploaded" means. */
const KINDS: [string, string][] = [["sales", "Sales"], ["expenses", "Expenses"], ["noncash", "Non-cash"]];

type StepState = "done" | "todo" | "warn" | "n/a";

type Step = {
  key: string;
  n: number;
  title: string;
  Icon: typeof Upload;
  state: StepState;
  /** One line, in the shop's words, saying what the data says. */
  says: string;
  /** Where to go to do it. */
  href: string;
  cta: string;
};

/* ── the screen ──────────────────────────────────────────────────────────── */

export default function RetailDayClose() {
  const { branches } = useBranches();
  const shops = useMemo(
    () => branches.filter((b) => b.active !== false && !(b.chain ?? "").toLowerCase().includes("head office")),
    [branches],
  );

  /* THE SHOP, shared with the left menu — see lib/retailShop.ts. Head Office
     is excluded from the pool because it has no till to close. */
  const { id: bid, list: pickable, set: setBid } = useScopedBranchId(branches, shops);
  const [date, setDate] = useState(() => addDays(today(), -1));
  const [d, setD] = useState<DaySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  /* First shop, once the list arrives. A screen that opens on "choose a shop"
     costs a tap every single evening. */

  const branch: Branch | undefined = shops.find((b) => String(b.id) === bid);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !bid) { setD(null); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("retail_day_summary", {
      p_date: date, p_branch: Number(bid),
    });
    setLoading(false);
    if (error) { setErr(error.message); setD(null); return; }
    /* A null answer means the permission gate said no, or the branch is gone.
       Both are "nothing to show", not "a zero day" — printing zeros would read
       as a shop that sold nothing. */
    setD((data as DaySummary) ?? null);
  }, [bid, date]);
  useEffect(() => { load(); }, [load]);

  /* ── what the data says about each step ──────────────────────────────────
     Every state below is derived from the figures. Nothing is remembered, so a
     step cannot claim to be done after somebody deletes the rows behind it. */
  const steps: Step[] = useMemo(() => {
    if (!d) return [];
    const s = d.sales, e = d.expenses, bk = d.book;
    const unit = branch ? unitForBranch(branch) : null;

    const missingKinds = KINDS.filter(([k]) => !d.uploaded.includes(k));

    /* THIS SCREEN DOES NOT WORK OUT THE CLOSING BALANCE, AND MUST NOT TRY.
       The first version of this file did, and it was wrong three ways at once:
       `retail_daily_book.expense` is a column nothing in the app ever writes (the
       cash book derives expenses from retail_expenses), HO is the typed half plus
       the imported half, and — worst — the opening balance is not a property of
       one day. It is the end of a CHAIN: every day opens where the day before it
       closed, re-anchored at each physical count. One day's row cannot know it.

       A day whose drawer was counted straight from the phone grid has a book row
       holding only `physical_cash`, so a one-day formula read Rs 0 as the closing
       balance and reported the entire count as surplus cash. That figure then went
       to the owner on WhatsApp.

       So the difference belongs to the cash book, which owns the chain, and this
       screen reports only what one day can actually answer: has anybody counted
       the drawer, and what were the day's cash takings. The link goes to the
       screen that knows. */
    const counted = bk?.physical_cash !== null && bk?.physical_cash !== undefined;
    const cashTaken = num(s.by_method["cash"]);

    const cardSale = num(s.by_method["meezan_card"]);
    const jazz = num(s.by_method["jazzcash"]);

    return [
      {
        key: "import", n: 1, title: "Nimbus files in", Icon: Upload,
        state: missingKinds.length === 0 ? "done" : s.lines > 0 ? "warn" : "todo",
        says: missingKinds.length === 0
          ? `All three files logged for ${unit ?? "this shop"}.`
          : `${missingKinds.map(([, l]) => l).join(" and ")} not logged yet` +
            (s.lines > 0 ? ` — though ${s.lines.toLocaleString()} sale lines are already in, so the file may have gone in before the log existed.` : "."),
        href: "/retail/import", cta: "Import files",
      },
      {
        key: "sales", n: 2, title: "Sales landed", Icon: Receipt,
        state: s.lines > 0 ? "done" : "todo",
        says: s.lines > 0
          ? `${money(s.net)} over ${s.receipts.toLocaleString()} bill${s.receipts === 1 ? "" : "s"}` +
            (s.returns ? `, ${money(s.returns)} returned.` : ".")
          : "No sale lines for this shop on this day. If the shop was shut, say so on the dashboard reminder.",
        href: "/retail/sales", cta: "Open sales",
      },
      {
        key: "expenses", n: 3, title: "Day's expenses entered", Icon: NotebookPen,
        state: e.rows > 0 ? "done" : "todo",
        says: e.rows > 0
          ? `${e.rows} entr${e.rows === 1 ? "y" : "ies"}: ${money(e.paid)} out` +
            (e.income ? `, ${money(e.income)} in` : "") + (e.ho ? `, ${money(e.ho)} of it to Head Office.` : ".")
          : "Nothing recorded. A day with no expenses is possible — a day with unrecorded expenses is a cash difference tomorrow.",
        href: "/retail/expenses", cta: "Add expenses",
      },
      {
        key: "cash", n: 4, title: "Drawer counted", Icon: Wallet,
        state: counted ? "done" : "todo",
        says: counted
          ? `${money(num(bk?.physical_cash))} counted. The cash book carries it forward and shows the difference — only it can, because the opening balance comes from the day before.`
          : `${money(cashTaken)} taken in cash today. Nobody has counted the drawer, so there is no difference to check yet.`,
        href: "/retail/cashbook", cta: counted ? "See the difference" : "Count the drawer",
      },
      {
        key: "card", n: 5, title: "Card & JazzCash money", Icon: CreditCard,
        /* A day with no card sale has nothing to reconcile. Marking it "to do"
           would put an impossible task on the list every time a shop takes only
           cash, which is most days in some of them. */
        state: cardSale + jazz === 0 ? "n/a"
          : num(d.card_settled) > 0 || d.bank_settled !== null ? "done" : "todo",
        says: cardSale + jazz === 0
          ? "No card or JazzCash sale today — nothing to settle."
          : num(d.card_settled) > 0 || d.bank_settled !== null
            ? `${money(cardSale + jazz)} taken, ${money(num(d.card_settled) || num(d.bank_settled))} recorded as received.`
            : `${money(cardSale)} on card` + (jazz ? ` and ${money(jazz)} on JazzCash` : "") +
              ". The bank keeps 1.276%, so this will not match to the rupee — record what actually arrived.",
        href: "/retail/cards", cta: "Reconcile cards",
      },
    ];
  }, [d, branch]);

  const doneCount = steps.filter((x) => x.state === "done" || x.state === "n/a").length;
  const allDone = steps.length > 0 && doneCount === steps.length;

  /* ── the message a shop sends to the group ────────────────────────────── */
  async function share() {
    if (!d || !branch) return;
    const s = d.sales, e = d.expenses, bk = d.book;
    const counted = bk?.physical_cash !== null && bk?.physical_cash !== undefined;

    /* No closing balance and no difference in the message, for the reason written
       out above: this screen cannot know either of them from one day's row, and a
       figure the owner reads off WhatsApp has to be right. The cash counted and
       the cash taken are both facts about this day, so those go. */
    const text = shopSummary({
      shop: branch.name ?? "Shop", date: d.date,
      gross: s.gross, net: s.net, returns: s.returns, receipts: s.receipts,
      cash: num(s.by_method["cash"]), card: num(s.by_method["meezan_card"]),
      jazz: num(s.by_method["jazzcash"]), credit: num(s.by_method["credit"]),
      online: num(s.by_method["online"]),
      expenses: e.paid, income: e.income, ho: e.ho,
      physical: counted ? num(bk?.physical_cash) : null,
    });
    const r = await shareOrCopy(text, `${branch.name} — ${d.date}`);
    if (r === "cancelled") return;
    setNote(r === "shared" ? "Sent." : r === "copied" ? "Copied — paste it into WhatsApp." : "Could not share. Open the day and read it out.");
    setTimeout(() => setNote(""), 4000);
  }

  return (
    <Shell>
      <PageHeader
        title="Day Close"
        subtitle="The five things that have to be true before a shop-day is finished."
        onRefresh={load} loading={loading}
      >
        <Select value={bid} onChange={setBid} className="max-md:w-full">
          {pickable.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
        </Select>
      </PageHeader>

      {/* THE DAY PICKER.
          Arrows, not only a date box: the day you want is almost always one step
          from the day you are on, and on a phone a 44px arrow beats a native date
          wheel every time. Capped at today — there is nothing to close in the
          future. */}
      <div className="mt-5 flex items-center gap-2">
        <button onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"
          className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line bg-surface text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <ChevronRight size={18} className="rotate-180" />
        </button>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} aria-label="Day"
          className="min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-3 py-2.5 text-center font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
        <button onClick={() => { if (date < today()) setDate(addDays(date, 1)); }} aria-label="Next day"
          disabled={date >= today()}
          className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line bg-surface text-ink transition hover:bg-panel disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <ChevronRight size={18} />
        </button>
      </div>

      {/* WHERE THE DAY STANDS, in one line, before any detail. */}
      <div className={`mt-4 flex items-start gap-3 rounded-card border p-4 ${
        allDone ? "border-success/30 bg-success-soft dark:border-success/25 dark:bg-success/10"
                : "border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]"}`}>
        <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-full ${
          allDone ? "bg-success text-white" : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
          {allDone ? <Check size={19} /> : <ListChecks size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-extrabold text-ink dark:text-[#f4f1ea]">
            {loading ? "Checking the day…"
              : !d ? "Nothing to check"
              : allDone ? "This day is closed"
              : `${doneCount} of ${steps.length} done`}
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted dark:text-[#a89f93]">
            {branch?.name ?? "—"} · {dayLabel(date)}
          </div>
        </div>
        {d && (
          <button onClick={share} aria-label="Share this day"
            className="flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
            <Share2 size={15} /> <span className="max-sm:hidden">Share</span>
          </button>
        )}
      </div>

      {note && <p className="mt-2 rounded-xl2 bg-panel px-3.5 py-2.5 text-[12.5px] text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">{note}</p>}
      {err && <p className="mt-3 rounded-card border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger dark:bg-danger/10">Couldn&apos;t load the day: {err}</p>}

      {/* THE FIVE STEPS. */}
      {loading && !d ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[92px] animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {steps.map((st) => <StepCard key={st.key} step={st} />)}
        </div>
      )}

      {/* The day's figures, for somebody who wants to see them rather than be
          told about them. Behind a tap so the checklist stays the screen. */}
      {d && (
        <>
          <button onClick={() => setOpen(true)}
            className="mt-3 flex w-full items-center justify-between rounded-card border border-line bg-surface px-4 py-3.5 text-[13.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/[0.06] dark:bg-[#201c17] dark:text-white">
            <span className="flex items-center gap-2"><Banknote size={16} /> The day&apos;s figures</span>
            <ChevronRight size={16} className="text-hint" />
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title={branch?.name ?? "Day"} subtitle={dayLabel(date)}>
            <Detail items={[
              { k: "Gross sale", v: money(d.sales.gross) },
              { k: "Net sale", v: money(d.sales.net) },
              { k: "Returns", v: money(d.sales.returns) },
              { k: "Gross margin", v: money(d.sales.margin) },
              { k: "Bills", v: d.sales.receipts.toLocaleString() },
              { k: "Lines", v: d.sales.lines.toLocaleString() },
              { k: "Cash", v: money(d.sales.by_method["cash"]) },
              { k: "Card", v: money(d.sales.by_method["meezan_card"]) },
              { k: "JazzCash", v: money(d.sales.by_method["jazzcash"]) },
              { k: "Credit (udhaar)", v: money(d.sales.by_method["credit"]) },
              { k: "Online", v: money(d.sales.by_method["online"]) },
              { k: "Unclassified", v: money(d.sales.by_method["unclassified"]) },
              { k: "Expenses", v: money(d.expenses.paid) },
              { k: "Misc income", v: money(d.expenses.income) },
              { k: "To Head Office", v: money(d.expenses.ho) },
              { k: "Opening cash", v: moneyOrDash(d.book?.opening_balance) },
              { k: "Cash counted", v: moneyOrDash(d.book?.physical_cash) },
              { k: "Note", v: d.book?.note || "—" },
            ]} />
          </Sheet>
        </>
      )}

      <SourceNote>
        Every tick on this page is worked out from the data each time it loads —
        nothing is stored as &ldquo;done&rdquo;, because a stored tick can disagree
        with the figures and then it is worse than no tick at all. The whole page
        is one database call, so it loads on a shop&apos;s mobile data.
      </SourceNote>
      <PreviewNote />
    </Shell>
  );
}

/* ── one step ────────────────────────────────────────────────────────────── */

function StepCard({ step }: { step: Step }) {
  const { state, says, title, n, Icon, href, cta } = step;

  const ring = state === "done" ? "border-l-success dark:border-l-success"
    : state === "warn" ? "border-l-amber-strong dark:border-l-amber-strong"
    : state === "n/a" ? "border-l-line dark:border-l-white/10"
    : "border-l-danger dark:border-l-danger";

  const badge = state === "done" ? <Pill tone="good">Done</Pill>
    : state === "warn" ? <Pill tone="warn">Check</Pill>
    : state === "n/a" ? <Pill tone="neutral">Nothing to do</Pill>
    : <Pill tone="bad">To do</Pill>;

  const mark = state === "done" ? <Check size={16} />
    : state === "warn" ? <AlertTriangle size={15} />
    : state === "n/a" ? <CircleDashed size={15} />
    : <span className="text-[12px] font-extrabold">{n}</span>;

  return (
    <div className={`rounded-card border border-l-[5px] border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${ring}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-full ${
          state === "done" ? "bg-success text-white"
          : state === "warn" ? "bg-amber-strong text-white"
          : state === "n/a" ? "bg-panel text-hint dark:bg-white/[0.06]"
          : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
          {mark}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">
              <Icon size={15} /> {title}
            </span>
            {badge}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted dark:text-[#a89f93]">{says}</p>
          {/* The link is the point of the card. A checklist that tells you what is
              missing and then makes you find the screen yourself is half a tool. */}
          {state !== "n/a" && (
            <Link href={href}
              className={`mt-2.5 inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition max-md:w-full max-md:justify-center ${
                state === "done"
                  ? "border border-line bg-surface text-muted hover:bg-panel dark:border-white/10 dark:bg-white/[0.04] dark:text-[#a89f93]"
                  : "bg-ink text-white hover:opacity-90 dark:bg-white dark:text-[#141414]"}`}>
              {state === "done" ? "Open anyway" : cta} <ChevronRight size={14} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
