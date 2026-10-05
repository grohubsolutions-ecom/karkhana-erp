"use client";
/* THE FS TRADERS FRAME.
 *
 * Three shapes, one file:
 *
 *   < 768px   phone          No sidebar. DOCUMENT scroll. Sticky top bar,
 *                            fixed bottom tab bar, everything else under More.
 *   768–1023  tablet /       Sidebar is a drawer behind an arrow tab. The page
 *             phone sideways gets its own scroll panel, as on a computer.
 *   ≥ 1024px  computer       EXACTLY what it was: permanent 248px sidebar,
 *                            inner-scrolling main, nothing added.
 *
 * WHY THE PHONE SCROLLS THE DOCUMENT AND THE COMPUTER DOES NOT
 *
 * The old frame was `h-[100dvh] overflow-hidden` with a scrolling `main`
 * inside it. On a computer that is correct — the sidebar stays put while the
 * page scrolls. On iOS it is the single nastiest bug in the department: when
 * the keyboard opens, Safari shrinks the visual viewport but `100dvh` is
 * re-measured against the *layout* viewport, so the frame shifts under the
 * page while the touch targets do not move with it. You tap "Save" and hit
 * whatever was 60px above it. Letting the document scroll on a phone removes
 * the fixed-height frame entirely, and with it the bug.
 *
 * `md:h-[100dvh] md:overflow-hidden` puts the frame back from 768px up, so at
 * 1024 and 1280 this renders what it always rendered.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import RetailSidebar from "@/components/RetailSidebar";
import {
  RetailTopBar, RetailTabBar, RetailMoreSheet, RetailSidebarTab,
} from "@/components/retail/RetailPhoneChrome";
import "./retail-mobile.css";

export default function RetailLayout({ children }: { children: React.ReactNode }) {
  /* The 768–1023 drawer. Starts closed — at that width a permanent menu takes
     a third of the screen. */
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const pathname = usePathname();

  /* Choosing a page closes both. Leaving the menu open over the screen you just
     asked for is the most common complaint about drawer menus. */
  useEffect(() => { setOpen(false); setMore(false); }, [pathname]);

  /* Esc closes the drawer. Tablets have keyboards. */
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  /* EVERY PHONE RULE IS SCOPED TO THIS CLASS.
     retail-mobile.css is written as `html.retail … @media (max-width: 767.98px)`,
     so until this runs not one of its rules matches anything. Added on mount,
     removed on unmount — which means leaving the department for Karkhana or the
     Hub takes the rules with it. Nothing went into globals.css, which all four
     departments share. */
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("retail");
    return () => html.classList.remove("retail");
  }, []);

  return (
    <div className="bg-canvas md:flex md:h-[100dvh] md:overflow-hidden dark:bg-[#17140f]">
      <RetailSidebar open={open} onClose={() => setOpen(false)} />
      <RetailSidebarTab onOpen={() => setOpen(true)} hidden={open} />

      <div className="flex min-w-0 flex-1 flex-col">
        <RetailTopBar onMore={() => setMore(true)} />
        {/* On a phone this is a plain block in the document flow — no height, no
            scroll container. From 768px it is the scroll panel it always was.
            `md:pl-10 lg:pl-0` keeps the arrow tab from sitting on the content. */}
        <main className="min-w-0 md:flex-1 md:overflow-y-auto md:overflow-x-hidden md:pl-10 lg:pl-0">
          {children}
        </main>
      </div>

      <RetailTabBar onMore={() => setMore(true)} moreOpen={more} />
      <RetailMoreSheet open={more} onClose={() => setMore(false)} />
    </div>
  );
}
