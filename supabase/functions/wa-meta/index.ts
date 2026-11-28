// Supabase Edge Function: wa-meta
//
// WhatsApp → Hub + Shopify. Meta calls this for every message a customer
// sends and every tick (sent / delivered / read / failed) on ours.
//
//   1. Every message is stored in online_wa_messages — the Hub inbox reads it.
//      Pictures, voice notes and documents are copied into the private
//      wa-media bucket (Meta's own media links expire after a few minutes).
//   2. Ticks update the status of the message they belong to.
//   3. Order answers go back to Shopify:
//        tap Confirm      → tag "✅ WA Confirmed"
//        tap Cancel       → tag "❌ WA Cancelled"
//        "haan" / "nahi"  → same, typed
//        anything else    → tag "💬 WA Reply" + text appended to the order note
//      Shopify cannot colour a tag, so the emoji is the colour.
//
// ONE NUMBER FOR ALL STORES
//   LM and TS can send from the same number, so the number cannot say which
//   store an answer belongs to. The store travels in the button payload
//   (confirm:TS:123456); typed text uses the last confirmation sent to that
//   customer.
//
// DEPLOY WITH VERIFY JWT OFF. Security is X-Hub-Signature-256 vs META_APP_SECRET.
//
// SECRETS
//   META_APP_SECRET, META_VERIFY_TOKEN, META_TOKEN (or META_WA_TOKEN)
//   META_PHONE_ID_{LM|TS|TRZ}       any of these marks a number as ours
//   SHOPIFY_{LM|TS|TRZ}_DOMAIN + _TOKEN, or + _CLIENT_ID / _SECRET

import { createClient } from "npm:@supabase/supabase-js@2";

const ok = (b = "ok") => new Response(b, { status: 200 });
const bad = (m: string, c = 401) => new Response(m, { status: c });
const env = (k: string) =>
  (Deno.env.get(k) ?? Deno.env.get(k.toLowerCase()) ?? Deno.env.get(k.toUpperCase()) ?? "").trim();

const STORES = ["LM", "TS", "TRZ"];
const API = env("SHOPIFY_API_VERSION") || "2026-01";
const GRAPH = "https://graph.facebook.com/v21.0";
const META_TOKEN = () => env("META_TOKEN") || env("META_WA_TOKEN");
const TAG = { confirm: "✅ WA Confirmed", cancel: "❌ WA Cancelled", reply: "💬 WA Reply" };

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function verifySig(raw: string, header: string): Promise<boolean> {
  const secret = env("META_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const mine = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const theirs = header.slice(7);
  if (mine.length !== theirs.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ theirs.charCodeAt(i);
  return diff === 0;
}

const storeFromPhoneId = (id: string) =>
  STORES.find((st) => env(`META_PHONE_ID_${st}`) === id) ?? null;

/* ── Shopify credentials, the same way shopify-sync / shopify-writeback get
   them: a fixed token if there is one, otherwise client credentials. TS has
   no fixed token, so a token-only lookup would fail every TS answer. ───── */
const credCache = new Map<string, { domain: string; token: string } | null>();
async function storeCreds(code: string) {
  const s = code.toUpperCase();
  if (credCache.has(s)) return credCache.get(s) ?? null;
  let out: { domain: string; token: string } | null = null;
  const domain = env(`SHOPIFY_${s}_DOMAIN`).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain) {
    const fixed = env(`SHOPIFY_${s}_TOKEN`);
    if (fixed) out = { domain, token: fixed };
    else {
      const cid = env(`SHOPIFY_${s}_CLIENT_ID`);
      const sec = env(`SHOPIFY_${s}_SECRET`);
      if (cid && sec) {
        try {
          const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_id: cid, client_secret: sec, grant_type: "client_credentials" }),
          });
          if (r.ok) {
            const { access_token } = await r.json();
            if (access_token) out = { domain, token: access_token };
          }
        } catch { /* reported below as missing credentials */ }
      }
    }
  }
  credCache.set(s, out);
  return out;
}

async function shopify(store: string, query: string, variables: Record<string, unknown>) {
  const c = await storeCreds(store);
  if (!c) throw new Error(`no Shopify credentials for ${store}`);
  const res = await fetch(`https://${c.domain}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": c.token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 300));
  return json.data;
}

const gid = (orderId: string) =>
  orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

async function tagOrder(store: string, orderId: string, tag: string) {
  const d = await shopify(store,
    `mutation addTags($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } } }`,
    { id: gid(orderId), tags: [tag] });
  const errs = d?.tagsAdd?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: { message: string }) => e.message).join("; "));
}

async function appendNote(store: string, orderId: string, line: string) {
  const cur = await shopify(store,
    `query getNote($id: ID!) { order(id: $id) { id note } }`, { id: gid(orderId) });
  const existing = (cur?.order?.note ?? "").trim();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const note = (existing ? existing + "\n" : "") + `[WhatsApp ${stamp}] ${line}`;
  await shopify(store,
    `mutation setNote($input: OrderInput!) {
       orderUpdate(input: $input) { order { id } userErrors { message } } }`,
    { input: { id: gid(orderId), note: note.slice(0, 5000) } });
}

/** confirm:TS:123  (current)  or  confirm:123  (messages sent before the change) */
function parsePayload(payload: string) {
  const parts = payload.split(":");
  const verb = parts[0];
  if (verb !== "confirm" && verb !== "cancel") return null;
  if (parts.length >= 3 && STORES.includes(parts[1])) {
    return { decision: verb as "confirm" | "cancel", store: parts[1], orderId: parts.slice(2).join(":") };
  }
  return { decision: verb as "confirm" | "cancel", store: null, orderId: parts[1] ?? null };
}

/* ── media: Meta gives an id; the file behind it is fetched with the token and
   kept in our own bucket so the inbox can show it next week too. ─────── */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "audio/aac": "aac", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};
async function saveMedia(phone: string, wamid: string, mediaId: string, mime: string, name?: string) {
  const token = META_TOKEN();
  if (!token || !mediaId) return null;
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  if (!meta?.url) return null;
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = (mime || meta.mime_type || "application/octet-stream").split(";")[0].trim();
  const ext = (name?.split(".").pop() ?? EXT[type] ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `${phone}/${wamid.replace(/[^A-Za-z0-9_-]/g, "").slice(-40)}.${ext}`;
  const up = await db.storage.from("wa-media").upload(path, bytes, { contentType: type, upsert: true });
  return up.error ? null : { path, mime: type };
}

/** What a message says, in one line, plus the fields the inbox needs. */
function describe(m: Record<string, any>) {
  const t = String(m.type ?? "unsupported");
  switch (t) {
    case "text": return { kind: "text", body: String(m.text?.body ?? "") };
    case "button": return { kind: "button", body: String(m.button?.text ?? m.button?.payload ?? "") };
    case "interactive": {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? {};
      return { kind: "button", body: String(r.title ?? r.id ?? "") };
    }
    case "image": return { kind: "image", body: String(m.image?.caption ?? ""), media: m.image };
    case "sticker": return { kind: "sticker", body: "", media: m.sticker };
    case "audio": return { kind: "audio", body: "", media: m.audio };
    case "video": return { kind: "video", body: String(m.video?.caption ?? ""), media: m.video };
    case "document": return { kind: "document", body: String(m.document?.caption ?? ""), media: m.document, name: m.document?.filename };
    case "location": {
      const l = m.location ?? {};
      return { kind: "location", body: [l.name, l.address, `${l.latitude},${l.longitude}`].filter(Boolean).join(" · ") };
    }
    case "reaction": return { kind: "reaction", body: String(m.reaction?.emoji ?? "") };
    case "contacts": return { kind: "text", body: "👤 " + (m.contacts?.[0]?.name?.formatted_name ?? "Contact") };
    default: return { kind: "unsupported", body: `[${t}]` };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && token && token === env("META_VERIFY_TOKEN")) {
      return new Response(challenge, { status: 200 });
    }
    return bad("verify failed", 403);
  }
  if (req.method !== "POST") return bad("POST only", 405);

  const raw = await req.text();
  if (!(await verifySig(raw, req.headers.get("x-hub-signature-256") ?? ""))) {
    console.error("bad Meta signature");
    return bad("bad signature");
  }

  let p: Record<string, any>;
  try { p = JSON.parse(raw); } catch { return bad("bad json", 400); }

  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const numberStore = storeFromPhoneId(String(v.metadata?.phone_number_id ?? ""));
      if (!numberStore) continue;

      /* ── ticks ─────────────────────────────────────────────────────────── */
      for (const s of v.statuses ?? []) {
        const wid = String(s.id ?? "");
        const st = String(s.status ?? "");
        if (!wid || !st) continue;
        const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
        const cur = await db.from("online_wa_messages").select("id, status").eq("wa_id", wid).maybeSingle();
        if (cur.data && (rank[st] ?? 0) > (rank[cur.data.status ?? ""] ?? 0)) {
          await db.from("online_wa_messages").update({
            status: st,
            error: st === "failed" ? String(s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? "delivery failed") : null,
          }).eq("id", cur.data.id);
        }
        if (st === "failed") {
          const sent = await db.from("online_wa_events").select("store_code").eq("wa_message_id", wid).limit(1).maybeSingle();
          await db.from("online_wa_events").insert({
            store_code: sent.data?.store_code ?? numberStore, kind: "error",
            phone: String(s.recipient_id ?? ""), wa_message_id: wid, status: "failed",
            error: String(s.errors?.[0]?.title ?? "delivery failed"), dedupe_key: `status:${wid}:failed`,
          });
        }
      }

      /* ── messages ──────────────────────────────────────────────────────── */
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c.wa_id && c.profile?.name) names.set(String(c.wa_id), String(c.profile.name));

      for (const m of v.messages ?? []) {
        const from = String(m.from ?? "");
        const wamid = String(m.id ?? "");
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
        const d = describe(m);

        let orderId: string | null = null;
        let store: string | null = null;
        let decision: "confirm" | "cancel" | null = null;

        if (m.type === "button") {
          const parsed = parsePayload(String(m.button?.payload ?? ""));
          if (parsed) { decision = parsed.decision; orderId = parsed.orderId; store = parsed.store; }
        } else if (m.type === "text") {
          const t = d.body.trim().toLowerCase();
          if (/^(haan|han|ji|ji han|yes|y|ok|okay|confirm|theek|thik|sahi)\b/.test(t)) decision = "confirm";
          else if (/^(nahi|nai|no|n|cancel|nahin)\b/.test(t)) decision = "cancel";
        }

        if (!orderId || !store) {
          let q = db.from("online_wa_events")
            .select("shopify_order_id, store_code, order_name").eq("phone", from).eq("kind", "confirm_sent")
            .not("shopify_order_id", "is", null);
          if (orderId) q = q.eq("shopify_order_id", orderId);
          const prior = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
          orderId = orderId ?? prior.data?.shopify_order_id ?? null;
          store = store ?? prior.data?.store_code ?? null;
        }
        store = store ?? numberStore;

        let orderName: string | null = null;
        if (orderId) {
          const o = await db.from("online_wa_events").select("order_name")
            .eq("shopify_order_id", orderId).not("order_name", "is", null).limit(1).maybeSingle();
          orderName = o.data?.order_name ?? null;
        }

        // 1. inbox
        let media: { path: string; mime: string } | null = null;
        if (d.media?.id) {
          try { media = await saveMedia(from, wamid, String(d.media.id), String(d.media.mime_type ?? ""), d.name); }
          catch (e) { console.error("media", (e as Error).message); }
        }
        if (d.kind === "reaction") {
          // A reaction is shown on the message it reacts to, not as its own bubble.
          const target = String(m.reaction?.message_id ?? "");
          if (target) {
            await db.from("online_wa_messages").insert({
              phone: from, store_code: store, dir: "in", kind: "reaction", body: d.body,
              reply_to: target, wa_id: wamid, status: "received", at,
            });
          }
        } else {
          await db.from("online_wa_messages").insert({
            phone: from, store_code: store, dir: "in", kind: d.kind, body: d.body || null,
            media_path: media?.path ?? null, media_mime: media?.mime ?? (d.media?.mime_type ?? null),
            media_name: d.name ?? null, reply_to: m.context?.id ?? null,
            wa_id: wamid, status: "received", order_id: orderId, order_name: orderName, at,
          });
        }
        const pname = names.get(from);
        if (pname) await db.from("online_wa_chats").update({ name: pname }).eq("phone", from);

        // 2. Shopify
        if (d.kind === "reaction") continue;
        const log = {
          store_code: store, kind: "reply" as const, phone: from,
          wa_message_id: wamid, shopify_order_id: orderId, body: (d.body || `[${d.kind}]`).slice(0, 1000),
          dedupe_key: `in:${wamid}`,
          status: decision ?? "text",
        };

        if (!orderId) {
          await db.from("online_wa_events").insert({ ...log, error: "no order matched this number" });
          continue;
        }

        try {
          if (decision === "confirm")      await tagOrder(store, orderId, TAG.confirm);
          else if (decision === "cancel")  await tagOrder(store, orderId, TAG.cancel);
          else {
            await tagOrder(store, orderId, TAG.reply);
            await appendNote(store, orderId, d.body || `[${d.kind}]`);
          }
          await db.from("online_wa_events").insert(log);
        } catch (e) {
          await db.from("online_wa_events")
            .insert({ ...log, error: String((e as Error).message ?? e).slice(0, 500) });
          console.error(`${store} ${orderId}: ${(e as Error).message}`);
        }
      }
    }
  }

  return ok();
});
