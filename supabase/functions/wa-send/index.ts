// Supabase Edge Function: wa-send
//
// The Hub inbox's only way out to WhatsApp. The browser never holds the Meta
// token: it calls this with the signed-in person's own session, this checks
// that person holds hub.whatsapp.reply (hub.whatsapp.view for read-only
// actions), then talks to Meta with the token kept in secrets.
//
// ACTIONS  (POST JSON { action, ... })
//   templates                         approved templates with their body text
//   text      { phone, text, reply_to? }
//   template  { phone, template, language, params[], preview }
//   media     { phone, base64, mime, filename, caption? }   image / video / audio / document
//   read      { phone }               blue ticks on the customer's side
//
// WhatsApp only lets a business write freely for 24 hours after the
// customer's last message. Outside that window only a template can open the
// conversation; text and media are refused here with window_closed so the
// inbox can offer a template instead.
//
// DEPLOY WITH VERIFY JWT ON.
//
// SECRETS  META_TOKEN (or META_WA_TOKEN), META_PHONE_ID_{LM|TS|TRZ}, META_WABA_ID (optional)

import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const GRAPH = "https://graph.facebook.com/v21.0";
const WABA = () => env("META_WABA_ID") || "1456865803269943";
const TOKEN = () => env("META_TOKEN") || env("META_WA_TOKEN");
const WINDOW_MS = 24 * 3600 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const phoneIdFor = (store: string | null | undefined) =>
  (store && env(`META_PHONE_ID_${store.toUpperCase()}`)) || env("META_PHONE_ID_LM");

const cleanPhone = (p: unknown) => {
  let d = String(p ?? "").replace(/\D/g, "");
  if (d.startsWith("0092")) d = d.slice(2);
  if (d.startsWith("0")) d = "92" + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
};

async function meta(path: string, body: unknown) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.error_data?.details ?? j?.error?.message ?? `Meta ${r.status}`);
  return j;
}

function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/^data:[^,]+,/, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const mediaKind = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  // ── who is asking ──────────────────────────────────────────────────────
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ ok: false, error: "sign in first" }, 401);
  const userDb = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: who } = await userDb.auth.getUser();
  if (!who?.user) return json({ ok: false, error: "sign in first" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const need = action === "templates" || action === "read" ? "hub.whatsapp.view" : "hub.whatsapp.reply";
  const { data: allowed } = await userDb.rpc("has_permission", { p_permission_code: need });
  if (allowed !== true) return json({ ok: false, error: "You don't have permission to do this on WhatsApp." }, 403);
  if (!TOKEN()) return json({ ok: false, error: "WhatsApp token is not set (META_TOKEN)." }, 500);

  try {
    // ── templates ────────────────────────────────────────────────────────
    if (action === "templates") {
      const r = await fetch(`${GRAPH}/${WABA()}/message_templates?fields=name,status,category,language,components&limit=100`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? "could not load templates");
      const list = (j.data ?? []).filter((t: any) => t.status === "APPROVED").map((t: any) => {
        const bodyC = (t.components ?? []).find((c: any) => c.type === "BODY");
        const headC = (t.components ?? []).find((c: any) => c.type === "HEADER");
        const footC = (t.components ?? []).find((c: any) => c.type === "FOOTER");
        const btnC = (t.components ?? []).find((c: any) => c.type === "BUTTONS");
        const text = String(bodyC?.text ?? "");
        const n = new Set((text.match(/\{\{(\d+)\}\}/g) ?? [])).size;
        return {
          name: t.name, language: t.language, category: t.category, body: text, params: n,
          header: headC?.format === "TEXT" ? headC.text : null, footer: footC?.text ?? null,
          headerNeedsParam: headC?.format === "TEXT" && /\{\{\d+\}\}/.test(headC.text ?? ""),
          headerMedia: headC && headC.format !== "TEXT" ? headC.format : null,
          buttons: (btnC?.buttons ?? []).map((b: any) => ({ type: b.type, text: b.text })),
          examples: bodyC?.example?.body_text?.[0] ?? [],
        };
      });
      return json({ ok: true, templates: list });
    }

    const phone = cleanPhone(body.phone);
    if (!phone) return json({ ok: false, error: "bad phone number" }, 400);

    const { data: chat } = await admin.from("online_wa_chats").select("*").eq("phone", phone).maybeSingle();
    const store = (body.store as string) || chat?.store_code || "LM";
    /* A brand-new chat has no row yet; the inbox passes the order it was
       started from, so the template's buttons can still tag Shopify. */
    const orderId: string | null = chat?.order_id ?? (body.order_id ? String(body.order_id) : null);
    const orderName: string | null = chat?.order_name ?? (body.order_name ? String(body.order_name) : null);
    const phoneId = phoneIdFor(store);
    if (!phoneId) return json({ ok: false, error: `no WhatsApp number set for ${store}` }, 500);
    const windowOpen = !!chat?.last_in_at && Date.now() - new Date(chat.last_in_at).getTime() < WINDOW_MS;

    const { data: me } = await admin.from("app_users").select("full_name, email").eq("id", who.user.id).maybeSingle();
    const myName = me?.full_name || me?.email || who.user.email || "Staff";

    const record = async (row: Record<string, unknown>) => {
      const { data, error } = await admin.from("online_wa_messages").insert({
        phone, store_code: store, dir: "out", status: "sent", sent_by: who.user.id, sent_by_name: myName,
        order_id: orderId, order_name: orderName, ...row,
      }).select("*").single();
      if (error) throw new Error(error.message);
      return data;
    };

    // ── read receipts ────────────────────────────────────────────────────
    if (action === "read") {
      const { data: last } = await admin.from("online_wa_messages").select("wa_id")
        .eq("phone", phone).eq("dir", "in").not("wa_id", "is", null)
        .order("at", { ascending: false }).limit(1).maybeSingle();
      await admin.from("online_wa_chats").update({ unread: 0 }).eq("phone", phone);
      if (last?.wa_id && windowOpen) {
        await meta(`${phoneId}/messages`, { messaging_product: "whatsapp", status: "read", message_id: last.wa_id }).catch(() => null);
      }
      return json({ ok: true });
    }

    // ── free text ────────────────────────────────────────────────────────
    if (action === "text") {
      const text = String(body.text ?? "").trim();
      if (!text) return json({ ok: false, error: "empty message" }, 400);
      if (text.length > 4096) return json({ ok: false, error: "message is too long (4096 max)" }, 400);
      if (!windowOpen) return json({ ok: false, error: "window_closed" }, 409);
      const payload: Record<string, unknown> = {
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text",
        text: { body: text, preview_url: /https?:\/\//.test(text) },
      };
      if (body.reply_to) payload.context = { message_id: String(body.reply_to) };
      const r = await meta(`${phoneId}/messages`, payload);
      const row = await record({ kind: "text", body: text, wa_id: r?.messages?.[0]?.id ?? null, reply_to: body.reply_to ?? null });
      return json({ ok: true, message: row });
    }

    // ── template ─────────────────────────────────────────────────────────
    if (action === "template") {
      const name = String(body.template ?? "");
      const lang = String(body.language ?? "en");
      const params: string[] = Array.isArray(body.params) ? body.params.map((x: unknown) => String(x ?? "").trim()) : [];
      if (!name) return json({ ok: false, error: "choose a template" }, 400);
      if (params.some((x) => !x)) return json({ ok: false, error: "fill every {{ }} field" }, 400);
      const components: unknown[] = [];
      if (params.length) components.push({ type: "body", parameters: params.map((t) => ({ type: "text", text: t })) });
      /* Confirm / Cancel on the order template must carry the order, or a tap
         from the inbox-sent copy could not be tied back to Shopify. */
      const buttons: string[] = Array.isArray(body.buttons) ? body.buttons.map(String) : [];
      if (name === "order_confirmation" && orderId) {
        ["confirm", "cancel"].forEach((verb, i) => components.push({
          type: "button", sub_type: "quick_reply", index: String(i),
          parameters: [{ type: "payload", payload: `${verb}:${store}:${orderId}` }],
        }));
      }
      const template: Record<string, unknown> = { name, language: { code: lang } };
      if (components.length) template.components = components;
      const r = await meta(`${phoneId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template });
      const row = await record({
        kind: "template", template: name, body: String(body.preview ?? "").slice(0, 4096) || name,
        buttons: buttons.length ? buttons : null, wa_id: r?.messages?.[0]?.id ?? null,
      });
      return json({ ok: true, message: row });
    }

    // ── picture / file / voice ───────────────────────────────────────────
    if (action === "media") {
      if (!windowOpen) return json({ ok: false, error: "window_closed" }, 409);
      const mime = String(body.mime ?? "application/octet-stream").split(";")[0];
      const filename = String(body.filename ?? "file").slice(0, 120);
      const bytes = b64ToBytes(String(body.base64 ?? ""));
      if (!bytes.length) return json({ ok: false, error: "empty file" }, 400);
      if (bytes.length > 16 * 1024 * 1024) return json({ ok: false, error: "file is larger than 16 MB" }, 400);
      const kind = mediaKind(mime);

      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mime);
      form.append("file", new Blob([bytes], { type: mime }), filename);
      const up = await fetch(`${GRAPH}/${phoneId}/media`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN()}` }, body: form });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || !uj.id) throw new Error(uj?.error?.message ?? "upload to WhatsApp failed");

      const caption = String(body.caption ?? "").trim();
      const obj: Record<string, unknown> = { id: uj.id };
      if (caption && kind !== "audio") obj.caption = caption;
      if (kind === "document") obj.filename = filename;
      const r = await meta(`${phoneId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: kind, [kind]: obj });
      const wid = r?.messages?.[0]?.id ?? null;

      const ext = (filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
      const path = `${phone}/out-${Date.now()}.${ext}`;
      await admin.storage.from("wa-media").upload(path, bytes, { contentType: mime, upsert: true });
      const row = await record({ kind, body: caption || null, media_path: path, media_mime: mime, media_name: filename, wa_id: wid });
      return json({ ok: true, message: row });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 502);
  }
});
