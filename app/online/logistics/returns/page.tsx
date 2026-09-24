"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Undo2, PackageCheck, Wallet, RefreshCw, Loader2, ArrowLeft, AlertTriangle, ChevronRight, Check } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { rangeDates, rs } from "@/lib/dateRange";
import { HubRange, PageActions, useIsPhone, Sheet, Detail } from "@/components/HubUI";
import { useLiveTables } from "@/lib/useLiveTables";
import ReturnsPrintButton from "@/components/ReturnsPrintSheet";

/* Returns live under Logistics, not Finance — a return is a parcel problem
   first and a money problem second, and the people chasing them are the
   logistics team.

   Three sections, because three different questions get asked:

     Pending returns    nobody here has confirmed the box  OLDEST first
     Pending delivered  delivered, money not in           newest first

   Pending returns is deliberately oldest-first: couriers stop honouring claims
   after a while, so the row most likely to cost money is the one at the top. */

type Section = "pending_returns" | "closed_returns" | "delivered_unpaid";

const TABS: { key: Section; label: string; hint: string }[] = [
  /* THE OWNER'S RULE (H241): a return is pending until it is cancelled in
     Shopify, and nothing else closes it. The team cancels an order in Shopify
     (and tags it RTS) when the parcel is physically in the office, so the
     cancel IS the receipt. A CPR settlement or the 9-day rule used to close
     returns here too, hiding parcels nobody had received. */
  { key: "pending_returns",  label: "Pending returns",   hint: "The courier says it is coming back, and it is not cancelled in Shopify — so it is not in the office yet. Cancel it in Shopify (tag RTS) when it arrives and it moves to Returns delivered." },
  /* A CLOSED RETURN HAD NOWHERE TO LIVE.
     Pending filters needs_chasing, and a return closed by the nightly job or by
     a settlement no longer needs chasing. The other tab is delivered parcels.
     So a real parcel — #4715, returned in May 2025, closed correctly — could not
     be seen anywhere in this screen, and searching for it said "Nothing here."
     which reads as "this does not exist". */
  { key: "closed_returns",   label: "Returns delivered", hint: "Back in the office — cancelled in Shopify. This is the only way a return gets here." },
  { key: "delivered_unpaid", label: "Awaiting CPR", hint: "Delivered to the customer, but the COD has not reached you yet. The CPR confirms it. This is the receivable." },
];

type ReturnRow = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; cod_amount: number | null; stage: string | null; cpr_number: string | null;
  courier_reason: string | null; courier_reason_text: string | null;
  shopify_reason: string | null; shopify_note: string | null;
  agent_note: string | null; order_tags: string[] | null;
  order_cancelled_at: string | null; needs_chasing: boolean;
  customer_name: string | null; city: string | null;
  return_date: string | null; return_received_at: string | null; received: boolean;
  return_claim_status: string | null; age_days: number | null;
};

type UnpaidRow = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; cod_amount: number | null; delivery_date: string | null;
  payment_status: string | null; cpr_number: string | null;
  customer_name: string | null; city: string | null; age_days: number | null;
};

type SectionCount = { section: string; n: number; value: number; oldest_days: number };

const PAGE = 500;

export default function ReturnsPage() {
  const [tab, setTab] = useState<Section>("pending_returns");
  const phone = useIsPhone();
  /* One parcel in full — every reason, the settlement, the customer. */
  const [open, setOpen] = useState<ReturnRow | UnpaidRow | null>(null);
  // Which tab a search moved us to, so the jump is explained rather than silent.
  const [jumped, setJumped] = useState("");
  /* HOW OFTEN EACH COURIER BRINGS PARCELS BACK.
     The list said which parcels came back; nothing said whether that was
     normal. OwnEx ran at 14.5% in June, 25.2% in July and 14.9% in August —
     a swing worth Rs 190,000 that nobody could see. */
  type Rate = { month_label: string; courier: string;
                delivered: number; returned: number;
                return_pct: number | null; change_pts: number | null;
                cod_returned: number | null; is_part_month: boolean };
  const [rates, setRates] = useState<Rate[]>([]);
  /* Closed by default. The parcel list is what this page is opened for, and a
     twelve-row table above it pushed the work below the fold. The rate belongs
     one click away, not in the way. */
  const [showRates, setShowRates] = useState(false);
  const [rows, setRows] = useState<(ReturnRow | UnpaidRow)[]>([]);
  const [counts, setCounts] = useState<SectionCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [preset, setPreset] = useState("all");
  const [cf, setCf] = useState(""); const [ct, setCt] = useState("");
  const [store, setStore] = useState("ALL");
  const [courier, setCourier] = useState("All couriers");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showReceive, setShowReceive] = useState(false);

  /* Same request-token guard as Logistics: switching tab or range can leave two
     queries in the air, and without this the slower, older one wins and paints
     figures that belong to a range the user already moved off. */
  const reqId = useRef(0);

  /* The database is asked once typing pauses, not on every key. */
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  /* Ticked rows belong to the list they were ticked in. Change the tab, the
     dates, the store, the courier or the search, and the ticks go — otherwise
     "Mark received" could act on parcels no longer on screen. */
  useEffect(() => { setPicked([]); }, [tab, preset, cf, ct, store, courier, term]);

  const load = useCallback(async (opts?: { silent?: boolean; figuresOnly?: boolean }) => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    if (!opts?.silent) setLoading(true);
    setErr("");
    const [from, to] = rangeDates(preset, cf, ct);

    const view = tab === "delivered_unpaid" ? "v_delivered_unpaid" : "v_returns_all";  // closed returns come from the same view, filtered below
    const dateCol = tab === "delivered_unpaid" ? "delivery_date" : "return_date";
    /* OLDEST FIRST, on both tabs.
       A chase list is worked from the top, and the oldest parcel is the one
       closest to being written off — so it should be the first thing seen, not
       something found by scrolling. Newest-first put the parcel that came back
       an hour ago above the one that has been missing for three months.

       This was newest-first briefly at Zeeshan's request and has been changed
       back deliberately. */
    // Oldest first on the chase list, because the top row is the one closest to
    // being written off. Closed returns are history — newest first there.
    const ascending = tab !== "closed_returns";

    /* Same fix as Orders: a search asks the database, not the 1,000 rows the
       page happens to hold. #4715 is a real parcel that has been in this table
       since May 2025, and searching for it returned "Nothing here." */
    let rq = supabase.from(view).select("*")
      .order(dateCol, { ascending, nullsFirst: false })
      .limit(PAGE);
    /* A SEARCH ASKS POSTGRES, NOT THE PAGE.
       Even with .or() the query is still capped at 1,000 rows and still bound
       to one tab. hub_find_return searches the whole table — tracking number,
       order number, customer, phone — across every store, any date, any state,
       and says which state each result is in.

       The tracking number is matched exactly first, because it is the only
       identifier a courier issues rather than a person types. */
    if (term) {
      const { data: found, error: fe } = await supabase.rpc("hub_find_return", { p_q: term });
      /* The same newest-wins guard as below. This branch returned before it,
         so an earlier, slower search could land last and replace the answer. */
      if (my !== reqId.current) return;
      setLoading(false);
      if (fe) { setErr(fe.message); return; }
      const hits = (found as unknown as ReturnRow[]) ?? [];
      setRows(hits);
      /* A SEARCH GOES TO THE TAB THE PARCEL IS ACTUALLY IN. This block used to
         sit after an early return and never ran. */
      setJumped("");
      if (hits.length && tab !== "delivered_unpaid") {
        const allClosed  = hits.every((x) => x.needs_chasing === false);
        const allChasing = hits.every((x) => x.needs_chasing === true);
        if (tab === "pending_returns" && allClosed)  { setJumped("Returns delivered");  setTab("closed_returns"); }
        if (tab === "closed_returns"  && allChasing) { setJumped("Pending returns"); setTab("pending_returns"); }
      }
      return;
    }
    // the same flag hub_returns_sections() counts, so the card and the list can
    // never disagree — a return acknowledged by cancelling in Shopify drops out
    /* A SEARCH LOOKS EVERYWHERE, NOT JUST IN THIS TAB.
       Typing an order number is asking for that parcel. Filtering the answer by
       whichever tab happened to be open is how #4715 — a real, correctly closed
       return — produced "Nothing here." on both tabs in turn. With a term, the
       chase filter comes off and the row is shown with its own status. */
    if (!term) {
      if (tab === "pending_returns") rq = rq.eq("needs_chasing", true);
      if (tab === "closed_returns")  rq = rq.eq("needs_chasing", false);
    }
    // A search ignores the date window, for the same reason as Orders.
    if (!term) {
      if (from) rq = rq.gte(dateCol, from);
      if (to) rq = rq.lte(dateCol, to);
    }
    if (store !== "ALL") rq = rq.eq("store_code", store);
    if (courier !== "All couriers") rq = rq.eq("courier", courier);

    const [r, rt, c] = await Promise.all([
      opts?.figuresOnly ? Promise.resolve({ data: null, error: null }) : rq,
      supabase.rpc("hub_return_rates", { p_months: 12 }),
      supabase.rpc("hub_returns_sections", {
        p_store: store === "ALL" ? null : store,
        p_courier: courier === "All couriers" ? null : courier,
        p_from: from, p_to: to,
      }),
    ]);

    if (my !== reqId.current) return;      // superseded — discard
    setRates((rt.data as Rate[]) ?? []);
    /* The cards read 0 when their count failed, as if there were no returns. */
    const firstErr = r.error ?? rt.error ?? c.error;
    if (firstErr) setErr(firstErr.message);
    // figuresOnly refreshes the counts and leaves the list alone
    if (!opts?.figuresOnly) setRows((r.data as (ReturnRow | UnpaidRow)[]) ?? []);

    /* A SEARCH GOES TO THE TAB THE PARCEL IS ACTUALLY IN.
       Searching across tabs stopped "Nothing here." for a parcel that exists,
       but it then displayed a received return underneath a heading that says
       "still needs chasing" — which is its own kind of wrong answer. If every
       match belongs somewhere else, move there rather than describing it. */
    setJumped("");
    setCounts((c.data as SectionCount[]) ?? []);
    setLoading(false);
  }, [tab, preset, cf, ct, store, courier, term]);

  useEffect(() => { load(); }, [load]);
  /* Figures only on a live tick — the same reason as Orders and Logistics.
     A courier status change should update the counts, not re-pull the list. */
  useLiveTables(["online_logistics"], useCallback(() => load({ silent: true, figuresOnly: true }), [load]));

  const find = (k: string) => counts.find((c) => c.section === k);
  /* Closed = every return, minus the ones still being chased. Counted from the
     same RPC rather than a second query, so the three cards can never disagree
     about how many returns exist. */
  const closedCount = Math.max(0, (find("all_returns")?.n ?? 0) - (find("pending_returns")?.n ?? 0));
  const closedValue = Math.max(0, (find("all_returns")?.value ?? 0) - (find("pending_returns")?.value ?? 0));

  const cards = [
    { key: "pending_returns" as Section, label: "Pending returns", Icon: Undo2, bg: "bg-amber-soft",
      n: find("pending_returns")?.n ?? 0, v: find("pending_returns")?.value ?? 0,
      sub: find("pending_returns")?.oldest_days ? `oldest ${find("pending_returns")?.oldest_days}d` : undefined },
    /* THE CLOSED TAB HAD NO CARD.
       I added a third tab and left the card row at two, so switching to Closed
       returns highlighted nothing and the Pending card — still showing 26 —
       read as the selected one. A parcel correctly moved to Closed looked like
       it was still stuck in Pending, which is the exact confusion the tab was
       added to remove.

       The count comes from the same figures the RPC already returns: everything
       that came back, less what is still chased. */
    { key: "closed_returns" as Section, label: "Returns delivered", Icon: PackageCheck, bg: "bg-periwinkle-soft",
      n: closedCount, v: closedValue, sub: "cancelled in Shopify" },
    { key: "delivered_unpaid" as Section, label: "Awaiting CPR", Icon: Wallet, bg: "bg-success-soft",
      n: find("delivered_unpaid")?.n ?? 0, v: find("delivered_unpaid")?.value ?? 0,
      sub: find("delivered_unpaid")?.oldest_days ? `oldest ${find("delivered_unpaid")?.oldest_days}d` : undefined },
  ];

  /* The database already matched the search — tracking, order, customer AND
     phone. Filtering again here on three of those four threw away every
     phone-number match the database had found. */
  const filtered = rows;

  const isReturns = tab !== "delivered_unpaid";

  /* A courier saying "returned" is not the same as the parcel being on your
     shelf, so nothing marks itself received — a person has to confirm they are
     holding the box, and record who and when. That is what closes any open
     claim, so it cannot be a silent one-click action.

     The signature matters: mark_return_received takes an ARRAY of tracking ids
     plus date, receiver, condition and notes. Calling it with a single id and
     three arguments is why this returned 404 — PostgREST could not find a
     function with that shape. */
  async function receive(f: { date: string; by: string; condition: string; notes: string }) {
    if (!supabase || !picked.length) return;
    /* Send today when the field is blank, rather than null. The function now
       defends against this too, but a page that sends null to a date column
       deciding whether a parcel is still chased should not rely on the other
       side catching it. */
    setBusy(true);
    const { error } = await supabase.rpc("mark_return_received", {
      p_tracking_ids: picked,
      p_received_at: f.date || new Date().toISOString().slice(0, 10),
      p_received_by: f.by || null,
      p_condition: f.condition,
      p_notes: f.notes || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setShowReceive(false); setPicked([]); load();
  }

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <Link href="/online/logistics" className="mb-1 hidden items-center gap-1.5 md:inline-flex text-[12.5px] font-semibold text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
        <ArrowLeft size={14} /> Logistics
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Returns</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">{TABS.find((t) => t.key === tab)?.hint}</p>
        </div>
        <PageActions>
          <ReturnsPrintButton store={store} />
          <button onClick={() => load()} className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      {/* range — the same control as every other Hub page: presets on a
          desktop, one picker on a phone (the old row wrapped into three lines
          of small chips there) */}
      <HubRange preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={<>
          <select value={store} onChange={(e) => setStore(e.target.value)} className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {["ALL", "LM", "TS", "TRZ"].map((s) => <option key={s} value={s}>{s === "ALL" ? "All stores" : s}</option>)}
          </select>
          <select value={courier} onChange={(e) => setCourier(e.target.value)} className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {["All couriers", "PostEx", "OwnEx"].map((c) => <option key={c}>{c}</option>)}
          </select>
          <div className="flex min-w-[200px] flex-1">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order or tracking — looks everywhere"
              className="w-full rounded-full border border-line bg-surface px-4 py-2 text-[13px] text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          </div>
        </>} />

      {/* the three sections as cards — click to switch */}
      {/* The three sections are the tabs. Three across on a phone too — they
          were three full-width cards stacked, a screen of scrolling before the
          first parcel. */}
      <div className="mt-4 grid grid-cols-3 gap-2 sm:mt-5 sm:gap-3">
        {cards.map((c) => (
          <button key={c.key} onClick={() => setTab(c.key)} aria-pressed={tab === c.key}
            className={`min-w-0 rounded-card p-3 text-left transition active:scale-[0.98] sm:p-4 ${c.bg} ${tab === c.key ? "ring-2 ring-ink dark:ring-white/40" : "opacity-80 hover:opacity-100"} dark:bg-white/[0.05]`}>
            <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-ink text-white sm:flex dark:bg-white dark:text-[#141414]"><c.Icon size={15} /></span>
            <div className="text-[19px] font-extrabold tabular-nums text-ink sm:mt-3 sm:text-[22px] dark:text-[#f4f1ea]">{loading ? "—" : c.n.toLocaleString()}</div>
            <div className="text-[11.5px] font-semibold leading-tight text-ink sm:text-[12.5px] dark:text-[#f4f1ea]">{c.label}</div>
            <div className="mt-0.5 text-[10.5px] text-muted max-sm:truncate sm:text-[11.5px] dark:text-[#a89f93]">{rs(c.v)}<span className="hidden sm:inline">{c.sub ? ` · ${c.sub}` : ""}</span></div>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-snug text-muted md:hidden dark:text-[#a89f93]">{TABS.find((t) => t.key === tab)?.hint}</p>

      {err && <p className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-danger"><AlertTriangle size={15} /> {err}</p>}

      {/* On a phone this rides above the tab bar, so it is in reach wherever
          the ticked parcels are in the list. */}
      {isReturns && picked.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 flex items-center gap-3 border-t border-line bg-surface px-4 py-2.5 shadow-[0_-6px_20px_rgba(20,16,12,0.08)] md:static md:mt-4 md:rounded-card md:border md:py-3 md:shadow-none dark:border-white/10 dark:bg-[#201c17] md:dark:bg-white/[0.05]">
          <span className="flex-1 text-[13px] font-semibold text-ink md:flex-none dark:text-[#f4f1ea]">{picked.length} selected</span>
          <button onClick={() => setPicked([])} className="h-11 px-2 text-[13px] font-semibold text-muted md:order-last md:h-auto dark:text-[#a89f93]">Clear</button>
          <button onClick={() => setShowReceive(true)} disabled={busy}
            className="flex h-11 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-white md:h-auto md:py-1.5 md:text-[12.5px] dark:bg-white dark:text-[#141414]">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />} Mark received
          </button>
        </div>
      )}

      {/* HOW OFTEN EACH COURIER BRINGS PARCELS BACK.
          The list says which parcels came back; this says whether that is
          normal. PostEx has sat near 21% since March — a rate, not a bad month.
          OwnEx swung 14.5% to 25.2% and back — an incident. Two different
          problems, and neither was visible before.

          Always shown in full, and deliberately not affected by the filters
          above: picking "30 days" would empty a table whose whole purpose is
          the comparison across months. */}
      {rates.length > 0 && (
        <div className="mt-4 rounded-card border border-line bg-surface dark:border-white/10 dark:bg-[#201c17]">
          {/* The headline sits in the button itself, so the current rate is
              readable without opening anything — only the history costs a click. */}
          <button onClick={() => setShowRates((v) => !v)}
                  className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-panel dark:hover:bg-white/[0.04]">
            <span className="text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
              <span className="block sm:inline">Return rate</span>
              {(() => {
                const done = rates.filter((x) => !x.is_part_month);
                return ["PostEx", "OwnEx"].map((cr) => {
                  const rows = done.filter((x) => x.courier === cr);
                  const now = rows[0], prev = rows[1];
                  if (!now) return null;
                  const pc = Number(now.return_pct ?? 0);
                  const d = prev ? pc - Number(prev.return_pct ?? 0) : null;
                  return (
                    <span key={cr} className="mr-3 text-[12.5px] font-normal text-muted sm:ml-3 sm:mr-0 dark:text-[#a89f93]">
                      {cr} <b className="text-ink dark:text-[#f4f1ea]">{pc.toFixed(1)}%</b>
                      {d !== null && (
                        <span className={d <= 0 ? "text-emerald-700" : "text-red-700"}>
                          {" "}{d > 0 ? "+" : ""}{d.toFixed(1)}
                        </span>
                      )}
                    </span>
                  );
                });
              })()}
            </span>
            <span className="shrink-0 text-[11.5px] font-semibold text-muted dark:text-[#a89f93]">
              {showRates ? "Hide months" : "Month by month"}
            </span>
          </button>
          {showRates && phone && (
            <div className="divide-y divide-line border-t border-line dark:divide-white/[0.06] dark:border-white/10">
              {[...new Set(rates.map((x) => x.month_label))].map((m) => (
                <div key={m} className="px-4 py-2.5">
                  <div className="text-[12.5px] font-bold text-ink dark:text-[#f4f1ea]">{m}{rates.find((x) => x.month_label === m)?.is_part_month && <span className="ml-2 rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-hint dark:bg-white/[0.06]">still running</span>}</div>
                  {rates.filter((x) => x.month_label === m && (x.courier === "PostEx" || x.courier === "OwnEx")).map((x) => {
                    const d = x.change_pts === null ? null : Number(x.change_pts);
                    return (
                      <div key={x.courier} className="mt-1 flex items-baseline gap-2 text-[12.5px]">
                        <span className="w-14 shrink-0 text-muted dark:text-[#a89f93]">{x.courier}</span>
                        <b className="tabular-nums text-ink dark:text-[#f4f1ea]">{Number(x.return_pct ?? 0).toFixed(1)}%</b>
                        <span className={`tabular-nums ${d === null ? "text-hint" : d <= 0 ? "text-emerald-700" : "text-red-700"}`}>{d === null ? "" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}</span>
                        <span className="ml-auto truncate tabular-nums text-muted dark:text-[#a89f93]">{x.returned}/{x.delivered + x.returned} · {rs(Number(x.cod_returned ?? 0))}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {showRates && !phone && (
          <div className="overflow-x-auto border-t border-line dark:border-white/10">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Month</th>
                  <th className="px-4 py-2.5 font-semibold">Courier</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Delivered</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Returned</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Rate</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Change</th>
                  <th className="px-4 py-2.5 text-right font-semibold">COD returned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.06]">
                {rates.filter((x) => x.courier === "PostEx" || x.courier === "OwnEx").map((x, i) => {
                  const pc = Number(x.return_pct ?? 0);
                  const d  = x.change_pts === null ? null : Number(x.change_pts);
                  return (
                    <tr key={`${x.month_label}-${x.courier}-${i}`} className="text-ink dark:text-[#e7e2d8]">
                      <td className="px-4 py-2.5">
                        {x.month_label}
                        {x.is_part_month && (
                          <span className="ml-2 rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-hint dark:bg-white/[0.06]">
                            still running
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{x.courier}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted dark:text-[#a89f93]">{x.delivered}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{x.returned}</td>
                      <td className="px-4 py-2.5 text-right font-bold tabular-nums">{pc.toFixed(1)}%</td>
                      {/* Fewer returns is better, so a fall is the green one. */}
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${
                        d === null ? "text-hint" : d <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted dark:text-[#a89f93]">
                        {rs(Number(x.cod_returned ?? 0))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {phone ? (
        <div className={`mt-4 space-y-2 ${isReturns && picked.length > 0 ? "pb-16" : ""}`}>
          {loading && Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[84px] animate-pulse rounded-xl2 bg-panel/70 dark:bg-white/[0.05]" />)}
          {!loading && !filtered.length && (
            <p className="px-4 py-12 text-center text-[13px] text-muted dark:text-[#a89f93]">
              {q.trim() ? <>No parcel matches <b className="text-ink dark:text-[#f4f1ea]">{q.trim()}</b> in any return, on any date.<span className="mt-1 block text-[12px] text-hint">Checked every tab and the whole date range, not just this view.</span></> : "Nothing here."}
            </p>
          )}
          {!loading && filtered.map((r) => {
            const ret = r as ReturnRow; const up = r as UnpaidRow;
            const reasons = isReturns ? allReasons(ret) : [];
            const on = picked.includes(r.tracking_id);
            const old = Number(r.age_days ?? 0) > 14;
            return (
              <div key={r.tracking_id} className={`flex items-stretch overflow-hidden rounded-xl2 border bg-surface dark:bg-[#201c17] ${on ? "border-ink dark:border-white/40" : "border-line dark:border-white/[0.06]"}`}>
                {isReturns && (
                  <button type="button" aria-pressed={on} aria-label={`Select ${r.order_number ?? r.tracking_id}`}
                    onClick={() => setPicked((p) => on ? p.filter((x) => x !== r.tracking_id) : [...p, r.tracking_id])}
                    className="flex w-12 shrink-0 items-center justify-center border-r border-line active:bg-panel dark:border-white/[0.06]">
                    <span className={`flex h-6 w-6 items-center justify-center rounded-md border-2 ${on ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]" : "border-line dark:border-white/20"}`}>{on && <Check size={15} strokeWidth={3} />}</span>
                  </button>
                )}
                <button type="button" onClick={() => setOpen(r)} className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 text-left active:bg-panel dark:active:bg-white/[0.04]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? "—"}</span>
                      <span className="shrink-0 rounded-md bg-panel px-1.5 py-0.5 text-[10.5px] font-bold text-muted dark:bg-white/[0.06] dark:text-[#a89f93]">{r.store_code ?? ""}</span>
                      <span className="ml-auto shrink-0 text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(Number(r.cod_amount ?? 0))}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted dark:text-[#a89f93]">
                      <span className="min-w-0 flex-1 truncate">{r.courier ?? "—"} · {r.tracking_id}</span>
                      <span className={`shrink-0 font-semibold tabular-nums ${old ? "text-danger" : ""}`}>{r.age_days != null ? `${r.age_days}d` : ""}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[12px]">
                      {isReturns
                        ? <><span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted dark:bg-white/[0.08] dark:text-[#a89f93]">{ret.stage ?? "—"}</span>
                            <span className="min-w-0 truncate text-ink dark:text-[#e7e2d8]">{reasons[0]?.text ?? <span className="text-hint">no reason recorded</span>}</span></>
                        : <span className="truncate text-muted dark:text-[#a89f93]">Delivered {up.delivery_date ?? "—"} · {up.customer_name ?? "—"}</span>}
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-hint" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
      <div className="mt-4 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-white/[0.03]">
        <table className="w-full min-w-[880px] text-left text-[13px]">
          <thead className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
            <tr>
              {isReturns && <th className="w-10 px-4 py-3" />}
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Store</th>
              <th className="px-4 py-3 font-semibold">Courier</th>
              <th className="px-4 py-3 font-semibold">Tracking</th>
              {/* Which settlement covered this parcel. On a return it shows what
                  the courier charged for the trip back; on a delivered parcel,
                  what paid for it. Either way it is the document to go to when
                  a figure is questioned. */}
              <th className="px-4 py-3 font-semibold">CPR / Invoice</th>
              <th className="px-4 py-3 font-semibold">{isReturns ? "Return date" : "Delivered"}</th>
              <th className="px-4 py-3 text-right font-semibold">COD</th>
              <th className="px-4 py-3 text-right font-semibold">Age</th>
              {isReturns
                ? <><th className="px-4 py-3 font-semibold">Stage</th><th className="px-4 py-3 font-semibold">Reason</th></>
                : <th className="px-4 py-3 font-semibold">Customer</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.06]">
            {loading && <tr><td colSpan={11} className="px-4 py-8 text-center text-muted dark:text-[#a89f93]">Loading…</td></tr>}
            {/* "Nothing here." after a search reads as "this parcel does not
                exist", which is the wrong conclusion and the one that cost an
                afternoon. Say what was actually searched. */}
            {/* A SEARCH SHOWS ROWS FROM EVERY TAB, SO IT MUST SAY WHICH.
                Widening the search fixed "Nothing here." for parcels sitting in
                another tab — but an already-received return then appeared inside
                Pending with nothing to mark it, which reads as "this is stuck".
                Each row now carries where it actually belongs. */}
            {!loading && !filtered.length && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted dark:text-[#a89f93]">
                {q.trim()
                  ? <>No parcel matches <b className="text-ink dark:text-[#f4f1ea]">{q.trim()}</b> in any return, on any date.
                     <span className="mt-1 block text-[12px] text-hint">Checked every tab and the whole date range, not just this view.</span></>
                  : "Nothing here."}
              </td></tr>
            )}
            {!loading && filtered.map((r) => {
              const ret = r as ReturnRow;
              const up = r as UnpaidRow;
              // EVERY reason, not one winner. Agent, courier and customer often
              // disagree, and the disagreement is usually the useful part.
              const reasons = isReturns ? allReasons(ret) : [];
              return (
                <tr key={r.tracking_id} className="transition hover:bg-panel/60 dark:hover:bg-white/[0.04]">
                  {isReturns && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={picked.includes(r.tracking_id)}
                        onChange={(e) => setPicked((p) => e.target.checked ? [...p, r.tracking_id] : p.filter((x) => x !== r.tracking_id))} />
                    </td>
                  )}
                  <td className="px-4 py-3 font-semibold text-ink dark:text-[#f4f1ea]">{r.order_number ?? "—"}</td>
                  <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{r.store_code ?? "—"}</td>
                  <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{r.courier ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">{r.tracking_id}</td>
                  <td className="px-4 py-3 font-mono text-[11.5px]">
                    {r.cpr_number
                      ? <span className="text-ink dark:text-[#e7e2d8]">{String(r.cpr_number)}</span>
                      : <span className="text-hint">not settled</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">{(isReturns ? ret.return_date : up.delivery_date) ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink dark:text-[#f4f1ea]">{rs(Number(r.cod_amount ?? 0))}</td>
                  <td className={`px-4 py-3 text-right tabular-nums font-semibold ${Number(r.age_days ?? 0) > 14 ? "text-danger" : "text-muted dark:text-[#a89f93]"}`}>
                    {r.age_days != null ? `${r.age_days}d` : "—"}
                  </td>
                  {isReturns
                    ? <>
                        <td className="px-4 py-3">
                          <span className="inline-block rounded-full bg-panel px-2.5 py-1 text-[11.5px] font-semibold text-muted dark:bg-white/[0.08] dark:text-[#a89f93]">{ret.stage ?? "—"}</span>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {reasons.length === 0
                            ? <span className="text-hint dark:text-[#8a8175]">no reason recorded</span>
                            : (
                              <div className="space-y-0.5">
                                {reasons.map((x, k) => (
                                  <div key={k} className="flex flex-wrap items-baseline gap-1.5">
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-hint dark:text-[#8a8175]">{x.from}</span>
                                    <span className={`text-[12.5px] ${x.tone}`}>{x.text}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                        </td>
                      </>
                    : <>
                        <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{up.customer_name ?? "—"}</td>
                      </>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)}
        title={String(open?.order_number ?? open?.tracking_id ?? "")}
        subtitle={`${open?.store_code ?? ""} · ${open?.courier ?? ""} · ${open?.tracking_id ?? ""}`}>
        {open && (() => {
          const ret = open as ReturnRow; const up = open as UnpaidRow;
          const reasons = isReturns ? allReasons(ret) : [];
          return (
            <div>
              {isReturns && <Detail label="Stage">{ret.stage ?? "—"}</Detail>}
              <Detail label="COD">{rs(Number(open.cod_amount ?? 0))}</Detail>
              <Detail label={isReturns ? "Return date" : "Delivered"}>{(isReturns ? ret.return_date : up.delivery_date) ?? "—"}</Detail>
              <Detail label="Age">{open.age_days != null ? `${open.age_days} days` : "—"}</Detail>
              <Detail label="CPR / Invoice">{open.cpr_number ? String(open.cpr_number) : "not settled"}</Detail>
              <Detail label="Customer">{open.customer_name ?? "—"}{open.city ? ` · ${open.city}` : ""}</Detail>
              {isReturns && (
                <div className="pt-3">
                  <div className="text-[12px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Why it came back</div>
                  {reasons.length === 0 ? <p className="mt-1 text-[13.5px] text-hint">No reason recorded.</p> : reasons.map((x, k) => (
                    <div key={k} className="mt-2 rounded-xl2 bg-panel px-3 py-2 dark:bg-white/[0.05]">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-hint dark:text-[#8a8175]">{x.from}</div>
                      <div className={`text-[14px] ${x.tone}`}>{x.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </Sheet>

      <ReceiveDialog open={showReceive} count={picked.length} busy={busy}
        onClose={() => setShowReceive(false)} onSave={receive} />

      {rows.length >= PAGE && (
        <p className="mt-3 text-[11.5px] text-hint dark:text-[#8a8175]">
          Showing the first {PAGE.toLocaleString()} rows. The card totals above are counted in the database, so they are complete — narrow the range or the store to see the rest here.
        </p>
      )}
    </div>
  );
}


/* Tags that explain WHY a parcel came back, as opposed to tags that merely
   record what the team did. "WhatsApp: Not a User" means the number is not on
   WhatsApp; "Call Busy" means nobody answered; "WhatsApp: Payment Issue" means
   the customer balked at paying. Those are reasons. "Order Confirmed" and
   "Fulfillment Notified" are process steps and explain nothing. */
const REASON_TAG = /^(whatsapp|call|wa)\b|not a user|payment issue|busy|no answer|unreachable|refus|fake|wrong/i;
const PROCESS_TAG = /confirmed|notified|fulfill/i;

/* Some notes are written by apps, not people — a shipping notification is not
   an explanation, and showing it as one is worse than showing nothing. */
const AUTOMATED_NOTE = /has been shipped|tracking\s*\d|dispatched via|courier assigned/i;

/** Every reason this parcel has, not just the winning one.
 *
 *  THE OLD BEHAVIOUR PICKED ONE AND THREW THE REST AWAY.
 *  That was wrong for this business. A return usually has more than one side to
 *  it and they do not always agree:
 *
 *      agent    "customer refused, wants replacement"
 *      courier  "REFUSED TO RECEIVE"
 *      customer "size was too small"
 *
 *  Three different people saying three different things, and the disagreement
 *  is often the useful part — a courier saying REFUSED against a customer
 *  saying they never got a call is a courier problem, not a customer one.
 *  Collapsing that into one line hid it.
 *
 *  ORDER OF DISPLAY, most authoritative first:
 *      1. agent      a sentence one of your people typed
 *      2. courier    PostEx or OwnEx's own finding
 *      3. Shopify    the fixed cancel-reason dropdown
 *      4. customer   the order note, when a person wrote it
 *      5. tags       how it was handled — kept last, it is process not cause
 *
 *  The courier's STATUS ("Verifying Reason") is still excluded. That is the
 *  courier saying it has not decided; it is the absence of a reason and putting
 *  it here would pad the column with noise. It only appears when there is
 *  genuinely nothing else. */
type Reason = { from: string; text: string; tone: string };

function allReasons(r: ReturnRow): Reason[] {
  const out: Reason[] = [];
  if (r.agent_note?.trim())
    out.push({ from: "agent", text: r.agent_note.trim(), tone: "text-ink dark:text-[#f4f1ea]" });
  if (r.courier_reason_text?.trim())
    out.push({ from: "courier", text: r.courier_reason_text.trim(), tone: "text-ink dark:text-[#f4f1ea]" });
  if (r.shopify_reason?.trim())
    out.push({ from: "Shopify", text: r.shopify_reason.trim(), tone: "text-muted dark:text-[#a89f93]" });
  if (r.shopify_note?.trim() && !AUTOMATED_NOTE.test(r.shopify_note))
    out.push({ from: "customer", text: r.shopify_note.trim(), tone: "text-muted dark:text-[#a89f93]" });

  const tags = (r.order_tags ?? []).filter((t) => REASON_TAG.test(t) && !PROCESS_TAG.test(t));
  if (tags.length)
    out.push({ from: "tag", text: tags.join(" · "), tone: "text-muted dark:text-[#a89f93]" });

  // Only when nothing real exists at all.
  if (!out.length && r.courier_reason?.trim())
    out.push({ from: "courier status", text: r.courier_reason.trim(), tone: "text-hint dark:text-[#8a8175]" });
  return out;
}

/* Confirming receipt is a deliberate act with a record attached: who took it in,
   on what date, and what state it arrived in. Condition drives whether it goes
   back into sellable stock, so it cannot default silently. */
function ReceiveDialog({ open, count, busy, onClose, onSave }: {
  open: boolean; count: number; busy: boolean; onClose: () => void;
  onSave: (f: { date: string; by: string; condition: string; notes: string }) => void;
}) {
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), by: "", condition: "good", notes: "" });
  return (
    <Modal open={open} onClose={onClose} title="Confirm return received"
      subtitle={`${count} parcel(s) will be marked as physically in your inventory.`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date received"><input type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Received by"><input className={inputCls} value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} placeholder="name" /></Field>
        <Field label="Condition">
          <select className={inputCls} value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>
            <option value="good">Good — back in stock</option>
            <option value="damaged">Damaged</option>
            <option value="partial">Partial / items missing</option>
          </select>
        </Field>
        <Field label="Notes"><input className={inputCls} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <p className="mt-3 text-[12px] text-hint dark:text-[#8a8175]">
        Only confirm what you are actually holding — this closes any open claim on these parcels.
      </p>
      <div className="mt-5 flex gap-2">
        <button onClick={() => onSave(f)} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={14} className="animate-spin" />} Confirm received</button>
        <button onClick={onClose} className={btnGhost}>Cancel</button>
      </div>
    </Modal>
  );
}
