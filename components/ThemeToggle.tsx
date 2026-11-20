"use client";
import { useEffect, useState, type MouseEvent } from "react";
import { Sun, Moon } from "lucide-react";

/* Light/dark switch. Persists to localStorage ("kk-theme") and toggles `dark`
   on <html>; the no-flash script in layout.tsx reads the same key.

   N2: the new theme spreads out in a circle from the button (View Transitions,
   Chrome/Edge/Android and Safari 18+; older browsers just switch instantly).
   Every CSS transition is paused for the switch itself — otherwise hundreds of
   elements each fade their colours separately, which is what made it stutter. */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function apply(next: boolean) {
    const html = document.documentElement;
    html.classList.add("theme-switching");
    html.classList.toggle("dark", next);
    try { localStorage.setItem("kk-theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove("theme-switching")));
  }

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    const next = !document.documentElement.classList.contains("dark");
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || reduce) { apply(next); return; }

    const x = e.clientX || window.innerWidth / 2;
    const y = e.clientY || 0;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const t = doc.startViewTransition(() => apply(next));
    t.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => { /* skipped transition: theme is already applied */ });
  }

  return (
    <button
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      className={`group flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-surface text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12] ${className}`}
    >
      <span key={dark ? "sun" : "moon"} className="theme-icon-in flex">
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </span>
    </button>
  );
}
