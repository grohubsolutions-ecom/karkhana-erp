"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const KINDS: { key: string; label: string }[] = [
  { key: "front_margin", label: "Front margin" },
  { key: "back_margin", label: "Back margin" },
  { key: "rebate", label: "Rebate" },
  { key: "supply_fee", label: "Supply fee" },
  { key: "margin_support", label: "Margin support fee" },
  { key: "other", label: "Other" },
];
export const kindLabel = (k: string) => KINDS.find((x) => x.key === k)?.label ?? k;
export const rs = (v: unknown) => `Rs ${Math.round(Number(v) || 0).toLocaleString("en-PK")}`;
export const qty = (v: unknown) => Number(v || 0).toLocaleString("en-PK");
export const day = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
export const inp = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-ink/30";

export function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "danger" | "good" }) {
  const c = tone === "danger" ? "text-[#b42318]" : tone === "good" ? "text-[#166534]" : "text-ink";
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-soft">
      <p className="text-[12px] font-semibold text-muted">{label}</p>
      <p className={`tnum mt-1 text-[20px] font-extrabold tracking-tight ${c}`}>{value}</p>
      {note && <p className="mt-0.5 text-[11.5px] text-hint">{note}</p>}
    </div>
  );
}

export function Notice({ children, tone = "amber" }: { children: React.ReactNode; tone?: "amber" | "danger" }) {
  return <div className={`rounded-xl2 px-4 py-3 text-[13px] font-medium ${tone === "danger" ? "bg-danger-soft text-[#b42318]" : "bg-amber-soft text-[#7c4a03]"}`}>{children}</div>;
}

/* A table on a computer, a stack of cards on a phone. */
export function Rows<T>({ rows, cols, empty, rowKey }: {
  rows: T[]; empty: string; rowKey: (r: T) => string;
  cols: { label: string; right?: boolean; cell: (r: T) => React.ReactNode }[];
}) {
  if (!rows.length) return <p className="rounded-card border border-line bg-surface p-6 text-center text-[13px] text-muted">{empty}</p>;
  return (
    <div className="rounded-card border border-line bg-surface shadow-soft">
      <table className="hidden w-full text-[13px] md:table">
        <thead><tr className="border-b border-line text-left text-[11.5px] text-muted">
          {cols.map((c) => <th key={c.label} className={`px-3 py-2.5 font-semibold ${c.right ? "text-right" : ""}`}>{c.label}</th>)}
        </tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={rowKey(r)} className="border-b border-line last:border-0">
            {cols.map((c) => <td key={c.label} className={`px-3 py-2.5 ${c.right ? "tnum text-right" : ""}`}>{c.cell(r)}</td>)}
          </tr>
        ))}</tbody>
      </table>
      <div className="divide-y divide-line md:hidden">
        {rows.map((r) => (
          <div key={rowKey(r)} className="space-y-1 p-4 text-[13.5px]">
            {cols.map((c) => (
              <div key={c.label} className="flex items-baseline justify-between gap-4">
                <span className="text-[12px] text-muted">{c.label}</span>
                <span className="min-w-0 text-right">{c.cell(r)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* One RPC or table read: rows, error and a reload. */
export function useLoad<T>(fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    const { data: d, error } = await fn();
    if (error) setErr(error.message); else { setErr(""); setData(d as T); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { data, err, loading, load };
}
