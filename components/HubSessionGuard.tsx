"use client";

/* ---------------------------------------------------------------------------
   WHEN THE SIGN-IN ENDS, SAY SO.

   What happened on 28 Sep, from the auth log: at 10:41 a Hub tab tried to
   renew its sign-in and was refused ("Refresh Token Not Found"). The app only
   ever checks the sign-in once, when a page first loads, so nothing noticed.
   The page stayed on screen looking signed in, and every button pressed after
   that went to the database as an anonymous visitor. Three tries to create an
   article came back as "permission denied for function hub_article_create" —
   the database's own words for "I do not know who you are", which read like a
   broken permission.

   This listens for the sign-in ending and puts that in front of the person at
   the moment it happens, instead of letting them fill in a form that can no
   longer be saved. It also checks again whenever the tab comes back into view,
   because a laptop lid closed overnight is the usual way a sign-in goes stale.

   Whatever they were typing stays on the page behind the notice: they can
   dismiss it, copy their text, and then sign in. Hub-only — mounted in the Hub
   frame and the staff portal. The other departments have the same gap; this
   deliberately does not reach into them.
--------------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import { LogIn, AlertTriangle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

export default function HubSessionGuard() {
  const [gone, setGone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /* A short wait before showing anything: pressing Sign out also ends the
       session, and that path leaves the Hub a moment later — which unmounts
       this and cancels the timer, so a deliberate sign-out never sees it. */
    const lost = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { setGone(true); setDismissed(false); }, 700);
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) { clearTimeout(timer); setGone(false); return; }
      /* INITIAL_SESSION with no session is the first load of a signed-out
         visitor; the app frame already sends that person to the login page. */
      if (event === "SIGNED_OUT") lost();
    });

    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      supabase!.auth.getSession().then(({ data }) => { if (!data.session) lost(); });
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);

    return () => {
      clearTimeout(timer);
      sub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);

  if (!gone) return null;

  /* A full reload, not a client-side hop: it clears everything the dead
     session left in memory. */
  const signIn = () => { window.location.href = "/login"; };

  if (dismissed) {
    return (
      <div role="alert"
        className="fixed inset-x-0 top-0 z-[90] flex items-center justify-center gap-3 bg-red-700 px-4 py-2 pt-[calc(8px+env(safe-area-inset-top))] text-[13px] font-semibold text-white shadow-lg">
        <span className="min-w-0 truncate">Signed out — nothing on this page will save.</span>
        <button onClick={signIn} className="shrink-0 rounded-full bg-white px-3 py-1 text-[12.5px] font-bold text-red-800">
          Sign in again
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="hub-signed-out-title"
        className="w-full rounded-t-card border border-line bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-card sm:pb-5 dark:border-white/[0.08] dark:bg-[#201c17]">
        <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
          <AlertTriangle size={18} />
          <h2 id="hub-signed-out-title" className="text-[17px] font-extrabold tracking-tight">You Have Been Signed Out</h2>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink dark:text-[#f4f1ea]">
          Your sign-in to the ERP ended, so this page can no longer save anything — a button pressed now
          would be refused.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted dark:text-[#a89f93]">
          Anything you were typing is still on the page behind this. If you need it, keep the page open
          and copy it first, then sign in again.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setDismissed(true)}
            className="h-11 rounded-full border border-line text-[13px] font-semibold text-ink dark:border-white/15 dark:text-white">
            Copy my text first
          </button>
          <button onClick={signIn} autoFocus
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-ink text-[13px] font-semibold text-white dark:bg-white dark:text-[#141414]">
            <LogIn size={15} /> Sign in again
          </button>
        </div>
      </div>
    </div>
  );
}
