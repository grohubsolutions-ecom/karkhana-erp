/* send-push — the server half of mobile push (H290, 5 Oct 2026).
 *
 * The database trigger (H290_push_trigger.sql) calls this once per new row in
 * hub_notifications, with the notification and the user it is for. This reads
 * that user's phones from hub_push_subscriptions (service role, past RLS) and
 * sends each one a Web Push. A phone the push service reports as gone (404/410)
 * is deleted, so dead rows do not pile up.
 *
 * DEPLOY (Kashif):
 *   1. Generate a VAPID key pair once:
 *        npx web-push generate-vapid-keys
 *   2. Set the secrets on the project:
 *        supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@grohub.com
 *   3. Deploy:  supabase functions deploy send-push
 *   4. Put the PUBLIC key in the site build as NEXT_PUBLIC_VAPID_PUBLIC_KEY and redeploy the app.
 *   5. Run H290_push_trigger.sql in the SQL editor (it stores the function URL
 *      and the service-role key in Vault and attaches the trigger).
 */
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const PUB = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const PRIV = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@grohub.com";
if (PUB && PRIV) webpush.setVapidDetails(SUBJECT, PUB, PRIV);

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    if (!PUB || !PRIV) return json({ ok: false, error: "VAPID keys not set" }, 200);
    const body = await req.json().catch(() => ({}));
    // The trigger sends the inserted row under "record"; a manual call may pass fields directly.
    const n = body.record ?? body;
    const userId: string | undefined = n.user_id;
    if (!userId) return json({ ok: false, error: "no user_id" }, 200);

    const { data: subs, error } = await admin
      .from("hub_push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userId);
    if (error) return json({ ok: false, error: error.message }, 200);
    if (!subs || subs.length === 0) return json({ ok: true, sent: 0 }, 200);

    const payload = JSON.stringify({
      title: n.title ?? "Grohub Hub",
      body: (n.body ?? "").slice(0, 300),
      tag: n.task_id ?? n.article_id ?? n.id ?? undefined,
      url: "/me",
    });

    let sent = 0;
    const dead: string[] = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
      }
    }));
    if (dead.length) await admin.from("hub_push_subscriptions").delete().in("endpoint", dead);
    return json({ ok: true, sent, removed: dead.length }, 200);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "error" }, 200);
  }
});

function json(b: unknown, status: number) {
  return new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
}
