"use client";

/* One message bubble in the WhatsApp inbox (H330): text, template with its
   buttons, picture, voice note, video, document, location, the quoted message
   it answers, its reaction, its time and its ticks. */

import { memo, useEffect, useState } from "react";
import { FileText, MapPin, Reply, Copy, Download, Bot, AlertCircle, Loader2 } from "lucide-react";
import { type Msg, Ticks, bubbleTime, mediaUrl, RichText } from "./waShared";

function useMedia(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (path) mediaUrl(path).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [path]);
  return url;
}

function Media({ m }: { m: Msg }) {
  const url = useMedia(m.media_path);
  const [big, setBig] = useState(false);
  if (!m.media_path) {
    return <div className="flex items-center gap-2 px-1 py-2 text-[13px] wa-sub"><AlertCircle size={15} /> {m.kind === "audio" ? "Voice message" : "Media"} not available</div>;
  }
  if (!url) return <div className="flex h-40 w-60 items-center justify-center rounded-md bg-black/5 dark:bg-white/5"><Loader2 size={20} className="animate-spin wa-sub" /></div>;

  if (m.kind === "image" || m.kind === "sticker") {
    return (
      <>
        <button type="button" onClick={() => setBig(true)} className="block overflow-hidden rounded-md">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={m.body ?? "Photo"} loading="lazy"
            className={m.kind === "sticker" ? "h-32 w-32 object-contain" : "max-h-80 w-full min-w-[200px] max-w-[330px] object-cover"} />
        </button>
        {big && (
          <div className="wa-fade fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-4" onClick={() => setBig(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="max-h-full max-w-full rounded-md object-contain" />
            <a href={url} download={m.media_name ?? "photo"} onClick={(e) => e.stopPropagation()}
              className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Download">
              <Download size={18} />
            </a>
          </div>
        )}
      </>
    );
  }
  if (m.kind === "audio") return <audio controls preload="metadata" src={url} className="h-10 w-[260px] max-w-full" />;
  if (m.kind === "video") return <video controls preload="metadata" src={url} className="max-h-80 w-full max-w-[330px] rounded-md bg-black" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" download={m.media_name ?? undefined}
      className="flex min-w-[220px] items-center gap-3 rounded-md bg-black/[0.04] p-3 hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]">
      <FileText size={30} className="shrink-0 text-[#e2574c]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px]">{m.media_name ?? "Document"}</div>
        <div className="text-[11px] uppercase wa-sub">{(m.media_name?.split(".").pop() ?? m.media_mime?.split("/").pop() ?? "file").slice(0, 6)}</div>
      </div>
      <Download size={18} className="shrink-0 wa-sub" />
    </a>
  );
}

type Props = {
  m: Msg;
  tail: boolean;
  quoted?: Msg | null;
  reaction?: string | null;
  onReply?: (m: Msg) => void;
  onJump?: (waId: string) => void;
};

function BubbleInner({ m, tail, quoted, reaction, onReply, onJump }: Props) {
  const out = m.dir === "out";
  const status = m.pending ? "pending" : m.status;
  const media = ["image", "sticker", "audio", "video", "document"].includes(m.kind);
  const text = m.body ?? "";
  const [menu, setMenu] = useState(false);

  return (
    <div className={`group flex ${out ? "justify-end wa-out" : "justify-start wa-in"} ${tail ? "wa-tail mt-[10px]" : "mt-[2px]"} px-[5%] md:px-[7%]`}
      data-wa={m.wa_id ?? undefined}>
      <div className="relative flex max-w-full flex-col items-stretch" style={{ alignItems: out ? "flex-end" : "flex-start" }}>
        <div className={`wa-bubble ${m.pending ? "" : "wa-pop"} ${reaction ? "mb-3" : ""}`}>
          {/* hover menu: reply / copy */}
          <div className={`absolute top-1 ${out ? "-left-16" : "-right-16"} z-10 hidden gap-1 group-hover:flex`}>
            {onReply && m.wa_id && !m.pending && (
              <button type="button" onClick={() => onReply(m)} aria-label="Reply"
                className="wa-press flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-[#54656f] shadow-sm dark:bg-[#233138] dark:text-[#aebac1]">
                <Reply size={14} />
              </button>
            )}
            {text && (
              <button type="button" onClick={() => { navigator.clipboard?.writeText(text); setMenu(true); setTimeout(() => setMenu(false), 900); }} aria-label="Copy"
                className="wa-press flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-[#54656f] shadow-sm dark:bg-[#233138] dark:text-[#aebac1]">
                <Copy size={13} />
              </button>
            )}
          </div>
          {menu && <div className="wa-fade absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-black/75 px-2 py-0.5 text-[11px] text-white">Copied</div>}

          <div className={media && !text ? "p-[3px]" : "px-[7px] pb-[6px] pt-[6px]"}>
            {out && m.sent_by_name && (
              <div className="mb-0.5 flex items-center gap-1 text-[11.5px] font-medium text-[#06cf9c]">
                {m.sent_by_name === "Bot" ? <Bot size={12} /> : null}
                {m.sent_by_name === "Bot" ? "Order bot" : m.sent_by_name}
                {m.template && <span className="font-normal wa-sub">· template</span>}
              </div>
            )}

            {quoted !== undefined && m.reply_to && (
              <button type="button" onClick={() => m.reply_to && onJump?.(m.reply_to)}
                className="mb-1 block w-full overflow-hidden rounded-[5px] border-l-4 border-[#06cf9c] bg-black/[0.05] px-2 py-1 text-left dark:bg-black/20">
                <div className="text-[12px] font-medium text-[#06cf9c]">{quoted ? (quoted.dir === "out" ? "You" : "Customer") : "Message"}</div>
                <div className="line-clamp-2 text-[12.5px] wa-sub">{quoted?.body ?? (quoted ? `[${quoted.kind}]` : "Earlier message")}</div>
              </button>
            )}

            {media && <Media m={m} />}

            {m.kind === "location" && (
              <a href={`https://maps.google.com/?q=${encodeURIComponent((text.split(" · ").pop() ?? text))}`} target="_blank" rel="noreferrer"
                className="mb-1 flex items-center gap-2 rounded-md bg-black/[0.04] p-2 text-[13px] hover:underline dark:bg-white/[0.06]">
                <MapPin size={18} className="text-[#ea0038]" /> Open location
              </a>
            )}

            {text && (
              <div className={`whitespace-pre-wrap break-words ${media ? "px-[4px] pt-1" : ""}`}>
                {m.kind === "button" && <span className="mr-1 inline-block rounded bg-[#06cf9c]/15 px-1.5 text-[11px] font-medium text-[#008069] dark:text-[#06cf9c]">Tapped</span>}
                <RichText text={text} />
                {/* room so the time never sits on top of the last word */}
                <span className="inline-block w-[72px]" aria-hidden />
              </div>
            )}

            <div className={`wa-meta flex items-center justify-end gap-1 ${text ? "-mt-[14px] float-right relative" : media ? "absolute bottom-1.5 right-2 rounded-full bg-black/35 px-1.5 text-white" : ""}`}>
              {m.order_name && !out && <span className="mr-1 opacity-80">{m.order_name}</span>}
              <span>{bubbleTime(m.at)}</span>
              {out && <Ticks status={status} />}
            </div>
            <div className="clear-both" />
          </div>
        </div>

        {/* template quick-reply buttons, shown as WhatsApp shows them */}
        {m.kind === "template" && Array.isArray(m.buttons) && m.buttons.length > 0 && (
          <div className="mt-[2px] flex w-full flex-col gap-[2px]" style={{ maxWidth: "min(78%, 560px)", minWidth: "100%" }}>
            {m.buttons.map((b) => (
              <div key={b} className="wa-tplbtn flex items-center justify-center gap-1.5 rounded-[7.5px] py-2 text-[14px]">
                <Reply size={14} className="-scale-x-100" /> {b}
              </div>
            ))}
          </div>
        )}

        {reaction && (
          <div className={`absolute -bottom-0 ${out ? "right-2" : "left-2"} rounded-full border-2 border-[var(--wa-chat-bg)] bg-[var(--wa-panel)] px-1 text-[14px] leading-5 shadow-sm`}>
            {reaction}
          </div>
        )}

        {out && m.status === "failed" && (
          <div className="mt-1 max-w-[320px] text-right text-[11.5px] text-[#ea0038]">Not delivered{m.error ? ` — ${m.error}` : ""}</div>
        )}
      </div>
    </div>
  );
}

export const Bubble = memo(BubbleInner);
