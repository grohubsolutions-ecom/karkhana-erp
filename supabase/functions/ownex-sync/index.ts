// Supabase Edge Function: ownex-sync   (Karkhana — ozkhkhlwjblzgwmjbdde)
// Deploy with --no-verify-jwt ; auth enforced manually below.
//
// HOW OWNEX WORKS FOR US  (updated 24 Oct 2026 — H303)
//   OwnEx locked its PUBLIC tracker on 22 Oct 22:43 UTC and now answers every
//   server-side GET to /api/v1/public/booking/status/{id} with http 403 (the
//   browser works because Cloudflare scores a residential IP low; our server
//   IP is blocked). The 23 Oct ownex-sync (v41) saw the 403 on parcel #1 and
//   short-circuited the run — correct, but no status refreshed for 24 hours.
//
//   On 23 Oct the user generated a merchant API token in the OwnEx portal
//   (Settings → Integrations → "HUB department") and stored it as the
//   Supabase edge-function secret OWNEX_API_TOKEN. The token unlocks a
//   different host:
//
//     GET https://ownex.courier-portal.com/api/v1/booking/{trackingId}
//     Authorization: Bearer <OWNEX_API_TOKEN>
//
//   This authenticated endpoint returns the SAME JSON tree as the old public
//   one — status.code, statusHistory[].code, same code vocabulary — with two
//   small renames at the top level:
//
//       old public                  new authenticated
//       ----------                  -----------------
//       data.currentStatus          data.status
//       data.history                data.statusHistory
//
//   The status label text ("Verifying Reason", "Out for Delivery") is NO
//   LONGER included — only the code. That is fine for status mapping (the
//   code is what CODE_MAP keys on), but the label is what we store in
//   raw_status, so we synthesise it from the code via LABEL_MAP below.
//
//   The reason description ("UNTRACEABLE ADDRESS", "RFD", "CNA") is also not
//   in the authenticated response. Reasons already in courier_reason_text are
//   never cleared by this function, so they are preserved; new reasons will
//   not come in until OwnEx exposes them or until we open their portal UI.
//   This is a known loss — status refreshing is the primary job and that
//   still works perfectly.
//
// OWNERSHIP RULE  (unchanged)
//   The courier's own system is authoritative for WHERE a parcel is, so it may
//   correct delivery_status. It knows nothing about money, so payment_status,
//   cpr_number and cpr_net_amount are never touched here.
//
// DIRECTION IS READ FROM HISTORY, NOT FROM THE CURRENT STATUS  (unchanged)
//   OwnEx reuses `transit-received` and `in-transit` on BOTH legs. Verified on
//   parcel 312010001714. The return leg is derived from the history array and
//   stored ONCE in return_leg_started_at (migration 0059).
//
// ACTIONS  (unchanged)
//   discover_codes      sample parcels, report every status code AND every
//                       reason wording seen, write nothing
//   track               refresh parcels still in motion  (the scheduled job)
//   backfill_return_leg one-off: stamp direction on parcels already misfiled

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

/* The authenticated merchant endpoint. The alternate host
   `shipper.courier-portal.com` also accepts the same bearer token at the same
   path, so it is kept as a fallback for the day OwnEx moves the service. The
   old public hosts are gone — a 403 from them is not useful fallback. */
const TRACK_HOSTS = ["https://ownex.courier-portal.com", "https://shipper.courier-portal.com"];
const TRACK_URL = (host: string, id: string) =>
  `${host}/api/v1/booking/${encodeURIComponent(id)}`;

/* The authenticated API returns codes only (no `status` label text), so we
   synthesise the human-readable label from the code. Observed labels, taken
   verbatim from OwnEx's own portal and from historical raw_status rows:

     code                    label
     ----                    -----
     unbooked                Unbooked
     booked                  Booked
     picked-up               Picked Up
     arrived                 Arrived
     pbag                    Preparing Transit
     in-transit              In-Transit
     transit-received        Transit Received
     de-manifested           Ready for Delivery
     en-route                Out for Delivery
     debrief                 Verifying Reason
     reason                  Waiting for Advice
     reattempt               Ready for Re-Attempt
     return_requested        Return In Progress
     return_initiated        Return Initiated
     return-pbag             Preparing Transit
     return-de-manifested    Waiting for Submission
     delivered               Delivered
     returned                Returned

   The courier may invent a new code — unknown codes fall through to a
   Title-Case rendering of the slug so review still has something readable. */
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
  // Unknown code — turn it into a readable guess so the row isn't blank in review.
  return c.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

type Hist = { code: string; status: string; date: string; description?: string };
type Tracked = {
  trackingId: string; ok: boolean;
  code?: string; status?: string; date?: string; route?: string;
  description?: string;
  history?: Hist[]; error?: string;
};

async function trackAt(host: string, id: string, token: string): Promise<Tracked> {
  try {
    const r = await fetch(TRACK_URL(host, id), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { trackingId: id, ok: false, error: `${host.replace("https://", "")}: http ${r.status}` };
    const j = await r.json();
    if (!j?.success || !j?.data) return { trackingId: id, ok: false, error: `${host.replace("https://", "")}: not found` };
    const d = j.data;
    /* Field rename: the authenticated API uses `status` and `statusHistory`
       where the old public one used `currentStatus` and `history`. Read both
       so a future OwnEx revert does not break the sync. */
    const cs = d.status ?? d.currentStatus ?? {};
    const histArr = d.statusHistory ?? d.history ?? [];
    const from = cs.details?.fromStation?.name;
    const to = cs.details?.transitStation?.name ?? cs.details?.toStation?.name;
    const code = String(cs.code ?? "").toLowerCase();
    return {
      trackingId: id, ok: true,
      code,
      /* Synthesise the label from the code when the API didn't send one. */
      status: cs.status ? String(cs.status) : (code ? labelFor(code) : ""),
      date: cs.date ?? undefined,
      route: from && to ? `${from} -> ${to}` : from || undefined,
      /* Preserved for the fallback path; the auth API never populates it. */
      description: cs.description ? String(cs.description) : undefined,
      history: (histArr as { code?: string; status?: string; date?: string; description?: string }[])
        .map((h) => {
          const hc = String(h.code ?? "").toLowerCase();
          return {
            code: hc,
            status: h.status ? String(h.status) : (hc ? labelFor(hc) : ""),
            date: h.date ?? "",
            description: h.description ? String(h.description) : undefined,
          };
        }),
    };
  } catch (e) {
    return { trackingId: id, ok: false, error: `${host.replace("https://", "")}: ${String(e).slice(0, 100)}` };
  }
}

/** Each host in turn; the first real answer wins. All failing returns the
 *  reasons from every host, so a failed run can say WHY. */
async function trackOne(id: string, token: string): Promise<Tracked> {
  const errors: string[] = [];
  for (const host of TRACK_HOSTS) {
    const t = await trackAt(host, id, token);
    if (t.ok) return t;
    errors.push(t.error ?? "failed");
  }
  return { trackingId: id, ok: false, error: errors.join(" | ") };
}

/* The complete OwnEx vocabulary, read from 150 live parcels via discover_codes
   — every code below was observed, none assumed. Their own labels are kept in
   the comments so the mapping can be checked at a glance. */
const CODE_MAP: Record<string, { status: string; attempt?: boolean }> = {
  // ---- moving (direction UNKNOWN from the code alone) -------------------
  unbooked:           { status: "In Transit" },   // Unbooked
  booked:             { status: "In Transit" },   // Booked
  "picked-up":        { status: "In Transit" },   // Picked Up
  arrived:            { status: "In Transit" },   // Arrived
  pbag:               { status: "In Transit" },   // Preparing Transit
  "in-transit":       { status: "In Transit" },   // In-Transit        ← both legs
  "transit-received": { status: "In Transit" },   // Transit Received  ← both legs
  "de-manifested":    { status: "In Transit" },   // Ready for Delivery
  "en-route":         { status: "In Transit" },   // Out for Delivery

  // ---- delivery was attempted and failed -------------------------------
  debrief:   { status: "In Transit", attempt: true },   // Verifying Reason
  reason:    { status: "In Transit", attempt: true },   // Reason / Waiting for Advice
  reattempt: { status: "In Transit", attempt: true },   // Ready for Re-Attempt

  // ---- coming back -----------------------------------------------------
  return_requested:       { status: "RTS" },      // Return In Progress
  return_initiated:       { status: "RTS" },      // Return Initiated
  "return-pbag":          { status: "RTS" },      // Preparing Transit (return leg)
  "return-de-manifested": { status: "RTS" },      // Waiting for Submission

  // ---- finished --------------------------------------------------------
  delivered: { status: "Delivered" },             // Delivered
  returned:  { status: "Returned" },              // Returned — back with us
};

function mapCode(code: string): { status: string; certain: boolean; attempt: boolean } {
  const hit = CODE_MAP[code];
  if (hit) return { status: hit.status, certain: true, attempt: !!hit.attempt };
  if (/^deliver/.test(code)) return { status: "Delivered", certain: false, attempt: false };
  if (/^return|^rts/.test(code)) return { status: "RTS", certain: false, attempt: false };
  if (/cancel|expire/.test(code)) return { status: "Cancelled", certain: false, attempt: false };
  return { status: "In Transit", certain: false, attempt: false };
}

const isReturnCode = (c: string) => /^return[-_]/.test(c ?? "");

/** The first moment the courier put this parcel on the return leg, or null. */
function returnLegStart(history?: Hist[]): string | null {
  const hit = (history ?? []).find((h) => isReturnCode(h.code));
  return hit?.date || null;
}

/* ---------------------------------------------------------------------------
   THE COURIER'S REASON

   Kept for the fallback path (if OwnEx ever includes `description` again on
   the authenticated endpoint). Today's authenticated response has no
   description field at all, so courierReason() will return null — that is
   fine, because the patch below only WRITES courier_reason_text when a
   reason is present, so existing reasons are preserved.
--------------------------------------------------------------------------- */
const REASON_CODES = new Set([
  "debrief", "reason", "reattempt",
  "return_requested", "return_initiated", "return-pbag", "return-de-manifested", "returned",
]);
const EMPTY_REASON = /^(n\/?a|none|null|-+|verif(y|ie)(ing|d) reason|reason|pending|no reason)$/i;
const LOOKS_LIKE_ROUTE = /^[^<>]{2,30}\s*(->|-->|→|=>|»)\s*[^<>]{2,30}$/;
const REASON_LABEL = /^\s*verif(y|ie)(ing|d)\s+reason\s*[:\-–]?\s*/i;

function cleanReason(v: unknown): string {
  let s = String(v ?? "");
  const hadMarkup = /<[^>]+>/.test(s);
  s = s.replace(/<[^>]+>/g, " ")
       .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
       .replace(/\s+/g, " ").trim();
  if (hadMarkup) return "";
  s = s.replace(REASON_LABEL, "").trim();
  if (!s || s.length < 3 || EMPTY_REASON.test(s)) return "";
  if (LOOKS_LIKE_ROUTE.test(s)) return "";
  return s.slice(0, 200);
}

function courierReason(t: Tracked): string | null {
  const hist = [...(t.history ?? [])].sort((a, b) =>
    String(b.date ?? "").localeCompare(String(a.date ?? "")));
  for (const h of hist) {
    if (REASON_CODES.has(h.code)) {
      const r = cleanReason(h.description);
      if (r) return r;
    }
  }
  return null;
}

/** small waves, so we stay polite to the merchant endpoint */
async function inWaves(ids: string[], size: number, deadline: number, token: string) {
  const out: Tracked[] = [];
  for (let i = 0; i < ids.length; i += size) {
    if (Date.now() > deadline) break;
    out.push(...await Promise.all(ids.slice(i, i + size).map((id) => trackOne(id, token))));
  }
  return out;
}

function failSamples(results: Tracked[]) {
  return results.filter((t) => !t.ok).slice(0, 5).map((t) => ({ tracking_id: t.trackingId, error: t.error }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const key = req.headers.get("x-sync-key") ?? "";
    let allowed = !!key && key === (Deno.env.get("SYNC_KEY") ?? "\u0000");
    if (!allowed) {
      const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!tok) return json({ error: "unauthorized" }, 401);
      const { data, error } = await db.auth.getUser(tok);
      if (error || !data?.user) return json({ error: "unauthorized" }, 401);
      allowed = true;
    }

    /* The authenticated endpoint will not answer without the merchant token.
       Fail loudly if it is missing, rather than running a whole batch that
       returns 401 on every parcel. */
    const ownexToken = Deno.env.get("OWNEX_API_TOKEN") ?? "";
    if (!ownexToken) {
      return json({
        ok: false,
        error: "OWNEX_API_TOKEN is not set. Add it under Project Settings → Edge Functions → Secrets.",
      }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "track";
    const limit = Math.min(Number(body.limit) || 200, 1000);
    const wave = Math.min(Number(body.concurrency) || 5, 10);
    const deadline = Date.now() + Math.min(Number(body.max_seconds) || 60, 140) * 1000;

    /* ============ discover_codes — read-only vocabulary check ============ */
    if (action === "discover_codes") {
      let ids: string[] = body.tracking_ids ?? [];
      if (!ids.length) {
        const { data } = await db.from("online_logistics")
          .select("tracking_id")
          .eq("courier", "OwnEx").not("tracking_id", "is", null)
          .order("dispatch_date", { ascending: false, nullsFirst: false })
          .limit(limit);
        ids = (data ?? []).map((r: { tracking_id: string }) => r.tracking_id);
      }
      const results = await inWaves(ids, wave, deadline, ownexToken);

      const codes: Record<string, { seen: number; label: string; reasons: Record<string, number> }> = {};
      let failed = 0;
      for (const t of results) {
        if (!t.ok) { failed++; continue; }
        const all: { code: string; status: string; description?: string }[] = [
          { code: t.code ?? "", status: t.status ?? "", description: t.description },
          ...(t.history ?? []),
        ];
        for (const h of all) {
          if (!h.code) continue;
          codes[h.code] = codes[h.code] ?? { seen: 0, label: h.status, reasons: {} };
          codes[h.code].seen++;
          const r = cleanReason(h.description);
          if (r) codes[h.code].reasons[r] = (codes[h.code].reasons[r] ?? 0) + 1;
        }
      }
      const table = Object.entries(codes)
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([code, v]) => ({
          code, label: v.label, seen: v.seen,
          maps_to: mapCode(code).status, certain: mapCode(code).certain,
          carries_reason: REASON_CODES.has(code),
          reasons: Object.entries(v.reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)
                         .map(([text, n]) => ({ text, n })),
        }));
      const unmapped = table.filter((r) => !r.certain).map((r) => r.code);

      return json({
        ok: true, checked: results.length, failed, fail_samples: failSamples(results), codes: table, unmapped,
        note: unmapped.length
          ? "These codes are not understood yet — send them to me and I will map them properly."
          : "Every code in circulation is understood.",
      });
    }

    /* ============ track — the scheduled refresh ========================== */
    if (action === "track" || action === "backfill_return_leg") {
      const backfill = action === "backfill_return_leg";

      const priorStatus = new Map<string, string | null>();
      const priorReason = new Map<string, string | null>();

      let ids: string[] = body.tracking_ids ?? [];
      if (!ids.length) {
        const terminal = '("Delivered","Returned","Cancelled")';

        let q = db.from("online_logistics")
          .select("tracking_id, raw_status, courier_reason_text")
          .eq("courier", "OwnEx").not("tracking_id", "is", null);

        if (backfill) {
          q = q.not("delivery_status", "in", '("Delivered","Cancelled")')
               .is("return_received_at", null);
        } else {
          q = q.not("delivery_status", "in", terminal);
          const staleMinutes = Number(body.stale_minutes ?? 45);
          if (staleMinutes > 0) {
            const cutoff = new Date(Date.now() - staleMinutes * 60000).toISOString();
            q = q.or(`updated_at.is.null,updated_at.lt.${cutoff}`);
          }
        }

        const { data } = await q
          .order("updated_at", { ascending: true, nullsFirst: true })
          .limit(limit);
        ids = (data ?? []).map((r: { tracking_id: string }) => r.tracking_id);

        /* H303 (24 Oct 2026) — ONE-PARCEL PROBE BEFORE A BATCH.
           v41 added this probe when the public tracker 403'd every call. With
           the merchant token in place every parcel succeeds, so the probe is
           kept for the opposite reason: if the token is revoked or expires,
           we want ONE 401 reported with the full error message rather than
           180 of them each writing the same unauthorised shape. */
        if (ids.length) {
          const probe = await trackOne(ids[0], ownexToken);
          if (!probe.ok && /http (401|403)/.test(probe.error ?? "")) {
            return json({
              ok: true, action, dry_run: body.dry_run === true, probe_only: true,
              requested: ids.length, checked: 1, updated: 0, not_found: 0, failed: 1,
              fail_samples: [{ tracking_id: ids[0],
                error: `OwnEx rejected the merchant token (${probe.error}). Check OWNEX_API_TOKEN in edge-function secrets.` }],
              now_showing: {},
            });
          }
        }

        for (const r of (data ?? []) as
             { tracking_id: string; raw_status?: string | null; courier_reason_text?: string | null }[]) {
          priorStatus.set(r.tracking_id, r.raw_status ?? null);
          priorReason.set(r.tracking_id, r.courier_reason_text ?? null);
        }
      }
      if (!ids.length) return json({ ok: true, checked: 0, note: "Nothing due a refresh — every parcel in transit was checked recently." });

      const results = await inWaves(ids, wave, deadline, ownexToken);
      const dryRun = body.dry_run === true;

      let updated = 0, unchanged = 0, flagged = 0, failed = 0, attempts = 0;
      let returnLegFound = 0, directionCorrected = 0, rescued = 0;
      let reasonsFound = 0, reasonsNew = 0;
      const reasonSamples: Record<string, unknown>[] = [];
      const nowShowing: Record<string, number> = {};
      const corrections: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];

      for (const t of results) {
        if (!t.ok) { failed++; continue; }
        const m = mapCode(t.code ?? "");
        let status = m.status;
        const certain = m.certain;
        const attempt = m.attempt;

        const legStart = returnLegStart(t.history);
        if (legStart) returnLegFound++;

        if (legStart && status === "In Transit") {
          status = "RTS";
          directionCorrected++;
          corrections.push({ tracking_id: t.trackingId, was: t.status, now: "RTS", leg_started: legStart });
        }
        if (legStart && status === "Delivered") rescued++;

        const reason = courierReason(t);
        if (reason) {
          reasonsFound++;
          if (reasonSamples.length < 20) reasonSamples.push({ tracking_id: t.trackingId, reason, status: t.status });
        }
        const reasonIsNew = !!reason && reason !== priorReason.get(t.trackingId);
        if (reasonIsNew) reasonsNew++;

        if (!certain) flagged++;
        if (attempt) attempts++;
        nowShowing[status] = (nowShowing[status] ?? 0) + 1;
        if (dryRun) continue;

        if (priorStatus.get(t.trackingId) === (t.status ?? null) && !legStart && !reasonIsNew) {
          unchanged++; continue;
        }

        events.push({ tracking_id: t.trackingId, courier: "OwnEx", raw_status: t.status ?? t.code ?? "" });

        const patch: Record<string, unknown> = {
          delivery_status: status,
          raw_status: t.status ?? t.code ?? null,
          needs_review: !certain,
          updated_at: new Date().toISOString(),
        };

        if (legStart) {
          patch.return_leg_started_at = legStart;
          patch.return_leg_source = "history";
        }

        if (reason) patch.courier_reason_text = reason;

        if (status === "Delivered" && t.date) patch.delivery_date = String(t.date).slice(0, 10);
        if (!certain) patch.review_status = `unmapped OwnEx code: ${t.code}`;
        if (attempt) patch.rts_reason = `OwnEx: ${t.status}${t.route ? ` (${t.route})` : ""}`;
        if (status === "RTS" || status === "Returned") patch.rts = "Yes";
        if (status === "Delivered") patch.rts = null;

        const { data } = await db.from("online_logistics")
          .update(patch)
          .eq("tracking_id", t.trackingId).eq("courier", "OwnEx")
          .select("id");
        if ((data ?? []).length) updated++; else unchanged++;
      }

      if (!dryRun && events.length) await db.from("online_courier_events").insert(events.slice(0, 1000));

      return json({
        ok: true, action, dry_run: dryRun,
        requested: ids.length, checked: results.length,
        updated, not_found: unchanged, failed,
        fail_samples: failSamples(results),
        flagged_unknown_code: flagged,
        failed_delivery_attempts: attempts,
        on_return_leg: returnLegFound,
        direction_corrected: directionCorrected,
        rescued_after_return_started: rescued,
        courier_reasons_seen: reasonsFound,
        courier_reasons_new: reasonsNew,
        reason_samples: reasonSamples,
        corrections: corrections.slice(0, 50),
        now_showing: nowShowing,
        stopped_early: results.length < ids.length ? "time budget — run again to continue" : undefined,
      });
    }

    return json({ error: "unknown action — use discover_codes, track or backfill_return_leg" }, 400);
  } catch (e) {
    const err = e as Error;
    return json({ error: err?.message ?? String(e), stack: (err?.stack ?? "").split("\n").slice(0, 5) }, 500);
  }
});
