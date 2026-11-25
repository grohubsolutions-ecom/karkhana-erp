"use client";

/* ---------------------------------------------------------------------------
   CALLING AGENT (H322)

   The agent has no Shopify login. Everything he needs to ring a customer is
   on this one screen:

     Archived        orders archived in Shopify, never fulfilled or cancelled —
                     ring for confirmation.
     Under Review    the Delivery Under Review desk (PostEx Delivery Under
                     Review + OwnEx Shipper Advice), the same component the
                     Logistics page uses.
     Returns         LM and TS orders fulfilled and then cancelled — ring to ask
                     whether they want the parcel again.

   The agent presses an answer. The office (hub.calling.manage) sees every
   answer under Office and presses Create order / Cancel order / Wait. A
   return that becomes a new order is linked to the NEW order number, so the
   agent's bonus follows the parcel.

   BONUS: Rs 200 per parcel the agent worked that is Delivered and inside a
   PostEx CPR / OwnEx invoice. Shown under Bonus — the agent sees his own,
   the office sees everyone's. Database: supabase/H322_calling_agent.sql.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Phone, MessageCircle, RefreshCw, Loader2, AlertTriangle, PackageX, Archive, PhoneCall,
  CheckCircle2, XCircle, Clock, PhoneOff, Ban, PlusCircle, Hourglass, Undo2, Wallet, History, Search,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Segmented, waNumber } from "@/components/HubUI";
import FirstAttemptDesk from "@/components/FirstAttemptDesk";

type Kind = "archive" | "return";
type Item = { title: string | null; variant: string | null; qty: number | null; price: number | null };
type LogLine = { at: string; who: "agent" | "office" | "system"; choice: string; note: string | null; name: string | null };
type ParcelState = { tracking_id: string; courier: string | null; delivery_status: string | null; cpr_number: string | null; earned_on: string | null; state: "earned" | "pending" | "lost" };
type Case = {
  id: number; kind: Kind; store_code: string; order_number: string; status: "to_call" | "to_office" | "waiting" | "done" | "dropped";
  source_at: string | null; opened_at: string; items: Item[] | null;
  calls: number; last_call_at: string | null; call_back_at: string | null;
  agent_choice: string | null; agent_note: string | null; agent_at: string | null; agent_name: string | null;
  office_action: string | null; office_note: string | null; office_at: string | null; office_name: string | null;
  result_order_number: string | null; dropped_reason: string | null;
  customer_name: string | null; phone: string | null; city: string | null; address: string | null;
  amount: number | null; order_date: string | null; note: string | null; tags: string[] | null;
  item_count: number | null; cancel_reason: string | null; cancel_staff_note: string | null;
  total_orders: number | null; delivered_orders: number | null; failed_orders: number | null;
  parcel: { tracking_id: string; courier: string | null; delivery_status: string | null; raw_status: string | null; reason: string | null } | null;
  log: LogLine[] | null;
  suggest: { order_number: string; store_code: string; order_date: string; amount: number }[] | null;
  bonus: ParcelState[] | null;
};
type Counts = { archive: number; return: number; later: number; office: number; waiting: number; done_today: number; called_today: number };
type Board = { ok: boolean; error?: string; may_manage: boolean; counts: Counts; rows: Case[]; settings?: { bonus_amount: number; starts_on: string } };
type BonusLine = { agent: string; source: string; worked_order: string; order_number: string; tracking_id: string; courier: string | null; delivery_status: string | null; cpr_number: string | null; earned_on: string | null; state: "earned" | "pending" | "lost"; amount: number; worked_at: string };
type BonusPerson = { agent: string; earned_parcels: number; earned: number; pending_parcels: number; pending: number; lost_parcels: number };
type Bonus = { ok: boolean; error?: string; month: string; bonus_amount: number; starts_on: string; may_manage: boolean; people: BonusPerson[]; lines: BonusLine[] };
type Tab = "archive" | "review" | "return" | "office" | "history" | "bonus";

const rs = (v: unknown) => (v == null || v === "" ? "—" : "Rs " + Math.round(Number(v)).toLocaleString("en-PK"));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-PK", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PK", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" }) : "—");
const telOf = (p: string | null) => { const w = waNumber(p); return w ? "+" + w : (p ?? "").replace(/[^\d+]/g, ""); };

/* The answers. Same keys as hub_call_answer accepts — nothing else gets through. */
const ANSWERS: Record<Kind, { key: string; label: string; Icon: typeof Phone; tone: string; needsNote?: boolean; later?: boolean }[]> = {
  archive: [
    { key: "confirmed", label: "Confirmed — send it", Icon: CheckCircle2, tone: "good" },
    { key: "cancel", label: "Cancel — doesn't want", Icon: XCircle, tone: "bad", needsNote: true },
    { key: "no_answer", label: "No answer", Icon: PhoneOff, tone: "plain" },
    { key: "call_later", label: "Call later", Icon: Clock, tone: "plain", later: true },
    { key: "wrong_number", label: "Wrong / fake number", Icon: Ban, tone: "bad" },
  ],
  return: [
    { key: "wants_parcel", label: "Wants parcel again", Icon: CheckCircle2, tone: "good" },
    { key: "not_interested", label: "Doesn't want it", Icon: XCircle, tone: "bad", needsNote: true },
    { key: "no_answer", label: "No answer", Icon: PhoneOff, tone: "plain" },
    { key: "call_later", label: "Call later", Icon: Clock, tone: "plain", later: true },
    { key: "wrong_number", label: "Wrong / fake number", Icon: Ban, tone: "bad" },
  ],
};
const CHOICE_LABEL: Record<string, string> = {
  confirmed: "Confirmed", cancel: "Cancel", no_answer: "No answer", call_later: "Call later", wrong_number: "Wrong number",
  wants_parcel: "Wants parcel again", not_interested: "Doesn't want it",
  create_order: "Order created", cancel_order: "Order cancelled", wait: "Wait", recall: "Sent back to agent", undo: "Undone", dropped: "Dropped",
};
const GOOD = new Set(["confirmed", "wants_parcel"]);

function toneCls(t: string) {
  if (t === "good") return "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700";
  if (t === "bad") return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300";
  return "border-line bg-surface text-ink hover:bg-panel dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]";
}
function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "good" | "bad" | "warn" }) {
  const cls = tone === "good" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
    : tone === "bad" ? "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300"
    : tone === "warn" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
    : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

/* ------------------------------------------------------------------------- */

export default function CallingAgentPage() {
  const [tab, setTab] = useState<Tab>("archive");
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [q, setQ] = useState("");

  const view = tab === "office" ? "office" : tab === "history" ? "history" : "agent";

  const load = useCallback(async () => {
    if (!supabase || tab === "review" || tab === "bonus") { setLoading(false); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("hub_call_board", { p_view: view, p_days: 14 });
    if (error) setErr(error.message);
    else if (!data?.ok) setErr(data?.error ?? "Could not load.");
    else setBoard(data as Board);
    setLoading(false);
  }, [view, tab]);

  useEffect(() => { load(); }, [load]);
  /* The desk looks again every 2 minutes, like the Delivery Under Review desk. */
  useEffect(() => {
    if (tab === "review" || tab === "bonus") return;
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [load, tab]);

  const counts = board?.counts;
  const manage = !!board?.may_manage;

  const rows = useMemo(() => {
    let r = board?.rows ?? [];
    if (tab === "archive") r = r.filter((x) => x.kind === "archive");
    if (tab === "return") r = r.filter((x) => x.kind === "return");
    const s = q.trim().toLowerCase();
    if (s) r = r.filter((x) => [x.order_number, x.customer_name, x.phone, x.city, x.parcel?.tracking_id]
      .some((v) => String(v ?? "").toLowerCase().includes(s)));
    return r;
  }, [board, tab, q]);
  const now = Date.now();
  const due = rows.filter((r) => r.status !== "to_call" || !r.call_back_at || new Date(r.call_back_at).getTime() <= now);
  const later = rows.filter((r) => r.status === "to_call" && r.call_back_at && new Date(r.call_back_at).getTime() > now);

  const n = (v: number | undefined | null) => (v ? <span className="ml-1 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{v}</span> : null);
  const options: { key: Tab; label: string; short?: string; badge?: React.ReactNode }[] = [
    { key: "archive", label: "Archived", badge: n(counts?.archive) },
    { key: "review", label: "Delivery Under Review", short: "Review", badge: n(reviewCount) },
    { key: "return", label: "Returns", badge: n(counts?.return) },
    ...(manage ? [{ key: "office" as Tab, label: "Office", badge: n(counts?.office) }] : []),
    { key: "history", label: "History", short: "Done" },
    { key: "bonus", label: "Bonus" },
  ];

  if (!isSupabaseConfigured) return <div className="p-8 text-muted">Supabase is not configured.</div>;

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="hidden md:block">
        <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Calling Agent</h1>
        <p className="mt-1 max-w-[80ch] text-[13px] text-muted dark:text-[#a89f93]">
          Ring the customer, press what they said. Archived orders are for confirmation; Returns are parcels
          cancelled after dispatch — ask if they want it again. Every answer goes to the office, who create or
          cancel the order. Bonus: {rs(board?.settings?.bonus_amount ?? 200)} for every parcel you worked that is
          delivered and paid in the CPR / invoice.
        </p>
      </div>

      {counts && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {[["To ring — archived", counts.archive], ["To ring — returns", counts.return], ["Call-backs later", counts.later],
            ["With office", counts.office + counts.waiting], ["Rung today", counts.called_today], ["Decided today", counts.done_today]]
            .map(([l, v]) => (
              <div key={String(l)} className="rounded-xl2 border border-line bg-surface px-3 py-2 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="text-[11px] text-muted dark:text-[#a89f93]">{l}</div>
                <div className="text-[20px] font-extrabold text-ink dark:text-[#f4f1ea]">{v}</div>
              </div>
            ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented value={tab} onChange={(t) => { setTab(t); setMsg(""); }} options={options} className="w-full md:w-auto" />
        {tab !== "review" && tab !== "bonus" && (
          <>
            <div className="relative ml-auto w-full md:w-64">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order, name, phone, city"
                className="h-10 w-full rounded-full border border-line bg-surface pl-9 pr-3 text-[13px] dark:border-white/10 dark:bg-[#201c17] dark:text-white" />
            </div>
            <button onClick={load} disabled={loading} className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:bg-panel dark:border-white/10 dark:bg-[#201c17] dark:text-white">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
            </button>
          </>
        )}
      </div>

      {err && <div className="mt-3 flex items-center gap-2 rounded-xl2 bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle size={16} /> {err}</div>}
      {msg && <div className="mt-3 rounded-xl2 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">{msg}</div>}

      {/* Delivery Under Review is the existing desk — one list, two homes. */}
      <div className={tab === "review" ? "mt-4" : "hidden"}>
        <FirstAttemptDesk onCount={setReviewCount} />
        <p className="mt-4 text-[12px] text-muted dark:text-[#a89f93]">
          Bonus counts a parcel only when <b>you</b> press Re-attempt here on the desk. Press it here first, then on the
          courier&rsquo;s portal — a re-attempt pressed only on PostEx/OwnEx cannot be credited to you.
        </p>
      </div>

      {tab === "bonus" && <BonusView />}

      {tab !== "review" && tab !== "bonus" && (
        <div className="mt-4 space-y-3">
          {loading && !board && <div className="flex items-center gap-2 py-10 text-muted"><Loader2 className="animate-spin" size={18} /> Loading…</div>}
          {!loading && due.length === 0 && later.length === 0 && (
            <div className="rounded-xl2 border border-dashed border-line px-4 py-10 text-center text-[14px] text-muted dark:border-white/10">
              {tab === "office" ? "No answers waiting for the office." : tab === "history" ? "Nothing decided in the last 14 days." : "Nothing to ring right now."}
            </div>
          )}
          {due.map((c) => (
            <CaseCard key={c.id} c={c} manage={manage} onDone={(m) => { setMsg(m); load(); }} onError={setErr} />
          ))}
          {later.length > 0 && (
            <>
              <h2 className="pt-4 text-[15px] font-extrabold text-ink dark:text-[#f4f1ea]">Call-backs later ({later.length})</h2>
              {later.map((c) => <CaseCard key={c.id} c={c} manage={manage} onDone={(m) => { setMsg(m); load(); }} onError={setErr} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function CaseCard({ c, manage, onDone, onError }: { c: Case; manage: boolean; onDone: (m: string) => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [laterAt, setLaterAt] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [newOrder, setNewOrder] = useState("");
  const wa = waNumber(c.phone);

  async function answer(key: string) {
    const def = ANSWERS[c.kind].find((a) => a.key === key)!;
    if ((def.needsNote && note.trim().length < 3) || (def.later && !laterAt)) { setPick(key); return; }
    setBusy(key); onError("");
    const { data, error } = await supabase!.rpc("hub_call_answer", {
      p_id: c.id, p_choice: key, p_note: note || null, p_call_back: def.later && laterAt ? new Date(laterAt).toISOString() : null,
    });
    setBusy("");
    if (error || !data?.ok) { onError(error?.message ?? data?.error ?? "Failed."); return; }
    setNote(""); setPick(null); setLaterAt("");
    onDone(`${c.order_number}: ${CHOICE_LABEL[key]}.`);
  }

  async function decide(action: string) {
    setBusy(action); onError("");
    const { data, error } = await supabase!.rpc("hub_call_decide", {
      p_id: c.id, p_action: action, p_note: note || null, p_new_order: newOrder || null,
    });
    setBusy("");
    if (error || !data?.ok) { onError(error?.message ?? data?.error ?? "Failed."); return; }
    setNote(""); setNewOrder("");
    onDone(`${c.order_number}: ${CHOICE_LABEL[action]}${data.order ? " → " + data.order : ""}.`);
  }

  const agentSide = c.status === "to_call";
  const officeSide = manage && (c.status === "to_office" || c.status === "waiting");

  return (
    <div className="rounded-xl2 border border-line bg-surface p-4 shadow-card dark:border-white/[0.06] dark:bg-[#201c17]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        {c.kind === "archive" ? <Archive size={16} className="text-muted" /> : <PackageX size={16} className="text-muted" />}
        <span className="text-[16px] font-extrabold text-ink dark:text-[#f4f1ea]">{c.order_number}</span>
        <Badge>{c.store_code}</Badge>
        <Badge tone={c.kind === "archive" ? "warn" : "bad"}>{c.kind === "archive" ? "Archived" : "Cancelled after dispatch"}</Badge>
        {c.calls > 0 && <Badge>{c.calls} call{c.calls > 1 ? "s" : ""}</Badge>}
        {c.status === "waiting" && <Badge tone="warn">Waiting</Badge>}
        {c.status === "dropped" && <Badge>{c.dropped_reason}</Badge>}
        {c.call_back_at && c.status === "to_call" && <Badge tone="warn">Ring at {when(c.call_back_at)}</Badge>}
        <span className="ml-auto text-[18px] font-extrabold text-ink dark:text-[#f4f1ea]">{rs(c.amount)}</span>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-[1.1fr_1fr]">
        {/* Customer */}
        <div className="text-[13.5px]">
          <div className="font-bold text-ink dark:text-[#f4f1ea]">{c.customer_name ?? "—"}</div>
          <div className="mt-0.5 text-muted dark:text-[#a89f93]">{c.address ?? ""}{c.city ? `, ${c.city}` : ""}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {c.phone && (
              <a href={`tel:${telOf(c.phone)}`} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white dark:bg-white dark:text-[#141414]">
                <Phone size={15} /> {c.phone}
              </a>
            )}
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-semibold text-ink dark:border-white/10 dark:text-white">
                <MessageCircle size={15} /> WhatsApp
              </a>
            )}
          </div>
          <div className="mt-2 text-[12px] text-muted dark:text-[#a89f93]">
            Ordered {c.order_date ?? "—"} · {c.kind === "archive" ? "archived" : "cancelled"} {when(c.source_at)}
            {c.total_orders != null && <> · customer: {c.total_orders} orders, {c.delivered_orders ?? 0} delivered, {c.failed_orders ?? 0} failed</>}
          </div>
        </div>

        {/* What they ordered / what happened */}
        <div className="text-[13px]">
          {(c.items ?? []).length > 0 ? (
            <ul className="space-y-1">
              {c.items!.map((it, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-ink dark:text-[#f4f1ea]">{it.qty ?? 1} × {it.title}{it.variant ? ` — ${it.variant}` : ""}</span>
                  <span className="shrink-0 text-muted">{rs(it.price)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="text-muted">{c.item_count ?? "?"} item(s)</div>}
          {c.parcel && (
            <div className="mt-2 rounded-lg bg-panel px-3 py-2 text-[12.5px] dark:bg-white/[0.04]">
              <b>{c.parcel.courier}</b> {c.parcel.tracking_id} · {c.parcel.delivery_status}
              {c.parcel.reason && <div className="text-muted">Courier: {c.parcel.reason}</div>}
            </div>
          )}
          {(c.cancel_staff_note || c.note) && (
            <div className="mt-2 text-[12.5px] text-muted dark:text-[#a89f93]">
              {c.cancel_staff_note && <div>Cancel note: {c.cancel_staff_note}</div>}
              {c.note && <div>Order note: {c.note}</div>}
            </div>
          )}
          {(c.tags ?? []).length > 0 && <div className="mt-2 flex flex-wrap gap-1">{c.tags!.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
        </div>
      </div>

      {/* Agent's answer so far */}
      {c.agent_choice && (
        <div className="mt-3 rounded-lg border border-line px-3 py-2 text-[13px] dark:border-white/10">
          <span className="text-muted">Agent:</span>{" "}
          <Badge tone={GOOD.has(c.agent_choice) ? "good" : c.agent_choice === "no_answer" || c.agent_choice === "call_later" ? "warn" : "bad"}>
            {CHOICE_LABEL[c.agent_choice] ?? c.agent_choice}
          </Badge>{" "}
          {c.agent_note && <span className="text-ink dark:text-[#f4f1ea]">“{c.agent_note}”</span>}
          <span className="ml-2 text-[11.5px] text-muted">{c.agent_name} · {when(c.agent_at)}</span>
          {c.office_action && (
            <div className="mt-1">
              <span className="text-muted">Office:</span> <Badge tone={c.office_action === "create_order" ? "good" : c.office_action === "wait" ? "warn" : "bad"}>{CHOICE_LABEL[c.office_action]}</Badge>
              {c.result_order_number && <b className="ml-1">{c.result_order_number}</b>}
              {c.office_note && <span className="ml-1">“{c.office_note}”</span>}
              <span className="ml-2 text-[11.5px] text-muted">{c.office_name} · {when(c.office_at)}</span>
            </div>
          )}
          {(c.bonus ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {c.bonus!.map((b) => (
                <Badge key={b.tracking_id} tone={b.state === "earned" ? "good" : b.state === "lost" ? "bad" : "warn"}>
                  {b.tracking_id}: {b.state === "earned" ? `bonus earned (${b.cpr_number})` : b.state === "lost" ? "returned — no bonus" : `${b.delivery_status ?? "in transit"} — bonus pending`}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AGENT BUTTONS */}
      {agentSide && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            {ANSWERS[c.kind].map((a) => (
              <button key={a.key} disabled={!!busy} onClick={() => answer(a.key)}
                className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold transition disabled:opacity-50 ${toneCls(a.tone)} ${pick === a.key ? "ring-2 ring-offset-1 ring-amber-400" : ""}`}>
                {busy === a.key ? <Loader2 size={15} className="animate-spin" /> : <a.Icon size={15} />} {a.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the customer say? (needed for Cancel / Doesn't want)"
              className="h-10 min-w-[240px] flex-1 rounded-full border border-line bg-surface px-4 text-[13px] dark:border-white/10 dark:bg-[#17140f] dark:text-white" />
            {(pick === "call_later" || laterAt) && (
              <label className="flex items-center gap-2 text-[12.5px] text-muted">
                Ring at
                <input type="datetime-local" value={laterAt} onChange={(e) => setLaterAt(e.target.value)}
                  className="h-10 rounded-full border border-line bg-surface px-3 text-[13px] dark:border-white/10 dark:bg-[#17140f] dark:text-white" />
              </label>
            )}
          </div>
          {pick && <div className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">{pick === "call_later" ? "Pick the time, then press Call later again." : "Write why, then press the button again."}</div>}
        </div>
      )}

      {/* OFFICE BUTTONS */}
      {officeSide && (
        <div className="mt-3 border-t border-line pt-3 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-2">
            {c.kind === "return" && (
              <>
                <input value={newOrder} onChange={(e) => setNewOrder(e.target.value)} placeholder="New order no. e.g. LM20012"
                  className="h-10 w-52 rounded-full border border-line bg-surface px-4 text-[13px] dark:border-white/10 dark:bg-[#17140f] dark:text-white" />
                {(c.suggest ?? []).map((s) => (
                  <button key={s.order_number} onClick={() => setNewOrder(s.order_number)}
                    className="rounded-full bg-panel px-3 py-1 text-[12px] font-semibold text-ink hover:bg-black/5 dark:bg-white/[0.06] dark:text-white">
                    {s.order_number} · {s.order_date} · {rs(s.amount)}
                  </button>
                ))}
              </>
            )}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Office note (optional)"
              className="h-10 min-w-[180px] flex-1 rounded-full border border-line bg-surface px-4 text-[13px] dark:border-white/10 dark:bg-[#17140f] dark:text-white" />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => decide("create_order")} className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold ${toneCls("good")}`}>
              {busy === "create_order" ? <Loader2 size={15} className="animate-spin" /> : <PlusCircle size={15} />}
              {c.kind === "archive" ? "Create order (un-archive & ship)" : "Create order (linked)"}
            </button>
            <button disabled={!!busy} onClick={() => decide("cancel_order")} className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold ${toneCls("bad")}`}>
              {busy === "cancel_order" ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />} Cancel order
            </button>
            {c.status !== "waiting" && (
              <button disabled={!!busy} onClick={() => decide("wait")} className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold ${toneCls("plain")}`}>
                {busy === "wait" ? <Loader2 size={15} className="animate-spin" /> : <Hourglass size={15} />} Wait
              </button>
            )}
            <button disabled={!!busy} onClick={() => decide("recall")} className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold ${toneCls("plain")}`}>
              {busy === "recall" ? <Loader2 size={15} className="animate-spin" /> : <PhoneCall size={15} />} Ring again
            </button>
          </div>
        </div>
      )}

      {manage && c.status === "done" && (
        <div className="mt-2">
          <button disabled={!!busy} onClick={() => decide("undo")} className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink">
            <Undo2 size={13} /> Undo decision
          </button>
        </div>
      )}

      {(c.log ?? []).length > 0 && (
        <details className="mt-2 text-[12px] text-muted dark:text-[#a89f93]">
          <summary className="cursor-pointer select-none"><History size={12} className="mr-1 inline" />History ({c.log!.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {c.log!.map((l, i) => (
              <li key={i}>{when(l.at)} — <b>{l.name ?? l.who}</b>: {CHOICE_LABEL[l.choice] ?? l.choice}{l.note ? ` — ${l.note}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function BonusView() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }).slice(0, 7));
  const [data, setData] = useState<Bonus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [show, setShow] = useState<"earned" | "pending" | "lost">("earned");

  useEffect(() => {
    (async () => {
      setLoading(true); setErr("");
      const { data, error } = await supabase!.rpc("hub_call_bonus", { p_month: `${month}-01` });
      if (error || !data?.ok) setErr(error?.message ?? data?.error ?? "Failed.");
      else setData(data as Bonus);
      setLoading(false);
    })();
  }, [month]);

  const lines = (data?.lines ?? []).filter((l) => l.state === show);
  const SRC: Record<string, string> = { archive: "Archived", return: "Return", review: "Under review" };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="h-10 rounded-full border border-line bg-surface px-4 text-[13px] dark:border-white/10 dark:bg-[#201c17] dark:text-white" />
        {data && <span className="text-[12.5px] text-muted">{rs(data.bonus_amount)} per parcel delivered and in a CPR / invoice · counted from {data.starts_on}</span>}
      </div>
      {err && <div className="mt-3 rounded-xl2 bg-red-50 px-4 py-3 text-[13px] text-red-700">{err}</div>}
      {loading ? <div className="flex items-center gap-2 py-10 text-muted"><Loader2 className="animate-spin" size={18} /> Loading…</div> : data && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.people.length === 0 && <div className="text-[13px] text-muted">No bonus lines yet this month.</div>}
            {data.people.map((p) => (
              <div key={p.agent} className="rounded-xl2 border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
                <div className="flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]"><Wallet size={16} /> {p.agent}</div>
                <div className="mt-2 text-[26px] font-extrabold text-emerald-700 dark:text-emerald-300">{rs(p.earned)}</div>
                <div className="text-[12px] text-muted">{p.earned_parcels} parcels paid this month</div>
                <div className="mt-2 text-[12.5px] text-ink dark:text-[#f4f1ea]">Pending: {p.pending_parcels} parcels ({rs(p.pending)} if all are paid)</div>
                <div className="text-[12.5px] text-muted">Returned (no bonus): {p.lost_parcels}</div>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <Segmented value={show} onChange={setShow} options={[
              { key: "earned", label: "Earned" }, { key: "pending", label: "Pending payment" }, { key: "lost", label: "Returned" },
            ]} />
          </div>
          <div className="mt-3 overflow-x-auto rounded-xl2 border border-line dark:border-white/[0.06]">
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead className="bg-panel text-left text-muted dark:bg-white/[0.04]">
                <tr>{(data.may_manage ? ["Agent"] : []).concat(["Worked", "From", "Order", "Parcel", "Status", "CPR / invoice", "Paid on", "Bonus"]).map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-muted">Nothing here.</td></tr>}
                {lines.map((l, i) => (
                  <tr key={i} className="border-t border-line dark:border-white/[0.06]">
                    {data.may_manage && <td className="px-3 py-2 font-semibold">{l.agent}</td>}
                    <td className="px-3 py-2">{day(l.worked_at)}</td>
                    <td className="px-3 py-2">{SRC[l.source] ?? l.source}{l.worked_order !== l.order_number ? ` (${l.worked_order})` : ""}</td>
                    <td className="px-3 py-2 font-semibold">{l.order_number}</td>
                    <td className="px-3 py-2">{l.courier} {l.tracking_id}</td>
                    <td className="px-3 py-2">{l.delivery_status}</td>
                    <td className="px-3 py-2">{l.cpr_number ?? "—"}</td>
                    <td className="px-3 py-2">{l.earned_on ?? "—"}</td>
                    <td className="px-3 py-2 font-bold">{l.state === "earned" ? rs(l.amount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
