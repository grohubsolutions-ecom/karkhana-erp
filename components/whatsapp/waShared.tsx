"use client";

/* Small shared pieces of the WhatsApp inbox (H330): types, time and phone
   formatting, ticks, avatars, and signed links for media in the wa-media
   bucket. Kept apart from the page so the bubbles and the list read the same
   way everywhere. */

import { supabase } from "@/lib/supabase";

export type Chat = {
  phone: string; name: string | null; store_code: string | null;
  last_text: string | null; last_dir: "in" | "out" | null; last_status: string | null;
  last_at: string | null; last_in_at: string | null; unread: number;
  pinned: boolean; archived: boolean; order_id: string | null; order_name: string | null;
};

export type Msg = {
  id: number; phone: string; store_code: string | null; dir: "in" | "out"; kind: string;
  body: string | null; template: string | null; buttons: string[] | null;
  media_path: string | null; media_mime: string | null; media_name: string | null;
  reply_to: string | null; wa_id: string | null; status: string | null; error: string | null;
  order_id: string | null; order_name: string | null; sent_by_name: string | null; at: string;
  /** client-only: a message on its way */
  pending?: boolean; tempId?: string;
};

export const STORE: Record<string, { name: string; short: string; tone: string }> = {
  LM: { name: "Little Minors", short: "LM", tone: "bg-[#ffe7c2] text-[#8a5300] dark:bg-[#4a3410] dark:text-[#ffd59a]" },
  TS: { name: "TopShop PK", short: "TS", tone: "bg-[#dbe8ff] text-[#1f4fa3] dark:bg-[#1b2c4d] dark:text-[#a9c6ff]" },
  TRZ: { name: "Trenzee", short: "TRZ", tone: "bg-[#fbdcef] text-[#9b1f6b] dark:bg-[#4a1836] dark:text-[#ffb3e0]" },
};

const TZ = "Asia/Karachi";

export const WINDOW_MS = 24 * 3600 * 1000;
export const windowOpen = (c: Chat | null | undefined) =>
  !!c?.last_in_at && Date.now() - new Date(c.last_in_at).getTime() < WINDOW_MS;
export const windowLeft = (c: Chat | null | undefined) => {
  if (!c?.last_in_at) return 0;
  return Math.max(0, WINDOW_MS - (Date.now() - new Date(c.last_in_at).getTime()));
};

/** +92 300 1234567 */
export function prettyPhone(p: string | null | undefined) {
  const d = String(p ?? "").replace(/\D/g, "");
  if (/^92\d{10}$/.test(d)) return `+92 ${d.slice(2, 5)} ${d.slice(5)}`;
  return d ? "+" + d : "";
}

export const displayName = (c: Pick<Chat, "name" | "phone">) => c.name?.trim() || prettyPhone(c.phone);

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });

/** Chat-list time: 3:42 pm today, Yesterday, weekday this week, else 12/11/26. */
export function listTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = dayKey(new Date().toISOString());
  const k = dayKey(iso);
  if (k === today) return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase();
  const y = new Date(Date.now() - 864e5).toISOString();
  if (k === dayKey(y)) return "Yesterday";
  if (Date.now() - d.getTime() < 6 * 864e5) return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
  return d.toLocaleDateString("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit" });
}

export const bubbleTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase();

/** Date pill between messages: TODAY, YESTERDAY, or 27 November 2026. */
export function dayLabel(iso: string) {
  const k = dayKey(iso);
  if (k === dayKey(new Date().toISOString())) return "Today";
  if (k === dayKey(new Date(Date.now() - 864e5).toISOString())) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
}
export const sameDay = (a: string, b: string) => dayKey(a) === dayKey(b);

export function hoursLeftLabel(ms: number) {
  if (ms <= 0) return "closed";
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

/* ── ticks ─────────────────────────────────────────────────────────────── */
export function Ticks({ status, className = "" }: { status: string | null | undefined; className?: string }) {
  if (status === "pending") {
    return (
      <svg viewBox="0 0 16 15" width="14" height="14" className={`text-[#8696a0] ${className}`} aria-label="Sending">
        <circle cx="8" cy="7.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 4.5v3.3l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" className={`text-[#ea0038] ${className}`} aria-label="Failed">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4.2v4.6M8 10.9v.9" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const double = status === "delivered" || status === "read";
  const color = status === "read" ? "text-[#53bdeb]" : "text-[#8696a0]";
  return double ? (
    <svg viewBox="0 0 16 11" width="16" height="11" className={`${color} ${className}`} aria-label={status === "read" ? "Read" : "Delivered"}>
      <path d="M11.07.65 4.98 8.13 2.44 5.73a.5.5 0 0 0-.7.72l2.92 2.77a.5.5 0 0 0 .74-.05L11.85 1.3a.5.5 0 1 0-.78-.65Z" fill="currentColor" />
      <path d="M15.07.65 8.98 8.13l-.9-.86-.68.77 1.25 1.18a.5.5 0 0 0 .74-.05L15.85 1.3a.5.5 0 1 0-.78-.65Z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 12 11" width="12" height="11" className={`${color} ${className}`} aria-label="Sent">
      <path d="M11.07.65 4.98 8.13 2.44 5.73a.5.5 0 0 0-.7.72l2.92 2.77a.5.5 0 0 0 .74-.05L11.85 1.3a.5.5 0 1 0-.78-.65Z" fill="currentColor" />
    </svg>
  );
}

/* ── avatar ────────────────────────────────────────────────────────────── */
const PALETTE = ["#25d366", "#53bdeb", "#ff8b6b", "#a78bfa", "#f59e0b", "#06b6d4", "#ec4899", "#10b981"];
export function Avatar({ chat, size = 49 }: { chat: Pick<Chat, "name" | "phone">; size?: number }) {
  const label = chat.name?.trim();
  const initials = label
    ? label.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("")
    : "";
  const n = [...chat.phone].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return (
    <div className="wa-avatar flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background: initials ? PALETTE[n % PALETTE.length] : "#dfe5e7" }}>
      {initials || (
        <svg viewBox="0 0 212 212" width={size} height={size} aria-hidden>
          <path fill="#dfe5e7" d="M106 0a106 106 0 1 0 0 212 106 106 0 0 0 0-212Z" />
          <path fill="#fff" d="M173 179c-17 16-40 26-67 26s-50-10-67-26c4-25 25-44 51-48a42 42 0 1 1 32 0c26 4 47 23 51 48ZM106 46a32 32 0 1 0 0 64 32 32 0 0 0 0-64Z" />
        </svg>
      )}
    </div>
  );
}

/* ── media links ───────────────────────────────────────────────────────── */
const signed = new Map<string, { url: string; until: number }>();
export async function mediaUrl(path: string): Promise<string | null> {
  const hit = signed.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  if (!supabase) return null;
  const { data } = await supabase.storage.from("wa-media").createSignedUrl(path, 3600);
  if (!data?.signedUrl) return null;
  signed.set(path, { url: data.signedUrl, until: Date.now() + 55 * 60e3 });
  return data.signedUrl;
}

/** Text with links made clickable and *bold* / _italic_ as WhatsApp shows them. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+|\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer" className="text-[#027eb5] underline-offset-2 hover:underline dark:text-[#53bdeb]">{p}</a>;
        if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
        if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** Calls wa-send with the signed-in person's session. */
export async function waSend<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: "not connected" } as T & { ok: boolean; error?: string };
  const { data, error } = await supabase.functions.invoke("wa-send", { body: payload });
  if (error) {
    /* A non-2xx reply arrives as an error whose context is the response; read
       our own JSON message out of it instead of "Edge Function returned a
       non-2xx status code". */
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.json();
        return { ok: false, ...(j ?? {}) } as T & { ok: boolean; error?: string };
      }
    } catch { /* fall through */ }
    return { ok: false, error: error.message } as T & { ok: boolean; error?: string };
  }
  return data as T & { ok: boolean; error?: string };
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result ?? "").replace(/^data:[^,]+,/, ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}
