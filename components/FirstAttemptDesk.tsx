"use client";

/* ---------------------------------------------------------------------------
   DELIVERY UNDER REVIEW — the first-attempt desk.
   (Named after PostEx's own screen, as the owner asked. The file and the URL
   keep the older name, first-attempt, so nothing that links here breaks.)

   Both couriers give a parcel three tries before it comes back to Lahore. The
   ERP only ever met it at the end, as a return — freight paid twice and the
   sale gone. This desk meets it after the FIRST failure, while the parcel is
   still sitting in the customer's city, and works out whose failure it was.

   The job on each row, in order:
     1. Ring the customer.  Why was it not received? Were you called?
     2. Copy the row into the courier's WhatsApp group. They reply with the
        rider's number — neither courier puts a rider in any data we receive.
     3. Ring the rider.  Did you call? Did you reach the address?
     4. Say whose fault it was, and whether it goes out again or comes back.

   WHAT THIS SCREEN DOES NOT DO: talk to the couriers. The owner's decision —
   the re-attempt or the return is clicked in PostEx's or OwnEx's own portal.
   This desk decides, records and remembers; it does not send.

   ONE COMPONENT, TWO HOMES. Abdullah opens it in his portal; the Hub opens it
   under Logistics. Both call the same two functions, so the office and the man
   doing the work can never be looking at different lists.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  RefreshCw, Loader2, AlertTriangle, Copy, Check, Phone, MessageCircle,
  PackageX, UserRound, Bike, Undo2, RotateCw, CheckCircle2,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Segmented, Sheet, Detail, useIsPhone, waNumber } from "@/components/HubUI";

type Row = {
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
type Board = {
  ok: boolean; error?: string; may_work: boolean; scope: string;
  summary: { open: number; postex: number; ownex: number; untouched: number; last_try: number; saved: number; lost: number };
  rows: Row[];
};

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

const COURIER_TONE: Record<string, string> = {
  PostEx: "bg-[#E6F1FB] text-[#0C447C] dark:bg-[#16283C] dark:text-[#8FBEEA]",
  OwnEx: "bg-[#E1F5EE] text-[#085041] dark:bg-[#12302A] dark:text-[#7FD3B8]",
};
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

export default function FirstAttemptDesk({ compact = false }: { compact?: boolean }) {
  const phone = useIsPhone();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [scope, setScope] = useState<"open" | "done">("open");
  const [courier, setCourier] = useState<"All" | "PostEx" | "OwnEx">("All");
  /* THE OWNER'S TABS: the attempt a parcel is on, not the courier it is with.
     The courier is a narrowing, so it became a dropdown beside them. */
  const [attempt, setAttempt] = useState<"1" | "2" | "3">("1");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  /* Rows ticked for copying. Cleared whenever the list underneath changes, so
     a tick can never be copied from a parcel that is no longer on screen. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* The rider's number, typed straight into the row. Held here until saved. */
  const [riderDraft, setRiderDraft] = useState<Record<string, string>>({});
  const [savingRider, setSavingRider] = useState("");
  const [riderErr, setRiderErr] = useState<Record<string, string>>({});

  /* Two taps on the scope and the slower answer can land last, painting the
     other list. Every Hub screen with a filter guards this the same way. */
  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("hub_rescue_board", { p_scope: scope });
    if (my !== reqId.current) return;              // superseded
    setLoading(false);
    if (error) {
      setErr(/function|schema cache/i.test(error.message)
        ? "This desk needs migration H278, which has not been run on the database yet."
        : error.message);
      return;
    }
    const b = data as Board;
    if (!b?.ok) { setErr(b?.error ?? "Could not open the desk."); setBoard(null); return; }
    setBoard(b);
  }, [scope]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPicked(new Set()); }, [scope, courier, attempt]);
  /* After a refresh, a tick on a parcel that has left the list is dropped. */
  useEffect(() => {
    const here = new Set((board?.rows ?? []).map((r) => r.tracking_id));
    setPicked((p) => { const n = new Set([...p].filter((t) => here.has(t))); return n.size === p.size ? p : n; });
  }, [board]);

  const byCourier = useMemo(
    () => (board?.rows ?? []).filter((r) => courier === "All" || r.courier === courier),
    [board, courier]
  );
  /* A fourth try should not exist, but if a courier ever reports one it
     belongs with the third, not nowhere. */
  const tabOf = (r: Row) => (r.attempts >= 3 ? "3" : r.attempts === 2 ? "2" : "1");
  const counts = useMemo(() => {
    const c = { "1": 0, "2": 0, "3": 0 };
    for (const r of byCourier) c[tabOf(r)]++;
    return c;
  }, [byCourier]);
  const rows = useMemo(() => byCourier.filter((r) => tabOf(r) === attempt), [byCourier, attempt]);
  const open = useMemo(() => (board?.rows ?? []).find((r) => r.tracking_id === openKey) ?? null, [board, openKey]);
  const pickedRows = rows.filter((r) => picked.has(r.tracking_id));
  const allPicked = rows.length > 0 && pickedRows.length === rows.length;

  async function save(tracking: string, patch: Record<string, unknown>) {
    if (!supabase) return false;
    const { data, error } = await supabase.rpc("hub_rescue_save", { p_tracking: tracking, ...patch });
    const r = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not save that."); return false; }
    setErr("");
    /* A number saved from the opened parcel must not be hidden behind an
       unsaved one still sitting in the row's box. */
    if ("p_rider_phone" in patch) setRiderDraft((d) => { const n = { ...d }; delete n[tracking]; return n; });
    /* Ticking it off moves it out of this list, so the sheet would vanish
       mid-tap with nothing said. Close it deliberately instead. */
    if (patch.p_done === true) setOpenKey(null);
    await load();
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

  const s = board?.summary;
  const noRider = scope === "open" ? (board?.rows ?? []).filter((r) => !r.rider_phone).length : null;
  const toCopy = pickedRows.length ? pickedRows : rows;
  /* EACH COURIER HAS ITS OWN GROUP. One message holding both would ask PostEx
     about OwnEx parcels, so a mixed list becomes one button per courier. */
  const copyGroups = (["PostEx", "OwnEx", "Other"] as const)
    .map((c) => ({ c, list: toCopy.filter((r) => (c === "Other" ? r.courier !== "PostEx" && r.courier !== "OwnEx" : r.courier === c)) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className="mt-1">
      {/* ------------------------------------------------------- the numbers */}
      {s && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="Under review" value={String(s.open)} sub={`${s.postex} PostEx · ${s.ownex} OwnEx`} tone="#E5786B" />
          <Stat label="Not yet called" value={String(s.untouched)} sub="nobody has rung the customer" tone="#E4B47E" />
          <Stat label="No rider number" value={noRider == null ? "—" : String(noRider)} sub="still to ask the group" tone="#A6C0E6" />
          <Stat label="Saved so far" value={String(s.saved)} sub={s.lost ? `${s.lost} still came back` : "delivered after a failed try"} tone="#7FC489" />
        </div>
      )}

      {/* --------------------------------------------------- attempt tabs */}
      <Segmented className="mt-3 w-full md:w-max" value={attempt} onChange={setAttempt}
        options={([["1", "1st attempt", "1st"], ["2", "2nd attempt", "2nd"], ["3", "3rd attempt", "3rd"]] as const).map(([key, label, short]) => ({
          key, label, short,
          badge: (
            <span className={`ml-1 rounded-full px-1.5 text-[11px] font-bold tabular-nums ${attempt === key
              ? "bg-white/20 dark:bg-black/10" : "bg-black/[0.06] dark:bg-white/10"}`}>{counts[key]}</span>
          ),
        }))} />

      {/* ------------------------------------------------ narrow it down */}
      <div className="mt-2 grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <select value={courier} onChange={(e) => setCourier(e.target.value as typeof courier)} aria-label="Courier"
          className="h-11 min-w-0 rounded-full border border-line bg-surface px-3 text-[16px] font-semibold text-ink outline-none md:h-10 xl:h-9 xl:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <option value="All">Both couriers</option>
          <option value="PostEx">PostEx</option>
          <option value="OwnEx">OwnEx</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Working or finished"
          className="h-11 min-w-0 rounded-full border border-line bg-surface px-3 text-[16px] font-semibold text-ink outline-none md:h-10 xl:h-9 xl:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <option value="open">Still working</option>
          <option value="done">Finished</option>
        </select>
        <button onClick={load}
          className="col-span-2 flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink transition hover:bg-panel md:col-span-1 md:h-9 dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* ------------------------------------------ pick and copy, in bulk */}
      {/* Only while working: finished parcels have no rider left to ask for. */}
      {rows.length > 0 && scope === "open" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 dark:border-white/[0.06] dark:bg-[#201c17]">
          <label className="flex min-h-[40px] cursor-pointer items-center gap-2 pr-1 text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
            <input type="checkbox" checked={allPicked} onChange={toggleAll}
              ref={(el) => { if (el) el.indeterminate = pickedRows.length > 0 && !allPicked; }}
              className="h-5 w-5 shrink-0 accent-[#141414] dark:accent-white" />
            {pickedRows.length ? `${pickedRows.length} picked` : `Pick all ${rows.length}`}
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-2">
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
                <button key={key} onMouseDown={(e) => e.preventDefault()} onClick={() => copy(key, bulkMessage(list))}
                  className={`flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition ${copied === key
                    ? "bg-success-soft text-[#2f7a3d]" : "bg-ink text-white dark:bg-white dark:text-[#141414]"}`}>
                  {copied === key ? <><Check size={15} /> Copied {list.length}</> : <><Copy size={15} /> {label}</>}
                </button>
              );
            })}
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
          <Loader2 size={16} className="animate-spin" /> Opening the desk…
        </p>
      )}

      {board && rows.length === 0 && !loading && (
        <p className="px-4 py-14 text-center text-[13px] text-muted dark:text-[#a89f93]">
          {scope === "open"
            ? `Nothing on its ${ordinal(Number(attempt))} attempt${courier === "All" ? "" : ` with ${courier}`} right now.`
            : "Nothing finished here yet."}
        </p>
      )}

      {/* ----------------------------------------------- cards (below 1280px) */}
      {/* One column on a phone, two on a tablet or a small laptop. The table
          only takes over at 1280px, where all its columns fit without a
          sideways scroll — below that the rider box and Copy fell off the edge. */}
      {rows.length > 0 && (
        <div className="mt-3 space-y-2 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 xl:hidden">
          {rows.map((r) => {
            const draft = riderDraft[r.tracking_id];
            const riderVal = draft ?? r.rider_phone ?? "";
            const dirty = draft !== undefined && draft !== (r.rider_phone ?? "");
            const on = picked.has(r.tracking_id);
            return (
              /* A card with inputs in it cannot itself be one big button — so the
                 top half opens the parcel and the bottom half is the work. */
              <div key={r.tracking_id} className={`rounded-xl2 border bg-surface dark:bg-[#201c17] ${on
                ? "border-ink dark:border-white/60" : "border-line dark:border-white/[0.06]"}`}>
                <div className="flex items-start gap-2.5 px-3 pt-3">
                  {/* A 20px box is a miss on a phone. The label around it is the
                      real target — 44px — and the negative margin keeps the card
                      laid out as if it were only the box. */}
                  <label className="-m-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${r.order_number ?? r.tracking_id}`}
                      className="h-5 w-5 accent-[#141414] dark:accent-white" />
                  </label>
                  <button type="button" onClick={() => setOpenKey(r.tracking_id)} className="ml-1 min-w-0 flex-1 text-left">
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

                <div className="mt-2 grid grid-cols-2 gap-2 px-3">
                  {r.phone ? (
                    <a href={`tel:${dial(r.phone)}`}
                      className="flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-full bg-panel px-2 text-[12.5px] font-semibold tabular-nums text-ink dark:bg-white/[0.07] dark:text-white">
                      <Phone size={13} className="shrink-0" /><span className="truncate">{r.phone}</span>
                    </a>
                  ) : <span className="flex h-10 items-center justify-center rounded-full bg-panel text-[12px] text-hint dark:bg-white/[0.05]">no customer number</span>}
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => copy(r.tracking_id, groupMessage(r))}
                    className={`flex h-10 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold transition ${copied === r.tracking_id
                      ? "bg-success-soft text-[#2f7a3d]" : "border border-line text-ink dark:border-white/10 dark:text-white"}`}>
                    {copied === r.tracking_id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                </div>

                <div className="flex items-center gap-2 px-3 pb-3 pt-2">
                  <input value={riderVal} inputMode="tel" placeholder="Rider's number" disabled={!board?.may_work}
                    aria-label={`Rider's number for ${r.order_number ?? r.tracking_id}`}
                    onChange={(e) => setRiderDraft((d) => ({ ...d, [r.tracking_id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") saveRider(r); }}
                    className="h-10 min-w-0 flex-1 rounded-full border border-line bg-canvas px-3.5 text-[16px] text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
                  {dirty ? (
                    /* onMouseDown keeps the focus in the box. Without it the tap
                       blurs the box first, the Hub's bottom bar (hidden while
                       typing) springs back under the finger, and the tap lands
                       on the bar instead of Save. */
                    <button onMouseDown={(e) => e.preventDefault()} onClick={() => saveRider(r)} disabled={savingRider === r.tracking_id}
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
      {/* Built to fit a laptop with the menu open (about 950px). At 1080px the
          rider box and the Copy button — the two things used on every row —
          sat off the right edge behind a sideways scroll. The courier rides on
          the order, the tracking sits under it, and the order itself opens the
          parcel, so no column is spent on any of those. */}
      {rows.length > 0 && (
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
                    <tr key={r.tracking_id} className={`border-t border-line align-top transition dark:border-white/[0.06] ${on ? "bg-panel dark:bg-white/[0.05]" : "hover:bg-panel/60 dark:hover:bg-white/[0.03]"}`}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" checked={on} onChange={() => toggle(r.tracking_id)} aria-label={`Pick ${r.order_number ?? r.tracking_id}`}
                          className="h-4 w-4 accent-[#141414] dark:accent-white" />
                      </td>
                      <td className="px-2.5 py-2">
                        <button onClick={() => setOpenKey(r.tracking_id)} className="group text-left" title="Open the parcel">
                          <span className="flex items-center gap-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier ?? "—"}</span>
                            <span className="font-semibold text-ink underline-offset-2 group-hover:underline dark:text-[#f4f1ea]">{r.order_number ?? "—"}</span>
                          </span>
                          <span className="mt-0.5 block text-[11.5px] tabular-nums text-muted dark:text-[#a89f93]">{r.tracking_id}</span>
                        </button>
                      </td>
                      <td className="max-w-[170px] px-2.5 py-2.5 leading-snug">
                        {r.reason ?? <span className="text-hint">not given — ask the group</span>}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{rs(r.cod_amount)}</td>
                      <td className="max-w-[150px] px-2.5 py-2 leading-snug">
                        <span className="block truncate">{r.customer_name ?? "—"}</span>
                        {r.city && <span className="block truncate text-[11.5px] text-muted dark:text-[#a89f93]">{r.city}</span>}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">
                        {r.phone ? <a href={`tel:${dial(r.phone)}`} className="hover:underline">{r.phone}</a> : <span className="text-hint">—</span>}
                      </td>
                      <td className={`whitespace-nowrap px-2.5 py-2.5 font-semibold tabular-nums ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)}</td>
                      <td className="px-2.5 py-1.5">
                        {/* Typed straight into the row, the moment the group replies.
                            Enter saves too. */}
                        <div className="flex items-center gap-1">
                          <input value={riderVal} inputMode="tel" placeholder="Add number" disabled={!board?.may_work}
                            aria-label={`Rider's number for ${r.order_number ?? r.tracking_id}`}
                            onChange={(e) => setRiderDraft((d) => ({ ...d, [r.tracking_id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") saveRider(r); }}
                            className="h-8 w-[118px] rounded-lg border border-line bg-canvas px-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-ink disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
                          {dirty && (
                            <button onMouseDown={(e) => e.preventDefault()} onClick={() => saveRider(r)} disabled={savingRider === r.tracking_id} title="Save the rider's number"
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
                        <button onClick={() => copy(r.tracking_id, groupMessage(r))} title="Copy this parcel for the group"
                          className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12px] font-semibold transition ${copied === r.tracking_id
                            ? "bg-success-soft text-[#2f7a3d]" : "border border-line text-ink hover:bg-panel dark:border-white/10 dark:text-white dark:hover:bg-white/[0.08]"}`}>
                          {copied === r.tracking_id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!compact && board && (
        <p className="mt-4 px-1 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
          A parcel lands here the moment a courier reports a failed attempt, and leaves by itself when it is
          finally delivered or returned. The re-attempt or the return is still clicked in PostEx&rsquo;s or
          OwnEx&rsquo;s own portal — this desk decides and remembers, it does not send anything to them.
        </p>
      )}

      {open && (
        <CaseSheet
          r={open} mayWork={!!board?.may_work} phone={phone} err={err}
          onClose={() => setOpenKey(null)} onDismissErr={() => setErr("")}
          onCopy={() => copy(open.tracking_id, groupMessage(open))} copied={copied === open.tracking_id}
          onSave={(patch) => save(open.tracking_id, patch)}
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

const Tag = ({ n }: { n: number }) => (
  <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${n >= 3
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
function CaseSheet({ r, mayWork, phone, err, onClose, onDismissErr, onCopy, copied, onSave }: {
  r: Row; mayWork: boolean; phone: boolean; err: string;
  onClose: () => void; onDismissErr: () => void;
  onCopy: () => void; copied: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  /* The courier's name is used in five sentences. A parcel whose courier never
     came through must not be told to go to "null's own portal". */
  const cn = r.courier ?? "the courier";
  const [rider, setRider] = useState(r.rider_phone ?? "");
  const [cust, setCust] = useState(r.customer_said ?? "");
  const [ridr, setRidr] = useState(r.rider_said ?? "");
  const [busy, setBusy] = useState("");
  /* ONLY on a different parcel. Depending on the three values as well meant
     that saving one of them re-ran this and overwrote the other two with the
     stale server copy — two phone calls typed in and silently thrown away. */
  useEffect(() => {
    setRider(r.rider_phone ?? ""); setCust(r.customer_said ?? ""); setRidr(r.rider_said ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.tracking_id]);

  const wa = waNumber(r.phone);
  const lastTry = r.attempts >= 3;
  const repeat = r.past_refusals >= 2;

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
        <Tag n={r.attempts} />
        <span className={`text-[12px] font-semibold ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)} since it failed</span>
        {r.outcome && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.outcome === "delivered" ? "bg-success-soft text-[#2f7a3d]" : "bg-danger-soft text-[#8d3328]"}`}>
            {r.outcome === "delivered" ? "Delivered in the end" : "Came back"}
          </span>
        )}
      </div>

      {lastTry && (
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
        <Detail label="Courier status">{r.raw_status ?? "—"}</Detail>
        <Detail label="Dispatched">{r.dispatch_date ?? "—"}</Detail>
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
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#E1F5EE] text-[#085041] dark:bg-[#12302A] dark:text-[#7FD3B8]">
                <MessageCircle size={17} />
              </a>
            )}
          </div>
        ) : <p className="text-[12.5px] text-muted dark:text-[#a89f93]">No number on the order.</p>}
        <textarea value={cust} onChange={(e) => setCust(e.target.value)} rows={2} disabled={!mayWork}
          placeholder="What did he say? Was he called? Was he at the address?"
          className="mt-2 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        <div className="flex flex-wrap items-center gap-2">
          {mayWork && cust !== (r.customer_said ?? "") && (
            <SaveBtn busy={busy === "cust"} onClick={() => run("cust", { p_customer_said: cust })} />
          )}
          {/* The commonest outcome of a COD call is nobody picking up. Without
              this there is nothing to type, so the parcel stays in the "not yet
              called" pile and gets rung again tomorrow by the same man. */}
          {mayWork && !r.customer_called_at && (
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
          <input value={rider} onChange={(e) => setRider(e.target.value)} disabled={!mayWork}
            inputMode="tel" placeholder="Rider's number"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          {mayWork && rider !== (r.rider_phone ?? "") && (
            <button onClick={() => run("rider", { p_rider_phone: rider })} disabled={busy === "rider"}
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
        <textarea value={ridr} onChange={(e) => setRidr(e.target.value)} rows={2} disabled={!mayWork || !r.rider_phone}
          placeholder="Did he call? Did he reach the address? What happened?"
          className="mt-2 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-ink outline-none disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        {mayWork && ridr !== (r.rider_said ?? "") && (
          <SaveBtn busy={busy === "ridr"} onClick={() => run("ridr", { p_rider_said: ridr })} />
        )}
      </Block>

      {/* --- 4. the verdict -------------------------------------------------- */}
      <Block n="4" title="Whose failure was it?" done={!!r.verdict}>
        <div className="grid grid-cols-3 gap-2">
          {VERDICTS.map(({ key, label, Icon }) => {
            const on = r.verdict === key;
            return (
              <button key={key} disabled={!mayWork || busy === "v" + key} onClick={() => run("v" + key, { p_verdict: key })}
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
          <button disabled={!mayWork || lastTry || busy === "d1"} onClick={() => run("d1", { p_decision: "reattempt" })}
            className={`flex min-h-[48px] items-center justify-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition disabled:opacity-40 ${r.decision === "reattempt"
              ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
              : "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.05] dark:text-white"}`}>
            <RotateCw size={15} /> Send it again
          </button>
          <button disabled={!mayWork || busy === "d2"} onClick={() => run("d2", { p_decision: "return" })}
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

      {mayWork && (
        <button onClick={() => run("done", { p_done: r.status !== "done" })} disabled={busy === "done"}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[13px] font-semibold text-ink disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          {busy === "done" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={15} />}
          {r.status === "done" ? "Put it back on the desk" : "Tick it off the desk"}
        </button>
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-hint dark:text-[#8a8175]">
        Ticking it off only clears your list. However it really ends — delivered or returned — the courier
        decides, and this row is marked with that by itself.
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
  <button onClick={onClick} disabled={busy}
    className="mt-2 flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
    {busy ? <Loader2 size={13} className="animate-spin" /> : null} Save
  </button>
);
