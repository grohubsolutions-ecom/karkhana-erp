"use client";
/* CARREFOUR DASHBOARD (K195). Every figure comes from carrefour_summary. */
import Link from "next/link";
import Topbar from "@/components/Topbar";
import { supabase } from "@/lib/supabase";
import { Notice, Stat, day, qty, rs, useLoad } from "@/components/carrefour/kit";

type S = Record<string, number> & { last_report: string | null };

export default function CarrefourDashboard() {
  const { data: s, err, loading } = useLoad<S>(() => supabase!.rpc("carrefour_summary"));
  return (
    <div className="pb-10">
      <Topbar title="Carrefour dashboard" subtitle={s ? `Latest report ${day(s.last_report)} · payment matures ${s.maturity_days} days after sale` : undefined} />
      <div className="space-y-4 px-6">
        {err && <Notice tone="danger">{err}</Notice>}
        {loading && !s && <p className="text-[13px] text-muted">Loading…</p>}
        {s && <>
          {s.sold_periods === 0 && (
            <Notice>Sales need two reports for a shop, and there {s.reports === 1 ? "is one" : `are ${s.reports}`} so far. Maturity starts filling in with the next <Link className="underline" href="/carrefour/upload">upload</Link>.</Notice>
          )}
          {s.unmatched_lines > 0 && (
            <Notice>{qty(s.unmatched_lines)} of {qty(s.lines)} lines on the latest report have a barcode that matches no product, so deliveries of those articles are not counted and their sold figures can come out too low.</Notice>
          )}
          {s.terms === 0 && (
            <Notice>No deduction terms entered, so amounts below are before deductions. <Link className="underline" href="/carrefour/terms">Add your terms</Link>.</Notice>
          )}
          <h2 className="pt-1 text-[13px] font-bold text-ink">Money</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Overdue" value={rs(s.overdue)} tone={s.overdue > 0 ? "danger" : undefined} />
            <Stat label="Due in 7 days" value={rs(s.due_7)} />
            <Stat label="Due in 30 days" value={rs(s.due_30)} />
            <Stat label="Unexplained deductions" value={rs(s.unexplained)} tone={s.unexplained > 0 ? "danger" : undefined} note="Charged above your terms" />
            <Stat label="Sold value" value={rs(s.gross)} note="From stock reports" />
            <Stat label="Expected deductions" value={rs(s.expected)} note="From your terms" />
            <Stat label="Debit notes charged" value={rs(s.debit_notes)} />
            <Stat label="Payments received" value={rs(s.paid)} tone="good" />
          </div>
          <h2 className="pt-1 text-[13px] font-bold text-ink">Stock</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="At Carrefour shops" value={`${qty(s.stock_pieces)} pcs`} note={`${rs(s.stock_value)} at report price`} />
            <Stat label="Delivered so far" value={`${qty(s.sent_pieces)} pcs`} note={`${rs(s.sent_value)} at retail`} />
            <Stat label="Invoices" value={qty(s.invoices)} />
          </div>
        </>}
      </div>
    </div>
  );
}
