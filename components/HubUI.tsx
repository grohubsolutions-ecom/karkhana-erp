"use client";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { CalendarDays, X } from "lucide-react";
import RangeBar from "@/components/RangeBar";
import { PRESETS } from "@/lib/dateRange";

/* SMALL PIECES THE HUB PAGES SHARE SO A PHONE GETS THE SAME HANDLING
   EVERYWHERE. Hub-only: nothing outside app/online and /me imports this. */

/* True below the desktop width. Pages use it to draw a list as cards rather
   than a table on a phone. On the server it answers "desktop" — the lists are
   empty until data arrives in the browser, so nothing flips visibly. */
const PHONE = "(max-width: 767.98px)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
export function useIsPhone() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false);
}

/* True for a tablet, or a phone turned sideways: wide enough for the desktop
   layout, too narrow to give a permanent 248px to the menu. The Hub menu hides
   behind a tab there; on a real computer (1024px and up) it stays put. */
const HANDHELD_WIDE = "(min-width: 768px) and (max-width: 1023.98px)";
function subscribeWide(cb: () => void) {
  const m = window.matchMedia(HANDHELD_WIDE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
export function useIsHandheldWide() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(HANDHELD_WIDE).matches, () => false);
}

/* THE DATE RANGE.
   Desktop keeps the row of presets exactly as before. On a phone that row was
   770px wide inside a 390px screen and scrolled sideways under the thumb — a
   swipe meant for the page moved the chips, and a tap meant as a scroll picked
   a range. It becomes one full-width picker that opens the phone's own list.
   The filters passed in `right` (store, courier, status, search…) sit in a
   two-column grid below it, each a full thumb-height; a search box takes the
   whole row. */
export function HubRange(p: {
  preset: string; setPreset: (v: string) => void;
  cf: string; setCf: (v: string) => void;
  ct: string; setCt: (v: string) => void;
  right?: ReactNode;
  /* A page with its own list of periods (Disputes counts from the return
     date and offers 90 days) passes it here; the rest use the shared one. */
  presets?: { key: string; label: string }[];
}) {
  const phone = useIsPhone();
  const list = p.presets ?? PRESETS;
  if (!phone && !p.presets) return <RangeBar {...p} />;
  if (!phone) return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      {list.map((x) => (
        <button key={x.key} onClick={() => p.setPreset(x.key)}
          className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition ${p.preset === x.key
            ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
            : "border border-line text-muted hover:bg-panel dark:border-white/10 dark:text-[#a89f93]"}`}>
          {x.label}
        </button>
      ))}
      {p.preset === "custom" && (<>
        <input type="date" value={p.cf} onChange={(e) => p.setCf(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        <input type="date" value={p.ct} onChange={(e) => p.setCt(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
      </>)}
      {p.right && <div className="flex w-full flex-wrap items-center gap-2 pt-1.5">{p.right}</div>}
    </div>
  );
  const label = list.find((x) => x.key === p.preset)?.label ?? "Range";
  return (
    <div className="mt-4 space-y-2">
      <label className="relative flex h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[14px] font-semibold text-ink dark:border-white/10 dark:bg-white/[0.05] dark:text-white">
        <CalendarDays size={17} className="shrink-0 text-muted dark:text-[#a89f93]" />
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[12px] font-medium text-muted dark:text-[#a89f93]">Change</span>
        {/* The real control is the phone's own picker, laid over the row. */}
        <select aria-label="Date range" value={p.preset} onChange={(e) => p.setPreset(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
          {list.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
      </label>
      {p.preset === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <input type="date" aria-label="From" value={p.cf} onChange={(e) => p.setCf(e.target.value)} className="h-11 w-full min-w-0 rounded-full border border-line bg-surface px-3 text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
          <input type="date" aria-label="To" value={p.ct} onChange={(e) => p.setCt(e.target.value)} className="h-11 w-full min-w-0 rounded-full border border-line bg-surface px-3 text-ink outline-none dark:border-white/10 dark:bg-white/[0.05] dark:text-white" />
        </div>
      )}
      {p.right && <PhoneFilters>{p.right}</PhoneFilters>}
    </div>
  );
}

/* Filters on a phone: two per row, full thumb-height; a search box (any child
   that is a box rather than a bare select) takes the full row. */
export function PhoneFilters({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0 [&>select]:h-11 [&>select]:w-full [&>div]:col-span-2 [&>div]:h-11 [&>div]:py-0 [&>div_input]:h-full [&>div_input]:w-full [&>div_input]:min-w-0 [&>button]:h-11 [&>select:only-child]:col-span-2">
      {children}
    </div>
  );
}

/* TABS THAT FIT. Every option gets an equal share of the width, so nothing
   hides off the edge and nothing scrolls sideways. On a desktop it looks like
   the old pill row. */
export function Segmented<T extends string>({ value, onChange, options, className = "" }: {
  value: T; onChange: (v: T) => void; options: { key: T; label: string; short?: string; badge?: ReactNode }[]; className?: string;
}) {
  return (
    <div role="tablist"
      className={`grid gap-1 rounded-full bg-panel p-1 md:inline-flex md:w-max dark:bg-white/[0.05] ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.key)}
            className={`flex h-10 min-w-0 items-center justify-center gap-1 truncate rounded-full px-1 text-[12.5px] font-semibold transition md:h-auto md:px-4 md:py-1.5 ${on
              ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
              : "text-muted hover:text-ink active:bg-black/5 dark:text-[#a89f93] dark:hover:text-white dark:active:bg-white/10"}`}>
            {o.short ? <><span className="truncate md:hidden">{o.short}</span><span className="hidden truncate md:inline">{o.label}</span></> : <span className="truncate">{o.label}</span>}{o.badge}
          </button>
        );
      })}
    </div>
  );
}

/* A page's own buttons. Desktop: a row, as before. Phone: two to a row, each
   full thumb-height, so nothing wraps into a ragged stack. */
export function PageActions({ children }: { children: ReactNode }) {
  return (
    <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:flex-wrap md:items-center [&>button]:min-h-[44px] [&>button]:w-full md:[&>button]:min-h-0 md:[&>button]:w-auto [&>a]:min-h-[44px] md:[&>a]:min-h-0 [&>button:last-child:nth-child(odd)]:col-span-2 max-md:[&>button]:whitespace-nowrap max-md:[&>button]:px-3 max-md:[&>button]:text-[12.5px] [&>select]:h-11 [&>select]:w-full md:[&>select]:h-auto md:[&>select]:w-auto">
      {children}
    </div>
  );
}

/* DETAILS. On a phone a sheet that rises from the bottom (the page behind stays
   still — hub-mobile.css locks it); on a desktop a centred dialog. Tapping the
   dimmed area or Close dismisses it; Escape too. */
export function Sheet({ open, onClose, title, subtitle, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        className="flex max-h-[88dvh] w-full flex-col rounded-t-card border border-line bg-surface shadow-xl sm:max-w-lg sm:rounded-card dark:border-white/[0.08] dark:bg-[#201c17]">
        <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-line sm:hidden dark:bg-white/15" />
        <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</div>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-muted dark:text-[#a89f93]">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted active:bg-panel dark:text-[#a89f93] dark:active:bg-white/[0.06]"><X size={20} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-line px-5 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] dark:border-white/[0.08]">{footer}</div>}
        {!footer && <div className="h-[env(safe-area-inset-bottom)] shrink-0" />}
      </div>
    </div>
  );
}

/* A label/value line inside a Sheet. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2.5 text-[14px] last:border-0 dark:border-white/[0.06]">
      <span className="shrink-0 text-muted dark:text-[#a89f93]">{label}</span>
      <span className="min-w-0 text-right font-semibold text-ink [overflow-wrap:anywhere] dark:text-[#f4f1ea]">{children}</span>
    </div>
  );
}

/* Pakistani mobile numbers, for Call and WhatsApp buttons: 03xx… → 923xx… */
export function waNumber(phone: unknown): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (/^03\d{9}$/.test(d)) return "92" + d.slice(1);
  if (/^923\d{9}$/.test(d)) return d;
  if (/^3\d{9}$/.test(d)) return "92" + d;
  return null;
}

/* One row of a list on a phone: a card that can be tapped when it leads
   somewhere. Used where a desktop table would have scrolled sideways. */
export function PhoneCard({ children, onClick, className = "" }: { children: ReactNode; onClick?: () => void; className?: string }) {
  const cls = `block w-full rounded-xl2 border border-line bg-surface px-4 py-3 text-left dark:border-white/[0.06] dark:bg-[#201c17] ${onClick ? "transition active:scale-[0.99] active:bg-panel dark:active:bg-white/[0.05]" : ""} ${className}`;
  return onClick ? <button type="button" onClick={onClick} className={cls}>{children}</button> : <div className={cls}>{children}</div>;
}
