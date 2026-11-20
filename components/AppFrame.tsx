"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import Link from "next/link";
import Sidebar from "./Sidebar";
import CarrefourSidebar from "./carrefour/CarrefourSidebar";
import MobileBar from "./MobileBar";
import KarkhanaBell from "./KarkhanaBell";
import SetPassword from "./SetPassword";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { PermissionsProvider, usePermissions } from "@/lib/usePermissions";
import { type Boot, readBoot, writeBoot, fetchBoot } from "@/lib/boot";
import { requiredFor } from "@/lib/access";
import PhoneTables from "./PhoneTables";
import "../app/kk-mobile.css";

/* PHONE LAYER FOR EVERYTHING THAT IS NOT THE HUB OR SHOPS SALES.
   The Hub (/online, /me) and Shops Sales (/retail) carry their own phone
   layers. Every other screen — Karkhana, Warehouse, Payments, Carrefour,
   Reports, Team, Administration, the wage desk, the department chooser — gets
   `html.kk`, which switches on app/kk-mobile.css, and PhoneTables, which lets
   that file turn tables into cards below 768px. Nothing in either applies at
   1024px and up: the computer layout is unchanged. */
function usesOwnPhoneLayer(pathname: string) {
  return pathname === "/me" ||
    pathname === "/wage-desk" ||
    pathname === "/online" || pathname.startsWith("/online/") ||
    pathname === "/retail" || pathname.startsWith("/retail/");
}
function KarkhanaPhoneLayer() {
  const pathname = usePathname();
  const on = !usesOwnPhoneLayer(pathname);
  useEffect(() => {
    if (!on) return;
    const html = document.documentElement;
    html.classList.add("kk");
    return () => html.classList.remove("kk");
  }, [on]);
  return on ? <PhoneTables /> : null;
}

/* The moment before the first screen is ready: the brand mark, breathing,
   instead of an empty page that looks like nothing is happening. */
function Splash() {
  return (
    <div className="kk-splash bg-canvas dark:bg-[#17140f]">
      <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-ink text-white shadow-card dark:bg-white dark:text-[#141414]">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5" /><path d="M12 12v10" /></svg>
      </span>
    </div>
  );
}

function AccessRestricted() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-panel text-muted"><Lock size={24} /></span>
      <h2 className="text-[18px] font-extrabold text-ink">You don&apos;t have access to this area</h2>
      <p className="mt-1 max-w-sm text-[13px] text-muted">Your role doesn&apos;t include this section. If you need it, ask an administrator to grant you access.</p>
      <Link href="/" className="mt-5 rounded-full bg-ink px-5 py-2.5 text-[13px] font-semibold text-white">Back to Home</Link>
    </div>
  );
}

// Inside the provider: has access to the shared permissions.
/* THE SAME GATE, WITHOUT THE FACTORY CHROME.
   FrameContent checks requiredFor(pathname) before rendering. The full-screen
   branch returned children straight through, so every /online/* page was open
   to anyone who could log in — Finance included. Adding the Hub routes to
   ROUTE_PERMS changed nothing on its own, because on those pages nothing was
   reading the map.

   The rule has to be applied wherever a page renders, not wherever it happens
   to be convenient. */
function FullScreenGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { ready, can } = usePermissions();
  if (!ready) return null;                       // nothing until we know
  if (!can(requiredFor(pathname))) return <AccessRestricted />;
  /* The Hub and Shops Sales animate inside their own layouts. */
  if (pathname.startsWith("/online") || pathname.startsWith("/retail")) return <>{children}</>;
  const flavour = pathname === "/" ? "dept-home" : pathname.startsWith("/administration") ? "dept-admin"
    : pathname === "/wage-desk" ? "dept-wage" : "dept-me";
  return <div key={pathname} className={`dept-in ${flavour}`}>{children}</div>;
}

function FrameContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { ready, can } = usePermissions();
  const allowed = can(requiredFor(pathname));
  const [navOpen, setNavOpen] = useState(false);
  const isCarrefour = pathname === "/carrefour" || pathname.startsWith("/carrefour/");
  return (
    /* Phone: the PAGE scrolls (document scroll), not a panel inside a fixed
       100dvh frame. With a fixed frame the iOS keyboard shifts the frame and
       every tap lands a few pixels from where the button is drawn — the Hub
       had the same bug and the same fix. 1024px and up: the original frame. */
    <div className="flex min-h-[100dvh] bg-canvas lg:h-[100dvh] lg:overflow-hidden">
      {isCarrefour
        ? <CarrefourSidebar open={navOpen} onClose={() => setNavOpen(false)} />
        : <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar title={isCarrefour ? "Carrefour" : "Karkhana"} onOpen={() => setNavOpen(true)} right={<KarkhanaBell />} />
        {/* keyed by path: each new page plays the short department entry
            animation, and lands scrolled to the top. */}
        <main key={pathname} className={`dept-in ${isCarrefour ? "dept-carrefour" : "dept-karkhana"} min-w-0 flex-1 lg:overflow-y-auto lg:overflow-x-hidden`}>
          {!ready ? null : allowed ? children : <AccessRestricted />}
        </main>
      </div>
    </div>
  );
}

/* H306 (29 Oct 2026) — ON A PHONE, A COLD APP OPEN LANDS ON "/".
   Zeeshan uses the ERP as a PWA on his phone. The last page he was on when he
   closed the app would reload on reopen — he wanted the department chooser
   every time instead, so he can pick where to go without first navigating out
   of yesterday's screen. Desktop keeps the last-visited page.

   This is a module-level flag so it survives client-side navigations but is
   lost on a full page reload (cold open). SessionStorage would do the same
   thing less reliably (private browsing throws). */
let coldOpenHandled = false;

export default function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login" || pathname === "/reset-password";
  // The department chooser (/) and the new Online/Retail areas render full-screen
  // (their own chrome), not inside the factory sidebar. Still auth-gated below.
  /* Administration is one of the four boxes on the home screen, not a page
     inside Karkhana — so it gets its own full-screen chrome like the others.
     It was still rendering inside the factory sidebar, which put "Raw
     Materials" and "Production" next to a page about Hub and FS Traders staff. */
  const isFullScreen =
    pathname === "/" ||
    pathname === "/administration" || pathname.startsWith("/administration/") ||
    // The employee portal is the whole app for the person using it. No sidebar,
    // no department chrome — there is nowhere else for them to go.
    pathname === "/me" ||
    // K199 — the wage desk is a portal of its own, same reasoning as /me: the
    // wage supervisor has nowhere else to go, so no factory sidebar.
    pathname === "/wage-desk" ||
    pathname === "/online" || pathname.startsWith("/online/") ||
    pathname === "/retail" || pathname.startsWith("/retail/");
  /* Session + password flag + permissions, in ONE parallel trip, drawn from
     the kept copy at once when there is one (see lib/boot.ts). */
  const [boot, setBoot] = useState<Boot | null>(null);
  const authReady = isLogin || boot !== null;
  const mustChange = boot ? boot.mustChange : null;

  useEffect(() => {
    if (isLogin) return;
    if (!isSupabaseConfigured || !supabase) { setBoot({ uid: "preview", mustChange: false, perms: [], all: true }); return; }
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) { router.replace("/login"); return; }
      const uid = data.session.user.id;
      const kept = readBoot(uid);
      setBoot((b) => (b && b.uid === uid ? b : kept));
      try {
        const fresh = await fetchBoot(uid);
        if (!active) return;
        writeBoot(fresh);
        setBoot((b) => (b && JSON.stringify(b) === JSON.stringify(fresh) ? b : fresh));
      } catch {
        /* offline / flaky: keep the copy; with none, fall back to the old
           behaviour of "no password change, no permissions". */
        if (active && !kept) setBoot({ uid, mustChange: false, perms: [], all: false });
      }
    });
    return () => { active = false; };
  }, [isLogin, router]);

  /* Cold-open redirect: once per fresh page load, on a phone, if the user
     landed somewhere other than "/", send them to the department chooser. */
  useEffect(() => {
    if (coldOpenHandled) return;
    if (!authReady || isLogin) return;
    if (pathname === "/") { coldOpenHandled = true; return; }
    coldOpenHandled = true;
    if (typeof window === "undefined") return;
    try {
      if (window.matchMedia("(max-width: 767px)").matches) router.replace("/");
    } catch { /* no matchMedia (very old browsers) — skip silently */ }
  }, [authReady, isLogin, pathname, router]);

  if (isLogin) return <><KarkhanaPhoneLayer />{children}</>;
  if (!authReady) return <Splash />;
  if (mustChange === null) return <Splash />;
  if (mustChange) return <SetPassword onDone={() => setBoot((b) => { if (!b) return b; const n = { ...b, mustChange: false }; writeBoot(n); return n; })} />;

  /* Chooser + Online/Retail: authenticated, but full-screen — no factory
     sidebar, no route gate. They still need PERMISSIONS, though.

     This used to return children directly, outside the provider. Anything on
     those pages calling usePermissions() therefore got the default context —
     { ready: false, all: false, can: () => false } — which is indistinguishable
     from "this person is allowed nothing". That is why the Administration box
     never appeared on the home screen even for a super admin: it was not
     refused, it was asked before anyone was listening.

     The provider now wraps both branches. Only the chrome differs. */
  if (isFullScreen) {
    return <PermissionsProvider boot={boot}><KarkhanaPhoneLayer /><FullScreenGate>{children}</FullScreenGate></PermissionsProvider>;
  }

  // Only now (fully authenticated) do we load permissions — one shared copy.
  return (
    <PermissionsProvider boot={boot}>
      <KarkhanaPhoneLayer />
      <FrameContent>{children}</FrameContent>
    </PermissionsProvider>
  );
}
