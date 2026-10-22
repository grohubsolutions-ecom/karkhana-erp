// courier-review-queue — the couriers' OWN review lists, read exactly as they are.
// Deploy with VERIFY JWT OFF (server-to-server; the caller must hold SYNC_KEY,
// which call_sync() sends as the x-sync-key header).
//
// WHY (H297, 21 Oct 2026)
//   The owner: "Suppose today there are 5 reviews on PostEx — it should fetch
//   all 5 and show them on our portal. Not any other parcel." The Delivery Under
//   Review desk was built from our own status column and showed 42-43 parcels
//   that are on neither courier's review screen (PostEx "Attempted" = PostEx
//   retrying by itself; OwnEx "Verifying Reason" = OwnEx has not asked us yet).
//   This function reads the two real lists, every 10 minutes:
//
//   PostEx  "Delivery Under Review"
//           GET /v1/get-all-order?orderStatusId=9&startDate=…&endDate=…
//           Status 9 is labelled "Under Verification" in this list and
//           "Delivery Under Review" in track-order — checked parcel by parcel
//           on 21 Oct. The date filter is the BOOKING date, so the window is
//           wide (120 days): a parcel booked weeks ago can still be under review.
//
//   OwnEx   "Shipper Advice"
//           OwnEx has no list to download. Its public tracker gives each
//           parcel's current status; Shipper Advice is current code "reason"
//           with the label "Waiting for Advice". ("Reason" / "Verified Reason
//           CNA" under the same code is OwnEx deciding by itself — not a request
//           to us.) Every OwnEx parcel still out there is asked
//           (hub_review_queue_ownex_candidates) — NOT only the ones our status
//           column says failed: on 21 Oct #TS4893 was waiting for advice while
//           our status for it was still empty.
//
//   Each list is written through hub_review_queue_record() — one row per read
//   (the desk shows the latest GOOD one) and one row per parcel per day it was
//   seen (the history the couriers' portals do not keep).
//
// WHEN A READ FAILS
//   PostEx: the read is recorded as failed with its reason; the desk keeps the
//   last good list and says how old it is. OwnEx: a parcel that was on the last
//   good list and could not be read this time is KEPT (marked kept), so one
//   slow answer does not drop it off the desk; if fewer than half of the
//   parcels could be read, the whole read is marked failed instead.
//
// CALL
//   {}                          both couriers (the schedule)
//   {"courier": "PostEx"}       one of them
//   {"dry_run": true}           read and report, write nothing
//
// SECRETS: SYNC_KEY, POSTEX_API_TOKEN. OwnEx's tracker is public.

import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const PX = "https://api.postex.pk/services/integration/api/order";
/* New host first; the old one stays as a fallback in case OwnEx moves back
   (it moved on ~10 Oct 2026 — see ownex-sync). */
const OX_HOSTS = ["https://shipper.courier-portal.com", "https://shipper.ownexpress.pk"];
const OX_URL = (host: string, id: string) => `${host}/api/v1/public/booking/status/${encodeURIComponent(id)}`;

type Item = {
  tracking_id: string; order_number: string | null; status: string | null;
  reason?: string | null; at?: string | null; kept?: boolean;
};
type Read = { ok: boolean; items: Item[]; checked: number; error?: string; failed?: number; samples?: unknown[] };

/* Pakistan has no daylight saving: its day is UTC + 5 hours. */
const pkDay = (offsetDays: number) =>
  new Date(Date.now() + 5 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ PostEx */
async function readPostEx(token: string): Promise<Read> {
  const url = `${PX}/v1/get-all-order?orderStatusId=9&startDate=${pkDay(-120)}&endDate=${pkDay(0)}`;
  try {
    const r = await fetch(url, {
      headers: { token, "content-type": "application/json" },
      signal: AbortSignal.timeout(40000),
    });
    const text = await r.text();
    let j: { statusCode?: unknown; statusMessage?: unknown; dist?: unknown } | null = null;
    try { j = JSON.parse(text); } catch { /* not JSON — reported below */ }
    if (!r.ok) return { ok: false, items: [], checked: 0, error: `PostEx answered http ${r.status}: ${text.slice(0, 160)}` };
    /* An empty list is "statusCode 200" with dist []; anything else is not an answer. */
    if (!j || String(j.statusCode) !== "200" || !Array.isArray(j.dist)) {
      return { ok: false, items: [], checked: 0, error: `PostEx gave no list: ${text.slice(0, 200)}` };
    }
    const items = (j.dist as Record<string, unknown>[])
      .map((o) => ({
        tracking_id: String(o.trackingNumber ?? "").trim(),
        order_number: o.orderRefNumber ? String(o.orderRefNumber).trim() : null,
        status: o.transactionStatus ? String(o.transactionStatus).trim() : null,
      }))
      .filter((i) => i.tracking_id);
    return { ok: true, items, checked: items.length };
  } catch (e) {
    return { ok: false, items: [], checked: 0, error: `PostEx could not be reached: ${String(e).slice(0, 160)}` };
  }
}

/* ------------------------------------------------------------------- OwnEx */
type OxHist = { code: string; status: string; description: string; at: number };
type OxRead = { ok: true; code: string; status: string; date: string | null; history: OxHist[] } | { ok: false; error: string };

/* OwnEx writes ISO times with a Z; anything without an offset is its own
   clock — Pakistan time. */
function when(v: unknown): number {
  let s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "+05:00";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/* A description carrying markup is a route ("Lahore <i/> Karachi"), not a reason. */
function cleanReason(v: unknown): string {
  const raw = String(v ?? "");
  if (/<[^>]+>/.test(raw)) return "";
  const s = raw.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^\s*verif(y|ie)(ing|d)\s+reason\s*[:\-–]?\s*/i, "").trim();
  if (!s || s.length < 2 || /^(n\/?a|none|null|-+|pending|reason)$/i.test(s)) return "";
  return s.slice(0, 200);
}

async function trackOwnEx(id: string): Promise<OxRead> {
  const errors: string[] = [];
  for (const host of OX_HOSTS) {
    try {
      const r = await fetch(OX_URL(host, id), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) { errors.push(`${host.replace("https://", "")}: http ${r.status}`); continue; }
      const j = await r.json().catch(() => null) as
        { success?: boolean; data?: { currentStatus?: Record<string, unknown>; history?: Record<string, unknown>[] } } | null;
      if (!j?.success || !j?.data) { errors.push(`${host.replace("https://", "")}: not found`); continue; }
      const cs = j.data.currentStatus ?? {};
      const history = (Array.isArray(j.data.history) ? j.data.history : [])
        .map((h) => ({ code: String(h.code ?? "").toLowerCase(), status: String(h.status ?? ""),
                       description: String(h.description ?? ""), at: when(h.date) }))
        .filter((h) => h.code && Number.isFinite(h.at))
        .sort((a, b) => a.at - b.at);
      return { ok: true, code: String(cs.code ?? "").toLowerCase(), status: String(cs.status ?? ""),
               date: cs.date ? String(cs.date) : null, history };
    } catch (e) {
      errors.push(`${host.replace("https://", "")}: ${String(e).slice(0, 80)}`);
    }
  }
  return { ok: false, error: errors.join(" | ") };
}

/* Waiting for OUR advice — the parcels on OwnEx's Shipper Advice page. */
const isShipperAdvice = (t: { code: string; status: string }) =>
  t.code === "reason" && /waiting\s*for\s*advice/i.test(t.status);

/* The reason for THIS failure: the newest debrief/reason description since the
   parcel last went out. */
function oxReason(hist: OxHist[]): string | null {
  let best: string | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.code === "en-route") break;
    if (h.code === "debrief" || h.code === "reason") {
      const r = cleanReason(h.description);
      if (r && (!best || h.code === "debrief")) best = r;   // the debrief's words are the fuller ones
    }
  }
  return best;
}

async function readOwnEx(ids: string[], prev: Set<string>, orders: Map<string, string | null>): Promise<Read> {
  if (!ids.length) return { ok: true, items: [], checked: 0 };
  const items: Item[] = [];
  let read = 0, failed = 0;
  const samples: unknown[] = [];
  for (let i = 0; i < ids.length; i += 6) {               // small waves: a public endpoint
    const wave = ids.slice(i, i + 6);
    const got = await Promise.all(wave.map(async (id) => ({ id, t: await trackOwnEx(id) })));
    for (const { id, t } of got) {
      if (!t.ok) {
        failed++;
        if (samples.length < 5) samples.push({ tracking_id: id, error: t.error });
        /* On the last good list and unreadable now: keep it, marked kept. */
        if (prev.has(id)) items.push({ tracking_id: id, order_number: orders.get(id) ?? null, status: null, kept: true });
        continue;
      }
      read++;
      if (isShipperAdvice(t)) {
        items.push({ tracking_id: id, order_number: orders.get(id) ?? null, status: t.status,
                     reason: oxReason(t.history), at: t.date });
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  /* Fewer than half answered: this is not a reading of the list. */
  if (read < Math.ceil(ids.length / 2)) {
    return { ok: false, items, checked: ids.length, failed, samples,
             error: `Only ${read} of ${ids.length} OwnEx parcels could be read` + (samples.length ? ` — ${JSON.stringify(samples[0])}` : "") };
  }
  return { ok: true, items, checked: ids.length, failed, samples };
}

/* ------------------------------------------------------------------ the run */
Deno.serve(async (req) => {
  try {
    const gate = Deno.env.get("SYNC_KEY");
    if (!gate || (req.headers.get("x-sync-key") ?? "") !== gate) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const dry = body.dry_run === true;
    const only = typeof body.courier === "string" ? String(body.courier) : null;
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const out: Record<string, unknown> = { ok: true, dry_run: dry };

    /* -------- PostEx */
    if (!only || only === "PostEx") {
      const token = Deno.env.get("POSTEX_API_TOKEN");
      const px: Read = token ? await readPostEx(token) : { ok: false, items: [], checked: 0, error: "POSTEX_API_TOKEN is not set" };
      out.postex = { ok: px.ok, n: px.items.length, error: px.error,
                     items: px.items.map((i) => `${i.order_number ?? "?"} ${i.tracking_id}`) };
      if (!dry) {
        const { data, error } = await db.rpc("hub_review_queue_record", {
          p_courier: "PostEx", p_ok: px.ok, p_items: px.items, p_error: px.error ?? null, p_checked: px.checked,
        });
        out.postex_saved = error ? { error: error.message } : data;
      }
    }

    /* -------- OwnEx */
    if (!only || only === "OwnEx") {
      const { data: cand, error: cErr } = await db.rpc("hub_review_queue_ownex_candidates", { p_limit: Number(body.limit ?? 250) });
      if (cErr) {
        out.ownex = { ok: false, error: `candidates: ${cErr.message}` };
      } else {
        const ids = ((cand ?? []) as { tracking_id: string }[]).map((r) => r.tracking_id).filter(Boolean);
        /* the last good list, so a parcel on it is not dropped by one failed read */
        const { data: now } = await db.rpc("hub_review_queue_now");
        const prev = new Set(((now ?? []) as { courier: string; tracking_id: string }[])
          .filter((r) => r.courier === "OwnEx").map((r) => r.tracking_id));
        /* order numbers, so the history carries them */
        const orders = new Map<string, string | null>();
        for (let i = 0; i < ids.length; i += 200) {
          const { data: rows } = await db.from("online_logistics").select("tracking_id, order_number")
            .in("tracking_id", ids.slice(i, i + 200));
          for (const r of (rows ?? []) as { tracking_id: string; order_number: string | null }[]) orders.set(r.tracking_id, r.order_number);
        }
        const ox = await readOwnEx(ids, prev, orders);
        out.ownex = { ok: ox.ok, n: ox.items.length, checked: ox.checked, failed: ox.failed, error: ox.error,
                      fail_samples: ox.samples,
                      items: ox.items.map((i) => `${i.order_number ?? "?"} ${i.tracking_id}${i.kept ? " (kept)" : ""}`) };
        if (!dry) {
          const { data, error } = await db.rpc("hub_review_queue_record", {
            p_courier: "OwnEx", p_ok: ox.ok, p_items: ox.items, p_error: ox.error ?? null, p_checked: ox.checked,
          });
          out.ownex_saved = error ? { error: error.message } : data;
        }
      }
    }
    return json(out);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
