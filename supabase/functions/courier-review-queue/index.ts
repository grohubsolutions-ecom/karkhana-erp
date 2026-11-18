// courier-review-queue — the couriers' OWN review lists, read exactly as they are.
// Deploy with VERIFY JWT OFF (server-to-server; the caller must hold SYNC_KEY).
//
// H303 (24 Oct 2026) — OWNEX AUTH REQUIRED
//   OwnEx locked its public tracker on 22 Oct. The authenticated endpoint
//   (merchant token in secret OWNEX_API_TOKEN) is the only way in. Response
//   shape is identical except for the top-level field renames also handled
//   in ownex-sync v43 and ownex-review v5:
//        old: data.currentStatus  new: data.status
//        old: data.history        new: data.statusHistory
//   History items also no longer carry a `status` label text, so we synthesise
//   it from the code — critical because isShipperAdvice() tests the label with
//   /waiting\s*for\s*advice/i to pick out the parcels OwnEx is asking us about.
//
// WHY (H297, 21 Oct 2026)
//   The desk reads two real lists every 10 minutes:
//     PostEx  Delivery Under Review
//             GET /v1/get-all-order?orderStatusId=9&startDate=…&endDate=…
//     OwnEx   Shipper Advice — current code "reason" + label "Waiting for Advice"
//
// CALL
//   {}                          both couriers (the schedule)
//   {"courier": "PostEx"}       one of them
//   {"dry_run": true}           read and report, write nothing
//
// SECRETS: SYNC_KEY, POSTEX_API_TOKEN, OWNEX_API_TOKEN.

import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const PX = "https://api.postex.pk/services/integration/api/order";
/* OwnEx authenticated hosts. Same pair as ownex-sync. */
const OX_HOSTS = ["https://ownex.courier-portal.com", "https://shipper.courier-portal.com"];
const OX_URL = (host: string, id: string) => `${host}/api/v1/booking/${encodeURIComponent(id)}`;

/* Code → human label — same mapping as ownex-sync. The authenticated API
   doesn't send `status` text any more, so we synth it so the
   /waiting for advice/ regex on the "reason" code still fires. */
const LABEL_MAP: Record<string, string> = {
  "unbooked": "Unbooked",
  "booked": "Booked",
  "picked-up": "Picked Up",
  "arrived": "Arrived",
  "pbag": "Preparing Transit",
  "in-transit": "In-Transit",
  "transit-received": "Transit Received",
  "de-manifested": "Ready for Delivery",
  "en-route": "Out for Delivery",
  "debrief": "Verifying Reason",
  "reason": "Waiting for Advice",
  "reattempt": "Ready for Re-Attempt",
  "return_requested": "Return In Progress",
  "return_initiated": "Return Initiated",
  "return-pbag": "Preparing Transit",
  "return-de-manifested": "Waiting for Submission",
  "delivered": "Delivered",
  "returned": "Returned",
};
function labelFor(code: string): string {
  const c = String(code ?? "").toLowerCase();
  if (LABEL_MAP[c]) return LABEL_MAP[c];
  return c.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

type Item = {
  tracking_id: string; order_number: string | null; status: string | null;
  reason?: string | null; at?: string | null; kept?: boolean;
};
type Read = { ok: boolean; items: Item[]; checked: number; error?: string; failed?: number; samples?: unknown[] };

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

function when(v: unknown): number {
  let s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "+05:00";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function cleanReason(v: unknown): string {
  const raw = String(v ?? "");
  if (/<[^>]+>/.test(raw)) return "";
  const s = raw.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^\s*verif(y|ie)(ing|d)\s+reason\s*[:\-–]?\s*/i, "").trim();
  if (!s || s.length < 2 || /^(n\/?a|none|null|-+|pending|reason)$/i.test(s)) return "";
  return s.slice(0, 200);
}

async function trackOwnEx(id: string, token: string): Promise<OxRead> {
  const errors: string[] = [];
  for (const host of OX_HOSTS) {
    try {
      const r = await fetch(OX_URL(host, id), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) { errors.push(`${host.replace("https://", "")}: http ${r.status}`); continue; }
      const j = await r.json().catch(() => null) as
        {
          success?: boolean;
          data?: {
            currentStatus?: Record<string, unknown>;
            status?: Record<string, unknown>;
            history?: Record<string, unknown>[];
            statusHistory?: Record<string, unknown>[];
          };
        } | null;
      if (!j?.success || !j?.data) { errors.push(`${host.replace("https://", "")}: not found`); continue; }
      const cs = j.data.status ?? j.data.currentStatus ?? {};
      const histRaw = Array.isArray(j.data.statusHistory) ? j.data.statusHistory
                   : Array.isArray(j.data.history)       ? j.data.history
                   : [];
      const history = histRaw
        .map((h) => {
          const code = String(h.code ?? "").toLowerCase();
          const status = h.status ? String(h.status) : (code ? labelFor(code) : "");
          return { code, status, description: String(h.description ?? ""), at: when(h.date) };
        })
        .filter((h) => h.code && Number.isFinite(h.at))
        .sort((a, b) => a.at - b.at);
      const csCode = String(cs.code ?? "").toLowerCase();
      const csStatus = cs.status ? String(cs.status) : (csCode ? labelFor(csCode) : "");
      return { ok: true, code: csCode, status: csStatus,
               date: cs.date ? String(cs.date) : null, history };
    } catch (e) {
      errors.push(`${host.replace("https://", "")}: ${String(e).slice(0, 80)}`);
    }
  }
  return { ok: false, error: errors.join(" | ") };
}

const isShipperAdvice = (t: { code: string; status: string }) =>
  t.code === "reason" && /waiting\s*for\s*advice/i.test(t.status);

function oxReason(hist: OxHist[]): string | null {
  let best: string | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.code === "en-route") break;
    if (h.code === "debrief" || h.code === "reason") {
      const r = cleanReason(h.description);
      if (r && (!best || h.code === "debrief")) best = r;
    }
  }
  return best;
}

async function readOwnEx(ids: string[], token: string, prev: Set<string>, orders: Map<string, string | null>): Promise<Read> {
  if (!ids.length) return { ok: true, items: [], checked: 0 };
  const items: Item[] = [];
  let read = 0, failed = 0;
  const samples: unknown[] = [];
  for (let i = 0; i < ids.length; i += 6) {
    const wave = ids.slice(i, i + 6);
    const got = await Promise.all(wave.map(async (id) => ({ id, t: await trackOwnEx(id, token) })));
    for (const { id, t } of got) {
      if (!t.ok) {
        failed++;
        if (samples.length < 5) samples.push({ tracking_id: id, error: t.error });
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

    if (!only || only === "OwnEx") {
      const oxToken = Deno.env.get("OWNEX_API_TOKEN");
      if (!oxToken) {
        out.ownex = { ok: false, error: "OWNEX_API_TOKEN is not set" };
      } else {
        const { data: cand, error: cErr } = await db.rpc("hub_review_queue_ownex_candidates", { p_limit: Number(body.limit ?? 250) });
        if (cErr) {
          out.ownex = { ok: false, error: `candidates: ${cErr.message}` };
        } else {
          const ids = ((cand ?? []) as { tracking_id: string }[]).map((r) => r.tracking_id).filter(Boolean);
          const { data: now } = await db.rpc("hub_review_queue_now");
          const prev = new Set(((now ?? []) as { courier: string; tracking_id: string }[])
            .filter((r) => r.courier === "OwnEx").map((r) => r.tracking_id));
          const orders = new Map<string, string | null>();
          for (let i = 0; i < ids.length; i += 200) {
            const { data: rows } = await db.from("online_logistics").select("tracking_id, order_number")
              .in("tracking_id", ids.slice(i, i + 200));
            for (const r of (rows ?? []) as { tracking_id: string; order_number: string | null }[]) orders.set(r.tracking_id, r.order_number);
          }
          const ox = await readOwnEx(ids, oxToken, prev, orders);
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
    }
    return json(out);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
