"use client";
/* The maturity calendar (K195): sold amounts by the day they fall due, less
   expected deductions, with payments applied to the oldest first. */
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import Topbar from "@/components/Topbar";
import { supabase } from "@/lib/supabase";
import { exportExcel } from "@/lib/export";
import { Notice, Rows, day, qty, rs, useLoad } from "@/components/carrefour/kit";

type M = { branch_id: string | null; shop: string; from_date: string; to_date: string; due_date: string;
  pieces: number; gross: number; deductions: number; net: number; remaining: number; status: string; odd_lines: number };
const FILTERS = ["All", "Overdue", "Upcoming", "Paid"];
const TONE: Record<string, string> = {
  Overdue: "bg-danger-soft text-[#b42318]", Upcoming: "bg-periwinkle-soft text-[#1e3a8a]",
  Paid: "bg-success-soft text-[#166534]", Deducted: "bg-panel text-muted",
};

export default function CarrefourMaturity() {
  const { data, err, loading } = useLoad<M[]>(() => supabase!.rpc("carrefour_maturity"));
  const [f, setF] = useState("All");
  const rows = useMemo(() => (data ?? []).filter((r) => f === "All" || r.status === f), [data, f]);
  const odd = rows.reduce((a, r) => a + r.odd_lines, 0);
  function save() {
    exportExcel({ title: "Carrefour maturity",
      headers: ["Due", "Shop", "Period from", "Period to", "Pieces", "Sold value", "Deductions", "Net", "Still to come", "Status"],
      rows: rows.map((r) => [r.due_date, r.shop, r.from_date, r.to_date, r.pieces, r.gross, r.deductions, r.net, r.remaining, r.status]) });
  }
  return (
    <div className="pb-10">
      <Topbar title="Maturity" subtitle="When each sold amount falls due" />
      <div className="space-y-4 px-6">
        {err && <Notice tone="danger">{err}</Notice>}
        {odd > 0 && <Notice>{odd} article {odd === 1 ? "line shows" : "lines show"} stock rising by more than we delivered. Check the barcodes on the latest report, as these reduce the sold figure.</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((x) => (
            <button key={x} onClick={() => setF(x)} className={`rounded-full px-3.5 py-2 text-[13px] font-semibold ${f === x ? "bg-ink text-white" : "border border-line bg-surface text-muted"}`}>{x}</button>
          ))}
          <button onClick={save} disabled={!rows.length} className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"><Download size={14} /> Excel</button>
        </div>
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={rows} rowKey={(r) => `${r.shop}|${r.from_date}|${r.to_date}`}
            empty="Nothing here yet. Each shop needs two reports before a sale can be worked out." cols={[
            { label: "Due", cell: (r) => <span className="font-semibold">{day(r.due_date)}</span> },
            { label: "Shop", cell: (r) => r.shop },
            { label: "Period", cell: (r) => `${day(r.from_date)} – ${day(r.to_date)}` },
            { label: "Sold", right: true, cell: (r) => rs(r.gross) },
            { label: "Deductions", right: true, cell: (r) => rs(r.deductions) },
            { label: "Net", right: true, cell: (r) => rs(r.net) },
            { label: "Still to come", right: true, cell: (r) => rs(r.remaining) },
            { label: "Status", cell: (r) => <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${TONE[r.status] ?? ""}`}>{r.status}</span> },
          ]} />
        )}
      </div>
    </div>
  );
}
