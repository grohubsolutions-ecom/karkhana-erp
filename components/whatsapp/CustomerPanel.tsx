"use client";

/* The customer behind a chat: every order on that number (LM / TS / TRZ),
   newest first, with its parcel and courier status — so "where is my parcel"
   is answered without leaving WhatsApp. */

import { useEffect, useState } from "react";
import { X, Package, Truck, Loader2, Copy, Phone } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { type Chat, Avatar, STORE, displayName, prettyPhone } from "./waShared";

export type CustOrder = {
  order_number: string; store_code: string; customer_name: string | null; city: string | null; address: string | null;
  amount: number | null; product: string | null; created_at: string; fulfillment_status: string | null;
  cancelled: boolean; archived: boolean; tags: string[] | null;
  tracking_id: string | null; courier: string | null; delivery_status: string | null;
};

const rs = (v: number | null) => (v == null ? "—" : "Rs " + Math.round(v).toLocaleString("en-PK"));

function state(o: CustOrder) {
  if (o.cancelled) return { t: "Cancelled", c: "bg-[#ea0038]/12 text-[#c2002e] dark:text-[#ff6b8b]" };
  if (o.delivery_status) {
    const d = o.delivery_status.toLowerCase();
    const tone = d.includes("deliver") && !d.includes("un") ? "bg-[#00a884]/12 text-[#008069] dark:text-[#06cf9c]"
      : d.includes("return") ? "bg-[#ea0038]/12 text-[#c2002e] dark:text-[#ff6b8b]" : "bg-[#53bdeb]/15 text-[#027eb5] dark:text-[#53bdeb]";
    return { t: o.delivery_status, c: tone };
  }
  if (o.archived) return { t: "Archived", c: "bg-black/5 wa-sub dark:bg-white/10" };
  if (o.fulfillment_status?.toLowerCase() === "fulfilled") return { t: "Fulfilled", c: "bg-[#53bdeb]/15 text-[#027eb5] dark:text-[#53bdeb]" };
  return { t: "Unfulfilled", c: "bg-[#f59e0b]/15 text-[#a16207] dark:text-[#fbbf24]" };
}

export default function CustomerPanel({ chat, onClose, onOrders }: {
  chat: Chat; onClose: () => void; onOrders?: (o: CustOrder[]) => void;
}) {
  const [orders, setOrders] = useState<CustOrder[] | null>(null);

  useEffect(() => {
    let live = true;
    setOrders(null);
    supabase?.rpc("hub_wa_customer", { p_phone: chat.phone }).then(({ data }) => {
      if (!live) return;
      const list = ((data as { orders?: CustOrder[] } | null)?.orders ?? []) as CustOrder[];
      setOrders(list);
      onOrders?.(list);
    });
    return () => { live = false; };
  }, [chat.phone, onOrders]);

  const delivered = orders?.filter((o) => (o.delivery_status ?? "").toLowerCase().startsWith("deliver")).length ?? 0;
  const returned = orders?.filter((o) => (o.delivery_status ?? "").toLowerCase().includes("return")).length ?? 0;

  return (
    <aside className="wa-slide wa-panel flex h-full w-full flex-col border-l wa-line">
      <div className="wa-panel-2 flex h-[59px] shrink-0 items-center gap-4 px-4">
        <button type="button" onClick={onClose} className="wa-press rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Close">
          <X size={20} />
        </button>
        <span className="text-[16px]">Customer info</span>
      </div>
      <div className="wa-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-1 px-6 py-6">
          <Avatar chat={chat} size={120} />
          <div className="mt-3 text-center text-[20px]">{displayName(chat)}</div>
          <div className="flex items-center gap-2 text-[15px] wa-sub">
            {prettyPhone(chat.phone)}
            <button type="button" onClick={() => navigator.clipboard?.writeText("0" + chat.phone.slice(2))} className="wa-press rounded p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Copy number"><Copy size={13} /></button>
            <a href={`tel:+${chat.phone}`} className="wa-press rounded p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Call"><Phone size={13} /></a>
          </div>
          {orders && orders.length > 0 && (
            <div className="mt-3 grid w-full grid-cols-3 gap-2 text-center">
              <div className="wa-panel-2 rounded-lg py-2"><div className="text-[17px] font-semibold">{orders.length}</div><div className="text-[11px] wa-sub">Orders</div></div>
              <div className="wa-panel-2 rounded-lg py-2"><div className="text-[17px] font-semibold text-[#008069] dark:text-[#06cf9c]">{delivered}</div><div className="text-[11px] wa-sub">Delivered</div></div>
              <div className="wa-panel-2 rounded-lg py-2"><div className="text-[17px] font-semibold text-[#c2002e] dark:text-[#ff6b8b]">{returned}</div><div className="text-[11px] wa-sub">Returned</div></div>
            </div>
          )}
        </div>
        <div className="border-t-[10px] border-[var(--wa-panel-2)] px-4 py-3">
          <div className="mb-2 text-[14px] wa-sub">Orders on this number</div>
          {!orders && <div className="flex justify-center py-6"><Loader2 className="animate-spin wa-sub" /></div>}
          {orders && orders.length === 0 && <div className="py-4 text-[13px] wa-sub">No Shopify order found for this number.</div>}
          <div className="flex flex-col gap-2">
            {orders?.map((o, i) => {
              const s = state(o);
              return (
                <div key={o.store_code + o.order_number} className="wa-up rounded-xl border wa-line p-3" style={{ animationDelay: `${i * 30}ms` }}>
                  <div className="flex items-center gap-2">
                    <Package size={15} className="wa-sub" />
                    <span className="font-medium">{o.order_number}</span>
                    <span className={`rounded px-1.5 text-[10.5px] font-semibold ${STORE[o.store_code]?.tone ?? ""}`}>{STORE[o.store_code]?.short ?? o.store_code}</span>
                    <span className="ml-auto text-[13px] font-medium">{rs(o.amount)}</span>
                  </div>
                  {o.product && <div className="mt-1 line-clamp-2 text-[12.5px] wa-sub">{o.product}</div>}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className={`rounded-full px-2 py-0.5 font-medium ${s.c}`}>{s.t}</span>
                    {o.courier && <span className="flex items-center gap-1 wa-sub"><Truck size={12} />{o.courier}{o.tracking_id ? ` · ${o.tracking_id}` : ""}</span>}
                    <span className="ml-auto wa-sub">{new Date(o.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
                  </div>
                  {o.tags?.some((t) => /\bWA\b/.test(t)) && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {o.tags.filter((t) => /\bWA\b/.test(t)).map((t) => (
                        <span key={t} className="rounded bg-[#00a884]/12 px-1.5 text-[10.5px] font-medium text-[#008069] dark:text-[#06cf9c]">{t}</span>
                      ))}
                    </div>
                  )}
                  {o.address && <div className="mt-1.5 text-[11.5px] wa-sub">{[o.address, o.city].filter(Boolean).join(", ")}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
