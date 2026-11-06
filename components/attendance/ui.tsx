"use client";
import { AlertTriangle, Loader2 } from "lucide-react";
import { STATUS_LABEL } from "@/lib/attendance";

export const th = "px-3 py-2.5 text-left font-semibold whitespace-nowrap";
export const td = "px-3 py-2.5 whitespace-nowrap";

export function ErrorNote({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="mb-3 flex gap-2 rounded-card border border-danger/40 bg-danger-soft p-3 text-[13px] text-ink dark:bg-white/[0.06] dark:text-[#f4f1ea]">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" /><span>{text}</span>
    </div>
  );
}

export function TableBox({ children, min = 760 }: { children: React.ReactNode; min?: number }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface dark:border-white/10 dark:bg-white/[0.03]">
      <table className="w-full text-[13px]" style={{ minWidth: min }}>{children}</table>
    </div>
  );
}

export function Head({ cols }: { cols: string[] }) {
  return (
    <thead className="bg-panel text-muted dark:bg-white/[0.04] dark:text-[#a89f93]">
      <tr>{cols.map((c) => <th key={c} className={th}>{c}</th>)}</tr>
    </thead>
  );
}

export function Empty({ span, loading, text }: { span: number; loading: boolean; text: string }) {
  return (
    <tr><td colSpan={span} className="px-4 py-8 text-center text-muted dark:text-[#a89f93]">
      {loading ? <><Loader2 size={15} className="inline animate-spin" /> Loading…</> : text}
    </td></tr>
  );
}

const TONE: Record<string, string> = {
  present: "bg-success-soft text-ink", worked_off: "bg-success-soft text-ink", in_progress: "bg-periwinkle-soft text-ink",
  half_day: "bg-amber-soft text-ink", paid_leave: "bg-lavender-soft text-ink",
  absent: "bg-danger-soft text-ink", missing_out: "bg-danger-soft text-ink", no_shift: "bg-amber-soft text-ink",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status ?? "";
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${TONE[s] ?? "bg-panel text-muted"}`}>
      {STATUS_LABEL[s] ?? (s || "No record")}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
      <p className="text-[12px] text-muted dark:text-[#a89f93]">{label}</p>
      <p className="mt-0.5 text-[20px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{value}</p>
    </div>
  );
}

export const NO_DEPT = "No department";
export const deptOf = (name: string | null | undefined) => name || NO_DEPT;

export function DeptPicker({ names, value, onChange, allLabel }: { names: string[]; value: string; onChange: (v: string) => void; allLabel: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Department"
      className="h-10 w-full rounded-full border border-line bg-surface px-3 text-[13px] font-semibold text-ink sm:w-60 dark:border-white/10 dark:bg-white/[0.03] dark:text-[#f4f1ea]">
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
      <option value="all">{allLabel}</option>
    </select>
  );
}

export const linkBtn = "rounded-full border border-line px-3 py-1 text-[12px] font-semibold text-ink transition hover:bg-panel disabled:opacity-50 dark:border-white/10 dark:text-[#f4f1ea] dark:hover:bg-white/[0.06]";
