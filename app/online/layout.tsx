"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import OnlineSidebar, { SidebarTab } from "@/components/OnlineSidebar";
import { HubTopBar, HubTabBar } from "@/components/HubPhoneChrome";
import "./hub-mobile.css";

/* TWO SHAPES, ONE HUB.
 *
 * Desktop (768px and up): the page has the whole width. The menu is hidden
 * behind a small tab on the left edge and slides in over the page when that
 * tab is pressed; choosing a page, Esc, or a click outside puts it away again.
 * The page scrolls in its own panel, as before.
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

  /* The desktop menu: hidden until asked for, and hidden again as soon as a
     page is chosen — the reason to open it is to go somewhere. */
  const [menu, setMenu] = useState(false);
  const path = usePathname();
  useEffect(() => { setMenu(false); }, [path]);
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [menu]);

  return (
    <div className="min-h-[100dvh] bg-canvas md:flex md:h-[100dvh] md:overflow-hidden dark:bg-[#17140f]">
      <SidebarTab open={menu} onOpen={() => setMenu(true)} />
      <OnlineSidebar open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <HubTopBar />
        {/* md:pl-6 keeps the page's own left edge clear of the menu tab. */}
        <main className="hub-main min-w-0 flex-1 pb-[calc(76px+env(safe-area-inset-bottom))] md:overflow-y-auto md:overflow-x-hidden md:pb-0 md:pl-6">
          <div className="hub-clip">{children}</div>
        </main>
      </div>
      <HubTabBar />
    </div>
  );
}
