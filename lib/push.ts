"use client";
/* MOBILE PUSH — the browser half (H290, 5 Oct 2026).
 *
 * The bell already shows notifications inside the app. This signs the phone up
 * with the browser's push service so the same notification reaches it when the
 * app is closed. Everything server-side (the VAPID keys, the sender) is the
 * edge function send-push; this file only registers the service worker and
 * saves/drops the subscription through hub_push_subscribe / hub_push_unsubscribe.
 *
 * It needs the VAPID PUBLIC key at build time as NEXT_PUBLIC_VAPID_PUBLIC_KEY.
 * Until that is set, isConfigured() is false and the toggle says so instead of
 * failing — nothing here breaks the app when push is not set up yet.
 */
import { supabase } from "@/lib/supabase";

export type PushState = "unsupported" | "not-configured" | "off" | "on" | "blocked";

/* Next inlines NEXT_PUBLIC_* at build time; the typeof guard keeps this from
   throwing anywhere `process` is not defined (SSR edge cases, test bundles). */
const VAPID = (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  ? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY : "").trim();

export const isSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator &&
  "PushManager" in window && "Notification" in window;

export const isConfigured = () => VAPID.length > 0;

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js");
}

/** What state to show without prompting for anything. */
export async function currentState(): Promise<PushState> {
  if (!isSupported()) return "unsupported";
  if (!isConfigured()) return "not-configured";
  if (Notification.permission === "denied") return "blocked";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? "on" : "off";
  } catch { return "off"; }
}

/** Ask permission, subscribe, and save it. Returns the new state. */
export async function enablePush(): Promise<{ state: PushState; error?: string }> {
  if (!isSupported()) return { state: "unsupported" };
  if (!isConfigured()) return { state: "not-configured" };
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "denied") return { state: "blocked" };
  if (perm !== "granted") return { state: "off" };
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID),
      });
    }
    const j = sub.toJSON();
    if (!supabase || !j.keys) return { state: "off", error: "Could not read the subscription." };
    const { data, error } = await supabase.rpc("hub_push_subscribe", {
      p_endpoint: sub.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
      p_ua: navigator.userAgent.slice(0, 200),
    });
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) return { state: "off", error: error.message };
    if (res && res.ok === false) return { state: "off", error: res.error };
    return { state: "on" };
  } catch (e) {
    return { state: "off", error: e instanceof Error ? e.message : "Could not turn on phone alerts." };
  }
}

/** Drop this phone's subscription. */
export async function disablePush(): Promise<PushState> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      if (supabase) await supabase.rpc("hub_push_unsubscribe", { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch { /* leave it; the row ages out when the endpoint dies */ }
  return "off";
}
