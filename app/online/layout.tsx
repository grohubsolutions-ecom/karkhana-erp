"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePermissions } from "@/lib/usePermissions";
import { isCallingOnly } from "@/components/hubNav";
import OnlineSidebar, { SidebarTab } from "@/components/OnlineSidebar";
import { HubTopBar, HubTabBar } from "@/components/HubPhoneChrome";
import HubSessionGuard from "@/components/HubSessionGuard";
import "./hub-mobile.css";

/* TWO SHAPES, ONE HUB.
 *
 * Computer (1024px and up): exactly as before — the menu down the left and
 * the page scrolling beside it.
 *
 * Tablet, or a phone turned sideways (768–1023px): the same layout, but the
 * menu hides behind a small tab on the left edge and slides in over the page
 * when the tab is pressed; choosing a page, Esc, or a tap outside puts it away.
 *
 * Phone: the page itself scrolls. The old phone layout was the desktop frame —
 * a box fixed to the screen height with its own scrolling panel inside. iOS
 * Safari handles that badly: opening the keyboard slides the whole frame up,
 * and after it closes, taps can land a few pixels away from what they hit.
 * With the page scrolling normally, Safari and Chrome do what they do on every
 * other site. The header sticks to the top, the tab bar is fixed to the bottom,
 * and the content keeps clear of it.
 *
 * `hub` on <html> scopes hub-mobile.css to these pages only. It is removed on
 * the way out, so nothing here can reach another department. */
export default function OnlineLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("hub");
    return () => html.classList.remove("hub");
  }, []);

  /* The tablet menu: hidden until asked for, and hidden again as soon as a
     page is chosen — the reason to open it is to go somewhere. (On a computer
     the menu is always showing and this state is not used.) */
  const [menu, setMenu] = useState(false);
  const path = usePathname();
  /* H322: the calling agent may open her desk and nothing else in the Hub. */
  const router = useRouter();
  const { ready, can } = usePermissions();
  const callingOnly = ready && isCallingOnly(can);
  useEffect(() => {
    if (callingOnly && !path.startsWith("/online/calling") && !path.startsWith("/online/whatsapp")) router.replace("/online/calling");
  }, [callingOnly, path, router]);
  useEffect(() => { setMenu(false); }, [path]);
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [menu]);

  return (
    <div className="min-h-[100dvh] bg-canvas md:fixed md:inset-0 md:flex md:h-[100dvh] md:overflow-hidden dark:bg-[#17140f]">
      <SidebarTab open={menu} onOpen={() => setMenu(true)} />
      <OnlineSidebar open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <HubTopBar />
        {/* md:pl-6 keeps the page clear of the tablet's menu tab; a computer has no tab. */}
        <main className="hub-main min-w-0 flex-1 pb-[calc(76px+env(safe-area-inset-bottom))] md:overflow-y-auto md:overflow-x-hidden md:pb-0 md:pl-6 lg:pl-0">
          <div key={path} className="hub-clip dept-in dept-hub">{children}</div>
        </main>
      </div>
      <HubTabBar />
      {/* Says so when the sign-in ends mid-work, instead of letting a form
          fail with the database's "permission denied". */}
      <HubSessionGuard />
    </div>
  );
}
