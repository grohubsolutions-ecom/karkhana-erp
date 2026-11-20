"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

/* Live updates without pressing Refresh.
 *
 * A webhook can write a status change to the database in about a second, but
 * the browser has no idea until something tells it. This subscribes to Postgres
 * changes and calls back so the page can reload itself.
 *
 * WHY THE DEBOUNCE MATTERS
 *   One Shopify order fires several webhooks in quick succession (create, then
 *   paid, then fulfilled), and a courier sync can update hundreds of rows in one
 *   run. Reacting to each one would mean hundreds of full page queries in a few
 *   seconds — slow for the user and, on a free project, a real waste of the
 *   quota. Changes inside the window are coalesced into a single reload.
 *
 * WHY A DEBOUNCE ALONE WAS NOT ENOUGH
 *   The debounce collapses one burst. It does nothing about the next one. The
 *   couriers are polled every five minutes and Shopify pushes all day, so a
 *   page left open reloaded itself twelve to twenty times an hour — at roughly
 *   a megabyte and a half a time on Logistics. A tab open across a working day
 *   was spending hundreds of megabytes of a five gigabyte monthly allowance on
 *   data nobody was looking at.
 *
 *   Two limits fix that, and neither changes what the user sees:
 *
 *   HIDDEN TABS DO NOT REFETCH. If the tab is in the background there is nobody
 *   to show the update to. The change is remembered and applied the moment the
 *   tab is looked at again, so it is still current when it matters — it simply
 *   is not paid for while it does not.
 *
 *   A FLOOR BETWEEN RELOADS. Even in front of someone, refetching an entire
 *   page more than once every 20 seconds tells them nothing new; a courier
 *   status does not change that fast. A change arriving inside the floor is
 *   held and applied when it lifts, never dropped.
 *
 * Realtime respects RLS, so a subscriber only ever hears about rows it could
 * have selected itself. */
/* N3 (20 Nov 2026): TABLES TOO BUSY FOR THE LIVE FEED.
 *
 * online_orders and online_logistics are rewritten all day by the Shopify and
 * courier syncs — about ten million writes so far, most of them rows that did
 * not change. Every one of those went through Supabase Realtime, which decodes
 * the change and re-checks it against every open tab's permissions. That was
 * 43% of ALL database time (more than every staff page load and sync job put
 * together), and when a sync burst landed, staff page loads queued behind it.
 *
 * For these two tables the page now simply refreshes itself every 45 seconds
 * while it is on screen (same 20 s floor, same "hidden tabs don't fetch" rule).
 * The figures are just as current as a person can notice, and the database
 * no longer pays per write. They are taken out of the realtime publication by
 * migration N3b; until then the poll and the feed coexist harmlessly (the
 * floor stops them doubling up). */
const POLLED = new Set(["online_orders", "online_logistics"]);
const POLL_MS = 45000;

export function useLiveTables(
  tables: string[],
  onChange: () => void,
  { debounceMs = 2000, minGapMs = 20000, enabled = true }:
    { debounceMs?: number; minGapMs?: number; enabled?: boolean } = {},
) {
  const [live, setLive] = useState(false);
  const [lastChange, setLastChange] = useState<Date | null>(null);

  // hold the callback in a ref so a re-render does not tear down the channel
  const cb = useRef(onChange);
  cb.current = onChange;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRun = useRef(0);
  const pending = useRef(false);   // a change arrived while hidden or throttled
  const key = tables.join(",");

  useEffect(() => {
    if (!supabase || !enabled || !tables.length) return;

    const pushed = tables.filter((t) => !POLLED.has(t));
    const polled = tables.some((t) => POLLED.has(t));
    const channel = pushed.length ? supabase.channel(`live:${key}`) : null;

    /* Run now, or remember to run later. Never drop the change. */
    const run = () => {
      if (document.visibilityState !== "visible") { pending.current = true; return; }
      const since = Date.now() - lastRun.current;
      if (since < minGapMs) {
        pending.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(run, minGapMs - since);
        return;
      }
      pending.current = false;
      lastRun.current = Date.now();
      cb.current();
    };

    for (const table of pushed) {
      channel!.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          setLastChange(new Date());
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(run, debounceMs);
        },
      );
    }

    /* The quiet tables: a timer instead of the feed. It does nothing while the
       tab is hidden, and catches up once when it is looked at again. */
    let poll: ReturnType<typeof setInterval> | null = null;
    if (polled) {
      lastRun.current = Date.now();             // the page has just loaded its data
      poll = setInterval(() => {
        if (document.visibilityState !== "visible") { pending.current = true; return; }
        setLastChange(new Date());
        run();
      }, POLL_MS);
      if (!channel) setLive(true);
    }

    // Coming back to the tab applies whatever was missed, once.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pending.current || (polled && Date.now() - lastRun.current > POLL_MS)) run();
    };
    document.addEventListener("visibilitychange", onVisible);

    channel?.subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (poll) clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) supabase!.removeChannel(channel);
      setLive(false);
    };
    // `key` stands in for `tables` so a new array identity each render does not
    // reconnect the socket every time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs, minGapMs, enabled]);

  return { live, lastChange };
}
