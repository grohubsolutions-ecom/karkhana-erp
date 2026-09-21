"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, LogOut, ShoppingBag, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import HubBell from "@/components/HubBell";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import ThemeToggle from "@/components/ThemeToggle";
import { useIsHandheldWide } from "@/components/HubUI";
/* The list of places lives in hubNav, shared with the phone tab bar, and is
   filtered there by requiredFor — the prefix-aware lookup the page lock uses. */
import { visibleNav, isActive } from "@/components/hubNav";

/* THE HUB MENU, BY SCREEN.
 *
 *   Computer (1024px and up)    — exactly as it always was: a permanent strip
 *                                 down the left, bell beside the department name.
 *   Tablet / phone turned       — the desktop layout, but 248px is a third of the
 *   sideways (768–1023px)         screen there. The menu hides; a small tab on the
 *                                 left edge (arrow + bell) slides it in over the
 *                                 page. Choosing a page, Esc, a tap outside or
 *                                 its own ‹ button puts it away again.
 *   Phone upright (below 768px) — not rendered at all. The header and bottom
 *                                 tab bar in HubPhoneChrome replace it. */
export default function OnlineSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  /* Which groups the person has opened by hand. The arrow is a button that owns
     the state; the route only decides what is open BEFORE anyone touches it. */
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const { ready, can } = usePermissions();
  const visible = ready ? visibleNav(can) : [];
  const pathname = usePathname();
  const router = useRouter();
  /* Only where it slides may the hidden menu be taken out of reach of the
     keyboard; on a computer it is always there. */
  const sliding = useIsHandheldWide();
  async function logout() { if (supabase) await supabase.auth.signOut(); router.replace("/login"); }
  return (
    <>
      {/* A tap outside the slid-in menu puts it away. Rendered only while open,
          so it can never sit invisibly over the page. */}
      {open && sliding && <div className="fixed inset-0 z-40 hidden bg-black/20 md:block lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside id="hub-menu" aria-label="Hub menu" inert={sliding && !open}
        className={[
          "hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface md:flex dark:border-white/[0.06] dark:bg-[#201c17]",
          // tablet / sideways phone: a drawer over the page
          "md:fixed md:inset-y-0 md:left-0 md:z-50 md:shadow-xl md:transition-transform md:duration-200 md:ease-out",
          open ? "md:translate-x-0" : "md:-translate-x-full",
          // computer: back in the page, always showing, exactly as before
          "lg:static lg:z-auto lg:translate-x-0 lg:shadow-none lg:transition-none",
        ].join(" ")}>
        <div className="flex items-center justify-between gap-2 pr-3">
          <Link href="/" className="flex items-center gap-2 px-5 pt-4 text-[12.5px] font-semibold text-muted transition hover:text-ink lg:pt-5 dark:text-[#a89f93] dark:hover:text-white">
            <ArrowLeft size={15} /> All departments
          </Link>
          <button type="button" onClick={onClose} aria-label="Hide menu" title="Hide menu (Esc)"
            className="mt-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-panel hover:text-ink lg:hidden dark:text-[#a89f93] dark:hover:bg-white/[0.08] dark:hover:text-white">
            <ChevronLeft size={18} />
          </button>
        </div>
        {/* The bell sits with the department name: the first place the eye lands. */}
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-3 lg:pt-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-white dark:bg-white dark:text-[#141414]"><ShoppingBag size={18} /></span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight dark:text-[#f4f1ea]">Hub Department</div>
            <div className="text-[11px] text-muted dark:text-[#a89f93]">Online orders</div>
          </div>
          {/* On a computer only — on a tablet the bell rides on the edge tab,
              where it can be seen while the menu is away. Opens rightward, into
              the page: the menu is only 248px wide. */}
          <span className="hidden lg:block"><HubBell align="left" /></span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3">
          {visible.map(({ label, href, Icon, soon, children }) => {
            const on = isActive(pathname, { label, href, Icon, children, short: label });
            // Opened by hand wins; otherwise a section opens because you are in it.
            const openGroup = !!children && (manual[label] ?? on);
            return (
              <div key={label}>
                <div className={`flex items-center rounded-xl2 transition ${on ? "bg-periwinkle-soft dark:bg-white/[0.10]" : "hover:bg-panel dark:hover:bg-white/[0.06]"}`}>
                  <Link href={href} className={`flex min-w-0 flex-1 items-center gap-3 px-3.5 ${children ? "py-[11px]" : "py-2.5"} text-[14px] ${on ? "font-semibold text-ink dark:text-white" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
                    <Icon size={18} strokeWidth={2} />
                    <span className="flex-1">{label}</span>
                    {soon && <span className="rounded-full bg-panel px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-hint dark:bg-white/[0.06] dark:text-[#8a8175]">Soon</span>}
                  </Link>
                  {children && (
                    /* Beside the link, not inside it: pressing the arrow opens or
                       closes the section and never navigates. */
                    <button type="button" aria-label={openGroup ? `Collapse ${label}` : `Expand ${label}`}
                      onClick={() => setManual((m) => ({ ...m, [label]: !openGroup }))}
                      className="mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-black/5 dark:text-[#a89f93] dark:hover:bg-white/10">
                      <ChevronDown size={15} className={`transition ${openGroup ? "rotate-180" : ""}`} />
                    </button>
                  )}
                </div>
                {openGroup && (
                  <div className="ml-4 mt-1 space-y-0.5 border-l border-line pl-3 dark:border-white/[0.08]">
                    {children!.map((c) => {
                      const cOn = pathname === c.href;
                      return (
                        <Link key={c.href} href={c.href} className={`flex items-center gap-2.5 rounded-xl2 px-3 py-2 text-[13px] transition ${cOn ? "font-semibold text-ink dark:text-white" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
                          <c.Icon size={15} strokeWidth={2} />
                          {c.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="space-y-1 border-t border-line p-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between px-2 py-1"><span className="text-[11px] text-hint dark:text-[#8a8175]">Theme</span><ThemeToggle /></div>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-xl2 px-3.5 py-2.5 text-[13.5px] font-semibold text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white"><LogOut size={16} /> Sign out</button>
        </div>
      </aside>
    </>
  );
}

/* THE TAB ON THE LEFT EDGE — tablet and sideways phone only. It brings the
   hidden menu back, and carries the bell so notifications are still seen while
   the menu is away. */
export function SidebarTab({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <div className="fixed left-0 top-4 z-30 hidden flex-col items-center gap-1 rounded-r-2xl border border-l-0 border-line bg-surface py-1.5 pl-0.5 pr-1 shadow-card md:flex lg:hidden dark:border-white/10 dark:bg-[#201c17]">
      <button type="button" onClick={onOpen} aria-label="Show menu" title="Show menu" aria-expanded={open} aria-controls="hub-menu"
        className="flex h-10 w-10 items-center justify-center rounded-full text-ink transition hover:bg-panel dark:text-white dark:hover:bg-white/[0.08]">
        <ChevronRight size={20} />
      </button>
      <HubBell align="left" />
    </div>
  );
}
