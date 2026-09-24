"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, ArrowLeft, LogOut, UserRound, X, LayoutGrid } from "lucide-react";
import HubBell from "@/components/HubBell";
import ThemeToggle from "@/components/ThemeToggle";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { visibleNav, isActive, activeChild, hubTitle } from "@/components/hubNav";

/* THE HUB ON A PHONE IS AN APP, NOT A SHRUNKEN WEBSITE.
 *
 * It used to be the desktop layout squeezed: a hamburger drawer for moving
 * between sections, whose small group arrows sat inside the links (a tap near
 * the arrow opened a group instead of going anywhere), and a fixed-height frame
 * with its own scrolling panel inside. On iPhones that frame is what made the
 * page slide when the keyboard opened and left taps landing a few pixels off
 * afterwards.
 *
 * Now, below the desktop width:
 *   - the PAGE scrolls, like any site Safari and Chrome know how to handle;
 *   - a header names the page you are on, with the bell and a More button;
 *   - a tab bar at the bottom moves between sections in one tap, where the
 *     thumb already is;
 *   - sections with two screens (Shipments/Returns, Settlements/Disputes,
 *     Attendance/Employees) get a switcher under the header that fits the
 *     screen — nothing in the chrome ever scrolls sideways.
 * The desktop sidebar is untouched. */

export function HubTopBar() {
  const path = usePathname();
  const { ready, can } = usePermissions();
  const [more, setMore] = useState(false);
  const nav = ready ? visibleNav(can) : [];
  const group = nav.find((n) => n.children && n.children.length > 1 && isActive(path, n));
  const child = group ? activeChild(path, group) : undefined;
  const isArticle = /^\/online\/articles\/[^/]+/.test(path);
  const router = useRouter();
  // Moving to another page closes the sheet — it is never left over the next one.
  useEffect(() => { setMore(false); }, [path]);

  return (
    <>
      {/* Solid, not blurred: a blur would make this header the frame the
          bell's full-screen sheet is measured against. */}
      <header className="hub-topbar sticky top-0 z-[45] border-b border-line bg-surface pt-[env(safe-area-inset-top)] md:hidden dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="flex h-14 items-center gap-1 px-2">
          {isArticle ? (
            <button type="button" onClick={() => router.push("/online/articles")} aria-label="Back to articles"
              className="flex h-11 w-11 items-center justify-center rounded-full text-ink active:bg-panel dark:text-white dark:active:bg-white/[0.08]">
              <ArrowLeft size={20} />
            </button>
          ) : <span className="w-2" />}
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{hubTitle(path)}</h1>
          <HubBell size="lg" />
          <button type="button" onClick={() => setMore(true)} aria-label="More"
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink active:bg-panel dark:text-white dark:active:bg-white/[0.08]">
            <MoreHorizontal size={22} />
          </button>
        </div>
        {group && (
          <div className="px-3 pb-2.5">
            <div className="grid gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.06]"
              style={{ gridTemplateColumns: `repeat(${group.children!.length}, minmax(0, 1fr))` }}>
              {group.children!.map((c) => {
                const on = c.href === child?.href;
                return (
                  /* min-w-0 and truncate, because People now has three
                     children: without them the third label is cut off by the
                     page's own clip rather than shortened. The icon steps
                     aside once there are three, to leave the words room. */
                  <Link key={c.href} href={c.href} aria-current={on ? "page" : undefined}
                    className={`flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-full px-1 text-[13px] font-semibold transition ${on
                      ? "bg-ink text-white shadow-soft dark:bg-white dark:text-[#141414]"
                      : "text-muted active:bg-black/5 dark:text-[#a89f93] dark:active:bg-white/10"}`}>
                    {group.children!.length < 3 && <c.Icon size={15} className="shrink-0" />}
                    <span className="truncate">{c.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </>
  );
}

export function HubTabBar() {
  const path = usePathname();
  const { ready, can } = usePermissions();
  if (!ready) return <nav className="hub-tabbar fixed inset-x-0 bottom-0 z-40 h-[calc(60px+env(safe-area-inset-bottom))] border-t border-line bg-surface md:hidden dark:border-white/[0.06] dark:bg-[#201c17]" />;
  const nav = visibleNav(can);
  if (nav.length < 2) return null;
  return (
    <nav aria-label="Hub sections"
      className="hub-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-white/[0.06] dark:bg-[#201c17]/95">
      <div className="grid h-[60px]" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
        {nav.map((n) => {
          const on = isActive(path, n);
          return (
            <Link key={n.label} href={n.href} aria-current={on ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-1 text-[10.5px] font-semibold leading-none transition active:opacity-60 ${on
                ? "text-ink dark:text-white" : "text-muted dark:text-[#8a8175]"}`}>
              <span className={`flex h-7 w-12 items-center justify-center rounded-full transition ${on ? "bg-periwinkle-soft dark:bg-white/[0.12]" : ""}`}>
                <n.Icon size={19} strokeWidth={on ? 2.4 : 2} />
              </span>
              <span className="max-w-full truncate px-0.5">{n.short}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/* Everything that is not a section: your own page, the other departments, the
   theme, signing out. It was at the bottom of the drawer. */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  async function logout() { if (supabase) await supabase.auth.signOut(); router.replace("/login"); }
  const row = "flex h-14 w-full items-center gap-3 rounded-xl2 px-4 text-[15px] font-semibold text-ink active:bg-panel dark:text-[#f4f1ea] dark:active:bg-white/[0.06]";
  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/45 md:hidden" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-card border-t border-line bg-surface p-3 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-xl dark:border-white/[0.08] dark:bg-[#201c17]">
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-line dark:bg-white/15" />
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[13px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Hub Department</span>
          <button type="button" onClick={onClose} aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted active:bg-panel dark:text-[#a89f93]"><X size={20} /></button>
        </div>
        <Link href="/me" className={row}><UserRound size={20} /> My page</Link>
        <Link href="/" className={row}><LayoutGrid size={20} /> All departments</Link>
        <div className={row + " justify-between"}><span className="flex items-center gap-3">Theme</span><ThemeToggle className="h-11 w-11" /></div>
        <button type="button" onClick={logout} className={row + " text-danger"}><LogOut size={20} /> Sign out</button>
      </div>
    </div>
  );
}
