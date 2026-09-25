"use client";

/* ---------------------------------------------------------------------------
   THE FIRST-ATTEMPT DESK.

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
import { Segmented, Sheet, Detail, PhoneCard, PageActions, useIsPhone, waNumber } from "@/components/HubUI";

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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copied, setCopied] = useState("");

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
        ? "This desk needs migrations H274–H277, which have not been run on the database yet."
        : error.message);
      return;
    }
    const b = data as Board;
    if (!b?.ok) { setErr(b?.error ?? "Could not open the desk."); setBoard(null); return; }
    setBoard(b);
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(
    () => (board?.rows ?? []).filter((r) => courier === "All" || r.courier === courier),
    [board, courier]
  );
  const open = useMemo(() => (board?.rows ?? []).find((r) => r.tracking_id === openKey) ?? null, [board, openKey]);

  async function save(tracking: string, patch: Record<string, unknown>) {
    if (!supabase) return false;
    const { data, error } = await supabase.rpc("hub_rescue_save", { p_tracking: tracking, ...patch });
    const r = (data ?? {}) as { ok?: boolean; error?: string };
    if (error || !r.ok) { setErr(error?.message ?? r.error ?? "Could not save that."); return false; }
    setErr("");
    /* Ticking it off moves it out of this list, so the sheet would vanish
       mid-tap with nothing said. Close it deliberately instead. */
    if (patch.p_done === true) setOpenKey(null);
    await load();
    return true;
  }

  async function copyRow(r: Row) {
    const ok = await copyText(groupMessage(r));
    setCopied(ok ? r.tracking_id : "");
    if (!ok) setErr("The phone would not let the page copy. Press and hold the message to copy it by hand.");
    setTimeout(() => setCopied(""), 2200);
  }

  const s = board?.summary;

  return (
    <div className="mt-1">
      {/* ------------------------------------------------------- the numbers */}
      {s && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="On the desk" value={String(s.open)} sub={`${s.postex} PostEx · ${s.ownex} OwnEx`} tone="#E5786B" />
          <Stat label="Not yet called" value={String(s.untouched)} sub="nobody has rung the customer" tone="#E4B47E" />
          <Stat label="On their last try" value={String(s.last_try)} sub="third attempt — no more re-tries" tone="#B693DD" />
          <Stat label="Saved so far" value={String(s.saved)} sub={s.lost ? `${s.lost} still came back` : "delivered after a failed try"} tone="#7FC489" />
        </div>
      )}

      {/* ------------------------------------------------------------ filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented value={courier} onChange={setCourier} className="flex-1 sm:flex-none"
          options={[{ key: "All" as const, label: "Both" }, { key: "PostEx" as const, label: "PostEx" }, { key: "OwnEx" as const, label: "OwnEx" }]} />
        <Segmented value={scope} onChange={setScope} className="flex-1 sm:flex-none"
          options={[{ key: "open" as const, label: "Working" }, { key: "done" as const, label: "Finished" }]} />
        <PageActions>
          <button onClick={load}
            className="flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </PageActions>
      </div>

      {err && (
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
          {scope === "open" ? "Nothing waiting. Every failed attempt has been dealt with." : "Nothing finished yet."}
        </p>
      )}

      {/* --------------------------------------------------------- phone list */}
      {rows.length > 0 && (
        <div className="mt-3 space-y-2 md:hidden">
          {rows.map((r) => (
            <PhoneCard key={r.tracking_id} onClick={() => setOpenKey(r.tracking_id)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier}</span>
                    <span className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? r.tracking_id}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted dark:text-[#a89f93]">
                    {r.customer_name ?? "—"}{r.city ? ` · ${r.city}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.cod_amount)}</div>
                  <div className={`text-[11.5px] font-semibold ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)} waiting</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <Tag n={r.attempts} />
                <span className="truncate text-muted dark:text-[#a89f93]">{r.reason ?? "no reason given"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Step on={!!r.customer_called_at} text="customer" />
                <Step on={!!r.rider_phone} text="rider no." />
                <Step on={!!r.rider_called_at} text="rider" />
                <Step on={!!r.verdict} text="verdict" />
              </div>
            </PhoneCard>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------ desktop table */}
      {rows.length > 0 && (
        <div className="mt-3 hidden md:block">
          <div className="overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead className="bg-panel text-left text-[11px] uppercase tracking-wide text-muted dark:bg-white/[0.05] dark:text-[#a89f93]">
                <tr>
                  {["Courier", "Try", "Order", "Tracking", "Why it failed", "Amount", "Customer", "Waiting", "Rider", "Done so far"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.tracking_id} onClick={() => setOpenKey(r.tracking_id)}
                    className="cursor-pointer border-t border-line transition hover:bg-panel dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${COURIER_TONE[r.courier ?? ""] ?? "bg-panel text-muted"}`}>{r.courier}</span>
                    </td>
                    <td className="px-3 py-2"><Tag n={r.attempts} /></td>
                    <td className="px-3 py-2 font-semibold text-ink dark:text-[#f4f1ea]">{r.order_number ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-muted dark:text-[#a89f93]">{r.tracking_id}</td>
                    <td className="max-w-[220px] px-3 py-2">
                      {r.reason ?? <span className="text-hint">not given — ask the group</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{rs(r.cod_amount)}</td>
                    <td className="max-w-[170px] truncate px-3 py-2">{r.customer_name ?? "—"}<span className="text-hint">{r.city ? ` · ${r.city}` : ""}</span></td>
                    <td className={`px-3 py-2 font-semibold tabular-nums ${heat(r.waiting_hours)}`}>{waited(r.waiting_hours)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.rider_phone ?? <span className="text-hint">—</span>}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Step on={!!r.customer_called_at} text="cust" />
                        <Step on={!!r.rider_called_at} text="rider" />
                        <Step on={!!r.verdict} text={r.verdict ?? "verdict"} />
                      </div>
                    </td>
                  </tr>
                ))}
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
          onCopy={() => copyRow(open)} copied={copied === open.tracking_id}
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
