"use client";

/* ---------------------------------------------------------------------------
   DELIVERY UNDER REVIEW — the first-attempt desk.
   (Named after PostEx's own screen, as the owner asked. The file and the URL
   keep the older name, first-attempt, so nothing that links here breaks.)

   Both couriers give a parcel more than one try before it comes back to
   Lahore. The ERP only ever met it at the end, as a return — freight paid
   twice and the sale gone. This desk meets it after a failure, while the
   parcel is still in the customer's city, and works out whose failure it was.

   The job on each row, in order:
     1. Ring the customer.  Why was it not received? Were you called?
     2. Copy the tracking numbers into the courier's WhatsApp group. They
        reply with the rider's number.
     3. Ring the rider.  Did you call? Did you reach the address?
     4. Re-attempt or Return — the two buttons on every row. Return asks why,
        and will not take an empty answer. Either way the parcel moves to
        History, with who decided and when.

   THE COURIERS' OWN LISTS (H297, 21 Oct 2026). The attempt tabs hold exactly
   what PostEx lists under "Delivery Under Review" and OwnEx under "Shipper
   Advice" — both lists read every 10 minutes (courier-review-queue) — and
   nothing else. Until H297 the desk was built from our own status column and
   showed PostEx's "Attempted" and OwnEx's "Verifying Reason" parcels too: 26
   on the desk against 9 on the two portals. A parcel stays while the courier
   lists it, decided or not; a decided one says so instead of offering the
   buttons. Everything else is in History, one line per failed try.

   OUR OWN COUNT (H297). The couriers' portals forget a parcel the moment it
   is decided. Ours does not: every day a parcel was on a list, every
   re-attempt — decided here, pressed on the courier's portal, or the
   courier's own — and how many times it has been sent out. FOLLOW-UP holds
   the parcels we re-attempted that are not delivered yet; when the customer
   says it never came, "Re-attempt again" records it (the courier's portal
   has no button for it then). Three times out, then it comes back.

   THE COURIER'S OWN WORD (H281, H283). PostEx's and OwnEx's own history is
   read every 10 minutes — the reason, the real count of tries, and any Return
   or Re-attempt already pressed on their portals (or started by the courier
   itself). A parcel settled there leaves the desk by itself, marked who did
   it, so nobody is asked to decide it twice. The open desk looks again every
   2 minutes.

   WHAT THIS SCREEN DOES NOT DO: press the button at the courier. The owner's
   decision — the re-attempt or the return is pressed in PostEx's or OwnEx's
   own portal. This desk decides and records; for PostEx it then shows whether
   the request has actually been made there.

   ONE COMPONENT, TWO HOMES. Abdullah opens it in his portal; the Hub opens it
   under Logistics. Both call the same database functions, so the office and
   the man doing the work can never be looking at different lists.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  RefreshCw, Loader2, AlertTriangle, Copy, Check, Phone, MessageCircle,
  PackageX, UserRound, Bike, Undo2, RotateCw, CheckCircle2, Search, History,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Segmented, Sheet, Detail, useIsPhone, waNumber } from "@/components/HubUI";
/* Headings are Title Case — every word starts with a capital (the owner,
   5 Oct 2026). */
import { tc } from "@/lib/titleCase";

/* How a failed try left the desk. "desk" = it has not: it is on today's desk.
   "again" = a "re-attempt again" recorded here (H297). */
type LeftAs = "desk" | "reattempt" | "return" | "done" | "failed_again" | "delivered" | "returned"
  | "out_again" | "coming_back" | "not_worked" | "moved" | "again";
type Decision = "reattempt" | "return";
/* Where a line comes from (H297): the couriers' lists today, a failed try in
   History, a "re-attempt again" in History, or the Follow-up list. */
type Src = "desk" | "hist" | "again" | "follow";
/* One re-attempt of a parcel, in order (hub_rescue_tries). n is ours only —
   1st, 2nd by us — and empty for the courier's own. */
type LogEntry = {
  n: number | null; at: string | null; how: "desk" | "portal" | "courier" | "again";
  try: number | null; by: string | null; note: string | null; id: number | null;
};
type QueueDay = { day: string; courier: string; status: string | null; first: string; last: string };
/* Why "Re-attempt again" may not be recorded (hub_rescue_again_block); null = it may. */
type AgainBlock = "settled" | "cancelled" | "coming_back" | "undecided" | "on_list" | "third_time" | null;
type ListInfo = { read_at: string | null; n: number; last_at: string | null; last_ok: boolean | null; error: string | null };

type Row = {
  row_key: string; attempt_no: number; left_as: LeftAs;
  failed_at: string | null; day: string | null;
  done_at: string | null; done_by_name: string | null;
  tracking_id: string; courier: string | null; order_number: string | null; store_code: string | null;
  attempts: number; last_failed_at: string | null; opened_at: string | null;
  rider_phone: string | null; rider_name: string | null;
  customer_called_at: string | null; customer_said: string | null;
  rider_called_at: string | null; rider_said: string | null;
  verdict: "customer" | "rider" | "address" | null;
  decision: Decision | null; return_reason: string | null; decided_via: "desk" | "courier" | null;
  courier_advice: Decision | null; courier_advice_at: string | null; courier_advice_by: "merchant" | "courier" | null;
  courier_attempts: number | null; courier_attempt_at: string | null; courier_checked_at: string | null;
  note: string | null; status: "open" | "done"; outcome: "delivered" | "returned" | null;
  closed_at: string | null; cod_amount: number | null; dispatch_date: string | null;
  raw_status: string | null; reason: string | null;
  customer_name: string | null; phone: string | null; city: string | null; address: string | null;
  waiting_hours: number | null; past_refusals: number; rider_strikes: number;
  decided_at: string | null; delivery_status: string | null;
  /* H297 — the courier's list, and our own count */
  src?: Src;
  in_queue?: boolean; q_status?: string | null; q_reason?: string | null; q_at?: string | null; q_read_at?: string | null;
  queue_days?: QueueDay[];
  tries?: number; sent_out?: number; our_reattempts?: number; again_count?: number; courier_reattempts?: number;
  last_ours_at?: string | null; reattempt_log?: LogEntry[];
  can_reattempt?: boolean; again_block?: AgainBlock;
  again_id?: number | null; again_note?: string | null;
};
type NotSent = { tracking_id: string; order_number: string | null; decision: Decision; courier?: string | null };
type Summary = {
  desk: number; postex: number; ownex: number; untouched: number; no_rider: number;
  not_worked: number; done_today: number; courier_today?: number; again_today?: number; follow?: number;
  not_sent?: number; not_sent_list?: NotSent[]; saved: number; lost: number;
};
type Board = {
  ok: boolean; error?: string; may_work: boolean; view: "today" | "history";
  today: string; range: { from: string; to: string };
  summary: Summary; rows: Row[];
  lists?: Partial<Record<"PostEx" | "OwnEx", ListInfo>>;
  follow?: Row[];
};
type Tab = "1" | "2" | "3" | "follow" | "history";
type Span = "today" | "yesterday" | "7" | "30" | "90";
type Kind = "all" | Exclude<LeftAs, "desk">;

/* A missing amount is a missing amount. Coercing it to zero printed "Rs 0",
   which in a COD business reads as a free parcel. */
const rs = (v: unknown) => (v == null || v === "" ? "—" : "Rs " + Math.round(Number(v)).toLocaleString("en-PK"));
/* 4th, not "4rd". This goes into the courier's own group. */
const ordinal = (n: number) => {
  const t = n % 100, u = n % 10;
  return `${n}${t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"}`;
};
/* A phone number a phone can actually dial. Shopify stores "+92 300 1234567",
   "0300-1234567 (ask for bhai)" and worse. */
const dial = (v: string | null) => (v ? String(v).replace(/[^\d+]/g, "") : "");
const waited = (h: number | null) => {
  if (h == null) return "—";
  if (h < 24) return `${Math.round(h)} h`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
};
/* Anything past two days is not being chased, it is being forgotten. */
const heat = (h: number | null) =>
  h == null ? "" : h >= 120 ? "text-[#b4562f] dark:text-[#e0a183]" : h >= 48 ? "text-[#8a6218] dark:text-[#e0b77c]" : "text-muted dark:text-[#a89f93]";

/* ON THE COURIER'S OWN REVIEW LIST RIGHT NOW (H297) — read from PostEx's
   "Delivery Under Review" and OwnEx's "Shipper Advice", not guessed from a
   status word. */
const listed = (r: Row) => !!r.in_queue;
/* What each courier calls its list, as its own portal does. */
const listName = (courier: string | null) =>
  courier === "OwnEx" ? "Shipper Advice" : courier === "PostEx" ? "Delivery Under Review" : "review list";
/* Which try it is on: the courier's count, never less than our re-attempts say. */
const triesOf = (r: Row) => r.tries ?? r.attempts;
/* Three times out, then it comes back (counted by the database, every time it
   was sent out — ours and the courier's). */
const lastTryOf = (r: Row) => !(r.can_reattempt ?? r.attempts < 3);
/* A line the courier lists, already decided or marked done here or on its
   portal: it is still listed, but there is nothing left to press on it. */
const settledOnList = (r: Row) => r.status === "done" && !r.outcome;

/* THE COURIER'S REASON. PostEx's is read from its history every 15 minutes;
   until the first read, say that rather than "not given". */
const reasonText = (r: Row) =>
  r.reason
  ?? (r.courier === "PostEx" && !r.courier_checked_at && (r.waiting_hours ?? 99) < 1
    ? "reading PostEx's reason…" : `${r.courier ?? "The courier"} gave no reason yet`);

/* ---- days, always in Pakistan time: "yesterday" is Lahore's yesterday, not
        whatever the browser's clock thinks, and the database agrees. */
const PKT = "Asia/Karachi";
const ymdPK = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PKT }).format(d);
const shiftDay = (ymd: string, n: number) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dateOf = (ymd: string, weekday = false) =>
  new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", {
    timeZone: "UTC", day: "numeric", month: "short", ...(weekday ? { weekday: "short" } : {}),
  });
const dayName = (ymd: string, today: string) =>
  ymd === today ? "Today" : ymd === shiftDay(today, -1) ? "Yesterday" : dateOf(ymd, true);
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: PKT, hour: "numeric", minute: "2-digit", hour12: true });
const when = (iso: string, today: string) => {
  const d = ymdPK(new Date(iso));
  return d === today ? `today ${clock(iso)}` : d === shiftDay(today, -1) ? `yesterday ${clock(iso)}` : `${dateOf(d)}, ${clock(iso)}`;
};

const SPANS: { key: Span; label: string; from: number; to: number }[] = [
  { key: "today", label: "Today", from: 0, to: 0 },
  { key: "yesterday", label: "Yesterday", from: -1, to: -1 },
  { key: "7", label: "Last 7 days", from: -6, to: 0 },
  { key: "30", label: "Last 30 days", from: -29, to: 0 },
  { key: "90", label: "Last 90 days", from: -89, to: 0 },
];

const COURIER_TONE: Record<string, string> = {
  PostEx: "bg-[#E6F1FB] text-[#0C447C] dark:bg-[#16283C] dark:text-[#8FBEEA]",
  OwnEx: "bg-[#E1F5EE] text-[#085041] dark:bg-[#12302A] dark:text-[#7FD3B8]",
};
/* How each line in History left the desk, in the order the chips are shown. */
const LEFT: { key: Exclude<LeftAs, "desk">; label: string; tone: string }[] = [
  { key: "reattempt", label: "Re-attempt", tone: "bg-periwinkle-soft text-[#38507a]" },
  { key: "again", label: "Re-attempted again", tone: "bg-periwinkle-soft text-[#38507a]" },
  { key: "return", label: "Return", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "done", label: "Marked done", tone: "bg-success-soft text-[#2f7a3d]" },
  /* H297: a failure the courier is handling itself — PostEx "Attempted", OwnEx
     "Verifying Reason". It is on neither review list, so nothing is decided here. */
  { key: "not_worked", label: "Not on a review list", tone: "bg-amber-soft text-[#7a5a28]" },
  { key: "out_again", label: "Sent out again", tone: "bg-periwinkle-soft text-[#38507a]" },
  { key: "failed_again", label: "Failed again", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "coming_back", label: "Coming back", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "delivered", label: "Delivered", tone: "bg-success-soft text-[#2f7a3d]" },
  { key: "returned", label: "Came back", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "moved", label: "Moved on", tone: "bg-panel text-muted dark:bg-white/[0.07] dark:text-[#a89f93]" },
];
const leftOf = (k: LeftAs) => LEFT.find((l) => l.key === k);

/* Who settled a decision, in a few words. */
function decidedBy(r: Row): string {
  const cn = r.courier ?? "the courier";
  if (r.decided_via === "courier") return courierDid(cn, r.decision ?? r.courier_advice, r.courier_advice_by);
  return r.done_by_name ?? "on this desk";
}
/* H283: both couriers are read now, and a courier acts on its own in two ways —
   PostEx starts a return after a second failure, OwnEx re-attempts a "not
   available" itself, PostEx sends a CNA out again next morning. */
function courierDid(cn: string, what: Decision | null, by: "merchant" | "courier" | null): string {
  if (by === "courier") return what === "reattempt" ? `${cn} sent it out again itself` : `${cn} started the return itself`;
  return `pressed on ${cn}'s portal`;
}

/* One line under the badge, saying what that badge means for THIS parcel. */
function leftDetail(r: Row, today: string): string {
  const cn = r.courier ?? "the courier";
  switch (r.left_as) {
    case "reattempt":
    case "return": {
      const t = r.done_at ? ` · ${when(r.done_at, today)}` : "";
      const why = r.left_as === "return" && r.return_reason ? ` · “${r.return_reason}”` : "";
      /* Decided here: has anybody pressed it on the courier's portal yet?
         Both couriers' histories are read now (H283). */
      const sent = r.decided_via === "desk" && (r.courier === "PostEx" || r.courier === "OwnEx") && r.attempt_no === r.attempts
        ? (r.courier_advice === r.decision
            ? ` · ✓ done on ${cn}`
            : r.courier_advice
              ? ` · ${cn} shows ${r.courier_advice === "return" ? "a return" : "a re-attempt"}${r.courier_advice_by === "courier" ? " (its own)" : ""} instead`
              : listed(r) ? ` · not yet pressed on ${cn}` : "")
        : "";
      return decidedBy(r) + t + why + sent;
    }
    case "again": {
      /* H297: ours, from our side, when the courier listed it nowhere */
      const t = r.done_at ? ` · ${when(r.done_at, today)}` : "";
      const note = r.again_note ? ` · “${r.again_note}”` : "";
      return `from our side, asked of ${cn} directly · ${r.done_by_name ?? "name not recorded"}${t}${note}`;
    }
    case "done": return `${r.done_by_name ?? "name not recorded"}${r.done_at ? ` · ${when(r.done_at, today)}` : ""}`;
    case "failed_again": return `went out again and failed — now on its ${ordinal(triesOf(r))} try`;
    case "delivered": return "delivered in the end";
    case "returned": return "came back to the warehouse";
    case "not_worked": return `${cn} says “${r.raw_status ?? "—"}” — it is not on ${cn}'s ${listName(r.courier)}, so there is nothing to decide yet`;
    default: return `${cn} now says: ${r.raw_status ?? "—"}`;
  }
}

/* ON THE LIST, ALREADY SETTLED (H297). The courier still lists it — PostEx
   can keep a parcel listed for hours after Return is pressed — so it stays on
   the desk, saying what was done instead of offering the buttons again. */
function listedNote(r: Row, today: string): string {
  const cn = r.courier ?? "the courier";
  const t = r.decided_at ? ` ${when(r.decided_at, today)}` : "";
  const what = r.decision === "return" ? "Return" : "Re-attempt";
  if (r.decision && r.decided_via === "courier") {
    return r.courier_advice_by === "courier"
      ? `${cn} ${r.decision === "return" ? "started the return" : "sent it out again"} itself${t} — ${cn} still lists it`
      : `${what} pressed on ${cn}'s portal${t} — ${cn} still lists it`;
  }
  if (r.decision) {
    return r.courier_advice === r.decision
      ? `${what} recorded here${t}, and pressed on ${cn}'s portal — ${cn} still lists it`
      : `${what} recorded here${t} — now press it on ${cn}'s portal`;
  }
  return `Marked done here — ${cn} still lists it`;
}

/* One re-attempt in the log, in words. */
function logLine(e: LogEntry, cn: string, today: string): { who: string; how: string; when: string } {
  const who = e.n != null ? `${ordinal(e.n)} by us` : `${cn} itself`;
  const how = e.how === "desk" ? `decided on this desk${e.by ? ` by ${e.by}` : ""}`
    : e.how === "portal" ? `pressed on ${cn}'s portal`
    : e.how === "again" ? `re-attempted again from our side${e.by ? ` by ${e.by}` : ""}`
    : `${cn} sent it out again on its own`;
  return { who, how, when: e.at ? when(e.at, today) : "time not recorded" };
}
/* A parcel decided or marked done can still end either way; say so. */
const afterDone = (r: Row) =>
  !["done", "reattempt", "return", "again"].includes(r.left_as) ? null
    : r.attempt_no < r.attempts ? "then failed again"
    : r.outcome === "delivered" ? "then delivered"
    : r.outcome === "returned" ? "then came back" : null;

const VERDICTS: { key: "customer" | "rider" | "address"; label: string; Icon: typeof UserRound }[] = [
  { key: "customer", label: "The customer", Icon: UserRound },
  { key: "rider", label: "The rider", Icon: Bike },
  { key: "address", label: "The address", Icon: PackageX },
];

/* "Re-attempt again" — what the customer said when rung back (H297). */
const AGAIN_REASONS = [
  "Customer says not received yet",
  "Customer asked to send it again",
  "Rider did not call the customer",
  "Customer was not home — wants it again",
];

/* Why it should come back. A button for the usual ones; the box for anything
   else. The database refuses a return with no reason. */
const RETURN_REASONS = [
  "Customer refused to take it",
  "Customer not answering / phone off",
  "Customer cancelled the order",
  "Wrong or incomplete address",
  "Customer wants it much later",
  "Refused after opening the parcel",
  "Fake or prank order",
];

/* ------------------------------------------------------------------ copying */

/* COPY IS THE TRACKING NUMBERS, one to a line — nothing else. That is what
   the courier's group asks for, and what the owner asked the button to do. */
const idsMessage = (rows: Row[]) => rows.map((r) => r.tracking_id).join("\n");

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Older phone browsers refuse the clipboard outside a trusted gesture. */
    try {
      /* iOS will not copy from a hidden or zero-opacity box, and returns true
         having copied nothing. It needs a real, readable, selected field. */
      const ta = document.createElement("textarea");
      ta.value = text; ta.readOnly = true;
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;font-size:16px;opacity:0.01;";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy") && ta.value === text;
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

const SELECT = "h-11 min-w-0 rounded-full border border-line bg-surface px-3 text-[16px] font-semibold text-ink outline-none md:h-10 xl:h-9 xl:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white";
/* Buttons that sit beside a text box keep the focus where it is on a phone.
   Without this the tap blurs the box first, the Hub's bottom bar (hidden
   while typing) springs back under the finger, and the tap lands on the bar. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

export default function FirstAttemptDesk({ compact = false, onCount, courierFilter, storeFilter, onCourierCounts }: {
  compact?: boolean;
  /* The portal puts this number on its tab: what is on the desk right now. */
  onCount?: (n: number) => void;
  /* H322 — the Calling Agent page picks the courier and the shop itself, with
     its own tabs; when given, the desk's own courier dropdown is hidden. */
  courierFilter?: "All" | "PostEx" | "OwnEx";
  storeFilter?: "All" | "LM" | "TS" | "TRZ";
  onCourierCounts?: (c: { PostEx: number; OwnEx: number }) => void;
}) {
  const phone = useIsPhone();
  /* Two lists, kept apart: today's desk and the History. */
  const [desk, setDesk] = useState<Board | null>(null);
  const [hist, setHist] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("1");
  const [courierOwn, setCourier] = useState<"All" | "PostEx" | "OwnEx">("All");
  const courier = courierFilter ?? courierOwn;
  const shopOk = (r: { store_code: string | null }) => !storeFilter || storeFilter === "All" || r.store_code === storeFilter;
  const [span, setSpan] = useState<Span>("7");
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [riderDraft, setRiderDraft] = useState<Record<string, string>>({});
  const [savingRider, setSavingRider] = useState("");
  const [riderErr, setRiderErr] = useState<Record<string, string>>({});
  /* What was just moved to History (or a "re-attempt again" just recorded),
     so one tap can put it back. */
  const [undo, setUndo] = useState<{ ids: string[]; text: string; kind: "done" | "decide" | "again"; againId?: number } | null>(null);
  const [marking, setMarking] = useState("");
  /* The parcels a Return is being asked for; the dialog is open while set. */
  const [returning, setReturning] = useState<Row[] | null>(null);

  const view: "today" | "history" = tab === "history" ? "history" : "today";


  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const args: Record<string, unknown> = { p_view: view };
    if (view === "history") {
      const t = ymdPK(new Date());
      const s = SPANS.find((x) => x.key === span) ?? SPANS[2];
      args.p_from = shiftDay(t, s.from);
      args.p_to = shiftDay(t, s.to);
    }
    const { data, error } = await supabase.rpc("hub_rescue_desk", args);
    if (my !== reqId.current) return;              // superseded
    setLoading(false);
    if (error) {
      /* Only a function the database has never heard of means a missing
         migration; a refused permission or a failed query says so itself. */
      const missing = (error as { code?: string }).code === "PGRST202" || /could not find the function/i.test(error.message);
      setErr(missing ? "This desk needs migration H281, which has not been run on the database yet." : error.message);
      return;
    }
    const b = data as Board;
    if (!b?.ok) { setErr(b?.error ?? "Could not open the desk."); return; }
    if (b.view === "history") setHist(b); else setDesk(b);
  }, [view, span]);
  useEffect(() => { load(); }, [load]);
  /* A save or a decision answers after the person may have moved tab. */
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { setPicked(new Set()); }, [tab, courier]);
  useEffect(() => {
    const here = new Set((desk?.rows ?? []).map((r) => r.tracking_id));
    setPicked((p) => { const n = new Set([...p].filter((t) => here.has(t))); return n.size === p.size ? p : n; });
  }, [desk]);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 15000);
    return () => clearTimeout(t);
  }, [undo]);
  /* LIVE (H283). Both couriers are read every 10 minutes; the open desk looks
     again every 2 minutes, so a parcel settled on PostEx's or OwnEx's portal
     leaves the screen by itself. Not while a parcel or the Return box is open,
     and not in a hidden tab. */
  const quiet = useRef(false);
  useEffect(() => { quiet.current = !!openKey || !!returning; }, [openKey, returning]);
  useEffect(() => {
    const t = setInterval(() => {
      if (quiet.current || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      loadRef.current();
    }, 120000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (onCount && desk?.summary) onCount(Number(desk.summary.desk) || 0);
  }, [desk, onCount]);

  const board = view === "history" ? hist : desk;
  const today = board?.today ?? desk?.today ?? ymdPK(new Date());
  const mayWork = !!(board?.may_work ?? desk?.may_work);

  /* ---------------------------------------------------------- today's desk */
  const byCourier = useMemo(
    () => (desk?.rows ?? []).filter((r) => (courier === "All" || r.courier === courier) && shopOk(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [desk, courier, storeFilter]
  );
  /* H322: how many of each courier are on the desk, for the page's own tabs. */
  useEffect(() => {
    if (!onCourierCounts) return;
    const rows = (desk?.rows ?? []).filter(shopOk);
    onCourierCounts({ PostEx: rows.filter((r) => r.courier === "PostEx").length, OwnEx: rows.filter((r) => r.courier === "OwnEx").length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk, storeFilter, onCourierCounts]);
  /* A fourth try belongs with the third, not nowhere. The try is ours as well
     as the courier's count (H297): re-attempted twice means a third try. */
  const tabOf = (r: Row): Tab => (triesOf(r) >= 3 ? "3" : triesOf(r) === 2 ? "2" : "1");
  const counts = useMemo(() => {
    const c = { "1": 0, "2": 0, "3": 0 };
    for (const r of byCourier) c[tabOf(r) as "1" | "2" | "3"]++;
    return c;
  }, [byCourier]);
  const rows = useMemo(() => (view === "today" ? byCourier.filter((r) => tabOf(r) === tab) : []), [byCourier, tab, view]);
  const pickedRows = rows.filter((r) => picked.has(r.tracking_id));
  const allPicked = rows.length > 0 && pickedRows.length === rows.length;
  /* Only lines still waiting for a decision can be decided in bulk. */
  const pickedOpen = pickedRows.filter((r) => r.status === "open");
  const deskTab = tab === "1" || tab === "2" || tab === "3";

  /* ------------------------------------------------------------ Follow-up */
  const followShown = useMemo(
    () => (desk?.follow ?? []).filter((r) => (courier === "All" || r.courier === courier) && shopOk(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [desk, courier, storeFilter]
  );

  /* --------------------------------------------------------------- History */
  const histBase = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, "");
    return (hist?.rows ?? []).filter((r) => {
      if (courier !== "All" && r.courier !== courier) return false;
      if (!shopOk(r)) return false;
      if (!needle) return true;
      return [r.order_number, r.tracking_id, r.customer_name, r.city].some((v) => (v ?? "").toLowerCase().includes(needle))
        || (digits.length >= 4 && dial(r.phone).includes(digits));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, courier, q, storeFilter]);
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of histBase) c[r.left_as] = (c[r.left_as] ?? 0) + 1;
    return c;
  }, [histBase]);
  const histShown = useMemo(() => histBase.filter((r) => kind === "all" || r.left_as === kind), [histBase, kind]);
  const days = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of histShown) {
      const k = r.day ?? "—";
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return [...m.entries()];
  }, [histShown]);

  const open = useMemo(
    () => [...(board?.rows ?? []), ...(view === "today" ? desk?.follow ?? [] : [])]
      .find((r) => r.row_key === openKey) ?? null,
    [board, desk, view, openKey]
  );

  async function save(tracking: string, patch: Record<string, unknown>) {
    if (!supabase) return false;
    const { data, error } = await supabase.rpc("hub_rescue_save", { p_tracking: tracking, ...patch });
    const r = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not save that."); return false; }
    setErr("");
    if ("p_rider_phone" in patch) setRiderDraft((d) => { const n = { ...d }; delete n[tracking]; return n; });
    await loadRef.current();
    return true;
  }

  /* After a move to History: close the sheet, clear the ticks, reload. The
     answer from the database names what actually moved, and only that can be
     undone — never a parcel somebody else had already settled. */
  async function afterMove(asked: string[], moved: string[], text: string | null, kind: "done" | "decide", extra?: string) {
    setErr("");
    setPicked(new Set());
    setUndo(moved.length && text ? { ids: moved, text, kind } : null);
    if (extra) setErr(extra);
    else if (moved.length < asked.length) {
      setErr(moved.length === 0
        ? "Nothing moved — it was already settled, perhaps by someone else. The list has been refreshed."
        : `${asked.length - moved.length} of them were already settled, perhaps by someone else, and were left as they were.`);
    }
    setOpenKey(null);
    await loadRef.current();
  }

  async function markDone(ids: string[], done: boolean, key: string, label?: string) {
    if (!supabase || !ids.length || marking) return false;
    setMarking(key);
    const { data, error } = await supabase.rpc("hub_rescue_mark_done", { p_trackings: ids, p_done: done });
    setMarking("");
    const r = (data ?? {}) as { ok?: boolean; error?: string; ids?: string[] };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not mark that done."); return false; }
    const moved = r.ids ?? [];
    if (!done) { setUndo(null); setOpenKey(null); await loadRef.current(); return true; }
    const n = moved.length;
    await afterMove(ids, moved, label && n === 1 && ids.length === 1 ? `${label} marked done — moved to History.` : `${n} marked done — moved to History.`, "done");
    return true;
  }

  /* RE-ATTEMPT or RETURN. Records the decision and moves the parcel to
     History; the courier is then told on its own portal. */
  async function decide(ids: string[], decision: Decision, key: string, label?: string, reason?: string) {
    if (!supabase || !ids.length) return false;
    if (marking) { setErr("One moment — the last change is still being saved."); return false; }
    setMarking(key);
    const { data, error } = await supabase.rpc("hub_rescue_decide", { p_trackings: ids, p_decision: decision, p_reason: reason ?? null });
    setMarking("");
    const r = (data ?? {}) as { ok?: boolean; error?: string; ids?: string[]; third_try_refused?: number };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not record that."); return false; }
    const moved = r.ids ?? [];
    const couriers = new Set((desk?.rows ?? []).filter((x) => moved.includes(x.tracking_id)).map((x) => x.courier ?? "the courier"));
    const where = couriers.size === 1 ? `${[...couriers][0]}'s portal` : "the courier's portal";
    const what = decision === "return" ? "Return" : "Re-attempt";
    const who = label && moved.length === 1 && ids.length === 1 ? label : `${moved.length} ${moved.length === 1 ? "parcel" : "parcels"}`;
    const third = r.third_try_refused ?? 0;
    await afterMove(ids, moved, `${what} recorded for ${who}. Press it on ${where} too.`, "decide",
      third ? `${third} on ${third === 1 ? "its" : "their"} third try can only come back — press Return for ${third === 1 ? "it" : "them"}.` : undefined);
    return true;
  }

  async function undoLast() {
    if (!supabase || !undo || marking) return;
    setMarking("__undo");
    const res = undo.kind === "again"
      ? await supabase.rpc("hub_rescue_reattempt_undo", { p_id: undo.againId })
      : undo.kind === "decide"
        ? await supabase.rpc("hub_rescue_decide", { p_trackings: undo.ids, p_decision: "undo" })
        : await supabase.rpc("hub_rescue_mark_done", { p_trackings: undo.ids, p_done: false });
    setMarking("");
    const r = (res.data ?? {}) as { ok?: boolean; error?: string };
    if (res.error || !r.ok) { setErr(res.error?.message ?? r.error ?? "Could not undo that."); return; }
    setUndo(null);
    await loadRef.current();
  }

  /* RE-ATTEMPT AGAIN (H297). The parcel is on no list, so the courier's portal
     has no button for it: the agent asks the courier directly, and this keeps
     the record — numbered, with who and why. */
  async function again(r: Row, note: string) {
    if (!supabase || marking) return false;
    setMarking("__again");
    const { data, error } = await supabase.rpc("hub_rescue_reattempt_again", { p_tracking: r.tracking_id, p_note: note || null });
    setMarking("");
    const res = (data ?? {}) as { ok?: boolean; error?: string; report?: string; id?: number };
    if (error || !res.ok) { setErr(error?.message ?? res.error ?? "Could not record that."); return false; }
    setErr("");
    setOpenKey(null);
    setUndo({ ids: [r.tracking_id], text: res.report ?? "Re-attempt recorded.", kind: "again", againId: res.id });
    await loadRef.current();
    return true;
  }
  /* A note written wrong is corrected; a re-attempt recorded by mistake is
     taken back (the latest one only, so the count has no hole in it). */
  async function againFix(id: number, note: string | null, takeBack: boolean) {
    if (!supabase || marking) return false;
    setMarking("__againfix");
    const { data, error } = takeBack
      ? await supabase.rpc("hub_rescue_reattempt_undo", { p_id: id })
      : await supabase.rpc("hub_rescue_reattempt_note", { p_id: id, p_note: note });
    setMarking("");
    const res = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !res.ok) { setErr(error?.message ?? res.error ?? "Could not change that."); return false; }
    setErr("");
    if (takeBack) setOpenKey(null);
    await loadRef.current();
    return true;
  }

  async function saveRider(r: Row) {
    const v = riderDraft[r.tracking_id];
    if (v === undefined || savingRider === r.tracking_id) return;   // Enter twice is one save
    setSavingRider(r.tracking_id);
    setRiderErr((e) => { const n = { ...e }; delete n[r.tracking_id]; return n; });
    const ok = await save(r.tracking_id, { p_rider_phone: v });
    setSavingRider((cur) => (cur === r.tracking_id ? "" : cur));
    if (!ok) setRiderErr((e) => ({ ...e, [r.tracking_id]: "Did not save — try again." }));
  }

  async function copy(key: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? key : "");
    if (!ok) setErr("The phone would not let the page copy. Try once more; if it still refuses, open a parcel and press and hold its message to copy it by hand.");
    setTimeout(() => setCopied((c) => (c === key ? "" : c)), 2200);
  }

  /* Refresh also reads PostEx's and OwnEx's lists and histories again straight
     away (at most every two minutes each), and looks once more when their
     answers have had time to land — OwnEx's list takes about half a minute. */
  async function refresh() {
    if (supabase) {
      const { data } = await supabase.rpc("hub_rescue_refresh_courier");
      if ((data as { queued?: boolean } | null)?.queued) {
        setTimeout(() => { loadRef.current(); }, 12000);
        setTimeout(() => { loadRef.current(); }, 35000);
      }
    }
    await load();
  }

  function toggle(t: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  }
  function toggleAll() {
    setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.tracking_id)));
  }

  const s = desk?.summary;
  const toCopy = pickedRows.length ? pickedRows : rows;
  /* EACH COURIER HAS ITS OWN GROUP: a mixed list is one button per courier. */
  const copyGroups = (["PostEx", "OwnEx", "Other"] as const)
    .map((c) => ({ c, list: toCopy.filter((r) => (c === "Other" ? r.courier !== "PostEx" && r.courier !== "OwnEx" : r.courier === c)) }))
    .filter((g) => g.list.length > 0);
  const spanLabel = (SPANS.find((x) => x.key === span) ?? SPANS[2]).label.toLowerCase();
  const notSent = s?.not_sent_list ?? [];

  function openReturn(list: Row[]) { setErr(""); setReturning(list); }

  return (
    <div className="mt-1">
      {/* ------------------------------------------------------- the numbers */}
      {s && view === "today" && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="On the desk" value={String(s.desk)} sub={`${s.postex} PostEx · ${s.ownex} OwnEx — as on their portals`} tone="#E5786B" />
          <Stat label="Not yet called" value={String(s.untouched)} sub="nobody has rung the customer" tone="#E4B47E" />
          <Stat label="No rider number" value={String(s.no_rider)} sub="still to ask the group" tone="#A6C0E6" />
          <Stat label="Done today" value={String(s.done_today)}
            sub={[s.courier_today ? `+ ${s.courier_today} settled on the couriers' own portals` : "",
                  s.again_today ? `+ ${s.again_today} re-attempted again` : ""].filter(Boolean).join(" · ")
                 || "decided or marked done here"} tone="#7FC489" />
        </div>
      )}

      {/* ------------------------------------ attempt tabs + Follow-up + History */}
      <Segmented className="mt-3 w-full md:w-max" value={tab} onChange={(v) => { setTab(v); setOpenKey(null); }}
        /* "Ring" on a phone: five tabs share 358px, and "Follow" with its count
           would not fit — the tab is the list of customers to ring again. */
        options={([["1", "1st attempt", "1st"], ["2", "2nd attempt", "2nd"], ["3", "3rd attempt", "3rd"],
                   ["follow", "Follow-up", "Ring"], ["history", "History", "History"]] as const).map(([key, label, short]) => ({
          key, label, short,
          badge: key === "history" ? undefined : (
            <span className={`ml-1 rounded-full px-1.5 text-[11px] font-bold tabular-nums ${tab === key
              ? "bg-white/20 dark:bg-black/10" : "bg-black/[0.06] dark:bg-white/10"}`}>
              {!desk ? "·" : key === "follow" ? (desk.follow?.length ?? 0) : counts[key]}
            </span>
          ),
        }))} />

      {/* EXACTLY THE COURIERS' LISTS (H297) — and when each was last read. */}
      {deskTab && desk && <ListsLine lists={desk.lists} today={today} />}
      {tab === "follow" && desk && (
        <p className="mt-2 px-1 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
          Parcels <b className="font-semibold text-ink dark:text-[#f4f1ea]">we re-attempted</b> — on this desk or on the
          courier&rsquo;s portal — that are on no review list now, not delivered and not on their way back. Ring the
          customer: if it has not reached him, open it and press <b className="font-semibold text-ink dark:text-[#f4f1ea]">Re-attempt again</b>.
          Newest first.
        </p>
      )}
      {/* DECIDED HERE, NOT YET PRESSED AT THE COURIER. The desk records; the
          courier only acts when the button is pressed on its portal. One line
          per courier, because each portal is pressed separately (H283). */}
      {deskTab && (["PostEx", "OwnEx"] as const).map((cname) => {
        const list = notSent.filter((x) => (x.courier ?? "PostEx") === cname);
        if (!list.length) return null;
        const key = `__notsent_${cname}`;
        return (
          <div key={cname} className="mt-2 flex flex-col gap-2 rounded-card border border-[#e7c98f] bg-amber-soft px-3 py-2 text-[12.5px] leading-snug text-[#7a5a28] sm:flex-row sm:items-center dark:border-white/10">
            <span className="min-w-0 flex-1">
              <b>{list.length} decided here but not yet pressed on {cname}&rsquo;s portal:</b>{" "}
              {list.map((x) => `${x.order_number ?? x.tracking_id} (${x.decision === "return" ? "return" : "re-attempt"})`).join(", ")}
            </span>
            <button onMouseDown={keepFocus} onClick={() => copy(key, list.map((x) => x.tracking_id).join("\n"))}
              className={`flex h-10 shrink-0 items-center justify-center gap-1.5 self-start rounded-full px-3 text-[12px] font-bold sm:h-9 sm:self-auto ${copied === key
                ? "bg-success-soft text-[#2f7a3d]" : "bg-surface text-ink dark:bg-white dark:text-[#141414]"}`}>
              {copied === key ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy their tracking IDs</>}
            </button>
          </div>
        );
      })}

      {/* ------------------------------------------------ narrow it down */}
      <div className={`mt-2 grid gap-2 md:flex md:flex-wrap md:items-center ${view === "history" ? "grid-cols-2" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
        {!courierFilter && (
        <select value={courier} onChange={(e) => setCourier(e.target.value as typeof courier)} aria-label="Courier" className={SELECT}>
          <option value="All">Both couriers</option>
          <option value="PostEx">PostEx</option>
          <option value="OwnEx">OwnEx</option>
        </select>
        )}
        {view === "history" && (
          <select value={span} onChange={(e) => setSpan(e.target.value as Span)} aria-label="Which days" className={SELECT}>
            {SPANS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        )}
        {view === "history" && (
          <label className="relative col-span-2 flex min-w-0 items-center md:w-72">
            <Search size={15} className="pointer-events-none absolute left-3.5 text-muted dark:text-[#a89f93]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order, tracking, name or number"
              aria-label="Search History" type="search"
              className="h-11 w-full min-w-0 rounded-full border border-line bg-surface pl-9 pr-3 text-[16px] text-ink outline-none md:h-10 xl:h-9 xl:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white" />
          </label>
        )}
        <button onClick={refresh}
          className={`flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink transition hover:bg-panel md:h-9 dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12] ${view === "history" ? "col-span-2 md:col-span-1" : ""}`}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* ------------------------------------------------ History: what happened */}
      {view === "history" && hist && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip on={kind === "all"} onClick={() => setKind("all")} label="Everything" n={histBase.length} />
          {LEFT.filter((l) => kindCounts[l.key] || kind === l.key).map((l) => (
            <Chip key={l.key} on={kind === l.key} onClick={() => setKind(l.key)} label={l.label} n={kindCounts[l.key] ?? 0} />
          ))}
        </div>
      )}

      {/* ------------------------------------------ just moved: undo */}
      {undo && (
        <div role="status" className="mt-3 flex items-center justify-between gap-2 rounded-card border border-[#bfe3c5] bg-success-soft px-3 py-2 text-[13px] font-semibold text-[#2f7a3d] dark:border-white/10">
          <span className="flex min-w-0 items-start gap-2"><CheckCircle2 size={16} className="mt-0.5 shrink-0" /><span>{undo.text}</span></span>
          {mayWork && (
            <button onMouseDown={keepFocus} onClick={undoLast} disabled={marking === "__undo"}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface px-3.5 text-[12.5px] font-bold text-ink disabled:opacity-50 dark:bg-white dark:text-[#141414]">
              {marking === "__undo" ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Undo
            </button>
          )}
        </div>
      )}

      {/* ------------------------------------------ pick, copy, decide */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 rounded-card border border-line bg-surface px-3 py-2 dark:border-white/[0.06] dark:bg-[#201c17]">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-[40px] cursor-pointer items-center gap-2 pr-1 text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
              <input type="checkbox" checked={allPicked} onChange={toggleAll}
                ref={(el) => { if (el) el.indeterminate = pickedRows.length > 0 && !allPicked; }}
                className="h-5 w-5 shrink-0 accent-[#141414] dark:accent-white" />
              {pickedRows.length ? `${pickedRows.length} picked` : `Pick all ${rows.length}`}
            </label>
            {pickedRows.length > 0 && (
              <button onClick={() => setPicked(new Set())}
                className="h-10 rounded-full px-2 text-[12.5px] font-semibold text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
                Clear
              </button>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {copyGroups.map(({ c, list }) => {
              const key = "__bulk_" + c;
              const label = copyGroups.length > 1
                ? `Copy ${list.length} ${c} IDs`
                : pickedRows.length ? `Copy ${list.length} picked IDs` : `Copy all ${list.length} IDs`;
              return (
                <button key={key} onMouseDown={keepFocus}
                  onClick={() => copy(key, idsMessage(list))}
                  className={`flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition ${copied === key
                    ? "bg-success-soft text-[#2f7a3d]" : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
                  {copied === key ? <><Check size={15} /> Copied {list.length}</> : <><Copy size={15} /> {label}</>}
                </button>
              );
            })}
            {/* Only picked rows: a whole tab decided by accident is too easy. */}
            {mayWork && pickedOpen.length > 0 && (
              <>
                {pickedOpen.some((r) => !lastTryOf(r)) && <button onMouseDown={keepFocus} disabled={!!marking}
                  onClick={() => decide(pickedOpen.filter((r) => !lastTryOf(r)).map((r) => r.tracking_id), "reattempt", "__bulk_re")}
                  className="flex h-10 items-center gap-2 rounded-full border border-[#38507a]/30 bg-periwinkle-soft px-4 text-[13px] font-semibold text-[#38507a] disabled:opacity-50">
                  {marking === "__bulk_re" ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />} Re-attempt {pickedOpen.filter((r) => !lastTryOf(r)).length}
                </button>}
                <button onMouseDown={keepFocus} disabled={!!marking} onClick={() => openReturn(pickedOpen)}
                  className="flex h-10 items-center gap-2 rounded-full border border-[#8d3328]/30 bg-danger-soft px-4 text-[13px] font-semibold text-[#8d3328] disabled:opacity-50">
                  <Undo2 size={15} /> Return {pickedOpen.length}
                </button>
              </>
            )}
            </div>
          </div>
        </div>
      )}

      {err && !open && !returning && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
          <span className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{err}</span>
          <button onClick={() => setErr("")} className="shrink-0 font-semibold opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {loading && !board && (
        <p className="flex items-center justify-center gap-2 px-4 py-14 text-[13px] text-muted dark:text-[#a89f93]">
          <Loader2 size={16} className="animate-spin" /> {view === "history" ? "Opening History…" : "Opening the desk…"}
        </p>
      )}

      {deskTab && desk && rows.length === 0 && !loading && (
        <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
          Nothing on its {ordinal(Number(tab))} try on {courier === "All"
            ? "PostEx's Delivery Under Review or OwnEx's Shipper Advice"
            : `${courier}'s ${listName(courier)}`} right now.
        </p>
      )}

      {/* ---------------------------------------------------------- Follow-up */}
      {tab === "follow" && desk && followShown.length === 0 && !loading && (
        <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
          Nothing to follow up{courier === "All" ? "" : ` with ${courier}`} — every parcel we re-attempted has been
          delivered, is on its way back, or is on a review list again.
        </p>
      )}
      {tab === "follow" && followShown.length > 0 && (
        <div className="mt-3 space-y-2 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:grid-cols-3">
          {followShown.map((r) => {
            const label = r.order_number ?? r.tracking_id;
            const lastLog = [...(r.reattempt_log ?? [])].reverse().find((e) => e.n != null);
            const cn = r.courier ?? "the courier";
            return (
              <div key={r.row_key} className="rounded-xl2 border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
                <button type="button" onClick={() => setOpenKey(r.row_key)} className="block w-full px-3 pt-3 text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                        <span className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{label}</span>
                        <Tag n={triesOf(r)} />
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                        {r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.cod_amount)}</div>
                  </div>
                  <div className="mt-1.5 text-[12px] font-semibold leading-snug text-[#38507a] dark:text-[#a9bde6]">
                    Re-attempted {r.our_reattempts ?? 1}× by us
                    {lastLog ? ` · last ${logLine(lastLog, cn, today).when} — ${logLine(lastLog, cn, today).how}` : ""}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                    {cn} says now: {r.raw_status ?? "—"} · sent out {r.sent_out ?? triesOf(r)} {(r.sent_out ?? triesOf(r)) === 1 ? "time" : "times"}
                  </div>
                </button>
                <div className="flex gap-2 px-3 pb-3 pt-2">
                  {r.phone ? (
                    <a href={`tel:${dial(r.phone)}`}
                      className="flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-panel px-2 text-[12.5px] font-semibold tabular-nums text-ink dark:bg-white/[0.07] dark:text-white">
                      <Phone size={13} className="shrink-0" /><span className="truncate">{r.phone}</span>
                    </a>
                  ) : <span className="flex h-10 min-w-0 flex-1 items-center justify-center truncate rounded-full bg-panel px-2 text-[12px] text-hint dark:bg-white/[0.05]">no number</span>}
                  {mayWork && r.again_block == null && (
                    <button type="button" onClick={() => setOpenKey(r.row_key)}
                      className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-[#38507a]/30 bg-periwinkle-soft px-3 text-[12.5px] font-semibold text-[#38507a]">
                      <RotateCw size={13} /> Re-attempt again
                    </button>
                  )}
                  {/* Three times out already: no "again" — it comes back. */}
                  {r.again_block === "third_time" && (
                    <span className="flex h-10 shrink-0 items-center justify-center rounded-full bg-danger-soft px-3 text-[12px] font-semibold text-[#8d3328]">
                      Out {r.sent_out ?? 3}× — return only
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ----------------------------------------------- cards (below 1280px) */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 space-y-2 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:hidden">
          {rows.map((r) => {
            const draft = riderDraft[r.tracking_id];
            const riderVal = draft ?? r.rider_phone ?? "";
            const dirty = draft !== undefined && draft !== (r.rider_phone ?? "");
            const on = picked.has(r.tracking_id);
            const lastTry = lastTryOf(r);
            const label = r.order_number ?? r.tracking_id;
            return (
              <div key={r.row_key} className={`rounded-xl2 border bg-surface dark:bg-[#201c17] ${on
                ? "border-ink dark:border-white/60" : "border-line dark:border-white/[0.06]"}`}>
                <div className="flex items-start gap-2.5 px-3 pt-3">
                  <label className="-m-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${label}`}
                      className="h-5 w-5 accent-[#141414] dark:accent-white" />
                  </label>
                  <button type="button" onClick={() => setOpenKey(r.row_key)} className="ml-1 min-w-0 flex-1 text-left">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                          <span className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{label}</span>
                          <OursChip r={r} />
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                          {r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.cod_amount)}</div>
                        <div className={`text-[11.5px] font-semibold ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)}</div>
                      </div>
                    </div>
                    <div className={`mt-1.5 truncate text-[12px] font-semibold ${r.reason ? "text-[#8d3328] dark:text-[#e8a397]" : "text-muted dark:text-[#a89f93]"}`}>
                      {reasonText(r)}
                    </div>
                  </button>
                </div>

                <div className="mt-2 px-3">
                  {r.phone ? (
                    <a href={`tel:${dial(r.phone)}`}
                      className="flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-full bg-panel px-2 text-[12.5px] font-semibold tabular-nums text-ink dark:bg-white/[0.07] dark:text-white">
                      <Phone size={13} className="shrink-0" /><span className="truncate">{r.phone}</span>
                    </a>
                  ) : <span className="flex h-10 min-w-0 items-center justify-center truncate rounded-full bg-panel px-2 text-[12px] text-hint dark:bg-white/[0.05]">no number</span>}
                </div>

                {/* THE TWO BUTTONS THE OWNER ASKED FOR. A third try can only come back.
                    Already settled but still listed (H297): say so instead. */}
                {settledOnList(r) ? (
                  <p className={`mx-3 mt-2 rounded-xl2 px-3 py-2 text-[12px] font-semibold leading-snug ${listedTone(r)}`}>
                    {listedNote(r, today)}
                  </p>
                ) : mayWork && (
                  <div className={`mt-2 grid gap-2 px-3 ${lastTry ? "grid-cols-1" : "grid-cols-2"}`}>
                    {!lastTry && (
                      <button onMouseDown={keepFocus} disabled={!!marking}
                        onClick={() => decide([r.tracking_id], "reattempt", r.tracking_id + ":re", label)}
                        aria-label={`Re-attempt ${label}`}
                        className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-[#38507a]/30 bg-periwinkle-soft text-[12.5px] font-semibold text-[#38507a] disabled:opacity-50">
                        {marking === r.tracking_id + ":re" ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Re-attempt
                      </button>
                    )}
                    <button onMouseDown={keepFocus} disabled={!!marking} onClick={() => openReturn([r])}
                      aria-label={`Return ${label}`}
                      className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-[#8d3328]/30 bg-danger-soft text-[12.5px] font-semibold text-[#8d3328] disabled:opacity-50">
                      <Undo2 size={13} /> {lastTry ? "Return — third try, it cannot go out again" : "Return"}
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 px-3 pb-3 pt-2">
                  <input value={riderVal} inputMode="tel" placeholder="Rider's number" disabled={!mayWork}
                    aria-label={`Rider's number for ${label}`}
                    onChange={(e) => setRiderDraft((d) => ({ ...d, [r.tracking_id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") saveRider(r); }}
                    className="h-10 min-w-0 flex-1 rounded-full border border-line bg-canvas px-3.5 text-[16px] text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
                  {dirty ? (
                    <button onMouseDown={keepFocus} onClick={() => saveRider(r)} disabled={savingRider === r.tracking_id}
                      className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                      {savingRider === r.tracking_id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
                    </button>
                  ) : (
                    <div className="flex shrink-0 gap-1">
                      <Step on={!!r.customer_called_at} text="cust" />
                      <Step on={!!r.verdict} text="verdict" />
                    </div>
                  )}
                </div>
                {riderErr[r.tracking_id] && (
                  <p className="-mt-1 px-4 pb-3 text-[12px] font-semibold text-red-700 dark:text-red-300">{riderErr[r.tracking_id]}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------------ desktop table */}
      {/* Fits a 1280px laptop with the menu open. Waiting rides under the
          amount and the two decisions stack in one column, so Copy and Done
          never fall off the right edge. */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 hidden xl:block">
          <div className="overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="bg-panel text-left text-[12px] text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Pick every row"
                      ref={(el) => { if (el) el.indeterminate = pickedRows.length > 0 && !allPicked; }}
                      className="h-4 w-4 accent-[#141414] dark:accent-white" />
                  </th>
                  {["Order", "Why It Failed", "Amount", "Customer", "Customer No.", "Rider No.", "Decide"].map((h, i) => (
                    <th key={h + i} className="whitespace-nowrap px-2 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const draft = riderDraft[r.tracking_id];
                  const riderVal = draft ?? r.rider_phone ?? "";
                  const dirty = draft !== undefined && draft !== (r.rider_phone ?? "");
                  const on = picked.has(r.tracking_id);
                  const lastTry = lastTryOf(r);
                  const label = r.order_number ?? r.tracking_id;
                  return (
                    <tr key={r.row_key} className={`border-t border-line align-top transition dark:border-white/[0.06] ${on ? "bg-panel dark:bg-white/[0.05]" : "hover:bg-panel/60 dark:hover:bg-white/[0.03]"}`}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${label}`}
                          className="h-4 w-4 accent-[#141414] dark:accent-white" />
                      </td>
                      <td className="px-2 py-2">
                        <button onClick={() => setOpenKey(r.row_key)} className="group text-left" title="Open the parcel">
                          <span className="flex items-center gap-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                            <span className="font-semibold text-ink underline-offset-2 group-hover:underline dark:text-[#f4f1ea]">{r.order_number ?? "—"}</span>
                            <OursChip r={r} />
                          </span>
                          <span className="mt-0.5 block text-[11.5px] tabular-nums text-muted dark:text-[#a89f93]">{r.tracking_id}</span>
                        </button>
                      </td>
                      <td className={`max-w-[136px] px-2 py-2.5 font-semibold leading-snug ${r.reason ? "text-[#8d3328] dark:text-[#e8a397]" : "font-normal text-hint"}`}>
                        {reasonText(r)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 tabular-nums">
                        {rs(r.cod_amount)}
                        <span className={`mt-0.5 block text-[11.5px] font-semibold ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)}</span>
                      </td>
                      <td className="max-w-[128px] px-2 py-2 leading-snug">
                        <span className="block truncate">{r.customer_name ?? "—"}</span>
                        {r.city && <span className="block truncate text-[11.5px] text-muted dark:text-[#a89f93]">{r.city}</span>}
                      </td>
                      <td className="px-2 py-2.5 tabular-nums">
                        {r.phone
                          ? <a href={`tel:${dial(r.phone)}`} title={r.phone} className="block max-w-[118px] truncate hover:underline">{r.phone}</a>
                          : <span className="text-hint">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <input value={riderVal} inputMode="tel" placeholder="Add number" disabled={!mayWork}
                            aria-label={`Rider's number for ${label}`}
                            onChange={(e) => setRiderDraft((d) => ({ ...d, [r.tracking_id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") saveRider(r); }}
                            className="h-8 w-[100px] rounded-lg border border-line bg-canvas px-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-ink disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
                          {dirty && (
                            <button onMouseDown={keepFocus} onClick={() => saveRider(r)} disabled={savingRider === r.tracking_id} title="Save the rider's number"
                              className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                              {savingRider === r.tracking_id ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
                            </button>
                          )}
                        </div>
                        {riderErr[r.tracking_id] && (
                          <p className="mt-0.5 text-[11.5px] font-semibold text-red-700 dark:text-red-300">{riderErr[r.tracking_id]}</p>
                        )}
                      </td>
                      <td className="px-2 py-1.5 pr-3">
                        {settledOnList(r) ? (
                          <p className={`w-[150px] rounded-lg px-2 py-1.5 text-[11.5px] font-semibold leading-snug ${listedTone(r)}`}>
                            {listedNote(r, today)}
                          </p>
                        ) : mayWork ? (
                          <div className="flex w-[96px] flex-col gap-1">
                            <button onClick={() => decide([r.tracking_id], "reattempt", r.tracking_id + ":re", label)}
                              disabled={!!marking || lastTry} aria-label={`Re-attempt ${label}`}
                              title={lastTry ? "Third try — it can only come back" : "Record a re-attempt — it moves to History"}
                              className="flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#38507a]/30 bg-periwinkle-soft px-2 text-[12px] font-semibold text-[#38507a] disabled:opacity-40">
                              {marking === r.tracking_id + ":re" ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Re-attempt
                            </button>
                            <button onClick={() => openReturn([r])} disabled={!!marking} aria-label={`Return ${label}`}
                              title="Record a return — it asks why"
                              className="flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#8d3328]/30 bg-danger-soft px-2 text-[12px] font-semibold text-[#8d3328] disabled:opacity-50">
                              <Undo2 size={13} /> Return
                            </button>
                          </div>
                        ) : <span className="text-hint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ History */}
      {view === "history" && hist && histShown.length === 0 && !loading && (
        <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
          {histBase.length || q || courier !== "All"
            ? "Nothing matches — try another filter."
            : `Nothing in History for ${spanLabel}.`}
        </p>
      )}
      {view === "history" && hist && days.map(([day, list]) => (
        <section key={day} className="mt-4">
          <h3 className="flex items-baseline gap-2 px-1 text-[13px] font-bold text-ink dark:text-[#f4f1ea]">
            <History size={13} className="self-center text-muted dark:text-[#a89f93]" />
            {day === "—" ? "No Date" : dayName(day, hist.today)}
            {day !== "—" && dayName(day, hist.today) !== dateOf(day, true) && (
              <span className="font-semibold text-muted dark:text-[#a89f93]">{dateOf(day, true)}</span>
            )}
            <span className="ml-auto text-[12px] font-semibold tabular-nums text-muted dark:text-[#a89f93]">
              {list.length} {list.length === 1 ? "parcel" : "parcels"}
            </span>
          </h3>
          <div className="mt-1.5 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            {list.map((r) => {
              const lf = leftOf(r.left_as);
              const then = afterDone(r);
              return (
                /* Phone: the order keeps the first line, the badge rides at its
                   end and what it means goes underneath. */
                <button key={r.row_key} type="button" onClick={() => setOpenKey(r.row_key)}
                  className="block w-full border-t border-line px-3 py-2.5 text-left transition first:border-t-0 hover:bg-panel/60 active:bg-panel md:flex md:items-start md:gap-4 dark:border-white/[0.06] dark:hover:bg-white/[0.03]">
                  <div className="min-w-0 md:flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                      <span className="min-w-0 truncate text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? r.tracking_id}</span>
                      <Tag n={r.attempt_no} />
                      <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold md:hidden ${lf?.tone ?? ""}`}>{lf?.label ?? r.left_as}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                      {r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""} · {rs(r.cod_amount)}{r.reason ? ` · ${r.reason}` : ""}
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-muted md:hidden dark:text-[#a89f93]">
                      {leftDetail(r, hist.today)}{then ? ` · ${then}` : ""}
                    </div>
                  </div>
                  <div className="hidden min-w-0 shrink-0 text-right md:block md:w-[46%]">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${lf?.tone ?? ""}`}>{lf?.label ?? r.left_as}</span>
                      {then && <span className="rounded-full bg-panel px-1.5 py-0.5 text-[10.5px] font-semibold text-muted dark:bg-white/[0.07] dark:text-[#a89f93]">{then}</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">{leftDetail(r, hist.today)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!compact && board && (
        <p className="mt-4 px-1 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
          The desk is exactly what PostEx lists under Delivery Under Review and OwnEx under Shipper Advice — both
          lists, and both couriers&rsquo; own histories, are read every 10 minutes (and when you press Refresh), and
          this screen looks again every 2 minutes. A parcel stays here as long as the courier lists it; when it
          leaves the list its line stays in History — who decided what, and when — and every re-attempt, ours or
          the courier&rsquo;s, is counted on the parcel. Follow-up holds the parcels we re-attempted that are not
          delivered yet: if the customer says it never came, Re-attempt again records it, because the
          courier&rsquo;s portal has no button for it by then. Three times out, then it comes back. The re-attempt
          or the return is still pressed in the courier&rsquo;s own portal — this desk decides and records, it does
          not send anything to them.
        </p>
      )}

      {open && !returning && (
        <CaseSheet
          r={open} mayWork={mayWork} phone={phone} err={err} today={today}
          onClose={() => setOpenKey(null)} onDismissErr={() => setErr("")}
          onCopy={() => copy(open.tracking_id, open.tracking_id)} copied={copied === open.tracking_id}
          onSave={(patch) => save(open.tracking_id, patch)}
          onDone={(done) => markDone([open.tracking_id], done, "__sheet", open.order_number ?? open.tracking_id)}
          onReattempt={() => decide([open.tracking_id], "reattempt", "__sheet", open.order_number ?? open.tracking_id)}
          onReturn={() => openReturn([open])}
          onAgain={(note) => again(open, note)}
          onAgainFix={againFix}
          againBusy={marking === "__again" || marking === "__againfix"}
          onUndoDecision={async () => {
            if (!supabase) return;
            setMarking("__sheet");
            const { data, error } = await supabase.rpc("hub_rescue_decide", { p_trackings: [open.tracking_id], p_decision: "undo" });
            setMarking("");
            const r = (data ?? {}) as { ok?: boolean; error?: string };
            if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not undo that."); return; }
            setOpenKey(null); await loadRef.current();
          }}
          busy={marking === "__sheet"}
        />
      )}

      {returning && (
        <ReturnDialog
          rows={returning} err={err} busy={marking === "__return"}
          onClose={() => { setReturning(null); setErr(""); }}
          onConfirm={async (reason) => {
            const ids = returning.map((r) => r.tracking_id);
            const one = returning.length === 1 ? (returning[0].order_number ?? returning[0].tracking_id) : undefined;
            const ok = await decide(ids, "return", "__return", one, reason);
            if (ok) setReturning(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/* A time on today's list reads as a clock; an older one says its day. */
const readAt = (iso: string, today: string) => (ymdPK(new Date(iso)) === today ? clock(iso) : when(iso, today));

/* EXACTLY WHAT THE COURIERS LIST (H297), and how fresh each list is. A list
   that could not be read says so; the desk keeps the last good one. */
function ListsLine({ lists, today }: { lists?: Board["lists"]; today: string }) {
  const now = Date.now();
  const parts = (["PostEx", "OwnEx"] as const).map((c) => {
    const l = lists?.[c];
    return { c, l, stale: !l?.read_at || now - new Date(l.read_at).getTime() > 35 * 60000 };
  });
  const px = parts[0].l, ox = parts[1].l;
  return (
    <div className="mt-2 space-y-1 px-1 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
      <p>
        Exactly what <b className="font-semibold text-ink dark:text-[#f4f1ea]">PostEx</b> lists under Delivery Under Review
        {px?.read_at ? ` (${px.n}, read ${readAt(px.read_at, today)})` : ""} and{" "}
        <b className="font-semibold text-ink dark:text-[#f4f1ea]">OwnEx</b> under Shipper Advice
        {ox?.read_at ? ` (${ox.n}, read ${readAt(ox.read_at, today)})` : ""} — both read every 10 minutes. Nothing else
        is on the desk.
      </p>
      {parts.map(({ c, l, stale }) => {
        const warn = "flex items-start gap-1.5 font-semibold text-[#8a6218] dark:text-[#e0b77c]";
        if (!l?.read_at) {
          return <p key={c} className={warn}><AlertTriangle size={13} className="mt-0.5 shrink-0" />{c}&rsquo;s list has not been read yet — press Refresh.</p>;
        }
        if (l.last_ok === false && l.last_at) {
          return (
            <p key={c} className={warn} title={l.error ?? ""}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {c}&rsquo;s list could not be read at {readAt(l.last_at, today)}{l.error ? ` (${l.error.slice(0, 90)})` : ""} —
              this is the list as read at {readAt(l.read_at, today)}.
            </p>
          );
        }
        if (stale) {
          return <p key={c} className={warn}><AlertTriangle size={13} className="mt-0.5 shrink-0" />{c}&rsquo;s list was last read {when(l.read_at, today)} — press Refresh.</p>;
        }
        return null;
      })}
    </div>
  );
}

/* Re-attempted by us before, on any try (H297). */
const OursChip = ({ r }: { r: Row }) => ((r.our_reattempts ?? 0) > 0 ? (
  <span title="Re-attempts by us: decided here, pressed on the courier's portal, or re-attempted again from our side"
    className="shrink-0 rounded-full bg-periwinkle-soft px-1.5 py-0.5 text-[10.5px] font-bold text-[#38507a]">
    {r.our_reattempts}× by us
  </span>
) : null);

/* Settled but still listed: green when nothing is left to do, amber when it
   was decided here and still has to be pressed on the courier's portal. */
const listedTone = (r: Row) =>
  r.decision && r.decided_via === "desk" && r.courier_advice !== r.decision
    ? "bg-amber-soft text-[#7a5a28]"
    : "bg-success-soft text-[#2f7a3d]";

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-muted dark:text-[#a89f93]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />{tc(label)}
      </div>
      <div className="mt-1 text-[22px] font-extrabold leading-none tabular-nums text-ink dark:text-[#f4f1ea]">{value}</div>
      <div className="mt-1 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">{sub}</div>
    </div>
  );
}

const Chip = ({ on, onClick, label, n }: { on: boolean; onClick: () => void; label: string; n: number }) => (
  <button type="button" onClick={onClick} aria-pressed={on}
    className={`flex h-10 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition xl:h-8 ${on
      ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
      : "border-line bg-surface text-muted hover:text-ink dark:border-white/10 dark:bg-white/[0.05] dark:text-[#a89f93] dark:hover:text-white"}`}>
    {label}<span className="tabular-nums opacity-70">{n}</span>
  </button>
);

const Tag = ({ n }: { n: number }) => (
  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${n >= 3
    ? "bg-danger-soft text-[#8d3328]" : n === 2 ? "bg-amber-soft text-[#7a5a28]" : "bg-panel text-muted dark:bg-white/[0.07] dark:text-[#a89f93]"}`}>
    {ordinal(n)} try
  </span>
);

const Step = ({ on, text }: { on: boolean; text: string }) => (
  <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold capitalize ${on
    ? "bg-success-soft text-[#2f7a3d]" : "bg-panel text-hint dark:bg-white/[0.06] dark:text-[#8a8175]"}`}>
    {on ? "✓ " : ""}{text}
  </span>
);

/* WHY SHOULD IT COME BACK? A button for the usual reasons, a box for anything
   else or anything to add. Nothing is sent until a reason is given. */
function ReturnDialog({ rows, err, busy, onClose, onConfirm }: {
  rows: Row[]; err: string; busy: boolean;
  onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [pick, setPick] = useState("");
  const [more, setMore] = useState("");
  const reason = [pick, more.trim()].filter(Boolean).join(" — ");
  const ready = !!pick || more.trim().length >= 4;
  const one = rows.length === 1 ? rows[0] : null;
  const courierSays = [...new Set(rows.map((r) => r.reason).filter(Boolean))] as string[];
  return (
    <Sheet open onClose={onClose}
      title={one ? `Return ${one.order_number ?? one.tracking_id}?` : `Return ${rows.length} Parcels?`}
      subtitle="Say why it should come back. The reason is kept with the parcel in History."
      footer={
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="h-11 rounded-full border border-line text-[13px] font-semibold text-ink dark:border-white/15 dark:text-white">
            Cancel
          </button>
          <button onClick={() => ready && onConfirm(reason)} disabled={!ready || busy}
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#8d3328] text-[13px] font-bold text-white disabled:opacity-40">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
            {one ? "Record the return" : `Return ${rows.length}`}
          </button>
        </div>
      }>
      {err && (
        <div className="mb-2 rounded-xl2 border border-red-300 bg-red-50 p-2.5 text-[12.5px] text-red-800">{err}</div>
      )}
      {courierSays.length > 0 && (
        <p className="mb-2 rounded-xl2 bg-panel px-3 py-2 text-[12.5px] leading-snug text-ink dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <b>{rows[0]?.courier ?? "The courier"} says:</b> {courierSays.join(" · ")}
        </p>
      )}
      <div role="radiogroup" aria-label="Reason for the return" className="grid gap-1.5 sm:grid-cols-2">
        {RETURN_REASONS.map((x) => (
          <button key={x} role="radio" aria-checked={pick === x} onClick={() => setPick(pick === x ? "" : x)}
            className={`min-h-[44px] rounded-xl2 border px-3 py-2 text-left text-[13px] font-semibold transition ${pick === x
              ? "border-[#8d3328] bg-danger-soft text-[#8d3328]"
              : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-white"}`}>
            {x}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-[12.5px] font-semibold text-ink dark:text-[#f4f1ea]">
        {pick ? "Anything to add?" : "Or write the reason"}
        <textarea value={more} onChange={(e) => setMore(e.target.value)} rows={2}
          placeholder={pick ? "Optional — what the customer or rider said" : "e.g. Customer says he ordered by mistake"}
          className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[16px] font-normal text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
      </label>
      {!ready && (
        <p className="mt-1 text-[12px] text-muted dark:text-[#a89f93]">Pick a reason or write one — a return is not recorded without it.</p>
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        This records the decision and moves {one ? "the parcel" : "them"} to History. Press Return on the courier&rsquo;s own
        portal too — this desk does not send it.
      </p>
    </Sheet>
  );
}

/* The whole job for one parcel, in the order it is done. */
function CaseSheet({ r, mayWork, phone, err, today, onClose, onDismissErr, onCopy, copied, onSave, onDone,
  onReattempt, onReturn, onUndoDecision, busy, onAgain, onAgainFix, againBusy }: {
  r: Row; mayWork: boolean; phone: boolean; err: string; today: string;
  onClose: () => void; onDismissErr: () => void;
  onCopy: () => void; copied: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  onDone: (done: boolean) => void;
  onReattempt: () => void; onReturn: () => void; onUndoDecision: () => void;
  busy: boolean;
  onAgain: (note: string) => Promise<boolean>;
  onAgainFix: (id: number, note: string | null, takeBack: boolean) => Promise<boolean>;
  againBusy: boolean;
}) {
  const cn = r.courier ?? "the courier";
  const [rider, setRider] = useState(r.rider_phone ?? "");
  const [cust, setCust] = useState(r.customer_said ?? "");
  const [ridr, setRidr] = useState(r.rider_said ?? "");
  const [saving, setSaving] = useState("");
  /* "Re-attempt again": what the customer said, and a note being corrected. */
  const [againPick, setAgainPick] = useState("");
  const [againMore, setAgainMore] = useState("");
  const [fixing, setFixing] = useState<{ id: number; note: string } | null>(null);
  /* ONLY on a different line (a parcel, or another try of it). Depending on
     the three values as well meant that saving one of them re-ran this and
     overwrote the other two with the stale server copy. */
  useEffect(() => {
    setRider(r.rider_phone ?? ""); setCust(r.customer_said ?? ""); setRidr(r.rider_said ?? "");
    setAgainPick(""); setAgainMore(""); setFixing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.row_key]);

  const wa = waNumber(r.phone);
  const lastTry = lastTryOf(r);
  const log = r.reattempt_log ?? [];
  /* the newest "again" still on record — the only one that can be taken back */
  const latestAgainId = [...log].reverse().find((e) => e.how === "again" && e.id != null)?.id ?? null;
  const days = r.queue_days ?? [];
  const sentOut = r.sent_out ?? triesOf(r);
  const againNote = [againPick, againMore.trim()].filter(Boolean).join(" — ");
  const nextOurs = (r.our_reattempts ?? 0) + 1;
  /* "the first, then 1 re-attempt by us, 1 by PostEx itself" — and any try
     the courier counted with no re-attempt on record, so the parts add up. */
  const ours = r.our_reattempts ?? 0, theirs = r.courier_reattempts ?? 0;
  const unrecorded = Math.max(0, sentOut - 1 - ours - theirs);
  const sentOutWords = sentOut > 1
    ? "the first, then " + [ours ? `${ours} re-attempt${ours === 1 ? "" : "s"} by us` : "",
                             theirs ? `${theirs} by ${cn} itself` : "",
                             unrecorded ? `${unrecorded} with no re-attempt on record` : ""].filter(Boolean).join(", ")
    : "";
  const repeat = r.past_refusals >= 2;
  /* An earlier try's line is read-only: the case now belongs to the try it
     is on, and an edit here would land on that one. */
  const earlierTry = r.attempt_no < r.attempts;
  const lf = r.left_as !== "desk" ? leftOf(r.left_as) : undefined;
  const canEdit = mayWork && !earlierTry;
  const settled = r.status === "done" || !!r.outcome;

  async function run(key: string, patch: Record<string, unknown>) {
    setSaving(key); await onSave(patch); setSaving("");
  }

  return (
    <Sheet open onClose={onClose}
      title={r.order_number ?? r.tracking_id}
      subtitle={`${cn} · ${r.store_code ?? "—"} · ${r.tracking_id} · ${rs(r.cod_amount)}`}>

      {err && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded-xl2 border border-red-300 bg-red-50 p-2.5 text-[12.5px] text-red-800">
          <span>{err}</span>
          <button onClick={onDismissErr} className="shrink-0 font-semibold opacity-60">Dismiss</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag n={earlierTry ? r.attempt_no : triesOf(r)} />
        <OursChip r={r} />
        {listed(r) && (
          <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-bold text-[#7a5a28]">
            On {cn}&rsquo;s {listName(r.courier)} now
          </span>
        )}
        {r.last_failed_at && !earlierTry && (
          <span className={`text-[12px] font-semibold ${heat(r.waiting_hours)}`}>
            failed {when(r.last_failed_at, today)}
          </span>
        )}
        {r.outcome && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.outcome === "delivered" ? "bg-success-soft text-[#2f7a3d]" : "bg-danger-soft text-[#8d3328]"}`}>
            {r.outcome === "delivered" ? "Delivered in the end" : "Came back"}
          </span>
        )}
      </div>

      {r.src === "follow" ? (
        <p className="mt-2 rounded-xl2 bg-periwinkle-soft px-3 py-2 text-[12px] leading-snug text-[#38507a]">
          <b>Follow-up — re-attempted {r.our_reattempts ?? 1}× by us, not delivered yet.</b> {cn} says now:{" "}
          {r.raw_status ?? "—"}. Ring the customer; if it has not reached him, record it below.
        </p>
      ) : lf && (
        <p className="mt-2 rounded-xl2 bg-panel px-3 py-2 text-[12px] leading-snug text-ink dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <b>In History — {lf.label.toLowerCase()}.</b> {leftDetail(r, today)}
          {earlierTry && <> This line is its {ordinal(r.attempt_no)} try; the parcel is on its {ordinal(triesOf(r))} now.</>}
        </p>
      )}
      {r.left_as === "desk" && settledOnList(r) && (
        <p className={`mt-2 rounded-xl2 px-3 py-2 text-[12px] font-semibold leading-snug ${listedTone(r)}`}>
          {listedNote(r, today)}
        </p>
      )}
      {lastTry && !earlierTry && !r.outcome && (
        <p className="mt-2 rounded-xl2 bg-danger-soft px-3 py-2 text-[12px] font-semibold leading-snug text-[#8d3328]">
          Sent out {sentOut} {sentOut === 1 ? "time" : "times"} already. It comes back to the warehouse and the order is
          cancelled by hand — it does not go out again.
        </p>
      )}
      {r.rider_strikes >= 2 && r.rider_phone && (
        <p className="mt-2 rounded-xl2 bg-periwinkle-soft px-3 py-2 text-[12px] leading-snug text-[#38507a]">
          <b>This rider has {r.rider_strikes} other parcels blamed on him this year.</b> Worth raising with {cn} by
          name rather than parcel by parcel.
        </p>
      )}
      {repeat && (
        <p className="mt-2 rounded-xl2 bg-amber-soft px-3 py-2 text-[12px] leading-snug text-[#7a5a28]">
          <b>{ordinal(r.past_refusals + 1)} refusal from this number.</b> Confirm the next order before it is dispatched,
          take the payment in advance, or set a minimum — do not send another COD parcel to it blind.
        </p>
      )}

      <div className="mt-2">
        <Detail label="Why it failed">
          {r.reason ?? <span className="font-normal text-muted">{reasonText(r)}</span>}
        </Detail>
        {r.courier_attempt_at && !earlierTry && (
          <Detail label={`${cn}'s last try`}>
            {r.courier_attempts ? `${ordinal(r.courier_attempts)} · ` : ""}{when(r.courier_attempt_at, today)}
          </Detail>
        )}
        {r.courier_advice && r.courier_advice_at && !earlierTry && (
          <Detail label={`On ${cn}'s portal`}>
            {r.courier_advice_by === "courier"
              ? courierDid(cn, r.courier_advice, "courier")
              : `${r.courier_advice === "return" ? "Return" : "Re-attempt"} requested`} · {when(r.courier_advice_at, today)}
          </Detail>
        )}
        <Detail label={`${cn} says now`}>{r.raw_status ?? r.q_status ?? "—"}</Detail>
        {/* H297: the history the courier's portal does not keep */}
        <Detail label={`On ${cn}'s list`}>
          {days.length
            ? <>{days.slice(0, 8).map((d) => dateOf(d.day)).join(", ")}{days.length > 8 ? ` and ${days.length - 8} more` : ""}
                {listed(r) ? " · on it now" : ""}</>
            : <span className="font-normal text-muted">not seen on it since the desk began reading the lists (21 Oct)</span>}
        </Detail>
        <Detail label="Sent out">
          {sentOut} {sentOut === 1 ? "time" : "times"}
          {sentOutWords && <span className="font-normal text-muted dark:text-[#a89f93]"> — {sentOutWords}</span>}
        </Detail>
        <Detail label="Dispatched">{r.dispatch_date ? dateOf(r.dispatch_date) : "—"}</Detail>
        <Detail label="Customer">{r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""}</Detail>
        {r.address && <Detail label="Address">{r.address}</Detail>}
      </div>

      {/* --- 1. ring the customer ------------------------------------------ */}
      <Block n="1" title="Ring the customer" done={!!r.customer_called_at}>
        {r.phone ? (
          <div className="flex gap-2">
            <a href={`tel:${dial(r.phone)}`} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-ink text-[13px] font-semibold text-white dark:bg-white dark:text-[#141414]">
              <Phone size={15} /> {r.phone}
            </a>
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp the customer"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#E1F5EE] text-[#085041] dark:bg-[#12302A] dark:text-[#7FD3B8]">
                <MessageCircle size={17} />
              </a>
            )}
          </div>
        ) : <p className="text-[12.5px] text-muted dark:text-[#a89f93]">No number on the order.</p>}
        <textarea value={cust} onChange={(e) => setCust(e.target.value)} rows={2} disabled={!canEdit}
          placeholder="What did he say? Was he called? Was he at the address?"
          className="mt-2 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && cust !== (r.customer_said ?? "") && (
            <SaveBtn busy={saving === "cust"} onClick={() => run("cust", { p_customer_said: cust })} />
          )}
          {canEdit && !r.customer_called_at && (
            <button onClick={() => { setCust("No answer"); run("noans", { p_customer_said: "No answer" }); }}
              disabled={saving === "noans"}
              className="mt-2 flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[12.5px] font-semibold text-muted disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-[#a89f93]">
              {saving === "noans" ? <Loader2 size={13} className="animate-spin" /> : null} No answer
            </button>
          )}
        </div>
      </Block>

      {/* --- 2. the group --------------------------------------------------- */}
      <Block n="2" title="Ask the group for the rider" done={!!r.rider_phone}>
        <p className="text-[12.5px] leading-snug text-muted dark:text-[#a89f93]">
          Copy, paste into {cn}&rsquo;s dealership group, and type the number they send back.
        </p>
        <button onClick={onCopy}
          className={`mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full text-[13px] font-semibold transition ${copied
            ? "bg-success-soft text-[#2f7a3d]" : "border border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white"}`}>
          {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy the tracking ID</>}
        </button>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-xl2 bg-panel px-3 py-2 text-[11.5px] leading-relaxed text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">{r.tracking_id}</pre>
        <div className="mt-2 flex gap-2">
          <input value={rider} onChange={(e) => setRider(e.target.value)} disabled={!canEdit}
            inputMode="tel" placeholder="Rider's number"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          {canEdit && rider !== (r.rider_phone ?? "") && (
            <button onMouseDown={keepFocus} onClick={() => run("rider", { p_rider_phone: rider })} disabled={saving === "rider"}
              className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
              {saving === "rider" ? <Loader2 size={14} className="animate-spin" /> : null} Save
            </button>
          )}
        </div>
      </Block>

      {/* --- 3. ring the rider ---------------------------------------------- */}
      <Block n="3" title="Ring the rider" done={!!r.rider_called_at}>
        {r.rider_phone ? (
          <a href={`tel:${dial(r.rider_phone)}`} className="flex h-11 items-center justify-center gap-2 rounded-full bg-ink text-[13px] font-semibold text-white dark:bg-white dark:text-[#141414]">
            <Phone size={15} /> {r.rider_phone}
          </a>
        ) : <p className="text-[12.5px] text-muted dark:text-[#a89f93]">Add his number above first.</p>}
        <textarea value={ridr} onChange={(e) => setRidr(e.target.value)} rows={2} disabled={!canEdit || !r.rider_phone}
          placeholder="Did he call? Did he reach the address? What happened?"
          className="mt-2 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        {canEdit && ridr !== (r.rider_said ?? "") && (
          <SaveBtn busy={saving === "ridr"} onClick={() => run("ridr", { p_rider_said: ridr })} />
        )}
      </Block>

      {/* --- 4. the verdict -------------------------------------------------- */}
      <Block n="4" title="Whose failure was it?" done={!!r.verdict}>
        <div className="grid grid-cols-3 gap-2">
          {VERDICTS.map(({ key, label, Icon }) => {
            const on = r.verdict === key;
            return (
              <button key={key} disabled={!canEdit || saving === "v" + key} onClick={() => run("v" + key, { p_verdict: key })}
                className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl2 border px-1 text-[12px] font-semibold transition disabled:opacity-60 ${on
                  ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
                  : "border-line bg-surface text-muted hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-[#a89f93]"}`}>
                <Icon size={17} /> {label}
              </button>
            );
          })}
        </div>
        {r.verdict === "customer" && (
          <p className="mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
            Counted against this number. On its third refusal the desk will say so on the next parcel.
          </p>
        )}
        {r.verdict === "rider" && r.rider_phone && (
          <p className="mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
            Logged against {r.rider_phone}.{" "}
            {r.rider_strikes > 0
              ? `${r.rider_strikes + 1} parcels now blamed on this rider in the last year — take it to ${cn} with the tracking numbers.`
              : "The first on this rider. Three of them is a complaint the courier has to answer."}
          </p>
        )}
      </Block>

      {/* --- 5. re-attempt or return ----------------------------------------- */}
      <Block n="5" title="Re-attempt or return?" done={!!r.decision}>
        {r.decision && (
          <p className="mb-2 text-[12.5px] leading-snug text-ink dark:text-[#f4f1ea]">
            <b>{r.decision === "return" ? "Return" : "Re-attempt"}</b> — {decidedBy(r)}
            {r.decided_at ? `, ${when(r.decided_at, today)}` : ""}
            {r.return_reason ? <>. Reason: &ldquo;{r.return_reason}&rdquo;</> : null}
          </p>
        )}
        {canEdit && !settled && (
          <div className="grid grid-cols-2 gap-2">
            <button disabled={lastTry || busy} onClick={onReattempt}
              className="flex min-h-[48px] items-center justify-center gap-2 rounded-full border border-[#38507a]/30 bg-periwinkle-soft px-3 text-[13px] font-semibold text-[#38507a] disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />} Re-attempt
            </button>
            <button disabled={busy} onClick={onReturn}
              className="flex min-h-[48px] items-center justify-center gap-2 rounded-full border border-[#8d3328]/30 bg-danger-soft px-3 text-[13px] font-semibold text-[#8d3328] disabled:opacity-50">
              <Undo2 size={15} /> Return
            </button>
          </div>
        )}
        <p className="mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
          {lastTry
            ? `Sent out ${sentOut} times — Return only, and cancel the order in Shopify; this desk does not touch Shopify.`
            : `Either one is kept in History. Then press the same on ${cn}'s own portal — this desk does not send it.`}
        </p>
      </Block>

      {/* --- 6. every re-attempt, ours and the courier's (H297) --------------- */}
      {log.length > 0 && (
        <section className="mt-4 border-t border-line pt-3 dark:border-white/[0.06]">
          <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">
            <History size={15} className="text-muted dark:text-[#a89f93]" />
            {tc("Re-attempts so far")}
            <span className="ml-auto text-[12px] font-semibold tabular-nums text-muted dark:text-[#a89f93]">
              {r.our_reattempts ?? 0} by us{(r.courier_reattempts ?? 0) > 0 ? ` · ${r.courier_reattempts} by ${cn}` : ""}
            </span>
          </h3>
          <ol className="space-y-1.5">
            {[...log].reverse().map((e, i) => {
              const w = logLine(e, cn, today);
              const editing = fixing && e.id != null && fixing.id === e.id;
              return (
                <li key={`${e.how}:${e.id ?? i}:${e.at ?? ""}`}
                  className="rounded-xl2 bg-panel px-3 py-2 text-[12.5px] leading-snug text-ink dark:bg-white/[0.05] dark:text-[#f4f1ea]">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span><b>{w.who}</b> — {w.how}</span>
                    <span className="text-[11.5px] tabular-nums text-muted dark:text-[#a89f93]">{w.when}{e.try ? ` · ${ordinal(e.try)} try` : ""}</span>
                  </div>
                  {e.note && !editing && <div className="mt-0.5 text-muted dark:text-[#a89f93]">&ldquo;{e.note}&rdquo;</div>}
                  {editing && (
                    <div className="mt-1.5">
                      <textarea value={fixing.note} onChange={(ev) => setFixing({ id: fixing.id, note: ev.target.value })} rows={2} maxLength={300}
                        aria-label="The note" className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[16px] text-ink outline-none md:text-[13px] dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
                      <div className="mt-1.5 flex gap-2">
                        <button onMouseDown={keepFocus} disabled={againBusy}
                          onClick={async () => { if (await onAgainFix(fixing.id, fixing.note.trim() || null, false)) setFixing(null); }}
                          className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                          {againBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save the note
                        </button>
                        <button onClick={() => setFixing(null)} className="h-9 rounded-full px-3 text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">Cancel</button>
                      </div>
                    </div>
                  )}
                  {mayWork && e.how === "again" && e.id != null && !editing && (
                    <div className="mt-1 flex flex-wrap gap-3 text-[12px] font-semibold">
                      <button onClick={() => setFixing({ id: e.id as number, note: e.note ?? "" })}
                        className="text-[#38507a] underline-offset-2 hover:underline dark:text-[#a9bde6]">Edit the note</button>
                      {e.id === latestAgainId && (
                        <button disabled={againBusy} onClick={() => onAgainFix(e.id as number, null, true)}
                          className="text-[#8d3328] underline-offset-2 hover:underline disabled:opacity-50 dark:text-[#e8a397]">
                          Take it back — recorded by mistake
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* --- 7. re-attempt again, from our side (H297) ------------------------ */}
      {mayWork && r.again_block === null && (
        <section className="mt-4 border-t border-line pt-3 dark:border-white/[0.06]">
          <h3 className="mb-1 flex items-center gap-2 text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">
            <RotateCw size={15} className="text-[#38507a]" /> {tc("Re-attempt again")}
          </h3>
          <p className="text-[12px] leading-snug text-muted dark:text-[#a89f93]">
            Rang the customer and it has not reached him? Ask {cn} to send it out again — their group or helpline —
            and record it here. It is on no review list now, so {cn}&rsquo;s portal has no button for it. This will be
            the <b className="text-ink dark:text-[#f4f1ea]">{ordinal(nextOurs)} re-attempt by us</b>, and the{" "}
            {ordinal(sentOut + 1)} time out{sentOut + 1 >= 3 ? " — the last one: after it, the parcel comes back" : ""}.
          </p>
          <div role="radiogroup" aria-label="What the customer said" className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {AGAIN_REASONS.map((x) => (
              <button key={x} role="radio" aria-checked={againPick === x} onClick={() => setAgainPick(againPick === x ? "" : x)}
                className={`min-h-[44px] rounded-xl2 border px-3 py-2 text-left text-[13px] font-semibold transition ${againPick === x
                  ? "border-[#38507a] bg-periwinkle-soft text-[#38507a] ring-1 ring-[#38507a]"
                  : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-white"}`}>
                {againPick === x ? "✓ " : ""}{x}
              </button>
            ))}
          </div>
          <textarea value={againMore} onChange={(e) => setAgainMore(e.target.value)} rows={2} maxLength={250}
            placeholder="Anything to add — optional" aria-label="Anything to add"
            className="mt-2 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          <button onMouseDown={keepFocus} disabled={againBusy} onClick={() => onAgain(againNote)}
            className="mt-2 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full border border-[#38507a]/30 bg-periwinkle-soft px-3 text-[13px] font-bold text-[#38507a] disabled:opacity-50">
            {againBusy ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
            Record the {ordinal(nextOurs)} re-attempt
          </button>
        </section>
      )}
      {mayWork && r.again_block === "third_time" && !earlierTry && r.status === "done" && (
        <p className="mt-4 rounded-xl2 bg-danger-soft px-3 py-2 text-[12px] font-semibold leading-snug text-[#8d3328]">
          Sent out {sentOut} times already — by the rule it is not re-attempted again. If the customer says it never
          came, ask {cn} to return it.
        </p>
      )}

      {/* --- done / undo ------------------------------------------------------ */}
      {canEdit && !r.outcome && (
        r.status === "open" ? (
          <button onClick={() => onDone(true)} disabled={busy}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-[#2f7a3d]/40 bg-surface text-[13px] font-semibold text-[#2f7a3d] disabled:opacity-50 dark:bg-white/[0.06] dark:text-[#8fd49a]">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Mark done without a decision
          </button>
        ) : r.decided_via === "courier" ? null : (
          <button onClick={() => (r.decision ? onUndoDecision() : onDone(false))} disabled={busy}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[13px] font-semibold text-ink disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={15} />}
            {r.decision ? `Undo the ${r.decision === "return" ? "return" : "re-attempt"}` : "Undo done"}
          </button>
        )
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        {r.outcome
          ? `${cn} has settled it — ${r.outcome === "delivered" ? "delivered" : "returned"}. Nothing is left to work on this parcel.`
          : earlierTry
            ? `To work its ${ordinal(triesOf(r))} try, open that one — on the desk if ${cn} lists it now, otherwise higher up in History.`
            : r.decided_via === "courier"
              ? `Settled on ${cn}'s own portal — the desk read it from ${cn}'s history. Nothing to undo here.`
              : r.status === "open"
                ? (listed(r)
                    ? `On ${cn}'s ${listName(r.courier)} now. Decide it here, then press the same on ${cn}'s portal.`
                    : `Not on ${cn}'s ${listName(r.courier)} — when ${cn} lists it, it is on the desk by itself.`)
                : `Undo puts it back to be decided again, while ${cn} has done nothing with it yet.`}
      </p>
      {phone && <div className="h-1" />}
    </Sheet>
  );
}

function Block({ n, title, done, children }: { n: string; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-line pt-3 dark:border-white/[0.06]">
      <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${done
          ? "bg-success-soft text-[#2f7a3d]" : "bg-panel text-muted dark:bg-white/[0.07] dark:text-[#a89f93]"}`}>
          {done ? "✓" : n}
        </span>
        {tc(title)}
      </h3>
      {children}
    </section>
  );
}

const SaveBtn = ({ busy, onClick }: { busy: boolean; onClick: () => void }) => (
  <button onMouseDown={keepFocus} onClick={onClick} disabled={busy}
    className="mt-2 flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
    {busy ? <Loader2 size={13} className="animate-spin" /> : null} Save
  </button>
);
