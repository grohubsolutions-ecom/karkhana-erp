"use client";
/* DASHBOARD — the real numbers, or nothing (K185).
 *
 * Every figure on this page used to come from lib/sampleData: "Rs 4,182,500"
 * of raw material, "+12.4% vs last year", an inventory score of 87. None of it
 * was ever measured. A dashboard that invents its own numbers is worse than no
 * dashboard, because people start making decisions on it.
 *
 * Everything here is now summed from what the system actually recorded, in the
 * same views the screens themselves read — so a number here and the number on
 * the screen it came from can never disagree. Where nothing has been recorded
 * yet it reads zero and says so, rather than filling the gap.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Scissors, Boxes, ArrowDownToLine, ArrowUpFromLine, Wallet, AlertTriangle } from "lucide-react";
import Topbar from "@/components/Topbar";
import MetricCard from "@/components/MetricCard";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

type Stock = { item_id: string; item_name: string; manual_code: string | null;
               quantity: number; retail_total: number | null };
type Move = { movement_type: "IN" | "OUT"; quantity: number; created_at: string; voided_at: string | null };
type Job = { id: string; order_number: string; article: string; department: string;
             assigned: number; received: number; pending: number; wage_unpaid: number; age_days: number };
type Pay = { employee: string; department: string; payable: number };

const rs = (v: number) => "Rs " + Math.round(Number(v) || 0).toLocaleString();
const num = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Dashboard() {
  const [stock, setStock] = useState<Stock[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pay, setPay] = useState<Pay[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const [s, m, j, p] = await Promise.all([
      supabase.from("v_warehouse_report").select("item_id,item_name,manual_code,quantity,retail_total"),
      supabase.from("v_khana_movements").select("movement_type,quantity,created_at,voided_at"),
      supabase.from("v_process_pending").select("id,order_number,article,department,assigned,received,pending,wage_unpaid,age_days")
        .order("age_days", { ascending: false }),
      supabase.from("v_process_payable").select("employee,department,payable").order("payable", { ascending: false }),
    ]);
    /* One failing view should not blank the whole page — the others still
       have something true to say. */
    const firstErr = [s, m, j, p].find((r) => r.error)?.error;
    if (firstErr) setErr(firstErr.message);
    setStock((s.data as Stock[]) ?? []);
    setMoves((m.data as Move[]) ?? []);
    setJobs((j.data as Job[]) ?? []);
    setPay((p.data as Pay[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const today = new Date().toDateString();
  const live = moves.filter((x) => !x.voided_at);
  const onDay = (t: "IN" | "OUT") => live
    .filter((x) => x.movement_type === t && new Date(x.created_at).toDateString() === today)
    .reduce((a, x) => a + Number(x.quantity || 0), 0);

  const pieces = stock.reduce((a, x) => a + Number(x.quantity || 0), 0);
  const value = stock.reduce((a, x) => a + Number(x.retail_total || 0), 0);
  const belowZero = stock.filter((x) => Number(x.quantity) < 0)
    .sort((a, b) => Number(a.quantity) - Number(b.quantity));
  const cutting = jobs.filter((x) => x.department === "Cutting");
  const toCut = cutting.reduce((a, x) => a + Number(x.pending || 0), 0);
  const payable = pay.reduce((a, x) => a + Number(x.payable || 0), 0);
  const openJobs = jobs.filter((x) => Number(x.pending) > 0);

  const KPIS = [
    { key: "stock", label: "Pieces in the warehouse", value: num(pieces),
      delta: value > 0 ? `${rs(value)} at retail` : undefined, up: true, accent: "salmon", Icon: Boxes },
    { key: "in", label: "Arrived today", value: num(onDay("IN")),
      delta: "pieces", up: true, accent: "amber", Icon: ArrowDownToLine },
    { key: "out", label: "Went out today", value: num(onDay("OUT")),
      delta: "pieces", up: false, accent: "periwinkle", Icon: ArrowUpFromLine },
    { key: "cut", label: "Still to cut", value: num(toCut),
      delta: cutting.length ? `${cutting.filter((x) => Number(x.pending) > 0).length} job(s) open` : "nothing at cutting",
      up: true, accent: "pink", Icon: Scissors },
  ] as const;

  return (
    <>
      <Topbar title="Dashboard" subtitle="Warehouse and factory, as recorded" />

      <div className="space-y-5 px-6 pb-10">
        {!isSupabaseConfigured ? (
          <div className="rounded-card bg-surface p-8 text-center text-[14px] text-muted shadow-card">
            Connect Supabase to see live figures.
          </div>
        ) : (
          <>
            {err && (
              <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-2.5 text-[13px] text-ink">{err}</div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {KPIS.map((k, i) => (
                <div key={k.key} className="reveal" style={{ animationDelay: `${i * 80}ms` }}>
                  <MetricCard label={k.label} value={loading ? "…" : k.value}
                    delta={k.delta} up={k.up} accent={k.accent} Icon={k.Icon} />
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* WHAT IS ON THE FLOOR */}
              <div className="reveal rounded-card bg-surface p-5 shadow-card" style={{ animationDelay: "340ms" }}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[15px] font-bold">On the floor</h3>
                    <p className="text-[12px] text-muted">Work given out and not yet back</p>
                  </div>
                  <Link href="/production/cutting"
                    className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel">
                    Cutting
                  </Link>
                </div>
                {loading ? <p className="text-[13px] text-muted">Loading…</p>
                : openJobs.length === 0 ? (
                  <p className="rounded-xl2 bg-panel/50 px-4 py-6 text-center text-[13px] text-muted">
                    Nothing is out on the floor.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {openJobs.slice(0, 6).map((j) => (
                      <div key={j.id} className="flex items-center justify-between gap-3 rounded-xl2 border border-line px-3.5 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-semibold text-ink">{j.article}</p>
                          <p className="text-[11.5px] text-muted">{j.order_number} · {j.department} · {j.age_days}d</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tabular-nums text-[14px] font-extrabold text-ink">{num(j.pending)}</p>
                          <p className="text-[11px] text-hint">of {num(j.assigned)}</p>
                        </div>
                      </div>
                    ))}
                    {openJobs.length > 6 && (
                      <p className="pt-1 text-[12px] text-hint">and {openJobs.length - 6} more</p>
                    )}
                  </div>
                )}
                {payable > 0 && (
                  <p className="mt-3 flex items-center gap-1.5 rounded-xl2 bg-panel/60 px-3 py-2 text-[12.5px] text-ink/80">
                    <Wallet size={14} /> {rs(payable)} of piece-work wages not paid yet
                  </p>
                )}
              </div>

              {/* WHAT NEEDS LOOKING AT */}
              <div className="reveal rounded-card bg-surface p-5 shadow-card" style={{ animationDelay: "400ms" }}>
                <div className="mb-3">
                  <h3 className="text-[15px] font-bold">Needs looking at</h3>
                  <p className="text-[12px] text-muted">Stock that has gone below zero — goods went out before their arrival was entered</p>
                </div>
                {loading ? <p className="text-[13px] text-muted">Loading…</p>
                : belowZero.length === 0 ? (
                  <p className="rounded-xl2 bg-panel/50 px-4 py-6 text-center text-[13px] text-muted">
                    Nothing is below zero.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {belowZero.slice(0, 6).map((x) => (
                      <div key={x.item_id} className="flex items-center justify-between gap-3 rounded-xl2 border border-danger/30 bg-danger-soft/40 px-3.5 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-semibold text-ink">{x.item_name}</p>
                          <p className="font-mono text-[11.5px] text-muted">{x.manual_code ?? "no printed barcode"}</p>
                        </div>
                        <p className="shrink-0 tabular-nums text-[14px] font-extrabold text-danger">{num(x.quantity)}</p>
                      </div>
                    ))}
                    {belowZero.length > 6 && (
                      <p className="pt-1 text-[12px] text-hint">and {belowZero.length - 6} more</p>
                    )}
                    <Link href="/warehouse/grn-in"
                      className="mt-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink/70 hover:text-ink">
                      <AlertTriangle size={13} /> Enter the missing GRN
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
