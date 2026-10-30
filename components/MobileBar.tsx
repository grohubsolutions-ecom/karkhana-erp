"use client";
import { Menu } from "lucide-react";
import MobileBack from "./MobileBack";

/* The phone header. It gained a right-hand slot so the notification bell can
   live here too: on a phone the sidebar is closed, and a bell that only exists
   inside a closed drawer is a bell nobody hears.
   H307 (30 Oct 2026): a Back button sits to the left of the menu, so a user
   can step out of the current page one tap without hunting for a link. */
export default function MobileBar({
  title, onOpen, right,
}: { title: string; onOpen: () => void; right?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-3 py-3 backdrop-blur md:hidden dark:border-white/[0.06] dark:bg-[#201c17]/95">
      <MobileBack />
      <button onClick={onOpen} aria-label="Open menu" className="flex h-9 w-9 items-center justify-center rounded-xl2 text-ink transition hover:bg-panel dark:text-white dark:hover:bg-white/[0.06]">
        <Menu size={22} />
      </button>
      <span className="min-w-0 truncate text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</span>
      {right && <span className="ml-auto flex items-center">{right}</span>}
    </div>
  );
}
