"use client";
import { X } from "lucide-react";
import { useEffect } from "react";

/** `wide` and `xwide` are two steps up from the default width. `xwide` exists
 *  for a modal showing a table that has to be read across — the factory day
 *  sheet preview turns it on only while the parsed lines are on screen, and
 *  back off for the result, so the box is wide exactly when there is something
 *  wide in it. */
export default function Modal({ open, onClose, title, subtitle, children, wide, xwide }:
  { open: boolean; onClose: () => void; title: string; subtitle?: string; children: React.ReactNode; wide?: boolean; xwide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4" onClick={onClose}>
      {/* role/aria-modal so a screen reader announces this as a dialog and
          stops reading the page behind it, and aria-label so it is announced
          by its title. It is also what lets a test address the dialog rather
          than guessing which input on the page it means. */}
      <div onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={title}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-card border border-line bg-surface p-5 shadow-xl sm:rounded-card dark:border-white/[0.08] dark:bg-[#201c17] ${xwide ? "sm:max-w-6xl" : wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[17px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-muted dark:text-[#a89f93]">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** `hint` is the one-line "what does this field mean" that sits under the
 *  label, before the control. Optional: most fields do not need one, and a
 *  field that explains itself should not have one. */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">
      {label}
      {hint && (
        <span className="mt-0.5 block text-[11.5px] font-normal text-hint dark:text-[#8a8175]">{hint}</span>
      )}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
export const inputCls = "w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[13px] font-normal text-ink outline-none transition focus:border-ink/30 dark:border-white/10 dark:bg-white/[0.04] dark:text-white";
export const btnPrimary = "flex items-center justify-center gap-2 rounded-full bg-ink px-5 py-2.5 text-[13px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-[#141414]";
export const btnGhost = "flex items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]";
