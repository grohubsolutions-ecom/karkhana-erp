"use client";

/* Pick an approved WhatsApp template, fill its {{1}} {{2}} fields and send.
   The only way to write to a customer whose 24-hour window is closed. Fields
   are pre-filled from the chat (name, order, store) where the template's own
   example says what a field is for. */

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Send, FileText, Search } from "lucide-react";
import { type Chat, STORE, waSend } from "./waShared";

export type Template = {
  name: string; language: string; category: string; body: string; params: number;
  header: string | null; footer: string | null; buttons: { type: string; text: string }[];
  examples: string[]; headerNeedsParam?: boolean; headerMedia?: string | null;
};

let cache: Template[] | null = null;

function guess(chat: Chat, i: number, example: string, latestAmount: string | null) {
  const ex = (example ?? "").toLowerCase();
  const first = chat.name?.split(/\s+/)[0] ?? "";
  if (i === 0 && first) return first;
  if (/^#|order|\d{4,}/.test(ex) && chat.order_name) return chat.order_name;
  if (/minors|topshop|trenzee|store|shop/.test(ex) && chat.store_code) return STORE[chat.store_code]?.name ?? chat.store_code;
  if (/^\d[\d,]*$/.test(ex) && latestAmount) return latestAmount;
  return "";
}

export default function TemplatePicker({ chat, amount, onClose, onSent }: {
  chat: Chat; amount: string | null; onClose: () => void; onSent: () => void;
}) {
  const [list, setList] = useState<Template[] | null>(cache);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Template | null>(null);
  const [vals, setVals] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (cache) return;
    waSend<{ templates: Template[] }>({ action: "templates" }).then((r) => {
      if (r.ok) { cache = r.templates; setList(r.templates); } else setErr(r.error ?? "Could not load templates");
    });
  }, []);

  useEffect(() => {
    if (!pick) return;
    setVals(Array.from({ length: pick.params }, (_, i) => guess(chat, i, pick.examples[i] ?? "", amount)));
  }, [pick, chat, amount]);

  const usable = useMemo(() => (list ?? []).filter((t) => !t.headerNeedsParam && !t.headerMedia), [list]);
  const shown = usable.filter((t) => !q || t.name.includes(q.toLowerCase()) || t.body.toLowerCase().includes(q.toLowerCase()));
  const preview = pick ? pick.body.replace(/\{\{(\d+)\}\}/g, (_, n) => vals[Number(n) - 1] || `{{${n}}}`) : "";

  const send = async () => {
    if (!pick) return;
    setBusy(true); setErr(null);
    const r = await waSend({
      action: "template", phone: chat.phone, template: pick.name, language: pick.language,
      store: chat.store_code ?? undefined, order_id: chat.order_id ?? undefined, order_name: chat.order_name ?? undefined,
      params: vals, preview: [pick.header, preview].filter(Boolean).join("\n"),
      buttons: pick.buttons.filter((b) => b.type === "QUICK_REPLY").map((b) => b.text),
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Not sent"); return; }
    onSent();
  };

  return (
    <div className="wa-fade fixed inset-0 z-[80] flex items-end justify-center bg-black/40 md:items-center" onClick={onClose}>
      <div className="wa-up wa-panel flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl shadow-2xl md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="wa-panel-2 flex items-center gap-3 px-4 py-3">
          <FileText size={18} className="wa-green" />
          <div className="flex-1 font-medium">{pick ? pick.name.replace(/_/g, " ") : "Send a template"}</div>
          <button type="button" onClick={pick ? () => setPick(null) : onClose} className="wa-press rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!pick ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="px-3 pt-3">
              <div className="wa-panel-2 flex items-center gap-2 rounded-lg px-3 py-1.5">
                <Search size={15} className="wa-sub" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates"
                  className="w-full bg-transparent py-1 text-[14px] outline-none placeholder:text-[var(--wa-sub)]" />
              </div>
            </div>
            <div className="wa-scroll min-h-0 flex-1 overflow-y-auto p-3">
              {!list && !err && <div className="flex justify-center py-10"><Loader2 className="animate-spin wa-sub" /></div>}
              {err && <div className="rounded-lg bg-[#ea0038]/10 p-3 text-[13px] text-[#ea0038]">{err}</div>}
              {list && shown.length === 0 && <div className="py-8 text-center text-[13px] wa-sub">No approved templates.</div>}
              <div className="flex flex-col gap-2">
                {shown.map((t, i) => (
                  <button key={t.name + t.language} type="button" onClick={() => setPick(t)} style={{ animationDelay: `${i * 25}ms` }}
                    className="wa-up wa-row rounded-xl border wa-line p-3 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium">{t.name.replace(/_/g, " ")}</span>
                      <span className="rounded bg-[#00a884]/12 px-1.5 text-[10.5px] font-medium uppercase text-[#008069] dark:text-[#06cf9c]">{t.category.toLowerCase()}</span>
                      <span className="ml-auto text-[11px] wa-sub">{t.language}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[13px] wa-sub">{t.body}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="wa-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {vals.map((v, i) => (
              <label key={i} className="block">
                <span className="mb-1 block text-[12px] wa-sub">{`{{${i + 1}}}`}{pick.examples[i] ? ` — e.g. ${pick.examples[i]}` : ""}</span>
                <input value={v} onChange={(e) => setVals((s) => s.map((x, j) => (j === i ? e.target.value : x)))}
                  className="w-full rounded-lg border wa-line bg-transparent px-3 py-2 text-[14px] outline-none focus:border-[#00a884]" />
              </label>
            ))}
            <div className="wa-wall rounded-xl p-3">
              <div className="wa-out wa-tail">
                <div className="wa-bubble ml-auto px-[9px] py-[7px]">
                  {pick.header && <div className="mb-1 font-semibold">{pick.header}</div>}
                  <div className="whitespace-pre-wrap text-[14px]">{preview}</div>
                  {pick.footer && <div className="mt-1 text-[12px] wa-sub">{pick.footer}</div>}
                </div>
                {pick.buttons.map((b) => (
                  <div key={b.text} className="wa-tplbtn ml-auto mt-[2px] max-w-[78%] rounded-[7.5px] py-2 text-center text-[14px]">{b.text}</div>
                ))}
              </div>
            </div>
            {pick.name === "order_confirmation" && !chat.order_id && (
              <div className="rounded-lg bg-[#f59e0b]/12 p-2.5 text-[12.5px] text-[#a16207] dark:text-[#fbbf24]">
                This chat has no order linked, so a Confirm / Cancel tap will not tag Shopify.
              </div>
            )}
            {err && <div className="rounded-lg bg-[#ea0038]/10 p-2.5 text-[13px] text-[#ea0038]">{err}</div>}
            <button type="button" disabled={busy || vals.some((x) => !x.trim())} onClick={send}
              className="wa-press wa-bg-green flex items-center justify-center gap-2 rounded-full py-2.5 text-[15px] font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Send size={16} />} Send template
            </button>
            <p className="text-center text-[11.5px] wa-sub">A template is a paid business message (about Rs 4).</p>
          </div>
        )}
      </div>
    </div>
  );
}
