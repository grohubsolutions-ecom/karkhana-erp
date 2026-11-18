"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bell, X, ArrowDownToLine, ArrowUpFromLine, Undo2, KeyRound } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { requiredFor } from "@/lib/access";

/* THE KARKHANA NOTIFICATION BAR (K178).
 *
 * Two kinds of message, one bell:
 *   ADMINS hear what employees recorded — stock in, stock out, GR out — with
 *   who, what and how many. The database bundles them: an operator scanning
 *   twenty items in a row is one message that grows, not twenty.
 *   EMPLOYEES hear what is meant for them — "your access has changed".
 *
 * It is LIVE. The database pushes each new or grown message the moment it is
 * written; nobody has to refresh. A slow poll stays underneath as a safety
 * net for a dropped connection.
 *
 * Each person only ever receives his own rows: the table's read rule is
 * recipient = the signed-in user, and the live feed obeys the same rule.
 *
 * Opening the list marks it read — that is the moment it has been seen. A
 * badge that clears on page load teaches people to ignore the badge.
 */

type Note = {
  id: number; kind: string; title: string; body: string | null; link: string | null;
  created_at: string; updated_at: string; read_at: string | null;
};

const KIND: Record<string, { label: string; tone: string; Icon: typeof Bell }> = {
  stock_in:  { label: "Stock in",  tone: "bg-success-soft text-[#166534] dark:bg-white/[0.10] dark:text-success", Icon: ArrowDownToLine },
  stock_out: { label: "Stock out", tone: "bg-periwinkle-soft text-[#1e3a8a] dark:bg-white/[0.10] dark:text-periwinkle", Icon: ArrowUpFromLine },
  gr_out:    { label: "GR out",    tone: "bg-amber-soft text-[#7c4a03] dark:bg-white/[0.10] dark:text-amber", Icon: Undo2 },
  access:    { label: "Access",    tone: "bg-salmon-soft text-[#7f1d1d] dark:bg-white/[0.10] dark:text-salmon", Icon: KeyRound },
};
const kindOf = (k: string) => KIND[k] ?? KIND.access;

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function KarkhanaBell({ align = "right" }: { align?: "left" | "right" }) {
  const [items, setItems] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [ring, setRing] = useState(false);
  const [toast, setToast] = useState<Note | null>(null);
  const [live, setLive] = useState(false);     // the push connection is actually up
  const [, tick] = useState(0);
  const router = useRouter();
  const path = usePathname();
  const { can } = usePermissions();
  const box = useRef<HTMLDivElement | null>(null);
  const newest = useRef<number | null>(null);   // latest updated_at already shown (ms)
  const instance = useId();

  /* The frame shows this bell twice — in the page header on a desktop, in the
     phone header on a phone — and CSS hides whichever does not fit. A hidden
     element has no offsetParent, so only the one you can see does anything. */
  const shown = () => !!box.current && box.current.offsetParent !== null;

  useEffect(() => { setOpen(false); }, [path]);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const { data, error } = await supabase
      .from("karkhana_notifications")
      .select("id,kind,title,body,link,created_at,updated_at,read_at")
      .order("updated_at", { ascending: false })
      .limit(40);
    if (error) return;            // before K178 is run the table does not exist yet
    const list = (data as Note[]) ?? [];
    setItems(list);

    /* Something new since last look? Ring the bell and slide in a card —
       but never for what was already there when the page opened. Compared
       as moments in time, not as text: two timestamps can be the same
       instant written in different time zones. */
    const at = (n: Note) => new Date(n.updated_at).getTime();
    const top = list.length ? Math.max(...list.map(at)) : 0;
    if (newest.current !== null && top > newest.current) {
      const seen = newest.current;
      const arrived = list.filter((n) => !n.read_at && at(n) > seen).sort((a, b) => at(b) - at(a));
      if (arrived.length && shown()) {
        setRing(true);
        setToast(arrived[0]);
        window.setTimeout(() => setRing(false), 2400);
      }
    }
    newest.current = Math.max(newest.current ?? 0, top);
  }, []);

  useEffect(() => { if (shown()) load(); }, [load]);

  /* LIVE: the database tells us the moment a row for this person is written
     or grows. The payload itself is not trusted for content — it is only a
     knock on the door; the list is re-read through the normal read rule. */
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    let stopped = false;
    (async () => {
      const { data: { session } } = await supabase!.auth.getSession();
      const uid = session?.user?.id;
      if (!uid || stopped) return;
      channel = supabase!
        .channel(`kk-bell-${uid}-${instance.replace(/[^a-zA-Z0-9]/g, "")}`)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "karkhana_notifications", filter: `recipient=eq.${uid}` },
            () => { if (shown()) load(); })
        .subscribe((status) => {
          setLive(status === "SUBSCRIBED");
          /* Back from a dropped connection: catch up on what was missed. */
          if (status === "SUBSCRIBED" && shown()) load();
        });
    })();
    return () => { stopped = true; if (channel) supabase!.removeChannel(channel); };
  }, [load, instance]);

  /* Safety net: a slow check while the tab is in front, an immediate one when
     it comes back to the front. A background tab asks nothing. */
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible" && shown()) load();
      tick((x) => x + 1);                       // keeps "2m ago" honest
    }, 60000);
    const back = () => { if (document.visibilityState === "visible" && shown()) load(); };
    document.addEventListener("visibilitychange", back);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const unread = items.filter((n) => !n.read_at).length;

  async function toggle() {
    const next = !open;
    setOpen(next);
    setToast(null);
    if (next) {
      setFresh(new Set(items.filter((n) => !n.read_at).map((n) => n.id)));
      if (unread > 0 && supabase) {
        const { error } = await supabase.rpc("karkhana_notifications_read", { p_id: null });
        /* Cleared on screen only if the database agreed — otherwise the badge
           would vanish now and come back on the next check. */
        if (!error) setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      }
    }
  }

  /* A message is a door only if the person can walk through it. An access
     change needs the page to reload so the new permissions take effect. */
  function follow(n: Note) {
    setOpen(false); setToast(null);
    if (n.kind === "access") { window.location.reload(); return; }
    if (n.link && can(requiredFor(n.link))) router.push(n.link);
  }
  const clickable = (n: Note) => n.kind === "access" || (!!n.link && can(requiredFor(n.link)));

  return (
    <div className="relative" ref={box}>
      <button onClick={toggle} aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
        <Bell size={17} className={ring ? "animate-bounce" : ""} />
        {unread > 0 && (
          <>
            {ring && <span className="absolute -right-0.5 -top-0.5 h-[18px] w-[18px] animate-ping rounded-full bg-danger/60" />}
            <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          </>
        )}
      </button>

      {open && <div className="fixed inset-0 z-40 bg-black/25 sm:bg-transparent lg:hidden" onClick={() => setOpen(false)} />}
      {open && (
        /* Phone: a sheet measured from the window, so it cannot run off an
           edge. Desktop: anchored to the bell, opening into the page. */
        <div className={[
          "fixed inset-x-2 top-[calc(60px+env(safe-area-inset-top))] z-50 max-h-[calc(100dvh-150px)] overflow-y-auto overscroll-contain rounded-card border border-line",
          "bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]",
          "sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:w-[380px]",
          align === "left" ? "sm:left-0" : "sm:right-0",
        ].join(" ")}>
          <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 dark:border-white/10 dark:bg-[#201c17]">
            <span className="text-[12.5px] font-bold text-ink dark:text-[#f4f1ea]">Notifications</span>
            {/* Only claimed when true. Without the push connection the list
                still refreshes every minute — it is just not instant. */}
            {live && (
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" /> live
              </span>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted dark:text-[#a89f93]">Nothing yet.</p>
          ) : (
            items.map((n) => {
              const k = kindOf(n.kind);
              const go = clickable(n);
              return (
                <button key={n.id} type="button" onClick={() => go && follow(n)}
                  className={`block w-full border-b border-line px-4 py-3 text-left transition last:border-0 dark:border-white/[0.06] ${
                    fresh.has(n.id) ? "bg-cream/70 dark:bg-white/[0.03]" : ""} ${
                    go ? "hover:bg-panel/60 dark:hover:bg-white/[0.04]" : "cursor-default"}`}>
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${k.tone}`}>
                      <k.Icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold leading-snug text-ink dark:text-[#f4f1ea]">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-[12px] leading-snug text-muted dark:text-[#a89f93]">{n.body}</span>}
                      <span className="mt-1 flex items-center gap-2 text-[11px] text-hint dark:text-[#8a8175]">
                        <span className={`rounded-full px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${k.tone}`}>{k.label}</span>
                        {ago(n.updated_at)}
                        {n.kind === "access" && <span className="font-semibold text-ink/70 dark:text-white/70">· tap to refresh</span>}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* The card that slides in when something arrives while the list is
          closed. It says what happened without anyone opening anything. */}
      {toast && !open && (
        <div role="status" aria-live="polite"
          className="reveal fixed inset-x-3 bottom-3 z-[70] rounded-card border border-line bg-surface p-3.5 shadow-card sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[360px] dark:border-white/10 dark:bg-[#201c17]">
          <div className="flex items-start gap-2.5">
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${kindOf(toast.kind).tone}`}>
              {(() => { const I = kindOf(toast.kind).Icon; return <I size={15} />; })()}
            </span>
            <button type="button" onClick={() => (clickable(toast) ? follow(toast) : toggle())} className="min-w-0 flex-1 text-left">
              <span className="block text-[13px] font-semibold leading-snug text-ink dark:text-[#f4f1ea]">{toast.title}</span>
              {toast.body && <span className="mt-0.5 block text-[12px] leading-snug text-muted line-clamp-2 dark:text-[#a89f93]">{toast.body}</span>}
              {toast.kind === "access" && <span className="mt-1 block text-[11.5px] font-semibold text-ink dark:text-white">Tap to refresh</span>}
            </button>
            <button onClick={() => setToast(null)} aria-label="Dismiss" className="rounded-full p-1 text-muted hover:bg-panel hover:text-ink dark:hover:bg-white/[0.06]">
              <X size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
