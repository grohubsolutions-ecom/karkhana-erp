"use client";
import { Menu } from "lucide-react";
import MobileBack from "./MobileBack";

/* The phone header. It gained a right-hand slot so the notification bell can
   live here too: on a phone the sidebar is closed, and a bell that only exists
   inside a closed drawer is a bell nobody hears.
   H307 (30 Oct 2026): a Back button sits to the left of the menu, so a user
   can step out of the current page one tap without hunting for a link.
   Solid background, no backdrop-blur: a blur makes this bar the containing
   block for the bell's `fixed` sheet and backdrop, so the backdrop covered
   only the bar instead of the screen. Safe-area padding keeps it clear of the
   iPhone notch when the ERP is opened from the home screen.
   Shown up to 1023px (was 767px): a phone held sideways or a small tablet
   gets the menu as a drawer instead of a permanent 248px column, same as the
   Hub and Shops Sales. 1024px and up: no bar, sidebar as before. */
export default function MobileBar({
  title, onOpen, right,
}: { title: string; onOpen: () => void; right?: React.ReactNode }) {
  return (
    <div className="kk-topbar sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface px-3 py-2 pt-[max(8px,env(safe-area-inset-top))] lg:hidden dark:border-white/[0.06] dark:bg-[#201c17]">
      <MobileBack />
      <button onClick={onOpen} aria-label="Open menu" className="flex h-10 w-10 items-center justify-center rounded-xl2 text-ink transition hover:bg-panel dark:text-white dark:hover:bg-white/[0.06]">
        <Menu size={22} />
      </button>
      <span className="min-w-0 truncate text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</span>
      {right && <span className="ml-auto flex items-center">{right}</span>}
    </div>
  );
}
