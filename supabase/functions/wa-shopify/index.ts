// Supabase Edge Function: wa-shopify
//
// Shopify → WhatsApp. One sender number (0303-933-3507) for every store; the
// store name travels inside the message so the customer knows which brand,
// and inside the button payload (confirm:TS:123) so wa-meta tags the right store.
//
//   orders/create        → order_confirmation (name, order, store, total) + Confirm/Cancel
//   fulfillments/create  → order_shipped (name, store, order, courier, tracking)
//
// Every message actually sent is also written to online_wa_messages, so the
// Hub WhatsApp inbox shows it in the customer's chat.
//
// DEPLOY WITH VERIFY JWT OFF. Security is the Shopify HMAC signature.
//
// SECRETS
//   SHOPIFY_{LM|TS|TRZ}_WEBHOOK_SECRET   (or _SECRET)
//   META_TOKEN (fallback META_WA_TOKEN)  permanent system-user token
//   META_PHONE_ID_{LM|TS|TRZ}            sender per store (fallback META_PHONE_ID_LM)
//   WA_DRY_RUN=1                         log what would be sent, send nothing

import { createClient } from "npm:@supabase/supabase-js@2";

const ok = (b = "ok") => new Response(b, { status: 200 });
const bad = (m: string, c = 401) => new Response(m, { status: c });
const env = (k: string) =>
  (Deno.env.get(k) ?? Deno.env.get(k.toLowerCase()) ?? Deno.env.get(k.toUpperCase()) ?? "").trim();

const STORES = ["LM", "TS", "TRZ"];
const STORE_NAME: Record<string, string> = {
  LM: "Little Minors",
  TS: "TopShop PK",
  TRZ: "Trenzee Cosmetics",
};
const TPL_CONFIRM = "order_confirmation";
const TPL_SHIPPED = "order_shipped";
const GRAPH = "https://graph.facebook.com/v21.0";
const DRY = env("WA_DRY_RUN") === "1";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

/* The text the customer actually reads, so the Hub inbox shows the same
   bubble. Must match the approved template bodies word for word. */
const RENDER: Record<string, (p: string[]) => string> = {
  [TPL_CONFIRM]: (p) => `Assalam o Alaikum ${p[0]}! Aap ka order ${p[1]} ${p[2]} par receive ho gaya hai. Total: Rs ${p[3]} (Cash on Delivery). Please neeche button se confirm karein taa ke hum order dispatch kar sakein.`,
  [TPL_SHIPPED]: (p) => `Assalam o Alaikum ${p[0]}, aap ka ${p[1]} order ${p[2]} dispatch ho gaya hai. Courier: ${p[3]}, Tracking: ${p[4]}. Delivery 2-4 working days mein ho jayegi.`,
};
const BUTTONS: Record<string, string[]> = { [TPL_CONFIRM]: ["Confirm Order", "Cancel Order"] };

async function toInbox(o: { store: string; to: string; tpl: string; params: string[]; waId: string | null; orderId: string; orderName: string; name?: string }) {
  if (!o.waId) return;
  await db.from("online_wa_messages").insert({
    phone: o.to, store_code: o.store, dir: "out", kind: "template", template: o.tpl,
    body: RENDER[o.tpl]?.(o.params) ?? o.params.join(" | "), buttons: BUTTONS[o.tpl] ?? null,
    wa_id: o.waId, status: "sent", order_id: o.orderId || null, order_name: o.orderName || null,
    sent_by_name: "Bot",
  });
  if (o.name && o.name !== "ji") {
    await db.from("online_wa_chats").update({ name: o.name }).eq("phone", o.to).is("name", null);
  }
}

async function verify(raw: string, header: string, secret: string) {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const mine = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (mine.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

async function storeFromSignature(raw: string, header: string): Promise<string | null> {
  for (const st of STORES) {
    const secret = env(`SHOPIFY_${st}_WEBHOOK_SECRET`) || env(`SHOPIFY_${st}_SECRET`);
    if (await verify(raw, header, secret)) return st;
  }
  return null;
}

function toE164(input: string | null | undefined): string | null {
  let d = (input ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0092")) d = d.slice(2);
  if (d.startsWith("092"))  d = d.slice(1);
  if (d.startsWith("0"))    d = "92" + d.slice(1);
  if (d.startsWith("3") && d.length === 10) d = "92" + d;
  if (!d.startsWith("92")) return null;
  return d.length === 12 ? d : null;
}

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-PK", { maximumFractionDigits: 0 }) : "0";
};

async function sendTemplate(opts: {
  store: string; to: string; name: string;
  bodyParams: string[];
  buttonPayloads?: string[];
}) {
  const components: Record<string, unknown>[] = [{
    type: "body",
    parameters: opts.bodyParams.map((t) => ({ type: "text", text: t })),
  }];
  (opts.buttonPayloads ?? []).forEach((payload, i) => {
    components.push({
      type: "button", sub_type: "quick_reply", index: String(i),
      parameters: [{ type: "payload", payload }],
    });
  });

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.to,
    type: "template",
    template: { name: opts.name, language: { code: "en" }, components },
  };

  if (DRY) return { dry: true, id: `dry_${Date.now()}`, body };

  const phoneId = env(`META_PHONE_ID_${opts.store}`) || env("META_PHONE_ID_LM");
  const token = env("META_TOKEN") || env("META_WA_TOKEN");
  if (!phoneId || !token) throw new Error(`no Meta sender configured for ${opts.store}`);

  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Meta ${res.status}`);
  return { dry: false, id: json?.messages?.[0]?.id ?? null, body };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return bad("POST only", 405);

  const raw = await req.text();
  const sigHeader = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const topic = (req.headers.get("x-shopify-topic") ?? "").toLowerCase();
  const delivery = req.headers.get("x-shopify-webhook-id") ?? "";
  const domain = req.headers.get("x-shopify-shop-domain") ?? "";

  const store = await storeFromSignature(raw, sigHeader);
  if (!store) {
    console.error(`bad signature from ${domain} (${topic}) — no store secret matched`);
    return bad("bad signature");
  }

  let p: Record<string, any>;
  try { p = JSON.parse(raw); } catch { return bad("bad json", 400); }

  if (topic !== "orders/create" && topic !== "fulfillments/create") return ok("ignored");

  const dedupe = `${topic}:${delivery || p.id || p.admin_graphql_api_id}`;
  const kind = topic === "orders/create" ? "confirm_sent" : "dispatch_sent";

  const orderId = String(topic === "orders/create" ? p.id : p.order_id ?? "");
  const orderName = String(p.name ?? p.order_name ?? "");
  const storeName = STORE_NAME[store] ?? store;

  const claim = await db.from("online_wa_events").insert({
    store_code: store, kind, shopify_order_id: orderId || null,
    order_name: orderName || null, dedupe_key: dedupe, status: "claimed",
  }).select("id").single();

  if (claim.error) {
    if (claim.error.code === "23505") return ok("duplicate");
    console.error("claim failed", claim.error.message);
    return ok("logged");
  }
  const rowId = claim.data.id;

  const fail = async (msg: string) => {
    await db.from("online_wa_events").update({ status: "failed", error: msg }).eq("id", rowId);
    console.error(`${store} ${topic} ${orderName}: ${msg}`);
    return ok("logged");
  };

  try {
    if (topic === "orders/create") {
      const to = toE164(p.phone ?? p.customer?.phone ?? p.shipping_address?.phone ?? p.billing_address?.phone);
      if (!to) return await fail("no usable phone number");

      const name = String(p.customer?.first_name ?? p.shipping_address?.first_name ?? "").trim() || "ji";
      const params = [
        name,
        orderName,
        storeName,
        money(p.current_total_price ?? p.total_price),
      ];

      const sent = await sendTemplate({
        store, to, name: TPL_CONFIRM, bodyParams: params,
        buttonPayloads: [`confirm:${store}:${orderId}`, `cancel:${store}:${orderId}`],
      });

      await db.from("online_wa_events").update({
        phone: to, wa_message_id: sent.id, status: sent.dry ? "dry_run" : "sent",
        body: params.join(" | "), payload: sent.body,
      }).eq("id", rowId);
      if (!sent.dry) {
        const full = [p.customer?.first_name, p.customer?.last_name].filter(Boolean).join(" ").trim();
        await toInbox({ store, to, tpl: TPL_CONFIRM, params, waId: sent.id, orderId, orderName, name: full || name });
      }

      return ok("confirm sent");
    }

    const to = toE164(p.destination?.phone ?? p.phone);
    if (!to) return await fail("no usable phone number on fulfillment");

    const prior = await db.from("online_wa_events")
      .select("order_name, body").eq("shopify_order_id", orderId)
      .eq("kind", "confirm_sent").order("created_at", { ascending: false }).limit(1).maybeSingle();

    const firstName = (prior.data?.body ?? "").split(" | ")[0] || "ji";
    const oName = prior.data?.order_name ?? (orderName || `#${orderId}`);
    const tracking = String(p.tracking_number ?? p.tracking_numbers?.[0] ?? "").trim();
    if (!tracking) return await fail("fulfillment carried no tracking number");

    const params = [
      firstName,
      storeName,
      oName,
      String(p.tracking_company ?? "Courier"),
      tracking,
    ];

    const sent = await sendTemplate({ store, to, name: TPL_SHIPPED, bodyParams: params });

    await db.from("online_wa_events").update({
      phone: to, wa_message_id: sent.id, status: sent.dry ? "dry_run" : "sent",
      order_name: oName, body: params.join(" | "), payload: sent.body,
    }).eq("id", rowId);
    if (!sent.dry) await toInbox({ store, to, tpl: TPL_SHIPPED, params, waId: sent.id, orderId, orderName: oName });

    return ok("dispatch sent");
  } catch (e) {
    return await fail(String((e as Error).message ?? e));
  }
});
