"use client";
/* Carrefour invoices (K195), read from the warehouse's deliveries. Printing
   uses the Invoice Book's own sheet. Changes stay in the Invoice Book. */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import Topbar from "@/components/Topbar";
import { supabase } from "@/lib/supabase";
import { printInvoice, type RegRow } from "@/components/warehouse/InvoiceBook";
import { Notice, Rows, Stat, day, inp, qty, rs, useLoad } from "@/components/carrefour/kit";

type Inv = { invoice_no: string; on_date: string; shop: string | null; delivery_no: number | null;
  pieces: number; retail: number; unpriced: number; lines: Parameters<typeof printInvoice>[1] };

function print(i: Inv) {
  const reg: RegRow = { party_id: "", party: "Carrefour", sequence_mode: "per_party", scope_branch_id: null, scope_branch: null,
    invoice_no: i.invoice_no, status: "used", on_date: i.on_date, branch_id: null, branches: i.shop, lines: i.lines.length,
    pieces: i.pieces, retail: i.retail, delivery_no: i.delivery_no, reason: null, note_id: null };
  printInvoice(reg, i.lines);
}

export default function CarrefourInvoices() {
  const { data, err, loading } = useLoad<Inv[]>(() => supabase!.rpc("carrefour_invoices"));
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter((i) => !t || i.invoice_no?.toLowerCase().includes(t) || (i.shop ?? "").toLowerCase().includes(t));
  }, [data, q]);
  const unpriced = rows.reduce((a, r) => a + r.unpriced, 0);
  return (
    <div className="pb-10">
      <Topbar title="Carrefour invoices" subtitle="Every delivery the warehouse has made to Carrefour" />
      <div className="space-y-4 px-6">
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Invoices" value={qty(rows.length)} />
          <Stat label="Pieces" value={qty(rows.reduce((a, r) => a + Number(r.pieces), 0))} />
          <Stat label="Value at retail" value={rs(rows.reduce((a, r) => a + Number(r.retail), 0))} />
        </div>
        {unpriced > 0 && <Notice>{unpriced} invoice {unpriced === 1 ? "line has" : "lines have"} no retail price, so the value above is short. Set the price on the product in the warehouse.</Notice>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice or shop" className={inp} />
        {loading && !data ? <p className="text-[13px] text-muted">Loading…</p> : (
          <Rows rows={rows} rowKey={(r) => r.invoice_no} empty="No invoices found." cols={[
            { label: "Invoice", cell: (r) => <span className="font-mono font-semibold">{r.invoice_no}</span> },
            { label: "Date", cell: (r) => day(r.on_date) },
            { label: "Shop", cell: (r) => r.shop ?? "—" },
            { label: "Pieces", right: true, cell: (r) => qty(r.pieces) },
            { label: "Value", right: true, cell: (r) => rs(r.retail) },
            { label: "Print", right: true, cell: (r) => (
              <button onClick={() => print(r)} aria-label={`Print invoice ${r.invoice_no}`} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-ink hover:bg-panel"><Printer size={15} /></button>
            ) },
          ]} />
        )}
      </div>
    </div>
  );
}
