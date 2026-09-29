// postex-review — the courier's own story of a parcel under review.
// Deploy with VERIFY JWT OFF (server-to-server; the caller must hold SYNC_KEY).
//
// WHY THIS EXISTS (H281, 29 Sep 2026)
//   The Delivery Under Review desk said "reason not given" on every PostEx
//   parcel. PostEx does give one — not in the status, which the big sync
//   reads, but in the parcel's history on the same tracking answer:
//
//       "Attempt Made: RFD(REFUSED TO RECEIVE)"   28 Sep 17:55
//       "Delivery Under Review"                    28 Sep 22:27
//       "Merchant Request For Return"              29 Sep 11:57
//
//   From that history this reads, for each parcel on or near the desk:
//     reason      the latest "Attempt Made: …", cleaned to REFUSED TO RECEIVE
//     attempts    how many tries PostEx itself counts
//     attempt_at  when the latest try was made, PostEx's own time
//     advice      "reattempt" / "return" if somebody already asked for it on
//                 PostEx's portal after that try (advice_by "merchant"), or
//                 "return" if PostEx started the return itself ("courier") —
//                 it does, straight after a re-attempt that fails again
//     codes       every "RFD(REFUSED TO RECEIVE)" seen, because a later try
//                 often says only "Attempt Made: RFD"
//   and hands them to hub_rescue_courier_facts(), which writes them where the
//   desk and every other screen read them.
//
//   It is deliberately separate from postex-sync: that job keeps Orders and
//   Logistics filled and is not touched. This one reads only the few dozen
//   parcels the desk cares about (hub_rescue_postex_queue), every 15 minutes,
//   and writes nothing but through that one database function.
//
// SECRETS: POSTEX_API_TOKEN, SYNC_KEY (the same ones postex-sync uses).

import { createClient } from "npm:@supabase/supabase-js@2";

const B = "https://api.postex.pk/services/integration/api/order";
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

type Hist = { msg: string; at: number };
type Fact = {
  tracking_id: string; attempts: number | null; attempt_at: string | null;
  reason: string | null; advice: "reattempt" | "return" | null; advice_at: string | null;
  advice_by: "merchant" | "courier" | null;
};

/* Codes PostEx has been seen to use, with the words it gives them on a first
   try. Anything else is learnt from the history as it is read. */
const KNOWN: Record<string, string> = {
  RFD: "REFUSED TO RECEIVE", CNA: "CUSTOMER NOT AVAILABLE", ICA: "INCOMPLETE ADDRESS",
};
const CODED = /^\s*attempt\s*made\s*[:\-–]?\s*([A-Z0-9]{2,6})\s*\(\s*(.+?)\s*\)\s*$/i;

/* PostEx writes "2026-09-28T17:55:56.000+0500"; the offset needs its colon
   before every runtime will read it. */
function when(v: unknown): number {
  let s = String(v ?? "").trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  /* No offset at all: it is PostEx's own clock, which is Pakistan time. */
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "+05:00";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/* "Attempt Made: RFD(REFUSED TO RECEIVE)" -> "REFUSED TO RECEIVE".
   A message with no code in front is kept as PostEx wrote it. */
function reasonOf(msg: string, codes: Map<string, string>): string | null {
  const rest = msg.replace(/^\s*attempt\s*made\s*[:\-–]?\s*/i, "").trim();
  if (!rest) return null;
  const coded = /^([A-Z0-9]{2,6})\s*\(\s*(.+?)\s*\)\s*$/.exec(rest);
  if (coded) return coded[2].replace(/\s+/g, " ").trim().slice(0, 200);
  /* "RFD" alone: in words if the code is known; otherwise the code itself,
     which the database turns into words once PostEx spells it out anywhere. */
  if (/^[A-Z0-9]{2,6}$/.test(rest)) return codes.get(rest) ?? KNOWN[rest] ?? rest;
  const text = rest.replace(/\s+/g, " ").trim();
  return text.length >= 3 ? text.slice(0, 200) : null;
}

function readHistory(detail: Record<string, unknown>, tracking: string, codes: Map<string, string>): Fact {
  const raw = Array.isArray(detail.transactionStatusHistory) ? detail.transactionStatusHistory : [];
  const hist: Hist[] = (raw as Record<string, unknown>[])
    .map((h) => ({ msg: String(h.transactionStatusMessage ?? "").trim(), at: when(h.updatedAt) }))
    .filter((h) => h.msg && Number.isFinite(h.at))
    .sort((a, b) => a.at - b.at);

  for (const h of hist) {
    const m = CODED.exec(h.msg);
    if (m) codes.set(m[1].toUpperCase(), m[2].replace(/\s+/g, " ").trim().toUpperCase());
  }
  const tries = hist.filter((h) => /^attempt\s*made/i.test(h.msg));
  const last = tries[tries.length - 1];
  let advice: Fact["advice"] = null; let adviceAt: number | null = null;
  let adviceBy: Fact["advice_by"] = null;
  if (last) {
    for (const h of hist) {
      if (h.at < last.at) continue;
      const m = /merchant\s+request\s+for\s+(re-?\s*attempt|return)/i.exec(h.msg);
      if (m) {
        advice = /return/i.test(m[1]) ? "return" : "reattempt"; adviceAt = h.at; adviceBy = "merchant";
      } else if (/return\s+process\s+initiated|^return\s+to\s+/i.test(h.msg)
                 && !(advice === "return" && adviceBy === "merchant")) {
        /* "Return Process Initiated", then "Return to LAHORE": the time is the first. */
        const already = advice === "return" && adviceBy === "courier";
        advice = "return"; adviceBy = "courier";
        if (!already) adviceAt = h.at;
      }
    }
  }
  return {
    tracking_id: tracking,
    attempts: tries.length || null,
    attempt_at: last ? new Date(last.at).toISOString() : null,
    reason: last ? reasonOf(last.msg, codes) : null,
    advice,
    advice_at: adviceAt != null ? new Date(adviceAt).toISOString() : null,
    advice_by: adviceBy,
  };
}

async function track(tracking: string, token: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${B}/v1/track-order/${encodeURIComponent(tracking)}`, {
    method: "GET", headers: { token, "content-type": "application/json" },
    signal: AbortSignal.timeout(10000),        // one slow answer must not stall the run
  });
  if (!r.ok) return null;
  const body = await r.json().catch(() => null) as Record<string, unknown> | null;
  const dist = (body?.dist ?? body) as unknown;
  const d = (Array.isArray(dist) ? dist[0] : dist) as Record<string, unknown> | undefined;
  if (!d) return null;
  return (d.trackingResponse ?? d) as Record<string, unknown>;
}

Deno.serve(async (req) => {
  try {
    const gate = Deno.env.get("SYNC_KEY");
    if (!gate || (req.headers.get("x-sync-key") ?? "") !== gate) return json({ error: "unauthorized" }, 401);
    const token = Deno.env.get("POSTEX_API_TOKEN");
    if (!token) return json({ error: "POSTEX_API_TOKEN not set" }, 400);
    const body = await req.json().catch(() => ({}));
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: queue, error: qErr } = await db.rpc("hub_rescue_postex_queue", { p_limit: Number(body.limit ?? 60) });
    if (qErr) return json({ error: qErr.message }, 500);
    const nums = ((queue ?? []) as { tracking_id: string }[]).map((r) => r.tracking_id).filter(Boolean);
    if (!nums.length) return json({ ok: true, checked: 0, note: "nothing to read" });

    const facts: Fact[] = []; const failed: string[] = [];
    const codes = new Map<string, string>(Object.entries(KNOWN));
    const details: { tn: string; d: Record<string, unknown> }[] = [];
    for (let i = 0; i < nums.length; i += 6) {             // small waves, polite to PostEx
      const wave = nums.slice(i, i + 6);
      const got = await Promise.all(wave.map(async (tn) => {
        try { return { tn, d: await track(tn, token) }; } catch { return { tn, d: null }; }
      }));
      for (const g of got) {
        if (!g.d) { failed.push(g.tn); continue; }
        details.push({ tn: g.tn, d: g.d });
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    /* Two passes, so a code spelt out on one parcel explains a bare code on
       another read in the same run. */
    for (const x of details) readHistory(x.d, x.tn, codes);
    for (const x of details) facts.push(readHistory(x.d, x.tn, codes));

    const { data: res, error } = await db.rpc("hub_rescue_courier_facts", {
      p_facts: facts,
      p_codes: [...codes].map(([code, meaning]) => ({ code, meaning })),
    });
    if (error) return json({ error: error.message, read: facts.length }, 500);
    return json({ ok: true, checked: nums.length, read: facts.length, failed: failed.slice(0, 10), result: res });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
