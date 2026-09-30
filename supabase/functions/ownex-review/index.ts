// ownex-review — OwnEx's own story of a parcel under review.
// Deploy with VERIFY JWT OFF (server-to-server; the caller must hold SYNC_KEY).
//
// WHY THIS EXISTS (H283, 30 Sep 2026)
//   The owner: when our agent presses Return or Re-attempt on OwnEx's portal,
//   the Delivery Under Review desk must say so by itself — accurately, every
//   parcel. PostEx was already read this way (postex-review, H281). OwnEx was
//   not: the general ownex-sync keeps the STATUS, but nothing read WHO decided
//   and WHAT.
//
//   OwnEx's public tracker carries the whole story in its history (read live
//   on 30 Sep, e.g. 312010002338 / #LM15547):
//
//     en-route          Out for Delivery
//     debrief           Verifying Reason     "REFUSED TO RECEIVE"   ← a failed try
//     reason            Waiting for Advice   "REFUSED TO RECEIVE"   ← OwnEx asks US
//     return_requested  Return In Progress                          ← we pressed Return
//       (or reattempt   Ready for Re-Attempt                        ← we pressed Re-attempt)
//
//   and when the customer was simply not there, OwnEx decides itself:
//     reason            Reason  "Verified Reason CNA"
//     reattempt         Ready for Re-Attempt      (the same instant)
//     en-route          Out for Delivery
//
//   From that, for each OwnEx parcel on or near the desk:
//     attempts    failed tries by OwnEx's own record (a debrief after a run out)
//     attempt_at  when the latest one failed
//     advice      "reattempt" / "return" given AFTER the latest failed try
//     advice_by   "merchant" when OwnEx had asked us (Waiting for Advice) and
//                 the answer followed — our agent pressed it on the portal;
//                 "courier" when OwnEx verified the reason and acted itself,
//                 or sent the parcel out again with no advice recorded
//   handed to hub_rescue_courier_facts() — the same function PostEx uses.
//
//   The reason is NOT passed: ownex-sync already writes OwnEx's reason into
//   online_logistics.courier_reason_text, and two writers would flip it back
//   and forth. This function reads; it writes nothing but through that one
//   database function.
//
// CALL
//   {}                           the queue (hub_rescue_ownex_queue) — schedule
//   {"tracking_ids": [...]}      exactly these (backfill / checking)
//   {"dry_run": true}            read and report, write nothing
//
// SECRETS: SYNC_KEY (the same one ownex-sync uses). No OwnEx credentials —
// the tracker is public.

import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const TRACK_URL = (id: string) =>
  `https://shipper.ownexpress.pk/api/v1/public/booking/status/${encodeURIComponent(id)}`;

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
    .map((h) => ({ code: String(h.code ?? "").toLowerCase(), status: String(h.status ?? ""), at: when(h.date) }))
    .filter((h) => h.code && Number.isFinite(h.at))
    .sort((a, b) => a.at - b.at);

  /* A try is a run out followed by a debrief. A second debrief with no new
     run out in between is OwnEx re-writing the same try, not another one. */
  let attempts = 0, sawOut = false;
  let tryAt: number | null = null;        // when the latest try failed
  let lastDebrief: number | null = null;  // the latest word on it
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
    let asked = false;                    // OwnEx put it to us: Waiting for Advice
    for (const h of hist) {
      if (h.at < lastDebrief) continue;
      if (h.code === "reason") { asked = /waiting\s*for\s*advice/i.test(h.status); continue; }
      if (h.code === "reattempt" && advice == null) {
        advice = "reattempt"; adviceAt = h.at; adviceBy = asked ? "merchant" : "courier";
      } else if (h.code === "en-route" && advice == null) {
        /* Out again with no advice written down: OwnEx sent it itself. */
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

async function track(id: string): Promise<unknown[] | null> {
  const r = await fetch(TRACK_URL(id), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),          // one slow answer must not stall the run
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null) as { success?: boolean; data?: { history?: unknown[] } } | null;
  if (!j?.success || !j?.data) return null;
  return Array.isArray(j.data.history) ? j.data.history : [];
}

Deno.serve(async (req) => {
  try {
    const gate = Deno.env.get("SYNC_KEY");
    if (!gate || (req.headers.get("x-sync-key") ?? "") !== gate) return json({ error: "unauthorized" }, 401);
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
    for (let i = 0; i < nums.length; i += 5) {               // small waves, polite to a public endpoint
      const wave = nums.slice(i, i + 5);
      const got = await Promise.all(wave.map(async (tn) => {
        try { return { tn, h: await track(tn) }; } catch { return { tn, h: null }; }
      }));
      for (const g of got) {
        if (!g.h) { failed.push(g.tn); continue; }
        facts.push(readHistory(g.h, g.tn));
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const summary = facts.map((f) => ({
      tracking_id: f.tracking_id, attempts: f.attempts, advice: f.advice, by: f.advice_by, last: f.last_code,
    }));
    if (body.dry_run === true) return json({ ok: true, dry_run: true, checked: nums.length, read: facts.length, failed, facts: summary });

    const { data: res, error } = await db.rpc("hub_rescue_courier_facts", {
      p_facts: facts.map(({ last_code: _l, ...f }) => f),
      p_codes: [],
    });
    if (error) return json({ error: error.message, read: facts.length }, 500);
    return json({ ok: true, checked: nums.length, read: facts.length, failed: failed.slice(0, 10), result: res, facts: summary });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
