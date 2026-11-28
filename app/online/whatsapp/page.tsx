"use client";

/* ---------------------------------------------------------------------------
   WHATSAPP INBOX (H330)

   Every customer who has a WhatsApp conversation with the order number, in
   one place, laid out like WhatsApp itself so nobody needs training:

     left    chats — search, All / Unread / LM / TS / Archived, unread badges,
             ticks on the last message, pinned on top
     middle  the conversation — the bot's order confirmations with their
             Confirm / Cancel buttons, the customer's taps and replies,
             pictures and voice notes, replies from staff
     right   the customer's orders on that number, with courier status

   Live: new messages and ticks arrive over Supabase Realtime, no refresh.

   WhatsApp's 24-hour rule: staff can write freely only within 24 hours of the
   customer's last message. After that the composer offers a template, which
   is the only thing WhatsApp allows to restart a conversation.

   Reading needs hub.whatsapp.view; writing needs hub.whatsapp.reply. Every
   send goes through the wa-send edge function — the Meta token never reaches
   the browser. Database: supabase/H330_whatsapp_inbox.sql.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Search, ArrowLeft, MoreVertical, Paperclip, Send, Smile, X, FileText, Pin, Archive, ArchiveRestore,
  MailWarning, ChevronDown, Info, Loader2, MessageCircle, Clock, Zap, Image as ImageIcon, RefreshCw, Lock, SquarePen, UserPlus, Package,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import {
  type Chat, type Msg, STORE, Avatar, Ticks, displayName, prettyPhone, listTime, dayLabel, sameDay,
  windowOpen, windowLeft, hoursLeftLabel, waSend, fileToBase64,
} from "@/components/whatsapp/waShared";
import { Bubble } from "@/components/whatsapp/Bubble";
import TemplatePicker from "@/components/whatsapp/TemplatePicker";
import CustomerPanel, { type CustOrder } from "@/components/whatsapp/CustomerPanel";
import "./wa.css";

type Filter = "all" | "unread" | "LM" | "TS" | "archived";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" }, { key: "unread", label: "Unread" },
  { key: "LM", label: "Little Minors" }, { key: "TS", label: "TopShop" }, { key: "archived", label: "Archived" },
];

/* Answers staff send again and again. Type "/" in the box to open them. */
const QUICK = [
  { k: "confirmed", t: "Shukriya! Aap ka order confirm ho gaya hai. In shaa Allah 2-4 working days mein deliver ho jayega." },
  { k: "dispatched", t: "Aap ka parcel dispatch ho chuka hai. Rider jald aap se rabta karega." },
  { k: "tracking", t: "Aap ka parcel courier ke paas hai. Tracking number upar message mein diya gaya hai." },
  { k: "cancelled", t: "Aap ki request par order cancel kar diya gaya hai. Koi aur madad chahiye to batayein." },
  { k: "address", t: "Please apna mukammal address aur nearest landmark bhej dein taa ke delivery mein asani ho." },
  { k: "exchange", t: "Size exchange ke liye parcel receive karne ke 3 din ke andar humein WhatsApp par batayein." },
  { k: "thanks", t: "Shukriya! Koi aur sawal ho to zaroor batayein. 😊" },
];
const EMOJI = ["😊", "😂", "❤️", "👍", "🙏", "👌", "🎉", "😍", "😅", "🙂", "✅", "📦", "🚚", "⏰", "📍", "💯", "🤝", "😔", "🙌", "👋"];

const PAGE = 120;

/* Phone width — the open chat is drawn straight onto <body> there, so no
   page wrapper (animation, clipping, the page's own scroll) can stop it
   from scrolling. */
function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** 03001234567 / +92 300 1234567 → 923001234567, else null */
function toWa(input: string) {
  let d = input.replace(/\D/g, "");
  if (d.startsWith("0092")) d = d.slice(2);
  if (d.startsWith("0")) d = "92" + d.slice(1);
  if (d.startsWith("3") && d.length === 10) d = "92" + d;
  return /^92\d{10}$/.test(d) ? d : null;
}

type OrderHit = { phone: string; name: string | null; store_code: string; order_number: string; order_id: string | null; amount: number | null };

export default function WhatsAppInbox() {
  const { ready, can } = usePermissions();
  const canReply = ready && can(["hub.whatsapp.reply"]);

  const [chats, setChats] = useState<Chat[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [info, setInfo] = useState(false);
  const [tpl, setTpl] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [remote, setRemote] = useState<Chat[]>([]);
  const [hits, setHits] = useState<OrderHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const isPhone = useIsPhone();

  const chat = useMemo(() => chats?.find((c) => c.phone === sel) ?? null, [chats, sel]);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  const flash = useCallback((t: string) => { setToast(t); setTimeout(() => setToast((x) => (x === t ? null : x)), 3200); }, []);

  /* ── chats ──────────────────────────────────────────────────────────── */
  const loadChats = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("online_wa_chats").select("*")
      .order("pinned", { ascending: false }).order("last_at", { ascending: false, nullsFirst: false }).limit(600);
    if (error) { flash(error.message); setChats([]); return; }
    setChats((data ?? []) as Chat[]);
  }, [flash]);

  useEffect(() => { loadChats(); }, [loadChats]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60e3); return () => clearInterval(t); }, []);

  const upsertChat = useCallback((c: Chat) => {
    setChats((list) => {
      if (!list) return list;
      const rest = list.filter((x) => x.phone !== c.phone);
      const merged = { ...(list.find((x) => x.phone === c.phone) ?? {}), ...c };
      return [merged, ...rest].sort((a, b) =>
        Number(b.pinned) - Number(a.pinned) || (b.last_at ?? "").localeCompare(a.last_at ?? ""));
    });
  }, []);

  /* ── live ───────────────────────────────────────────────────────────── */
  const markRead = useCallback((phone: string) => {
    supabase?.rpc("hub_wa_mark_read", { p_phone: phone });
    waSend({ action: "read", phone });
    setChats((l) => l?.map((c) => (c.phone === phone ? { ...c, unread: 0 } : c)) ?? l);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const ch = supabase.channel("wa-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "online_wa_chats" }, (p) => {
        const row = (p.new ?? null) as Chat | null;
        if (!row?.phone) return;
        if (row.phone === selRef.current && row.unread > 0 && document.visibilityState === "visible") {
          markRead(row.phone);
          row.unread = 0;
        }
        upsertChat(row);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "online_wa_messages" }, (p) => {
        const m = p.new as Msg;
        setMsgs((all) => {
          const cur = all[m.phone];
          if (!cur) return all;
          if (cur.some((x) => x.id === m.id)) return all;
          // replace our own pending copy once the real row lands
          const i = cur.findIndex((x) => x.pending && x.dir === "out" && x.body === m.body && m.dir === "out");
          const next = i >= 0 ? cur.map((x, j) => (j === i ? m : x)) : [...cur, m];
          return { ...all, [m.phone]: next };
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "online_wa_messages" }, (p) => {
        const m = p.new as Msg;
        setMsgs((all) => {
          const cur = all[m.phone];
          if (!cur) return all;
          return { ...all, [m.phone]: cur.map((x) => (x.id === m.id ? { ...x, ...m } : x)) };
        });
      })
      .subscribe();
    return () => { supabase?.removeChannel(ch); };
  }, [upsertChat, markRead]);

  /* Unread total in the browser tab, like WhatsApp Web. */
  const unreadChats = chats?.filter((c) => c.unread > 0 && !c.archived).length ?? 0;
  useEffect(() => {
    const base = "WhatsApp · Hub";
    document.title = unreadChats ? `(${unreadChats}) ${base}` : base;
    return () => { document.title = "Karkhana"; };
  }, [unreadChats]);

  /* ── messages ───────────────────────────────────────────────────────── */
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const openChat = useCallback(async (phone: string) => {
    const c = chats?.find((x) => x.phone === phone);
    setUnreadAtOpen(c?.unread ?? 0);
    setSel(phone);
    if (c && c.unread > 0) markRead(phone);
    if (msgs[phone] || !supabase) return;
    setLoadingMsgs(true);
    const { data } = await supabase.from("online_wa_messages").select("*").eq("phone", phone)
      .order("at", { ascending: false }).limit(PAGE);
    setLoadingMsgs(false);
    const list = ((data ?? []) as Msg[]).reverse();
    setMsgs((all) => ({ ...all, [phone]: list }));
    setMore((all) => ({ ...all, [phone]: (data?.length ?? 0) === PAGE }));
  }, [chats, msgs, markRead]);

  const loadOlder = useCallback(async () => {
    if (!sel || !supabase) return;
    const cur = msgs[sel] ?? [];
    const oldest = cur[0]?.at;
    if (!oldest) return;
    const { data } = await supabase.from("online_wa_messages").select("*").eq("phone", sel)
      .lt("at", oldest).order("at", { ascending: false }).limit(PAGE);
    const older = ((data ?? []) as Msg[]).reverse();
    setMsgs((all) => ({ ...all, [sel]: [...older, ...(all[sel] ?? [])] }));
    setMore((all) => ({ ...all, [sel]: (data?.length ?? 0) === PAGE }));
  }, [sel, msgs]);

  const closeChat = () => { setSel(null); setInfo(false); };

  /* Esc closes panels, then the chat. */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (tpl) setTpl(false); else if (info) setInfo(false); else if (sel) closeChat();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [tpl, info, sel]);

  /* ── search the whole history, not only the chats loaded on screen, and
        find customers by order number or phone to start a new chat ───── */
  useEffect(() => {
    const term = q.trim();
    if (!supabase || term.length < 3) { setRemote([]); setHits([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const digits = term.replace(/\D/g, "");
      const tail = digits.length >= 4 ? digits.replace(/^0+/, "").replace(/^92/, "") : "";
      const safe = term.replace(/[%,()]/g, " ");
      const ors = [`name.ilike.%${safe}%`, `order_name.ilike.%${safe}%`];
      if (tail) ors.push(`phone.ilike.%${tail}%`);
      const [c, o] = await Promise.all([
        supabase!.from("online_wa_chats").select("*").or(ors.join(",")).order("last_at", { ascending: false, nullsFirst: false }).limit(40),
        supabase!.from("online_orders").select("store_code, order_number, shopify_order_id, customer_name, phone, phone_e164, amount, created_at")
          .in("store_code", ["LM", "TS", "TRZ"])
          .or([`order_number.ilike.%${safe.replace(/^#/, "")}%`, `customer_name.ilike.%${safe}%`, ...(tail ? [`phone.ilike.%${tail}%`, `phone_e164.ilike.%${tail}%`] : [])].join(","))
          .order("created_at", { ascending: false }).limit(15),
      ]);
      setRemote((c.data ?? []) as Chat[]);
      const seen = new Set<string>();
      setHits(((o.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        phone: toWa(String(r.phone_e164 ?? r.phone ?? "")) ?? "",
        name: (r.customer_name as string) ?? null, store_code: String(r.store_code),
        order_number: String(r.order_number), order_id: r.shopify_order_id ? String(r.shopify_order_id) : null,
        amount: (r.amount as number) ?? null,
      })).filter((h) => h.phone && !seen.has(h.store_code + h.order_number) && (seen.add(h.store_code + h.order_number), true)));
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  /** Open a chat that may not exist yet. It becomes a real chat the moment
   *  the first template goes out (the database trigger creates the row). */
  const startChat = useCallback((d: { phone: string; name?: string | null; store: string; order_id?: string | null; order_name?: string | null }) => {
    const existing = chats?.find((c) => c.phone === d.phone);
    setQ(""); setNewChat(false);
    if (existing) { openChat(d.phone); return; }
    const draft: Chat = {
      phone: d.phone, name: d.name ?? null, store_code: d.store, last_text: null, last_dir: null, last_status: null,
      last_at: null, last_in_at: null, unread: 0, pinned: false, archived: false,
      order_id: d.order_id ?? null, order_name: d.order_name ?? null,
    };
    setChats((l) => [draft, ...(l ?? [])]);
    setMsgs((all) => ({ ...all, [d.phone]: all[d.phone] ?? [] }));
    setUnreadAtOpen(0);
    setSel(d.phone);
  }, [chats, openChat]);

  /* ── list filtering ─────────────────────────────────────────────────── */
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, "");
    const pool = [...(chats ?? [])];
    for (const r of remote) if (!pool.some((c) => c.phone === r.phone)) pool.push(r);
    return pool.filter((c) => {
      if (filter === "archived" ? !c.archived : c.archived) return false;
      if (filter === "unread" && c.unread === 0) return false;
      if ((filter === "LM" || filter === "TS") && c.store_code !== filter) return false;
      if (!s) return true;
      return (c.name ?? "").toLowerCase().includes(s) || (c.order_name ?? "").toLowerCase().includes(s)
        || (digits.length >= 3 && (c.phone.includes(digits) || ("0" + c.phone.slice(2)).includes(digits)))
        || (c.last_text ?? "").toLowerCase().includes(s);
    });
  }, [chats, filter, q, remote]);

  const counts = useMemo(() => ({
    unread: chats?.filter((c) => c.unread > 0 && !c.archived).length ?? 0,
    archived: chats?.filter((c) => c.archived).length ?? 0,
  }), [chats]);

  const flag = async (phone: string, patch: { p_pinned?: boolean; p_archived?: boolean; p_unread?: boolean }) => {
    setChats((l) => l?.map((c) => c.phone !== phone ? c : {
      ...c,
      pinned: patch.p_pinned ?? c.pinned,
      archived: patch.p_archived ?? c.archived,
      unread: patch.p_unread === true ? Math.max(1, c.unread) : patch.p_unread === false ? 0 : c.unread,
    }) ?? l);
    const { error } = await supabase!.rpc("hub_wa_chat_flag", { p_phone: phone, ...patch });
    if (error) flash(error.message);
  };

  if (!isSupabaseConfigured) {
    return <div className="p-8 text-center text-sm text-muted">WhatsApp inbox needs the live database.</div>;
  }

  return (
    <div className="wa-root md:h-[100dvh] md:p-3 lg:p-4">
      <div className="wa-panel relative flex h-full overflow-hidden md:rounded-2xl md:border md:shadow-sm wa-line">
        {/* ── chat list ─────────────────────────────────────────────── */}
        <section className={`flex w-full flex-col md:w-[360px] md:shrink-0 md:border-r wa-line lg:w-[400px]`}>
          <div className="wa-panel-2 hidden h-[59px] shrink-0 items-center justify-between px-4 md:flex">
            <div className="flex items-center gap-2 text-[17px] font-semibold">
              <MessageCircle size={20} className="wa-green" /> WhatsApp
              <span className="rounded-full bg-black/5 px-2 text-[11px] font-medium wa-sub dark:bg-white/10">LM · TS</span>
            </div>
            <div className="flex items-center gap-1">
              {canReply && (
                <button type="button" onClick={() => setNewChat(true)} className="wa-press rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="New chat" title="New chat">
                  <SquarePen size={18} className="wa-sub" />
                </button>
              )}
              <button type="button" onClick={() => { setChats(null); setMsgs({}); loadChats(); }} className="wa-press rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Refresh">
                <RefreshCw size={17} className="wa-sub" />
              </button>
            </div>
          </div>

          <div className="shrink-0 px-3 pb-2 pt-2">
            <div className="wa-panel-2 flex items-center gap-3 rounded-lg px-3">
              <Search size={16} className="wa-sub" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number or order"
                className="w-full bg-transparent py-2 text-[14px] outline-none placeholder:text-[var(--wa-sub)]" />
              {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><X size={15} className="wa-sub" /></button>}
            </div>
            <div className="-mx-3 mt-2 flex gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
              {FILTERS.map((f) => {
                const on = filter === f.key;
                const n = f.key === "unread" ? counts.unread : f.key === "archived" ? counts.archived : 0;
                return (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                    className={`wa-press shrink-0 rounded-full px-3 py-1 text-[13.5px] transition-colors ${on
                      ? "bg-[#d9fdd3] text-[#008069] dark:bg-[#0a332c] dark:text-[#06cf9c]"
                      : "wa-panel-2 wa-sub hover:brightness-95"}`}>
                    {f.label}{n ? ` ${n}` : ""}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="wa-list min-h-0 flex-1">
            {!chats && Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-3">
                <div className="h-[49px] w-[49px] animate-pulse rounded-full bg-black/5 dark:bg-white/5" />
                <div className="flex-1 space-y-2"><div className="h-3 w-1/2 animate-pulse rounded bg-black/5 dark:bg-white/5" /><div className="h-3 w-3/4 animate-pulse rounded bg-black/5 dark:bg-white/5" /></div>
              </div>
            ))}
            {chats && shown.length === 0 && (
              <div className="px-8 py-16 text-center text-[14px] wa-sub">
                {q ? "No chats match your search." : filter === "unread" ? "No unread chats." : filter === "archived" ? "No archived chats." : "No conversations yet. They appear here as soon as the bot sends an order confirmation or a customer writes."}
              </div>
            )}
            {shown.map((c) => (
              <ChatRow key={c.phone} c={c} on={c.phone === sel}
                onOpen={() => ((chats ?? []).some((x) => x.phone === c.phone) ? openChat(c.phone) : startChat({ phone: c.phone, name: c.name, store: c.store_code ?? "LM", order_id: c.order_id, order_name: c.order_name }))}
                onFlag={flag} />
            ))}
            {q.trim().length >= 3 && canReply && (
              <StartList q={q} hits={hits} searching={searching}
                known={new Set(shown.map((c) => c.phone))} onStart={startChat} />
            )}
          </div>
        </section>

        {/* ── conversation ──────────────────────────────────────────── */}
        {chat ? (
          <ChatShell phone={isPhone}>
            <Conversation
              key={chat.phone}
              chat={chat}
              msgs={msgs[chat.phone] ?? null}
              hasMore={!!more[chat.phone]}
              loading={loadingMsgs && !msgs[chat.phone]}
              unreadAtOpen={unreadAtOpen}
              canReply={canReply}
              onBack={closeChat}
              onInfo={() => setInfo((v) => !v)}
              onTemplate={() => setTpl(true)}
              onOlder={loadOlder}
              onFlag={flag}
              setMsgs={setMsgs}
              flash={flash}
            />
            {info && (
              <div className="absolute inset-0 z-10 md:static md:w-[340px] md:shrink-0 xl:w-[380px]">
                <CustomerPanel chat={chat} onClose={() => setInfo(false)} />
              </div>
            )}
          </ChatShell>
        ) : (
          <div className="wa-panel-2 hidden flex-1 flex-col items-center justify-center gap-4 border-b-[6px] border-[#25d366] text-center md:flex">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[#25d366]/12">
              <MessageCircle size={44} className="wa-green" />
            </div>
            <div className="text-[28px] font-light">WhatsApp for Hub</div>
            <p className="max-w-md text-[14px] wa-sub">
              Order confirmations, customer replies and your answers — all from the order number. Pick a chat on the left.
            </p>
            <div className="flex items-center gap-1.5 text-[12.5px] wa-sub"><Lock size={12} /> Messages go through Meta&apos;s official WhatsApp API</div>
          </div>
        )}
      </div>

      {tpl && chat && (
        <TemplatePicker chat={chat} amount={null} onClose={() => setTpl(false)}
          onSent={() => { setTpl(false); flash("Template sent"); }} />
      )}

      {canReply && !chat && (
        <button type="button" onClick={() => setNewChat(true)} aria-label="New chat"
          className="wa-press wa-pop wa-bg-green fixed bottom-[calc(88px+env(safe-area-inset-bottom))] right-4 z-[60] flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg md:hidden">
          <SquarePen size={22} />
        </button>
      )}

      {newChat && <NewChatDialog onClose={() => setNewChat(false)} onStart={startChat} />}

      {toast && (
        <div className="wa-up fixed bottom-[calc(90px+env(safe-area-inset-bottom))] left-1/2 z-[95] -translate-x-1/2 rounded-lg bg-[#111b21] px-4 py-2.5 text-[13.5px] text-white shadow-lg md:bottom-8 dark:bg-[#e9edef] dark:text-[#111b21]">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── where the open chat lives ───────────────────────────────────────────
   Computer: beside the list. Phone: a full-screen layer drawn on <body>,
   with an exact screen height, so the message list is the only thing that
   scrolls and nothing in the page can trap the finger. */
function ChatShell({ phone, children }: { phone: boolean; children: React.ReactNode }) {
  if (!phone) return <div className="relative flex min-w-0 flex-1">{children}</div>;
  return createPortal(
    <div className="wa-root fixed inset-0 z-[70] flex bg-[var(--wa-panel)]" style={{ height: "100dvh" }}>{children}</div>,
    document.body,
  );
}

/* ── start a chat with a customer who has none yet ───────────────────── */
function StartList({ q, hits, searching, known, onStart }: {
  q: string; hits: OrderHit[]; searching: boolean; known: Set<string>;
  onStart: (d: { phone: string; name?: string | null; store: string; order_id?: string | null; order_name?: string | null }) => void;
}) {
  const typed = toWa(q);
  const fresh = hits.filter((h) => !known.has(h.phone));
  const showTyped = typed && !known.has(typed) && !fresh.some((h) => h.phone === typed);
  if (!searching && !fresh.length && !showTyped) return null;
  return (
    <div className="wa-fade border-t-[8px] border-[var(--wa-panel-2)] pb-3">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[13px] font-medium wa-green">
        <UserPlus size={15} /> Start a new chat {searching && <Loader2 size={13} className="animate-spin wa-sub" />}
      </div>
      {fresh.map((h) => (
        <button key={h.store_code + h.order_number} type="button" onClick={() => onStart({ phone: h.phone, name: h.name, store: h.store_code, order_id: h.order_id, order_name: h.order_number })}
          className="wa-row flex w-full items-center gap-3 px-4 py-2.5 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00a884]/12"><Package size={18} className="wa-green" /></div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px]">{h.name || prettyPhone(h.phone)}</div>
            <div className="truncate text-[12.5px] wa-sub">{h.order_number} · {prettyPhone(h.phone)}{h.amount != null ? ` · Rs ${Math.round(h.amount).toLocaleString("en-PK")}` : ""}</div>
          </div>
          <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${STORE[h.store_code]?.tone ?? ""}`}>{STORE[h.store_code]?.short ?? h.store_code}</span>
        </button>
      ))}
      {showTyped && (
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00a884]/12"><UserPlus size={18} className="wa-green" /></div>
          <div className="min-w-0 flex-1 text-[15px]">{prettyPhone(typed!)}</div>
          {(["LM", "TS"] as const).map((st) => (
            <button key={st} type="button" onClick={() => onStart({ phone: typed!, store: st })}
              className={`wa-press rounded-full px-3 py-1 text-[12px] font-semibold ${STORE[st].tone}`}>{STORE[st].short}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewChatDialog({ onClose, onStart }: {
  onClose: () => void;
  onStart: (d: { phone: string; store: string }) => void;
}) {
  const [num, setNum] = useState("");
  const [store, setStore] = useState<"LM" | "TS">("LM");
  const wa = toWa(num);
  return (
    <div className="wa-fade wa-root fixed inset-0 z-[85] flex items-end justify-center bg-black/40 md:items-center" onClick={onClose}>
      <div className="wa-up wa-panel w-full max-w-sm rounded-t-2xl p-5 shadow-2xl md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center gap-2 text-[17px] font-medium"><SquarePen size={18} className="wa-green" /> New chat</div>
        <label className="mb-1 block text-[12.5px] wa-sub">Customer WhatsApp number</label>
        <input autoFocus inputMode="tel" value={num} onChange={(e) => setNum(e.target.value)} placeholder="0300 1234567"
          onKeyDown={(e) => { if (e.key === "Enter" && wa) onStart({ phone: wa, store }); }}
          className="w-full rounded-lg border wa-line bg-transparent px-3 py-2.5 text-[16px] outline-none focus:border-[#00a884]" />
        {num && !wa && <div className="mt-1 text-[12px] text-[#ea0038]">Enter a Pakistani mobile number, e.g. 0300 1234567</div>}
        <label className="mb-1 mt-4 block text-[12.5px] wa-sub">Send from</label>
        <div className="grid grid-cols-2 gap-2">
          {(["LM", "TS"] as const).map((st) => (
            <button key={st} type="button" onClick={() => setStore(st)}
              className={`wa-press rounded-xl border-2 px-3 py-2.5 text-[14px] font-medium ${store === st ? "border-[#00a884]" : "wa-line"}`}>
              {STORE[st].name}<div className="text-[11px] font-normal wa-sub">{st === "LM" ? "0301-8481401" : "0307-9542935"}</div>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[12px] wa-sub">A new chat starts with a template. Free text opens once the customer replies.</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="wa-press flex-1 rounded-full border wa-line py-2.5 text-[14px]">Cancel</button>
          <button type="button" disabled={!wa} onClick={() => wa && onStart({ phone: wa, store })}
            className="wa-press wa-bg-green flex-1 rounded-full py-2.5 text-[14px] font-medium text-white disabled:opacity-50">Start chat</button>
        </div>
      </div>
    </div>
  );
}

/* ── one row in the chat list ────────────────────────────────────────── */
function ChatRow({ c, on, onOpen, onFlag }: {
  c: Chat; on: boolean; onOpen: () => void;
  onFlag: (phone: string, p: { p_pinned?: boolean; p_archived?: boolean; p_unread?: boolean }) => void;
}) {
  const [menu, setMenu] = useState(false);
  const st = c.store_code ? STORE[c.store_code] : null;
  return (
    <div className="group relative">
      <button type="button" onClick={onOpen} data-on={on}
        className="wa-row flex w-full items-center gap-3 px-3 text-left">
        <Avatar chat={c} />
        <div className="min-w-0 flex-1 border-b py-3 wa-line">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[16px]">{displayName(c)}</span>
            <span className={`shrink-0 text-[12px] ${c.unread ? "text-[#1fa855] dark:text-[#06cf9c]" : "wa-sub"}`}>{listTime(c.last_at)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {c.last_dir === "out" && <Ticks status={c.last_status} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate text-[14px] wa-sub">{c.last_text ?? ""}</span>
            {st && <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${st.tone}`}>{st.short}</span>}
            {c.pinned && <Pin size={13} className="shrink-0 rotate-45 wa-sub" />}
            {c.unread > 0 && (
              <span className="wa-pop flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[#25d366] px-1.5 text-[11.5px] font-semibold text-white dark:text-[#111b21]">
                {c.unread}
              </span>
            )}
            <span className="w-0 overflow-hidden transition-all group-hover:w-5" />
          </div>
        </div>
      </button>
      <button type="button" onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }} aria-label="Chat options"
        className="absolute bottom-3 right-2 hidden rounded p-0.5 wa-sub group-hover:block">
        <ChevronDown size={18} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
          <div className="wa-fade wa-panel absolute right-3 top-12 z-30 w-48 overflow-hidden rounded-lg py-1.5 shadow-xl ring-1 ring-black/5">
            {[
              { l: c.pinned ? "Unpin chat" : "Pin chat", i: Pin, f: () => onFlag(c.phone, { p_pinned: !c.pinned }) },
              { l: c.unread ? "Mark as read" : "Mark as unread", i: MailWarning, f: () => onFlag(c.phone, { p_unread: !c.unread }) },
              { l: c.archived ? "Unarchive chat" : "Archive chat", i: c.archived ? ArchiveRestore : Archive, f: () => onFlag(c.phone, { p_archived: !c.archived }) },
            ].map(({ l, i: I, f }) => (
              <button key={l} type="button" onClick={() => { f(); setMenu(false); }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[14px] hover:bg-[var(--wa-hover)]">
                <I size={16} className="wa-sub" /> {l}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── the open conversation ───────────────────────────────────────────── */
function Conversation({ chat, msgs, hasMore, loading, unreadAtOpen, canReply, onBack, onInfo, onTemplate, onOlder, onFlag, setMsgs, flash }: {
  chat: Chat; msgs: Msg[] | null; hasMore: boolean; loading: boolean; unreadAtOpen: number; canReply: boolean;
  onBack: () => void; onInfo: () => void; onTemplate: () => void; onOlder: () => Promise<void>;
  onFlag: (phone: string, p: { p_pinned?: boolean; p_archived?: boolean; p_unread?: boolean }) => void;
  setMsgs: React.Dispatch<React.SetStateAction<Record<string, Msg[]>>>;
  flash: (t: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [menu, setMenu] = useState(false);
  const open = windowOpen(chat);
  const left = windowLeft(chat);
  const st = chat.store_code ? STORE[chat.store_code] : null;

  /* visible messages, their reactions and a lookup for quoted replies */
  const { list, reactions, byWa } = useMemo(() => {
    const reactions = new Map<string, string>();
    const byWa = new Map<string, Msg>();
    const list: Msg[] = [];
    for (const m of msgs ?? []) {
      if (m.kind === "reaction") { if (m.reply_to) { if (m.body) reactions.set(m.reply_to, m.body); else reactions.delete(m.reply_to); } continue; }
      list.push(m);
      if (m.wa_id) byWa.set(m.wa_id, m);
    }
    return { list, reactions, byWa };
  }, [msgs]);

  const firstUnreadIdx = useMemo(() => {
    if (!unreadAtOpen) return -1;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].dir === "in") { n++; if (n === unreadAtOpen) return i; }
    }
    return -1;
  }, [list, unreadAtOpen]);

  // first paint at the bottom, then follow new messages only if already there
  const lastLen = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !msgs) return;
    if (lastLen.current === 0) {
      const mark = el.querySelector("[data-unread-mark]") as HTMLElement | null;
      if (mark) el.scrollTop = mark.offsetTop - 80;
      else el.scrollTop = el.scrollHeight;
    } else if (list.length > lastLen.current) {
      const last = list[list.length - 1];
      if (atBottom.current || last?.dir === "out") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else setNewBelow((n) => n + (list.length - lastLen.current));
    }
    lastLen.current = list.length;
  }, [msgs, list]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    atBottom.current = near;
    setShowDown(!near);
    if (near) setNewBelow(0);
  };

  const older = async () => {
    const el = scroller.current;
    const h = el?.scrollHeight ?? 0;
    await onOlder();
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h; });
  };

  const jump = (waId: string) => {
    const el = scroller.current?.querySelector(`[data-wa="${CSS.escape(waId)}"]`) as HTMLElement | null;
    if (!el) { flash("That message is further up — load older messages"); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("wa-flash"); void el.offsetWidth; el.classList.add("wa-flash");
  };

  /* ── sending ─────────────────────────────────────────────────────── */
  const pushPending = (m: Partial<Msg>) => {
    const tempId = "t" + Date.now() + Math.random().toString(36).slice(2, 6);
    const row: Msg = {
      id: -Date.now(), phone: chat.phone, store_code: chat.store_code, dir: "out", kind: "text", body: null, template: null,
      buttons: null, media_path: null, media_mime: null, media_name: null, reply_to: null, wa_id: null, status: "pending",
      error: null, order_id: chat.order_id, order_name: chat.order_name, sent_by_name: "You", at: new Date().toISOString(),
      pending: true, tempId, ...m,
    };
    setMsgs((all) => ({ ...all, [chat.phone]: [...(all[chat.phone] ?? []), row] }));
    return tempId;
  };
  const settle = (tempId: string, real: Msg | null, error?: string) => {
    setMsgs((all) => {
      const cur = all[chat.phone] ?? [];
      if (real && cur.some((x) => x.id === real.id)) return { ...all, [chat.phone]: cur.filter((x) => x.tempId !== tempId) };
      return {
        ...all,
        [chat.phone]: cur.map((x) => x.tempId !== tempId ? x
          : real ? real : { ...x, pending: false, status: "failed", error: error ?? "Not sent" }),
      };
    });
  };

  const sendText = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    const reply = replyTo;
    setReplyTo(null);
    const tempId = pushPending({ body: t, reply_to: reply?.wa_id ?? null });
    const r = await waSend<{ message: Msg }>({ action: "text", phone: chat.phone, text: t, reply_to: reply?.wa_id ?? undefined });
    if (r.ok) settle(tempId, r.message);
    else if (r.error === "window_closed") { settle(tempId, null, "24-hour window closed — send a template"); onTemplate(); }
    else { settle(tempId, null, r.error); flash(r.error ?? "Not sent"); }
  };

  const sendFile = async (file: File, caption: string) => {
    if (file.size > 16 * 1024 * 1024) { flash("File is larger than 16 MB"); return; }
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document";
    const tempId = pushPending({ kind, body: caption || null, media_name: file.name, media_mime: file.type });
    const base64 = await fileToBase64(file);
    const r = await waSend<{ message: Msg }>({ action: "media", phone: chat.phone, base64, mime: file.type || "application/octet-stream", filename: file.name, caption });
    if (r.ok) settle(tempId, r.message);
    else if (r.error === "window_closed") { settle(tempId, null, "24-hour window closed"); onTemplate(); }
    else { settle(tempId, null, r.error); flash(r.error ?? "Not sent"); }
  };

  return (
    <div className="wa-slide flex h-full min-w-0 flex-1 flex-col md:animate-none">
      {/* header */}
      <header className="wa-panel-2 flex h-[59px] shrink-0 items-center gap-2 px-2 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4 md:pt-0" style={{ boxSizing: "content-box" }}>
        <button type="button" onClick={onBack} className="wa-press rounded-full p-2 md:hidden" aria-label="Back"><ArrowLeft size={22} /></button>
        <button type="button" onClick={onInfo} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar chat={chat} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[16px]">{displayName(chat)}</span>
              {st && <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${st.tone}`}>{st.name}</span>}
            </div>
            <div className="truncate text-[12.5px] wa-sub">
              {chat.name ? prettyPhone(chat.phone) : "tap for customer info"}
              {chat.order_name ? ` · ${chat.order_name}` : ""}
            </div>
          </div>
        </button>
        <button type="button" onClick={onInfo} className="wa-press hidden rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10 md:block" aria-label="Customer info"><Info size={19} className="wa-sub" /></button>
        <div className="relative">
          <button type="button" onClick={() => setMenu((v) => !v)} className="wa-press rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Menu"><MoreVertical size={20} className="wa-sub" /></button>
          {menu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="wa-fade wa-panel absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-lg py-1.5 shadow-xl ring-1 ring-black/5">
                {[
                  { l: "Customer info", f: onInfo },
                  { l: chat.pinned ? "Unpin chat" : "Pin chat", f: () => onFlag(chat.phone, { p_pinned: !chat.pinned }) },
                  { l: "Mark as unread", f: () => { onFlag(chat.phone, { p_unread: true }); onBack(); } },
                  { l: chat.archived ? "Unarchive chat" : "Archive chat", f: () => { onFlag(chat.phone, { p_archived: !chat.archived }); onBack(); } },
                  ...(canReply ? [{ l: "Send template", f: onTemplate }] : []),
                  { l: "Call customer", f: () => { window.location.href = `tel:+${chat.phone}`; } },
                ].map(({ l, f }) => (
                  <button key={l} type="button" onClick={() => { setMenu(false); f(); }}
                    className="block w-full px-5 py-2.5 text-left text-[14.5px] hover:bg-[var(--wa-hover)]">{l}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </header>

      {/* messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="wa-wall wa-scroll absolute inset-0 overflow-y-auto pb-3 pt-2">
          {loading && <div className="flex justify-center py-10"><Loader2 className="animate-spin wa-sub" /></div>}
          {hasMore && (
            <div className="flex justify-center py-2">
              <button type="button" onClick={older} className="wa-pill wa-press rounded-full px-3 py-1 text-[12.5px]">Load older messages</button>
            </div>
          )}
          <div className="mx-auto mb-2 mt-1 flex max-w-[460px] justify-center px-4">
            <div className="rounded-lg bg-[#ffeecd] px-3 py-1.5 text-center text-[12px] text-[#54656f] dark:bg-[#182229] dark:text-[#ffd279]">
              <Lock size={11} className="mr-1 inline -translate-y-px" />
              Messages go through Meta&apos;s WhatsApp Business API from the order number.
            </div>
          </div>
          {list.map((m, i) => {
            const prev = list[i - 1];
            const newDay = !prev || !sameDay(prev.at, m.at);
            const tail = newDay || !prev || prev.dir !== m.dir;
            return (
              <div key={m.tempId ?? m.id}>
                {newDay && (
                  <div className="sticky top-1 z-[5] my-2 flex justify-center">
                    <span className="wa-pill rounded-lg px-3 py-1 text-[12.5px] uppercase">{dayLabel(m.at)}</span>
                  </div>
                )}
                {i === firstUnreadIdx && (
                  <div data-unread-mark className="my-2 flex justify-center bg-black/[0.04] py-1 dark:bg-white/[0.03]">
                    <span className="wa-pill rounded-full px-3 py-0.5 text-[12.5px]">{unreadAtOpen} unread message{unreadAtOpen > 1 ? "s" : ""}</span>
                  </div>
                )}
                <Bubble m={m} tail={tail}
                  quoted={m.reply_to ? (byWa.get(m.reply_to) ?? null) : undefined}
                  reaction={m.wa_id ? reactions.get(m.wa_id) ?? null : null}
                  onReply={canReply && open ? setReplyTo : undefined}
                  onJump={jump} />
              </div>
            );
          })}
          {msgs && list.length === 0 && (
            <div className="py-16 text-center text-[13px] wa-sub">No messages in this chat yet.</div>
          )}
        </div>

        {showDown && (
          <button type="button" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}
            className="wa-pop wa-panel absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full shadow-lg" aria-label="Scroll to latest">
            <ChevronDown size={22} className="wa-sub" />
            {newBelow > 0 && <span className="absolute -top-1.5 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#25d366] px-1 text-[11px] font-semibold text-white">{newBelow}</span>}
          </button>
        )}
      </div>

      {/* composer */}
      {!canReply ? (
        <div className="wa-panel-2 shrink-0 px-4 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] text-center text-[13px] wa-sub">
          <Lock size={13} className="mr-1 inline -translate-y-px" /> You can read chats. Replying needs the WhatsApp reply permission.
        </div>
      ) : open ? (
        <Composer chat={chat} left={left} replyTo={replyTo} onCancelReply={() => setReplyTo(null)}
          onText={sendText} onFile={sendFile} onTemplate={onTemplate} />
      ) : (
        <div className="wa-panel-2 shrink-0 px-3 py-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <div className="flex flex-col items-center gap-2 text-center md:flex-row md:text-left">
            <Clock size={18} className="hidden shrink-0 wa-sub md:block" />
            <div className="flex-1 text-[13px] wa-sub">
              {chat.last_in_at
                ? "The customer last wrote over 24 hours ago. WhatsApp only allows a template to restart the chat."
                : "This customer hasn't written yet. Start with a template — free text opens once they reply."}
            </div>
            <button type="button" onClick={onTemplate}
              className="wa-press wa-bg-green flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium text-white">
              <FileText size={16} /> Send template
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── the box at the bottom ───────────────────────────────────────────── */
function Composer({ chat, left, replyTo, onCancelReply, onText, onFile, onTemplate }: {
  chat: Chat; left: number; replyTo: Msg | null; onCancelReply: () => void;
  onText: (t: string) => void; onFile: (f: File, caption: string) => void; onTemplate: () => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const draftKey = `wa-draft:${chat.phone}`;

  // drafts survive switching chats, like WhatsApp
  useEffect(() => {
    try { setText(localStorage.getItem(draftKey) ?? ""); } catch { /* private mode */ }
    if (window.matchMedia("(min-width: 768px)").matches) box.current?.focus();
  }, [draftKey]);
  useEffect(() => {
    try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch { /* private mode */ }
  }, [text, draftKey]);
  useEffect(() => { if (replyTo) box.current?.focus(); }, [replyTo]);

  // grow with the text, up to six lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
  }, [text]);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) { setPreview(null); return; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const slash = text.startsWith("/") ? text.slice(1).toLowerCase() : null;
  const quick = slash !== null ? QUICK.filter((x) => x.k.includes(slash) || x.t.toLowerCase().includes(slash)) : [];

  const submit = () => {
    if (file) { onFile(file, text.trim()); setFile(null); setText(""); return; }
    if (!text.trim()) return;
    onText(text);
    setText("");
    setEmoji(false);
  };

  const warn = left < 2 * 3600e3;

  return (
    <div className="wa-panel-2 relative shrink-0 pb-[env(safe-area-inset-bottom)]">
      {/* quick replies */}
      {quick.length > 0 && (
        <div className="wa-up wa-panel absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-y-auto rounded-xl py-1 shadow-xl ring-1 ring-black/5">
          <div className="flex items-center gap-1.5 px-3 py-1 text-[11.5px] font-medium wa-sub"><Zap size={12} /> Quick replies</div>
          {quick.map((x) => (
            <button key={x.k} type="button" onClick={() => setText(x.t)}
              className="block w-full px-3 py-2 text-left hover:bg-[var(--wa-hover)]">
              <div className="text-[12.5px] font-medium text-[#008069] dark:text-[#06cf9c]">/{x.k}</div>
              <div className="line-clamp-1 text-[13px] wa-sub">{x.t}</div>
            </button>
          ))}
        </div>
      )}

      {emoji && (
        <div className="wa-up wa-panel absolute bottom-full left-2 mb-2 grid grid-cols-10 gap-0.5 rounded-xl p-2 shadow-xl ring-1 ring-black/5">
          {EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => { setText((t) => t + e); box.current?.focus(); }}
              className="wa-press flex h-9 w-9 items-center justify-center rounded-lg text-[21px] hover:bg-[var(--wa-hover)]">{e}</button>
          ))}
        </div>
      )}

      {replyTo && (
        <div className="wa-up flex items-center gap-2 px-3 pt-2">
          <div className="min-w-0 flex-1 overflow-hidden rounded-[6px] border-l-4 border-[#06cf9c] bg-black/[0.05] px-3 py-1.5 dark:bg-black/20">
            <div className="text-[12.5px] font-medium text-[#06cf9c]">{replyTo.dir === "out" ? "You" : displayName(chat)}</div>
            <div className="truncate text-[13px] wa-sub">{replyTo.body ?? `[${replyTo.kind}]`}</div>
          </div>
          <button type="button" onClick={onCancelReply} className="wa-press rounded-full p-1.5" aria-label="Cancel reply"><X size={18} className="wa-sub" /></button>
        </div>
      )}

      {file && (
        <div className="wa-up flex items-center gap-3 px-3 pt-2">
          {preview
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={preview} alt="" className="h-14 w-14 rounded-md object-cover" />
            : <div className="flex h-14 w-14 items-center justify-center rounded-md bg-black/5 dark:bg-white/10"><FileText size={24} className="wa-sub" /></div>}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">{file.name}</div>
            <div className="text-[11.5px] wa-sub">{(file.size / 1024 / 1024).toFixed(2)} MB · the text box becomes the caption</div>
          </div>
          <button type="button" onClick={() => setFile(null)} className="wa-press rounded-full p-1.5" aria-label="Remove file"><X size={18} className="wa-sub" /></button>
        </div>
      )}

      <div className="flex items-end gap-1 px-2 py-[9px] md:gap-2 md:px-4">
        <button type="button" onClick={() => setEmoji((v) => !v)} className="wa-press mb-[3px] rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Emoji">
          <Smile size={24} className="wa-sub" />
        </button>
        <button type="button" onClick={() => picker.current?.click()} className="wa-press mb-[3px] rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Attach">
          <Paperclip size={22} className="wa-sub" />
        </button>
        <input ref={picker} type="file" hidden accept="image/*,video/mp4,video/3gpp,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
        <div className="wa-input flex min-w-0 flex-1 items-end rounded-lg px-3 py-[9px]">
          <textarea ref={box} rows={1} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(min-width: 768px)").matches) {
                e.preventDefault();
                if (quick.length === 1) setText(quick[0].t); else submit();
              }
            }}
            onPaste={(e) => { const f = e.clipboardData.files?.[0]; if (f) { e.preventDefault(); setFile(f); } }}
            placeholder={file ? "Add a caption" : "Type a message  ·  / for quick replies"}
            className="max-h-[132px] w-full resize-none bg-transparent text-[15px] leading-[20px] outline-none placeholder:text-[var(--wa-sub)]" />
        </div>
        {text.trim() || file ? (
          <button type="button" onClick={submit} className="wa-press wa-pop wa-bg-green mb-[1px] flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-white" aria-label="Send">
            <Send size={19} className="translate-x-[1px]" />
          </button>
        ) : (
          <button type="button" onClick={onTemplate} className="wa-press mb-[3px] rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Templates" title="Send a template">
            <FileText size={22} className="wa-sub" />
          </button>
        )}
      </div>
      <div className={`-mt-1 flex items-center justify-center gap-1 pb-1.5 text-[11px] ${warn ? "text-[#d97706]" : "wa-sub"}`}>
        <Clock size={11} /> Reply window: {hoursLeftLabel(left)}
        <span className="mx-1">·</span> <ImageIcon size={11} /> photos & files up to 16 MB
      </div>
    </div>
  );
}
