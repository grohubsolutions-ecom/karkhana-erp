"use client";

/* ---------------------------------------------------------------------------
   DELIVERY UNDER REVIEW — the first-attempt desk.
   (Named after PostEx's own screen, as the owner asked. The file and the URL
   keep the older name, first-attempt, so nothing that links here breaks.)

   Both couriers give a parcel three tries before it comes back to Lahore. The
   ERP only ever met it at the end, as a return — freight paid twice and the
   sale gone. This desk meets it after a failure, while the parcel is still
   sitting in the customer's city, and works out whose failure it was.

   The job on each row, in order:
     1. Ring the customer.  Why was it not received? Were you called?
     2. Copy the row into the courier's WhatsApp group. They reply with the
        rider's number — neither courier puts a rider in any data we receive.
     3. Ring the rider.  Did you call? Did you reach the address?
     4. Say whose fault it was, and whether it goes out again or comes back.
     5. Mark it done. It leaves the desk for good and goes into History.

   DAY BY DAY (H280). The attempt tabs hold only what came under review
   YESTERDAY OR TODAY and that PostEx or OwnEx STILL shows under review — the
   same thing their own portals show, read every 10 minutes. Everything else
   is in History, one line per failed try, filed under the day it failed and
   saying how it left: marked done (and by whom), sent out again, failed
   again, coming back, delivered, returned — or "not worked" if the courier
   still has it and nobody marked it done.

   WHAT THIS SCREEN DOES NOT DO: talk to the couriers. The owner's decision —
   the re-attempt or the return is clicked in PostEx's or OwnEx's own portal.
   This desk decides, records and remembers; it does not send.

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

/* How a failed try left the desk. "desk" = it has not: it is on today's desk. */
type LeftAs = "desk" | "done" | "failed_again" | "delivered" | "returned"
  | "out_again" | "coming_back" | "not_worked" | "moved";

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
  decision: "reattempt" | "return" | null;
  note: string | null; status: "open" | "done"; outcome: "delivered" | "returned" | null;
  closed_at: string | null; cod_amount: number | null; dispatch_date: string | null;
  raw_status: string | null; reason: string | null;
  customer_name: string | null; phone: string | null; city: string | null; address: string | null;
  waiting_hours: number | null; past_refusals: number; rider_strikes: number;
  decided_at: string | null; delivery_status: string | null;
};
type Summary = {
  desk: number; postex: number; ownex: number; untouched: number; no_rider: number;
  not_worked: number; done_today: number; saved: number; lost: number;
};
type Board = {
  ok: boolean; error?: string; may_work: boolean; view: "today" | "history";
  today: string; range: { from: string; to: string };
  summary: Summary; rows: Row[];
};
type Tab = "1" | "2" | "3" | "history";
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
  { key: "done", label: "Marked done", tone: "bg-success-soft text-[#2f7a3d]" },
  { key: "not_worked", label: "Not worked", tone: "bg-amber-soft text-[#7a5a28]" },
  { key: "out_again", label: "Sent out again", tone: "bg-periwinkle-soft text-[#38507a]" },
  { key: "failed_again", label: "Failed again", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "coming_back", label: "Coming back", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "delivered", label: "Delivered", tone: "bg-success-soft text-[#2f7a3d]" },
  { key: "returned", label: "Came back", tone: "bg-danger-soft text-[#8d3328]" },
  { key: "moved", label: "Moved on", tone: "bg-panel text-muted dark:bg-white/[0.07] dark:text-[#a89f93]" },
];
const leftOf = (k: LeftAs) => LEFT.find((l) => l.key === k);

/* One line under the badge, saying what that badge means for THIS parcel. */
function leftDetail(r: Row, today: string): string {
  const cn = r.courier ?? "the courier";
  switch (r.left_as) {
    case "done": return `${r.done_by_name ?? "name not recorded"}${r.done_at ? ` · ${when(r.done_at, today)}` : ""}`;
    case "failed_again": return `went out again and failed — now on its ${ordinal(r.attempts)} try`;
    case "delivered": return "delivered in the end";
    case "returned": return "came back to the warehouse";
    case "not_worked": return `still under review at ${cn} — nobody marked it done`;
    default: return `${cn} now says: ${r.raw_status ?? "—"}`;
  }
}
/* A parcel marked done can still end either way; say so beside the tick. */
const afterDone = (r: Row) =>
  r.left_as !== "done" ? null
    : r.attempt_no < r.attempts ? "then failed again"
    : r.outcome === "delivered" ? "then delivered"
    : r.outcome === "returned" ? "then came back" : null;

const VERDICTS: { key: "customer" | "rider" | "address"; label: string; Icon: typeof UserRound }[] = [
  { key: "customer", label: "The customer", Icon: UserRound },
  { key: "rider", label: "The rider", Icon: Bike },
  { key: "address", label: "The address", Icon: PackageX },
];

/* THE MESSAGE THAT GOES INTO THE DEALERSHIP GROUP. Everything they need to
   find the parcel, and the one thing we are asking them for. */
function groupMessage(r: Row): string {
  const nth = ordinal(r.attempts);
  return [
    `Order ${r.order_number ?? "—"}`,
    `Tracking ${r.tracking_id}`,
    `${nth} attempt failed${r.raw_status ? ` (${r.raw_status})` : ""}`,
    r.reason ? `Reason: ${r.reason}` : "Reason: not given",
    `Amount: ${rs(r.cod_amount)}`,
    `Customer: ${r.customer_name ?? "—"}${r.city ? ` — ${r.city}` : ""}`,
    "",
    "Please share the rider's number for this parcel.",
  ].join("\n");
}

/* SEVERAL AT ONCE, for the group. One ask at the top, then one short block
   per parcel, numbered so their reply can say "3) 0301…". *bold* is WhatsApp's
   own markup for the order numbers they will scan for. */
function bulkMessage(rows: Row[]): string {
  if (rows.length === 1) return groupMessage(rows[0]);
  /* Always one courier per message — the caller splits them — so the group
     it is pasted into can see at a glance that every parcel is theirs. */
  const cn = rows[0]?.courier ?? "Courier";
  const head = [`*${cn} — delivery under review — ${rows.length} parcels*`, "Please share the rider's number for each.", ""];
  const blocks = rows.map((r, i) => {
    const who = [r.customer_name, r.city].filter(Boolean).join(" — ");
    return [
      `*${i + 1}) ${r.order_number ?? r.tracking_id}* · ${r.tracking_id}`,
      `${ordinal(r.attempts)} attempt${r.raw_status ? ` (${r.raw_status})` : ""} · ${r.reason ?? "reason not given"}`,
      [r.cod_amount != null ? rs(r.cod_amount) : null, who || null].filter(Boolean).join(" · ") || "—",
    ].join("\n");
  });
  /* The blank line after the request is part of head; the blocks are joined
     to it with a newline, not glued on. */
  return [...head, blocks.join("\n\n")].join("\n");
}

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

export default function FirstAttemptDesk({ compact = false }: { compact?: boolean }) {
  const phone = useIsPhone();
  /* Two lists, kept apart: today's desk and the History. The attempt tabs
     keep their counts while the History is open, and a slow answer for one
     can never be painted as the other. */
  const [desk, setDesk] = useState<Board | null>(null);
  const [hist, setHist] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  /* THE OWNER'S TABS: the attempt a parcel is on, not the courier it is with.
     The courier is a narrowing, so it is a dropdown beside them. History is
     the fourth tab: where a parcel goes when it is done, or too old. */
  const [tab, setTab] = useState<Tab>("1");
  const [courier, setCourier] = useState<"All" | "PostEx" | "OwnEx">("All");
  const [span, setSpan] = useState<Span>("7");
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  /* Rows ticked for copying or marking done. Cleared whenever the list
     underneath changes, so a tick can never act on a parcel no longer shown. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* The rider's number, typed straight into the row. Held here until saved. */
  const [riderDraft, setRiderDraft] = useState<Record<string, string>>({});
  const [savingRider, setSavingRider] = useState("");
  const [riderErr, setRiderErr] = useState<Record<string, string>>({});
  /* What was just marked done, so one tap can put it back. */
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const [marking, setMarking] = useState("");

  const view: "today" | "history" = tab === "history" ? "history" : "today";

  /* Two taps and the slower answer can land last, painting the other list.
     Every Hub screen with a filter guards this the same way. */
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
      setErr(missing ? "This desk needs migration H280, which has not been run on the database yet." : error.message);
      return;
    }
    const b = data as Board;
    if (!b?.ok) { setErr(b?.error ?? "Could not open the desk."); return; }
    if (b.view === "history") setHist(b); else setDesk(b);
  }, [view, span]);
  useEffect(() => { load(); }, [load]);
  /* A save or a Done answers after the person may have moved to the other
     tab. Reloading through the load of the moment the button was pressed
     would fetch the old tab and knock out the one now on screen. */
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { setPicked(new Set()); }, [tab, courier]);
  /* After a refresh, a tick on a parcel that has left the list is dropped. */
  useEffect(() => {
    const here = new Set((desk?.rows ?? []).map((r) => r.tracking_id));
    setPicked((p) => { const n = new Set([...p].filter((t) => here.has(t))); return n.size === p.size ? p : n; });
  }, [desk]);
  /* The undo offer does not hang about for ever. */
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 15000);
    return () => clearTimeout(t);
  }, [undo]);

  const board = view === "history" ? hist : desk;
  const today = board?.today ?? desk?.today ?? ymdPK(new Date());
  const mayWork = !!(board?.may_work ?? desk?.may_work);

  /* ---------------------------------------------------------- today's desk */
  const byCourier = useMemo(
    () => (desk?.rows ?? []).filter((r) => courier === "All" || r.courier === courier),
    [desk, courier]
  );
  /* A fourth try should not exist, but if a courier ever reports one it
     belongs with the third, not nowhere. */
  const tabOf = (r: Row): Tab => (r.attempts >= 3 ? "3" : r.attempts === 2 ? "2" : "1");
  const counts = useMemo(() => {
    const c = { "1": 0, "2": 0, "3": 0 };
    for (const r of byCourier) c[tabOf(r) as "1" | "2" | "3"]++;
    return c;
  }, [byCourier]);
  const rows = useMemo(() => (view === "today" ? byCourier.filter((r) => tabOf(r) === tab) : []), [byCourier, tab, view]);
  const pickedRows = rows.filter((r) => picked.has(r.tracking_id));
  const allPicked = rows.length > 0 && pickedRows.length === rows.length;

  /* --------------------------------------------------------------- History */
  const histBase = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, "");
    return (hist?.rows ?? []).filter((r) => {
      if (courier !== "All" && r.courier !== courier) return false;
      if (!needle) return true;
      return [r.order_number, r.tracking_id, r.customer_name, r.city].some((v) => (v ?? "").toLowerCase().includes(needle))
        || (digits.length >= 4 && dial(r.phone).includes(digits));
    });
  }, [hist, courier, q]);
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of histBase) c[r.left_as] = (c[r.left_as] ?? 0) + 1;
    return c;
  }, [histBase]);
  const histShown = useMemo(() => histBase.filter((r) => kind === "all" || r.left_as === kind), [histBase, kind]);
  /* DAY BY DAY: each day the parcels failed that day, newest day first. */
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
    () => (board?.rows ?? []).find((r) => r.row_key === openKey) ?? null,
    [board, openKey]
  );

  async function save(tracking: string, patch: Record<string, unknown>) {
    if (!supabase) return false;
    const { data, error } = await supabase.rpc("hub_rescue_save", { p_tracking: tracking, ...patch });
    const r = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not save that."); return false; }
    setErr("");
    /* A number saved from the opened parcel must not be hidden behind an
       unsaved one still sitting in the row's box. */
    if ("p_rider_phone" in patch) setRiderDraft((d) => { const n = { ...d }; delete n[tracking]; return n; });
    await loadRef.current();
    return true;
  }

  /* DONE, one or many. It leaves the desk for good; the answer from the
     database says how many actually moved, and that is what is reported. */
  async function markDone(ids: string[], done: boolean, key: string, label?: string) {
    if (!supabase || !ids.length || marking) return false;
    setMarking(key);
    const { data, error } = await supabase.rpc("hub_rescue_mark_done", { p_trackings: ids, p_done: done });
    setMarking("");
    const r = (data ?? {}) as { ok?: boolean; error?: string; changed?: number; ids?: string[] };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not mark that done."); return false; }
    setErr("");
    setPicked(new Set());
    /* Undo reverses exactly what THIS tap moved. Five picked from a stale
       list, two already done by someone else: three moved, and Undo must
       not reopen the other man's two. */
    const moved = r.ids ?? [];
    if (done) {
      const n = moved.length;
      setUndo(n ? { ids: moved, text: label && n === 1 && ids.length === 1 ? `${label} moved to History.` : `${n} moved to History.` } : null);
      if (n < ids.length) {
        setErr(n === 0
          ? "Nothing moved — it was already marked done, perhaps by someone else. The list has been refreshed."
          : `${ids.length - n} of them were already marked done, perhaps by someone else, and were left as they were.`);
      }
    } else {
      setUndo(null);
    }
    /* Marking done moves the row out of the list it is in; the sheet would
       vanish mid-tap with nothing said. Close it deliberately instead. */
    setOpenKey(null);
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
    /* Thirty cards down, an error at the top of the page is an error nobody
       sees. It goes on the card whose number did not save. */
    if (!ok) setRiderErr((e) => ({ ...e, [r.tracking_id]: "Did not save — try again." }));
  }

  async function copy(key: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? key : "");
    if (!ok) setErr("The phone would not let the page copy. Try once more; if it still refuses, open a parcel and press and hold its message to copy it by hand.");
    setTimeout(() => setCopied((c) => (c === key ? "" : c)), 2200);
  }

  function toggle(t: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  }
  function toggleAll() {
    setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.tracking_id)));
  }

  const s = desk?.summary;
  const toCopy = pickedRows.length ? pickedRows : rows;
  /* EACH COURIER HAS ITS OWN GROUP. One message holding both would ask PostEx
     about OwnEx parcels, so a mixed list becomes one button per courier. */
  const copyGroups = (["PostEx", "OwnEx", "Other"] as const)
    .map((c) => ({ c, list: toCopy.filter((r) => (c === "Other" ? r.courier !== "PostEx" && r.courier !== "OwnEx" : r.courier === c)) }))
    .filter((g) => g.list.length > 0);
  const spanLabel = (SPANS.find((x) => x.key === span) ?? SPANS[2]).label.toLowerCase();

  function seeNotWorked() {
    setTab("history"); setKind("not_worked"); setSpan("90"); setQ(""); setCourier("All");
  }

  return (
    <div className="mt-1">
      {/* ------------------------------------------------------- the numbers */}
      {s && view === "today" && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="On the desk" value={String(s.desk)} sub={`${s.postex} PostEx · ${s.ownex} OwnEx`} tone="#E5786B" />
          <Stat label="Not yet called" value={String(s.untouched)} sub="nobody has rung the customer" tone="#E4B47E" />
          <Stat label="No rider number" value={String(s.no_rider)} sub="still to ask the group" tone="#A6C0E6" />
          <Stat label="Done today" value={String(s.done_today)} sub="marked done, moved to History" tone="#7FC489" />
        </div>
      )}

      {/* ------------------------------------------- attempt tabs + History */}
      <Segmented className="mt-3 w-full md:w-max" value={tab} onChange={(v) => { setTab(v); setOpenKey(null); }}
        options={([["1", "1st attempt", "1st"], ["2", "2nd attempt", "2nd"], ["3", "3rd attempt", "3rd"], ["history", "History", "History"]] as const).map(([key, label, short]) => ({
          key, label, short,
          badge: key === "history" ? undefined : (
            <span className={`ml-1 rounded-full px-1.5 text-[11px] font-bold tabular-nums ${tab === key
              ? "bg-white/20 dark:bg-black/10" : "bg-black/[0.06] dark:bg-white/10"}`}>{desk ? counts[key] : "·"}</span>
          ),
        }))} />

      {/* What "today" means, and what is NOT on it but still at the courier. */}
      {view === "today" && desk && (
        <p className="mt-2 px-1 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
          Came under review <b className="font-semibold text-ink dark:text-[#f4f1ea]">yesterday or today</b>
          {" "}({dateOf(shiftDay(today, -1))} – {dateOf(today)}) and still under review at the courier.
        </p>
      )}
      {/* NOT HIDDEN, JUST NOT TODAY'S. The couriers still show these on their
          own review screens; the desk says so rather than pretend they are gone. */}
      {view === "today" && s && s.not_worked > 0 && (
        <button onClick={seeNotWorked}
          className="mt-2 flex min-h-[40px] w-full items-center justify-between gap-3 rounded-card border border-dashed border-line px-3 py-1.5 text-left text-[12.5px] text-muted transition hover:bg-panel md:w-auto dark:border-white/15 dark:text-[#a89f93] dark:hover:bg-white/[0.05]">
          <span>
            <b className="text-ink dark:text-[#f4f1ea]">{s.not_worked} older</b>{" "}
            {s.not_worked === 1 ? "parcel is" : "parcels are"} still under review at the couriers
          </span>
          <span className="shrink-0 font-semibold text-ink dark:text-white">See in History →</span>
        </button>
      )}

      {/* ------------------------------------------------ narrow it down */}
      <div className={`mt-2 grid gap-2 md:flex md:flex-wrap md:items-center ${view === "history" ? "grid-cols-2" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
        <select value={courier} onChange={(e) => setCourier(e.target.value as typeof courier)} aria-label="Courier" className={SELECT}>
          <option value="All">Both couriers</option>
          <option value="PostEx">PostEx</option>
          <option value="OwnEx">OwnEx</option>
        </select>
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
        <button onClick={load}
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

      {/* ------------------------------------------ just marked done: undo */}
      {undo && (
        <div role="status" className="mt-3 flex items-center justify-between gap-2 rounded-card border border-[#bfe3c5] bg-success-soft px-3 py-2 text-[13px] font-semibold text-[#2f7a3d] dark:border-white/10">
          <span className="flex min-w-0 items-center gap-2"><CheckCircle2 size={16} className="shrink-0" /><span className="truncate">{undo.text}</span></span>
          {mayWork && (
            <button onMouseDown={keepFocus} onClick={() => markDone(undo.ids, false, "__undo")} disabled={marking === "__undo"}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface px-3.5 text-[12.5px] font-bold text-ink disabled:opacity-50 dark:bg-white dark:text-[#141414]">
              {marking === "__undo" ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Undo
            </button>
          )}
        </div>
      )}

      {/* ------------------------------------------ pick, copy, mark done */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 dark:border-white/[0.06] dark:bg-[#201c17]">
          <label className="flex min-h-[40px] cursor-pointer items-center gap-2 pr-1 text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
            <input type="checkbox" checked={allPicked} onChange={toggleAll}
              ref={(el) => { if (el) el.indeterminate = pickedRows.length > 0 && !allPicked; }}
              className="h-5 w-5 shrink-0 accent-[#141414] dark:accent-white" />
            {pickedRows.length ? `${pickedRows.length} picked` : `Pick all ${rows.length}`}
          </label>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {pickedRows.length > 0 && (
              <button onClick={() => setPicked(new Set())}
                className="h-10 rounded-full px-3 text-[12.5px] font-semibold text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
                Clear
              </button>
            )}
            {copyGroups.map(({ c, list }) => {
              const key = "__bulk_" + c;
              const label = copyGroups.length > 1
                ? `Copy ${list.length} ${c}`
                : pickedRows.length ? `Copy ${list.length} picked` : `Copy all ${list.length}`;
              return (
                <button key={key} onMouseDown={keepFocus} onClick={() => copy(key, bulkMessage(list))}
                  className={`flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition ${copied === key
                    ? "bg-success-soft text-[#2f7a3d]" : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
                  {copied === key ? <><Check size={15} /> Copied {list.length}</> : <><Copy size={15} /> {label}</>}
                </button>
              );
            })}
            {/* Only picked rows: marking a whole tab done by accident would
                empty the desk with one tap. */}
            {mayWork && pickedRows.length > 0 && (
              <button onMouseDown={keepFocus} disabled={!!marking}
                onClick={() => markDone(pickedRows.map((r) => r.tracking_id), true, "__bulk_done")}
                className="flex h-10 items-center gap-2 rounded-full border border-[#2f7a3d]/40 bg-success-soft px-4 text-[13px] font-semibold text-[#2f7a3d] disabled:opacity-50">
                {marking === "__bulk_done" ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                Mark {pickedRows.length} done
              </button>
            )}
          </div>
        </div>
      )}

      {err && !open && (
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

      {view === "today" && desk && rows.length === 0 && !loading && (
        <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
          Nothing on its {ordinal(Number(tab))} attempt from yesterday or today{courier === "All" ? "" : ` with ${courier}`}.
        </p>
      )}

      {/* ----------------------------------------------- cards (below 1280px) */}
      {/* One column on a phone, two on a tablet or a small laptop. The table
          only takes over at 1280px, where all its columns fit without a
          sideways scroll — below that the rider box and Copy fell off the edge. */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 space-y-2 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:hidden">
          {rows.map((r) => {
            const draft = riderDraft[r.tracking_id];
            const riderVal = draft ?? r.rider_phone ?? "";
            const dirty = draft !== undefined && draft !== (r.rider_phone ?? "");
            const on = picked.has(r.tracking_id);
            return (
              /* A card with inputs in it cannot itself be one big button — so the
                 top half opens the parcel and the bottom half is the work. */
              <div key={r.row_key} className={`rounded-xl2 border bg-surface dark:bg-[#201c17] ${on
                ? "border-ink dark:border-white/60" : "border-line dark:border-white/[0.06]"}`}>
                <div className="flex items-start gap-2.5 px-3 pt-3">
                  {/* A 20px box is a miss on a phone. The label around it is the
                      real target — 44px — and the negative margin keeps the card
                      laid out as if it were only the box. */}
                  <label className="-m-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${r.order_number ?? r.tracking_id}`}
                      className="h-5 w-5 accent-[#141414] dark:accent-white" />
                  </label>
                  <button type="button" onClick={() => setOpenKey(r.row_key)} className="ml-1 min-w-0 flex-1 text-left">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                          <span className="truncate text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? r.tracking_id}</span>
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
                    <div className="mt-1.5 truncate text-[12px] text-muted dark:text-[#a89f93]">{r.reason ?? "no reason given — ask the group"}</div>
                  </button>
                </div>

                <div className={`mt-2 grid gap-2 px-3 ${mayWork ? "grid-cols-[minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
                  {r.phone ? (
                    <a href={`tel:${dial(r.phone)}`}
                      className="flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-full bg-panel px-2 text-[12.5px] font-semibold tabular-nums text-ink dark:bg-white/[0.07] dark:text-white">
                      <Phone size={13} className="shrink-0" /><span className="truncate">{r.phone}</span>
                    </a>
                  ) : <span className="flex h-10 min-w-0 items-center justify-center truncate rounded-full bg-panel px-2 text-[12px] text-hint dark:bg-white/[0.05]">no number</span>}
                  <button onMouseDown={keepFocus} onClick={() => copy(r.tracking_id, groupMessage(r))}
                    className={`flex h-10 items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition ${copied === r.tracking_id
                      ? "bg-success-soft text-[#2f7a3d]" : "border border-line text-ink dark:border-white/10 dark:text-white"}`}>
                    {copied === r.tracking_id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                  {mayWork && (
                    <button onMouseDown={keepFocus} disabled={!!marking}
                      onClick={() => markDone([r.tracking_id], true, r.tracking_id, r.order_number ?? r.tracking_id)}
                      aria-label={`Mark ${r.order_number ?? r.tracking_id} done`}
                      className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-[#2f7a3d]/35 px-3 text-[12.5px] font-semibold text-[#2f7a3d] disabled:opacity-50 dark:text-[#8fd49a]">
                      {marking === r.tracking_id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Done
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2 px-3 pb-3 pt-2">
                  <input value={riderVal} inputMode="tel" placeholder="Rider's number" disabled={!mayWork}
                    aria-label={`Rider's number for ${r.order_number ?? r.tracking_id}`}
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
      {/* Built to fit a laptop with the menu open (about 950px). The courier
          rides on the order, the tracking sits under it, and the order itself
          opens the parcel, so no column is spent on any of those. */}
      {view === "today" && rows.length > 0 && (
        <div className="mt-3 hidden xl:block">
          <div className="overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="bg-panel text-left text-[11px] uppercase tracking-wide text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Pick every row"
                      ref={(el) => { if (el) el.indeterminate = pickedRows.length > 0 && !allPicked; }}
                      className="h-4 w-4 accent-[#141414] dark:accent-white" />
                  </th>
                  {["Order", "Why it failed", "Amount", "Customer", "Customer no.", "Waiting", "Rider no.", ""].map((h, i) => (
                    <th key={h + i} className="whitespace-nowrap px-2.5 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const draft = riderDraft[r.tracking_id];
                  const riderVal = draft ?? r.rider_phone ?? "";
                  const dirty = draft !== undefined && draft !== (r.rider_phone ?? "");
                  const on = picked.has(r.tracking_id);
                  return (
                    <tr key={r.row_key} className={`border-t border-line align-top transition dark:border-white/[0.06] ${on ? "bg-panel dark:bg-white/[0.05]" : "hover:bg-panel/60 dark:hover:bg-white/[0.03]"}`}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${r.order_number ?? r.tracking_id}`}
                          className="h-4 w-4 accent-[#141414] dark:accent-white" />
                      </td>
                      <td className="px-2.5 py-2">
                        <button onClick={() => setOpenKey(r.row_key)} className="group text-left" title="Open the parcel">
                          <span className="flex items-center gap-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                            <span className="font-semibold text-ink underline-offset-2 group-hover:underline dark:text-[#f4f1ea]">{r.order_number ?? "—"}</span>
                          </span>
                          <span className="mt-0.5 block text-[11.5px] tabular-nums text-muted dark:text-[#a89f93]">{r.tracking_id}</span>
                        </button>
                      </td>
                      <td className="max-w-[150px] px-2.5 py-2.5 leading-snug">
                        {r.reason ?? <span className="text-hint">not given — ask the group</span>}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{rs(r.cod_amount)}</td>
                      <td className="max-w-[140px] px-2.5 py-2 leading-snug">
                        <span className="block truncate">{r.customer_name ?? "—"}</span>
                        {r.city && <span className="block truncate text-[11.5px] text-muted dark:text-[#a89f93]">{r.city}</span>}
                      </td>
                      <td className="px-2.5 py-2.5 tabular-nums">
                        {/* Shopify keeps notes in the number ("… (ask for bhai)"). The
                            whole of it is one hover away; the column stays narrow. */}
                        {r.phone
                          ? <a href={`tel:${dial(r.phone)}`} title={r.phone} className="block max-w-[124px] truncate hover:underline">{r.phone}</a>
                          : <span className="text-hint">—</span>}
                      </td>
                      <td className={`whitespace-nowrap px-2.5 py-2.5 font-semibold tabular-nums ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)}</td>
                      <td className="px-2.5 py-1.5">
                        {/* Typed straight into the row, the moment the group replies.
                            Enter saves too. */}
                        <div className="flex items-center gap-1">
                          <input value={riderVal} inputMode="tel" placeholder="Add number" disabled={!mayWork}
                            aria-label={`Rider's number for ${r.order_number ?? r.tracking_id}`}
                            onChange={(e) => setRiderDraft((d) => ({ ...d, [r.tracking_id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") saveRider(r); }}
                            className="h-8 w-[112px] rounded-lg border border-line bg-canvas px-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-ink disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
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
                      <td className="px-2.5 py-1.5 pr-3">
                        {/* Copy over Done, not beside it: side by side they pushed
                            the pair off the right edge of a 1280px laptop. */}
                        <div className="flex w-[78px] flex-col gap-1">
                          <button onClick={() => copy(r.tracking_id, groupMessage(r))} title="Copy this parcel for the group"
                            className={`flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] font-semibold transition ${copied === r.tracking_id
                              ? "bg-success-soft text-[#2f7a3d]" : "border border-line text-ink hover:bg-panel dark:border-white/10 dark:text-white dark:hover:bg-white/[0.08]"}`}>
                            {copied === r.tracking_id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                          </button>
                          {mayWork && (
                            <button onClick={() => markDone([r.tracking_id], true, r.tracking_id, r.order_number ?? r.tracking_id)} disabled={!!marking}
                              title="Mark done — it moves to History"
                              className="flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#2f7a3d]/35 px-2 text-[12px] font-semibold text-[#2f7a3d] transition hover:bg-success-soft disabled:opacity-50 dark:text-[#8fd49a] dark:hover:bg-white/[0.06]">
                              {marking === r.tracking_id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Done
                            </button>
                          )}
                        </div>
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
            {day === "—" ? "No date" : dayName(day, hist.today)}
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
                /* Phone: the order number keeps the first line, the badge rides
                   at its end and what it means goes underneath — side by side
                   the badge squeezed the order down to "#…". From a tablet up
                   there is room for both halves on one line. */
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
                      {r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""} · {rs(r.cod_amount)}
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
          The desk holds parcels that came under review yesterday or today and that PostEx or OwnEx still show
          under review — checked against the couriers every 10 minutes. Mark one done and it moves to History for
          good; it only comes back if the courier reports a new failed try, in the next attempt tab. The re-attempt
          or the return is still clicked in PostEx&rsquo;s or OwnEx&rsquo;s own portal — this desk decides and
          remembers, it does not send anything to them.
        </p>
      )}

      {open && (
        <CaseSheet
          r={open} mayWork={mayWork} phone={phone} err={err} today={today}
          onClose={() => setOpenKey(null)} onDismissErr={() => setErr("")}
          onCopy={() => copy(open.tracking_id, groupMessage(open))} copied={copied === open.tracking_id}
          onSave={(patch) => save(open.tracking_id, patch)}
          onDone={(done) => markDone([open.tracking_id], done, "__sheet", open.order_number ?? open.tracking_id)}
          doneBusy={marking === "__sheet"}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted dark:text-[#a89f93]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />{label}
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

/* The whole job for one parcel, in the order it is done. */
function CaseSheet({ r, mayWork, phone, err, today, onClose, onDismissErr, onCopy, copied, onSave, onDone, doneBusy }: {
  r: Row; mayWork: boolean; phone: boolean; err: string; today: string;
  onClose: () => void; onDismissErr: () => void;
  onCopy: () => void; copied: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
  onDone: (done: boolean) => void; doneBusy: boolean;
}) {
  /* The courier's name is used in five sentences. A parcel whose courier never
     came through must not be told to go to "null's own portal". */
  const cn = r.courier ?? "the courier";
  const [rider, setRider] = useState(r.rider_phone ?? "");
  const [cust, setCust] = useState(r.customer_said ?? "");
  const [ridr, setRidr] = useState(r.rider_said ?? "");
  const [busy, setBusy] = useState("");
  /* ONLY on a different line (a parcel, or another try of it). Depending on
     the three values as well meant
     that saving one of them re-ran this and overwrote the other two with the
     stale server copy — two phone calls typed in and silently thrown away. */
  useEffect(() => {
    setRider(r.rider_phone ?? ""); setCust(r.customer_said ?? ""); setRidr(r.rider_said ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.row_key]);

  const wa = waNumber(r.phone);
  const lastTry = r.attempts >= 3;
  const repeat = r.past_refusals >= 2;
  /* A History line for an EARLIER try of a parcel that has failed again since:
     its done/undo belongs to the try it is on now, not this one. */
  const earlierTry = r.attempt_no < r.attempts;
  const lf = r.left_as !== "desk" ? leftOf(r.left_as) : undefined;
  /* An earlier try's line shows what was found out on THAT try, read-only:
     the case now belongs to the try it is on, and an edit here would land
     on that one. */
  const canEdit = mayWork && !earlierTry;

  async function run(key: string, patch: Record<string, unknown>) {
    setBusy(key); await onSave(patch); setBusy("");
  }

  return (
    <Sheet open onClose={onClose}
      title={r.order_number ?? r.tracking_id}
      subtitle={`${cn} · ${r.store_code ?? "—"} · ${r.tracking_id} · ${rs(r.cod_amount)}`}>

      {/* --- why it is here ------------------------------------------------ */}
      {err && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded-xl2 border border-red-300 bg-red-50 p-2.5 text-[12.5px] text-red-800">
          <span>{err}</span>
          <button onClick={onDismissErr} className="shrink-0 font-semibold opacity-60">Dismiss</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag n={earlierTry ? r.attempt_no : r.attempts} />
        {r.last_failed_at && !earlierTry && (
          <span className={`text-[12px] font-semibold ${heat(r.waiting_hours)}`}>
            under review since {when(r.last_failed_at, today)}
          </span>
        )}
        {r.outcome && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.outcome === "delivered" ? "bg-success-soft text-[#2f7a3d]" : "bg-danger-soft text-[#8d3328]"}`}>
            {r.outcome === "delivered" ? "Delivered in the end" : "Came back"}
          </span>
        )}
      </div>

      {lf && (
        <p className="mt-2 rounded-xl2 bg-panel px-3 py-2 text-[12px] leading-snug text-ink dark:bg-white/[0.06] dark:text-[#f4f1ea]">
          <b>In History — {lf.label.toLowerCase()}.</b> {leftDetail(r, today)}
          {earlierTry && <> This line is its {ordinal(r.attempt_no)} try; the parcel is on its {ordinal(r.attempts)} now.</>}
        </p>
      )}
      {lastTry && !earlierTry && (
        <p className="mt-2 rounded-xl2 bg-danger-soft px-3 py-2 text-[12px] font-semibold leading-snug text-[#8d3328]">
          Third try. It comes back to the warehouse and the order is cancelled by hand — it does not go out again.
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
        <Detail label="Why it failed">{r.reason ?? <span className="font-normal text-muted">not given by {cn} — ask the group</span>}</Detail>
        <Detail label={`${cn} says now`}>{r.raw_status ?? "—"}</Detail>
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
            <SaveBtn busy={busy === "cust"} onClick={() => run("cust", { p_customer_said: cust })} />
          )}
          {/* The commonest outcome of a COD call is nobody picking up. Without
              this there is nothing to type, so the parcel stays in the "not yet
              called" pile and gets rung again tomorrow by the same man. */}
          {canEdit && !r.customer_called_at && (
            <button onClick={() => { setCust("No answer"); run("noans", { p_customer_said: "No answer" }); }}
              disabled={busy === "noans"}
              className="mt-2 flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[12.5px] font-semibold text-muted disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-[#a89f93]">
              {busy === "noans" ? <Loader2 size={13} className="animate-spin" /> : null} No answer
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
          {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy for the group</>}
        </button>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-xl2 bg-panel px-3 py-2 text-[11.5px] leading-relaxed text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">{groupMessage(r)}</pre>
        <div className="mt-2 flex gap-2">
          <input value={rider} onChange={(e) => setRider(e.target.value)} disabled={!canEdit}
            inputMode="tel" placeholder="Rider's number"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          {canEdit && rider !== (r.rider_phone ?? "") && (
            <button onMouseDown={keepFocus} onClick={() => run("rider", { p_rider_phone: rider })} disabled={busy === "rider"}
              className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
              {busy === "rider" ? <Loader2 size={14} className="animate-spin" /> : null} Save
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
          <SaveBtn busy={busy === "ridr"} onClick={() => run("ridr", { p_rider_said: ridr })} />
        )}
      </Block>

      {/* --- 4. the verdict -------------------------------------------------- */}
      <Block n="4" title="Whose failure was it?" done={!!r.verdict}>
        <div className="grid grid-cols-3 gap-2">
          {VERDICTS.map(({ key, label, Icon }) => {
            const on = r.verdict === key;
            return (
              <button key={key} disabled={!canEdit || busy === "v" + key} onClick={() => run("v" + key, { p_verdict: key })}
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

      {/* --- 5. what happens to the parcel ----------------------------------- */}
      <Block n="5" title="And the parcel?" done={!!r.decision}>
        <div className="grid grid-cols-2 gap-2">
          <button disabled={!canEdit || lastTry || busy === "d1"} onClick={() => run("d1", { p_decision: "reattempt" })}
            className={`flex min-h-[48px] items-center justify-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition disabled:opacity-40 ${r.decision === "reattempt"
              ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
              : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-white"}`}>
            <RotateCw size={15} /> Send it again
          </button>
          <button disabled={!canEdit || busy === "d2"} onClick={() => run("d2", { p_decision: "return" })}
            className={`flex min-h-[48px] items-center justify-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition disabled:opacity-50 ${r.decision === "return"
              ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
              : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-white"}`}>
            <Undo2 size={15} /> Bring it back
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
          {lastTry
            ? "Bring it back, and cancel the order in Shopify — this desk does not touch Shopify."
            : `Then do it in ${cn}'s own portal — this desk records the decision, it does not send it.`}
        </p>
      </Block>

      {/* --- done --------------------------------------------------------------- */}
      {canEdit && !r.outcome && (
        r.status === "open" ? (
          <button onClick={() => onDone(true)} disabled={doneBusy}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#2f7a3d] text-[13.5px] font-bold text-white disabled:opacity-50">
            {doneBusy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={16} />}
            Mark done — move to History
          </button>
        ) : (
          <button onClick={() => onDone(false)} disabled={doneBusy}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[13px] font-semibold text-ink disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
            {doneBusy ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={15} />}
            Undo done
          </button>
        )
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        {r.outcome
          ? `${cn} has settled it — ${r.outcome === "delivered" ? "delivered" : "returned"}. Nothing is left to work on this parcel.`
          : earlierTry
            ? `To work its ${ordinal(r.attempts)} try, open that one — on the desk if it failed yesterday or today, otherwise higher up in History.`
            : r.status === "open"
              ? `Done takes it off the desk for good. It only comes back if ${cn} reports a new failed try — then it is in the next attempt tab. Delivered or returned, ${cn} decides; this row is marked with that by itself.`
              : `Undo puts it back on the desk if ${cn} still has it under review from yesterday or today; otherwise it stays in History as not worked.`}
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
        {title}
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
