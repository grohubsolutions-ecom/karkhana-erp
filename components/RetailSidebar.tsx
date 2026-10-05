"use client";
/* THE FS TRADERS MENU — computer and tablet only.
 *
 * The menu itself is unchanged: same items, same order, same names as the old
 * app. Somebody who has been running these nine shops for two years knows where
 * "Non-cash" is and what it holds; renaming it to something tidier would be an
 * improvement to nobody. The list now lives in components/retail/retailNav.ts so
 * the phone bars and this panel cannot drift apart — that is how a screen ends
 * up reachable on a computer and invisible on a phone.
 *
 * WHERE IT SHOWS
 *   ≥ 1024px   permanent 248px panel, exactly as before.
 *   768–1023   a drawer: hidden until the arrow tab is pressed. 248 out of 768
 *              leaves 520px for the work, which is not enough for the Cash Book.
 *   < 768px    not rendered at all — the phone has its own bars.
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Store, ArrowLeft, LogOut, ChevronDown } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { ROUTE_PERMS } from "@/lib/access";
import ThemeToggle from "@/components/ThemeToggle";
import { useIsHandheldWide } from "@/components/retail/kit";
import { RetailHideMenu } from "@/components/retail/RetailPhoneChrome";
import { visibleNav, isActive, type NavItem } from "@/components/retail/retailNav";

export default function RetailSidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const handheldWide = useIsHandheldWide();

  /* Opened by hand wins; otherwise a group opens because you are standing in
     it. The arrow is a button that owns this state, so pressing it toggles
     rather than navigating. */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  /* THE MENU SHOWS ONLY WHAT THE PERSON CAN OPEN.
     Until 0119 this department had a single permission, so this filter had
     nothing to filter on and every line showed for everybody. Now the shop
     accounts person sees Expenses and Cash Book and does not see Bank
     Statements, which is the arrangement that was always intended.

     A group vanishes when none of its children survive: "Head Office" pointing
     at nothing is a heading that lies. */
  const visible: NavItem[] = visibleNav(can, ROUTE_PERMS);

  async function logout() { if (supabase) await supabase.auth.signOut(); router.replace("/login"); }

  /* A drawer that is off-screen must not be reachable by Tab, or the first
     press of Tab on a tablet lands in a menu nobody can see. Only applied in
     the 768–1023 band — below that the panel is `hidden` (which already does
     this) and above it the panel is always on screen. */
  const hiddenDrawer = handheldWide && !open;

  return (
    <>
      {/* Backdrop, in the tablet band only and only while open. The phone never
          renders the drawer, so it never needs this; the computer never hides
          the menu, so it never needs it either. */}
      {open && <div className="fixed inset-0 z-40 hidden bg-black/40 md:block lg:hidden" onClick={onClose} />}

      <aside
        {...(hiddenDrawer ? { inert: true as unknown as boolean } : {})}
        className={`hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface md:flex md:fixed md:inset-y-0 md:left-0 md:z-50 md:transition-transform lg:static lg:z-auto lg:translate-x-0 dark:border-white/[0.06] dark:bg-[#201c17] ${
          open ? "md:translate-x-0" : "md:-translate-x-full"}`}
      >
        <Link href="/" onClick={onClose} className="flex items-center gap-2 px-5 pt-5 text-[12.5px] font-semibold text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
          <ArrowLeft size={15} /> All departments
        </Link>
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-white dark:bg-white dark:text-[#141414]"><Store size={18} /></span>
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight dark:text-[#f4f1ea]">FS Traders</div>
            <div className="text-[11px] text-muted dark:text-[#a89f93]">Retail shops</div>
          </div>
        </div>

        {onClose && <RetailHideMenu onClose={onClose} />}

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-2" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) onClose?.(); }}>
          {ready && visible.map(({ label, href, Icon, children }) => {
            const on = isActive(pathname, href);
            const openGroup = !!children && (manual[href] ?? on);
            /* A group's parent link points at its first surviving child rather
               than at a bare /retail/ho, so pressing the heading lands
               somewhere real instead of on a redirect. */
            const target = children ? children[0].href : href;
            const activeCls = "bg-salmon-soft font-semibold text-ink dark:bg-white/[0.10] dark:text-white";
            const idleCls = "text-muted hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white";

            /* A GROUP ROW IS A ROW, NOT A LINK WITH A BUTTON INSIDE IT.
               The chevron used to be nested in the <a>, so every press had to
               be cancelled with preventDefault + stopPropagation and a thumb
               that landed 3px off navigated instead of expanding. It is now a
               sibling: the link is the link, the arrow is the arrow. `py-[11px]`
               keeps the row at the 43px it has always been. */
            if (children) {
              return (
                <div key={href}>
                  <div className={`flex items-center gap-1 rounded-xl2 pr-1.5 transition ${on ? activeCls : idleCls}`}>
                    <Link href={target} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl2 py-[11px] pl-3.5 text-[14px]">
                      <Icon size={18} strokeWidth={2} />
                      <span className="flex-1 truncate">{label}</span>
                    </Link>
                    <button type="button" aria-label={openGroup ? `Collapse ${label}` : `Expand ${label}`}
                      onClick={() => setManual((m) => ({ ...m, [href]: !openGroup }))}
                      className="flex-none rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10">
                      <ChevronDown size={15} className={`transition ${openGroup ? "rotate-180" : ""}`} />
                    </button>
                  </div>
                  {openGroup && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l border-line pl-3 dark:border-white/[0.08]">
                      {children.map((c) => {
                        const cOn = pathname === c.href;
                        return (
                          <Link key={c.href} href={c.href} className={`flex items-center gap-2.5 rounded-xl2 px-3 py-2 text-[13px] transition ${cOn ? "font-semibold text-ink dark:text-white" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
                            <c.Icon size={15} strokeWidth={2} />
                            <span className="truncate">{c.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <Link key={href} href={href} className={`flex items-center gap-3 rounded-xl2 px-3.5 py-2.5 text-[14px] transition ${on ? activeCls : idleCls}`}>
                <Icon size={18} strokeWidth={2} />
                <span className="flex-1 truncate">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-line p-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between px-2 py-1"><span className="text-[11px] text-hint dark:text-[#8a8175]">Theme</span><ThemeToggle /></div>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-xl2 px-3.5 py-2.5 text-[13.5px] font-semibold text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white"><LogOut size={16} /> Sign out</button>
        </div>
      </aside>
      {/* The panel is `position: fixed` in the tablet band, so it is out of the
          flow there and the page runs full width — correct. At lg it is `static`
          again and takes its 248px back, which is the original computer layout. */}
    </>
  );
}
