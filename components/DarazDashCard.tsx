"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Store, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { rs, num } from "@/lib/dateRange";

type S = { orders: number; gross: number; delivered: number; returned: number; cancelled: number; pending: number; shipped: number;
  delivery_rate: number; net_payout: number; fees: number; paid_net: number; unpaid_net: number; awaiting_value: number };

/* K200 — Daraz beside LM / TS / TRZ on the Hub dashboard. Its figures come
   from uploaded Seller Center files, not Shopify, so it sits in its own card
   rather than as a column in the Shopify breakdown. Hidden from anyone
   without hub.daraz.view. */
export default function DarazDashCard({ from, to }: { from: string | null; to: string | null }) {
  const { ready, can } = usePermissions();
  const allowed = ready && can(["hub.daraz.view", "hub.daraz.manage"]);
  const [s, setS] = useState<S | null>(null);
  useEffect(() => {
    if (!allowed || !supabase) return;
    let live = true;
    supabase.rpc("daraz_summary", { p_from: from, p_to: to }).then(({ data, error }) => {
      if (live) setS(error ? null : ((data as S[])?.[0] ?? null));
    });
    return () => { live = false; };
  }, [allowed, from, to]);
  if (!allowed) return null;
  const cells = [
    { l: "Orders", v: num(s?.orders).toLocaleString() },
    { l: "Order value", v: rs(num(s?.gross)) },
    { l: "Delivered", v: `${num(s?.delivered)} · ${num(s?.delivery_rate)}%` },
    { l: "Returned / cancelled", v: `${num(s?.returned)} / ${num(s?.cancelled)}` },
    { l: "Net payout", v: rs(num(s?.net_payout)) },
    { l: "Daraz fees", v: rs(num(s?.fees)) },
    { l: "Unpaid in statements", v: rs(num(s?.unpaid_net)) },
    { l: "Delivered, not in statement", v: rs(num(s?.awaiting_value)) },
  ];
  return (
    <div className="mt-3 rounded-card border border-line bg-surface p-3 sm:mt-5 sm:p-5 dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]">
          <span className="h-2 w-2 rounded-full" style={{ background: "#F57224" }} /><Store size={15} /> Daraz
        </h3>
        <Link href="/online/daraz" className="flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink">Open <ChevronRight size={14} /></Link>
      </div>
      <p className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">From uploaded Seller Center files · same date range.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {cells.map((c) => (
          <div key={c.l} className="rounded-xl2 bg-panel/70 px-3 py-2 dark:bg-white/[0.04]">
            <div className="text-[11.5px] text-muted dark:text-[#a89f93]">{c.l}</div>
            <div className="text-[14.5px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{s ? c.v : "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
