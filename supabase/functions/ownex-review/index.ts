// ownex-review — OwnEx's own story of a parcel under review.
// Deploy with VERIFY JWT OFF (server-to-server; the caller must hold SYNC_KEY).
//
// H303 (24 Oct 2026) — AUTH IS NOW REQUIRED
//   OwnEx locked its public tracker on 22 Oct and the merchant token (secret
//   OWNEX_API_TOKEN) is now the only way in. The response path is the same
//   shape otherwise, except for the top-level field renames also handled in
//   ownex-sync v43:
//        old: data.history       new: data.statusHistory
//   Each history item still has a `code` and a `date`; the human-readable
//   `status` label is NO LONGER sent, so we synthesise it from the code the
//   same way ownex-sync does. This matters because readHistory() tests
//   `h.status` with /waiting\s*for\s*advice/i to decide advice_by.
//
// WHY THIS EXISTS (H283, 30 Sep 2026)
//   The owner wants Delivery Under Review to say WHO decided and WHAT, for
//   each parcel. ownex-sync keeps the status; this function reads attempts,
//   advice, and advice_by from OwnEx's own history and hands them to
//   hub_rescue_courier_facts(), the same function PostEx uses.
//
// CALL
//   {}                           the queue (hub_rescue_ownex_queue) — schedule
//   {"tracking_ids": [...]}      exactly these (backfill / checking)
//   {"dry_run": true}            read and report, write nothing
//
// SECRETS: SYNC_KEY (the gate) and OWNEX_API_TOKEN (the OwnEx bearer).

import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

/* The authenticated merchant endpoint, same pair as ownex-sync. */
const TRACK_HOSTS = ["https://ownex.courier-portal.com", "https://shipper.courier-portal.com"];
const TRACK_URL = (host: string, id: string) =>
  `${host}/api/v1/booking/${encodeURIComponent(id)}`;

/* Code → human label. Needed because the authenticated API drops the label
   text and readHistory() tests the label for "Waiting for Advice". */
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

type Hist = { code: string; status: string; at: number };
type Fact = {
  tracking_id: string; attempts: number | null; attempt_at: string | null;
  reason: null; advice: "reattempt" | "return" | null; advice_at: string | null;
  advice_by: "merchant" | "courier" | null;
};

/* OwnEx writes ISO times with a Z. Anything without an offset is its own
   clock — Pakistan time. */
function when(v: unknown): number {
  let s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "+05:00";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
const isReturn = (c: string) => /^return[-_]/.test(c) || c === "returned";

export function readHistory(raw: unknown[], tracking: string): Fact & { last_code: string | null } {
  const hist: Hist[] = (raw as Record<string, unknown>[])
    .map((h) => {
      const code = String(h.code ?? "").toLowerCase();
      /* Synthesise the label from the code when the API didn't send one. */
      const status = h.status ? String(h.status) : (code ? labelFor(code) : "");
      return { code, status, at: when(h.date) };
    })
    .filter((h) => h.code && Number.isFinite(h.at))
    .sort((a, b) => a.at - b.at);

  let attempts = 0, sawOut = false;
  let tryAt: number | null = null;
  let lastDebrief: number | null = null;
  for (const h of hist) {
    if (h.code === "en-route") sawOut = true;
    if (h.code === "debrief") {
      if (sawOut || attempts === 0) { attempts++; tryAt = h.at; }
      sawOut = false;
      lastDebrief = h.at;
    }
  }

  let advice: Fact["advice"] = null, adviceAt: number | null = null, adviceBy: Fact["advice_by"] = null;
  if (lastDebrief != null) {
    let asked = false;
    for (const h of hist) {
      if (h.at < lastDebrief) continue;
      if (h.code === "reason") { asked = /waiting\s*for\s*advice/i.test(h.status); continue; }
      if (h.code === "reattempt" && advice == null) {
        advice = "reattempt"; adviceAt = h.at; adviceBy = asked ? "merchant" : "courier";
      } else if (h.code === "en-route" && advice == null) {
        advice = "reattempt"; adviceAt = h.at; adviceBy = "courier";
      } else if (isReturn(h.code) && advice !== "return") {
        advice = "return"; adviceAt = h.at; adviceBy = asked ? "merchant" : "courier";
      }
    }
  }
  return {
    tracking_id: tracking,
    attempts: attempts || null,
    attempt_at: tryAt != null ? new Date(tryAt).toISOString() : null,
    reason: null,
    advice,
    advice_at: adviceAt != null ? new Date(adviceAt).toISOString() : null,
    advice_by: adviceBy,
    last_code: hist.length ? hist[hist.length - 1].code : null,
  };
}

async function track(id: string, token: string): Promise<{ history: unknown[] | null; error?: string }> {
  const errors: string[] = [];
  for (const host of TRACK_HOSTS) {
    try {
      const r = await fetch(TRACK_URL(host, id), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) { errors.push(`${host.replace("https://", "")}: http ${r.status}`); continue; }
      const j = await r.json().catch(() => null) as
        { success?: boolean; data?: { history?: unknown[]; statusHistory?: unknown[] } } | null;
      if (!j?.success || !j?.data) { errors.push(`${host.replace("https://", "")}: not found`); continue; }
      /* Read both names so a future revert does not break the function. */
      const h = Array.isArray(j.data.statusHistory) ? j.data.statusHistory
              : Array.isArray(j.data.history)       ? j.data.history
              : [];
      return { history: h };
    } catch (e) {
      errors.push(`${host.replace("https://", "")}: ${String(e).slice(0, 100)}`);
    }
  }
  return { history: null, error: errors.join(" | ") };
}

Deno.serve(async (req) => {
  try {
    const gate = Deno.env.get("SYNC_KEY");
    if (!gate || (req.headers.get("x-sync-key") ?? "") !== gate) return json({ error: "unauthorized" }, 401);
    const token = Deno.env.get("OWNEX_API_TOKEN") ?? "";
    if (!token) return json({ error: "OWNEX_API_TOKEN not set" }, 500);

    const body = await req.json().catch(() => ({}));
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let nums: string[] = Array.isArray(body.tracking_ids) ? body.tracking_ids.map(String).slice(0, 150) : [];
    if (!nums.length) {
      const { data: queue, error: qErr } = await db.rpc("hub_rescue_ownex_queue", { p_limit: Number(body.limit ?? 60) });
      if (qErr) return json({ error: qErr.message }, 500);
      nums = ((queue ?? []) as { tracking_id: string }[]).map((r) => r.tracking_id).filter(Boolean);
    }
    if (!nums.length) return json({ ok: true, checked: 0, note: "nothing to read" });

    const facts: (Fact & { last_code: string | null })[] = []; const failed: string[] = [];
    const failReasons: { tracking_id: string; error?: string }[] = [];
    for (let i = 0; i < nums.length; i += 5) {
      const wave = nums.slice(i, i + 5);
      const got = await Promise.all(wave.map(async (tn) => {
        try { return { tn, ...(await track(tn, token)) }; } catch (e) { return { tn, history: null, error: String(e).slice(0, 100) }; }
      }));
      for (const g of got) {
        if (!g.history) {
          failed.push(g.tn);
          if (failReasons.length < 5) failReasons.push({ tracking_id: g.tn, error: g.error });
          continue;
        }
        facts.push(readHistory(g.history, g.tn));
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const summary = facts.map((f) => ({
      tracking_id: f.tracking_id, attempts: f.attempts, advice: f.advice, by: f.advice_by, last: f.last_code,
    }));
    if (body.dry_run === true) return json({ ok: true, dry_run: true, checked: nums.length, read: facts.length, failed, fail_reasons: failReasons, facts: summary });

    const { data: res, error } = await db.rpc("hub_rescue_courier_facts", {
      p_facts: facts.map(({ last_code: _l, ...f }) => f),
      p_codes: [],
    });
    if (error) return json({ error: error.message, read: facts.length }, 500);
    return json({ ok: true, checked: nums.length, read: facts.length, failed: failed.slice(0, 10), fail_reasons: failReasons, result: res, facts: summary });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
