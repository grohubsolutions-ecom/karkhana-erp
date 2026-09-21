"use client";

/* ---------------------------------------------------------------------------
   DISPUTES — returns a courier has billed us for that Shopify still calls live.
 
   229 parcels across 35 settlements, Rs 515,149. Each one is the same
   disagreement: the courier says the parcel came back and charged for the trip;
   Shopify shows the order as open, so it counts as revenue there and nobody is
   looking for the box.
 
   These were only ever visible one settlement at a time, on each CPR's own
   panel. Seeing all of them meant opening thirty-five screens, which is another
   way of saying nobody saw them.
 
   The page is a worklist, not a report. Tick the ones you have actually
   received, and close or cancel those in Shopify. The rest stay, because a
   parcel nobody has seen should not quietly leave the only list that would make
   somebody look for it.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Loader2, AlertTriangle, ExternalLink, Check } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { useConfirm } from "@/components/ConfirmDialog";
import { HubRange, PageActions, useIsPhone } from "@/components/HubUI";

const PERIODS = [["7d", "7 days"], ["30d", "30 days"], ["60d", "60 days"], ["90d", "90 days"], ["all", "All time"], ["custom", "Custom"]]
  .map(([key, label]) => ({ key, label }));

type Dispute = {
  tracking_id: string;
  order_number: string | null;
  store_code: string | null;
  courier: string | null;
  cod_amount: number | null;
  return_charge: number | null;
  cpr_number: string | null;
  settled_on: string | null;
  return_date: string | null;
  age_days: number | null;
  received: boolean;
  courier_reason_text: string | null;
  raw_status: string | null;
  customer_name: string | null;
  city: string | null;
};

const rs = (v: unknown) =>
  "Rs " + Math.round(Number(v ?? 0)).toLocaleString("en-PK");

export default function DisputesPage() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  /* The search runs against rows already in memory, but re-filtering on every
     keystroke re-renders the whole table — which is what made typing feel
     sticky. A short delay means one filter per pause, not one per letter. */
  const [qLive, setQLive] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive), 180);
    return () => clearTimeout(t);
  }, [qLive]);
  const [courier, setCourier] = useState("All");
  const [cpr, setCpr] = useState("All");
  const [picked, setPicked] = useState<string[]>([]);
  const phone = useIsPhone();
  /* The date belongs here, not in the view. Four fixed dates have been written
     into this system and every one had to be undone; a filter somebody can
     change costs nothing and never goes stale. Defaults to the last 60 days,
     which is where the work is, and "All time" is one click away. */
  const [preset, setPreset] = useState("60d");
  const [cf, setCf] = useState("");
  const [ct, setCt] = useState("");

  const range = useMemo(() => {
    const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    switch (preset) {
      case "7d":   return { from: d(7),  to: "" };
      case "30d":  return { from: d(30), to: "" };
      case "60d":  return { from: d(60), to: "" };
      case "90d":  return { from: d(90), to: "" };
      case "all":  return { from: "",    to: "" };
      case "custom": return { from: cf,  to: ct };
      default:     return { from: d(60), to: "" };
    }
  }, [preset, cf, ct]);

  /* THE DATES ARE APPLIED BY THE DATABASE.
     The page used to load the first 1,000 disputes of all time and filter the
     dates here — fine at today's ~230, silently short past 1,000, and the
     totals are added from this list. A dispute with no return date recorded
     is kept in every range rather than hidden from all of them. */
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    let qq = supabase
      .from("v_return_disputes")
      .select("*", { count: "exact" })
      .order("settled_on", { ascending: false, nullsFirst: false })
      .limit(1000);
    /* One logic tree, never two .or() calls on the same request. */
    if (range.from && range.to)
      qq = qq.or(`and(return_date.gte.${range.from},return_date.lte.${range.to}),return_date.is.null`);
    else if (range.from) qq = qq.or(`return_date.gte.${range.from},return_date.is.null`);
    else if (range.to)   qq = qq.or(`return_date.lte.${range.to},return_date.is.null`);
    const { data, error, count } = await qq;
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setRows((data as Dispute[]) ?? []);
    setMatchCount(typeof count === "number" ? count : null);
    setPicked([]);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const cprs = useMemo(
    () => [...new Set(rows.map((r) => r.cpr_number).filter(Boolean))] as string[],
    [rows],
  );

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase().replace("#", "");
    return rows.filter((r) =>
      (courier === "All" || r.courier === courier) &&
      (cpr === "All" || r.cpr_number === cpr) &&
      (!n || [r.order_number, r.tracking_id, r.customer_name, r.city]
        .some((v) => String(v ?? "").toLowerCase().replace("#", "").includes(n))),
    );
  /* window must be here. It is read inside this filter, so leaving it out means
     React never recomputes when a date chip is clicked — the dates were being
     applied to a list that never refreshed, and every preset showed the same
     count. */
  }, [rows, q, courier, cpr]);

  const totals = useMemo(() => ({
    n: shown.length,
    cod: shown.reduce((t, r) => t + Number(r.cod_amount ?? 0), 0),
    charge: shown.reduce((t, r) => t + Number(r.return_charge ?? 0), 0),
  }), [shown]);

  const toggle = (t: string) =>
    setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));

  /* Everything currently visible, so "select all" respects the filters rather
     than quietly reaching past them. */
  const allShown = () => setPicked(shown.map((r) => r.tracking_id));

  async function push(action: "close" | "cancel") {
    if (!supabase || !picked.length) return;
    if (action === "cancel") {
      const ok = await confirm({
        title: `Cancel ${picked.length} order${picked.length === 1 ? "" : "s"} in Shopify?`,
        body: "Shopify has no un-cancel. The only way back is recreating the order, losing its number and history. Closing archives them instead and can be reversed.",
        confirmLabel: "Cancel them permanently",
      });
      if (!ok) return;
    }
    setBusy(action); setErr(""); setMsg("");
    const { data, error } = await supabase.functions.invoke("shopify-writeback", {
      body: {
        action,
        tracking: picked,
        dry_run: false,
        max: 200,
        ...(action === "cancel" ? { confirm: "CANCEL PERMANENTLY" } : {}),
      },
    });
    setBusy("");
    if (error) {
      let detail = error.message;
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try { detail = (await ctx.json())?.error ?? detail; } catch { /* keep it */ }
      }
      setErr(detail);
      return;
    }
    setMsg((data as { report?: string })?.report ?? "Done.");
    /* Reload rather than remove the rows by hand: whether a parcel leaves this
       list depends on Shopify, and guessing would show a result that has not
       happened yet. */
    load();
  }

  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <Link href="/online/finance"
            className="mb-1 hidden items-center gap-1.5 md:inline-flex text-[12.5px] font-semibold text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
        <ArrowLeft size={14} /> Finance
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="hidden text-[24px] font-extrabold tracking-tight text-ink md:block dark:text-[#f4f1ea]">
            Disputes
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-muted sm:text-[13px] dark:text-[#a89f93]">
            The courier billed us for bringing these back. Shopify still shows the order
            as live, so it counts as revenue there and nobody is chasing the parcel.
          </p>
        </div>
        <PageActions>
          <button onClick={() => load()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12.5px] font-semibold text-muted transition hover:bg-panel dark:border-white/10 dark:text-[#a89f93] dark:hover:bg-white/10">
            <RefreshCw size={13} /> Refresh
          </button>
        </PageActions>
      </div>

      {/* The totals below are added from the loaded list, which stops at 1,000.
          If the range ever holds more, say so instead of showing a short total. */}
      {!loading && matchCount != null && matchCount > rows.length && (
        <p className="mt-4 rounded-card border border-amber-300 bg-amber-soft px-4 py-2.5 text-[12.5px] font-semibold text-amber-900">
          {matchCount.toLocaleString()} disputes in this range — only the newest {rows.length.toLocaleString()} are counted below. Narrow the dates.
        </p>
      )}
      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        <div className="min-w-0 rounded-card border border-line bg-surface p-3 sm:p-4 dark:border-white/10 dark:bg-[#201c17]">
          <div className="max-sm:truncate text-[16px] font-extrabold tabular-nums text-ink sm:text-[22px] dark:text-[#f4f1ea]">
            {loading ? "—" : totals.n.toLocaleString()}
          </div>
          <div className="text-[11.5px] font-semibold leading-tight text-ink sm:text-[12.5px] dark:text-[#f4f1ea]">Open disputes</div>
          <div className="hidden text-[11.5px] text-muted sm:block dark:text-[#a89f93]">not cancelled in Shopify</div>
        </div>
        <div className="min-w-0 rounded-card border border-line bg-surface p-3 sm:p-4 dark:border-white/10 dark:bg-[#201c17]">
          <div className="max-sm:truncate text-[16px] font-extrabold tabular-nums text-ink sm:text-[22px] dark:text-[#f4f1ea]">
            {loading ? "—" : rs(totals.cod)}
          </div>
          <div className="text-[11.5px] font-semibold leading-tight text-ink sm:text-[12.5px] dark:text-[#f4f1ea]">COD on the orders</div>
          <div className="hidden text-[11.5px] text-muted sm:block dark:text-[#a89f93]">still counted as sales in Shopify</div>
        </div>
        <div className="min-w-0 rounded-card border border-amber-300 bg-amber-soft p-3 sm:p-4">
          <div className="max-sm:truncate text-[16px] font-extrabold tabular-nums text-amber-900 sm:text-[22px]">
            {loading ? "—" : rs(totals.charge)}
          </div>
          <div className="text-[11.5px] font-semibold leading-tight text-amber-900 sm:text-[12.5px]">Charged to bring them back</div>
          <div className="hidden text-[11.5px] text-amber-800 sm:block">already paid to the courier</div>
        </div>
      </div>

      {/* Filter by when the parcel came back — the date that matters for a
          dispute, since that is what the courier billed for. */}
      <HubRange presets={PERIODS} preset={preset} setPreset={setPreset} cf={cf} setCf={setCf} ct={ct} setCt={setCt}
        right={<>
          <select value={courier} onChange={(e) => setCourier(e.target.value)}
                  className="rounded-full border border-line bg-surface px-3 py-2 text-[12.5px] font-medium dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            {["All", "PostEx", "OwnEx"].map((c) => <option key={c} value={c}>{c === "All" ? "All couriers" : c}</option>)}
          </select>
          <select value={cpr} onChange={(e) => setCpr(e.target.value)}
                  className="max-w-[220px] rounded-full border border-line bg-surface px-3 py-2 text-[12.5px] font-medium max-md:max-w-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
            <option value="All">All settlements</option>
            {cprs.map((c) => <option key={c}>{c}</option>)}
          </select>
          <div className="flex">
            <input value={qLive} onChange={(e) => setQLive(e.target.value)}
                   placeholder="Search order, tracking, customer"
                   className="w-56 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          </div>
        </>} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto md:justify-end">
          {picked.length > 0 && (
            <button onClick={() => setPicked([])}
                    className="min-h-[40px] text-[12.5px] font-semibold text-muted underline underline-offset-2 md:min-h-0 dark:text-[#a89f93]">
              clear {picked.length}
            </button>
          )}
          <button onClick={allShown} disabled={!shown.length}
                  className="ml-auto min-h-[40px] rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-semibold disabled:opacity-40 md:ml-0 md:min-h-[36px] dark:border-white/10">
            Select all {shown.length}
          </button>
        </div>
        {/* Close / cancel: beside the filters on a desktop; on a phone a bar
            above the tab bar once something is ticked, in reach wherever the
            ticked rows are. */}
        <div className={`${picked.length ? "flex" : "hidden md:flex"} fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 items-center gap-2 border-t border-line bg-surface px-4 py-2.5 shadow-[0_-6px_20px_rgba(20,16,12,0.08)] md:static md:border-0 md:bg-transparent md:p-0 md:shadow-none dark:border-white/10 dark:bg-[#201c17] md:dark:bg-transparent`}>
          <span className="flex-1 text-[13px] font-semibold text-ink md:hidden dark:text-[#f4f1ea]">{picked.length} ticked</span>
          <button onClick={() => push("close")} disabled={!picked.length || !!busy}
                  className="min-h-[44px] rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40 md:min-h-[36px] dark:bg-white dark:text-[#141414]">
            {busy === "close" && <Loader2 size={12} className="mr-1 inline animate-spin" />}
            Close {picked.length || ""} in Shopify
          </button>
          <button onClick={() => push("cancel")} disabled={!picked.length || !!busy}
                  className="min-h-[44px] rounded-full border border-red-300 bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 md:min-h-[36px] md:bg-transparent dark:bg-transparent">
            {busy === "cancel" && <Loader2 size={12} className="mr-1 inline animate-spin" />}
            Cancel {picked.length || ""}
          </button>
        </div>
      </div>

      {msg && (
        <div className="mt-3 rounded-card border border-emerald-300 bg-success-soft p-2.5 text-[12.5px] font-medium text-emerald-900">
          {msg}
        </div>
      )}
      {err && (
        <div className="mt-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-2.5 text-[12px] text-red-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {phone ? (
        <div className={`mt-4 space-y-2 ${picked.length ? "pb-16" : ""}`}>
          {loading && <p className="px-4 py-8 text-center text-muted"><Loader2 size={15} className="inline animate-spin" /> Loading…</p>}
          {!loading && !shown.length && (
            <p className="px-4 py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">{rows.length ? "Nothing matches these filters." : "No disputes. Every settled return is cancelled in Shopify too."}</p>
          )}
          {shown.map((r) => {
            const on = picked.includes(r.tracking_id);
            return (
              <button key={r.tracking_id} type="button" onClick={() => toggle(r.tracking_id)} aria-pressed={on}
                className={`flex w-full items-start gap-3 rounded-xl2 border px-3.5 py-3 text-left transition active:scale-[0.99] ${on ? "border-ink bg-success-soft dark:border-white/40 dark:bg-white/[0.08]" : "border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]"}`}>
                <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${on ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]" : "border-line dark:border-white/20"}`}>{on && <Check size={15} strokeWidth={3} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-bold text-ink dark:text-[#f4f1ea]">{r.order_number ?? "—"}</span>
                    <span className="shrink-0 rounded-md bg-panel px-1.5 py-0.5 text-[10.5px] font-bold text-muted dark:bg-white/[0.06] dark:text-[#a89f93]">{r.store_code ?? ""}</span>
                    <span className="ml-auto shrink-0 text-[14px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(r.cod_amount)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted dark:text-[#a89f93]">
                    <span className="min-w-0 flex-1 truncate">{r.courier ?? "—"} · {r.tracking_id}</span>
                    <span className="shrink-0 tabular-nums text-amber-700">charge {rs(r.return_charge)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted dark:text-[#a89f93]">{r.cpr_number ?? "—"} · settled {r.settled_on ?? "—"} · back {r.return_date ?? "—"}{r.age_days != null ? ` (${r.age_days}d)` : ""}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink dark:text-[#e7e2d8]">{r.courier_reason_text || r.raw_status || "—"}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
      <div className="mt-4 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-white/[0.03]">
        <table className="w-full min-w-[900px] text-left text-[13px]">
          <thead className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
            <tr>
              <th className="w-10 px-4 py-3" />
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Store</th>
              <th className="px-4 py-3 font-semibold">Courier</th>
              <th className="px-4 py-3 font-semibold">Tracking</th>
              <th className="px-4 py-3 font-semibold">CPR / Invoice</th>
              <th className="px-4 py-3 font-semibold">Settled</th>
              <th className="px-4 py-3 font-semibold">Returned</th>
              <th className="px-4 py-3 text-right font-semibold">COD</th>
              <th className="px-4 py-3 text-right font-semibold">Charge</th>
              <th className="px-4 py-3 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.06]">
            {loading && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted">
                <Loader2 size={15} className="inline animate-spin" /> Loading…
              </td></tr>
            )}
            {!loading && !shown.length && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted dark:text-[#a89f93]">
                {rows.length
                  ? "Nothing matches these filters."
                  : "No disputes. Every settled return is cancelled in Shopify too."}
              </td></tr>
            )}
            {shown.map((r) => {
              const on = picked.includes(r.tracking_id);
              return (
                <tr key={r.tracking_id}
                    onClick={() => toggle(r.tracking_id)}
                    className={`cursor-pointer transition ${on ? "bg-success-soft" : "hover:bg-panel/50 dark:hover:bg-white/[0.03]"}`}>
                  <td className="px-4 py-3">
                    <input type="checkbox" readOnly checked={on} className="h-4 w-4 accent-current" />
                  </td>
                  <td className="px-4 py-3 font-semibold text-ink dark:text-[#f4f1ea]">{r.order_number ?? "—"}</td>
                  <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{r.store_code ?? "—"}</td>
                  <td className="px-4 py-3 text-muted dark:text-[#a89f93]">{r.courier ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-muted dark:text-[#a89f93]">{r.tracking_id}</td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-ink dark:text-[#e7e2d8]">{r.cpr_number ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">{r.settled_on ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-muted dark:text-[#a89f93]">
                    {r.return_date ?? "—"}
                    {r.age_days != null && (
                      <span className="ml-1.5 text-[11px] text-hint">{r.age_days}d</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-ink dark:text-[#e7e2d8]">{rs(r.cod_amount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-700">{rs(r.return_charge)}</td>
                  <td className="px-4 py-3 text-[11.5px] text-muted dark:text-[#a89f93]">
                    {r.courier_reason_text || r.raw_status || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <p className="mt-3 max-w-3xl text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
        Tick the parcels you have actually received, then close or cancel those in
        Shopify. <b>Close</b> archives an order and can be reversed from the Shopify
        admin; <b>cancel</b> cannot be reversed at all. Anything you leave unticked stays
        here — a parcel nobody has seen should not disappear from the only list that
        would make somebody look for it.
      </p>
    </div>
  );
}
