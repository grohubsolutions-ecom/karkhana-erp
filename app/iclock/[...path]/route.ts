import type { NextRequest } from "next/server";

/* The ZKTeco terminal calls these addresses itself, so they sit outside the
   login flow. A request is accepted only when its serial number is an enabled
   row in att_devices. The service key stays on the server. */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path?: string[] }> };

const SERIAL = /^[A-Za-z0-9_-]{4,64}$/;
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const text = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

async function rpc<T>(name: string, payload: unknown): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server environment is not configured");
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${name} failed with ${res.status}`);
  return (await res.json()) as T;
}

function allowed(req: NextRequest, serial: string | null) {
  if (!serial || !SERIAL.test(serial)) return Promise.resolve(false);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  return rpc<boolean>("att_device_seen", { p_serial: serial, p_ip: ip });
}

function parseLog(body: string) {
  return body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((raw) => {
    const [user, time, status, verify] = raw.split("\t");
    return { user_id: (user ?? "").trim(), time: (time ?? "").trim(), status: status ?? null, verify: verify ?? null, raw };
  }).filter((p) => p.user_id && STAMP.test(p.time));
}

const options = (serial: string) => [
  `GET OPTION FROM: ${serial}`,
  "ATTLOGStamp=None",
  "OPERLOGStamp=9999",
  "ATTPHOTOStamp=9999",
  "ErrorDelay=30",
  "Delay=10",
  "TransTimes=00:00;14:05",
  "TransInterval=1",
  "TransFlag=TransData AttLog",
  "TimeZone=5",
  "Realtime=1",
  "Encrypt=None",
].join("\n");

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path = [] } = await ctx.params;
  const serial = req.nextUrl.searchParams.get("SN");
  try {
    if (!(await allowed(req, serial))) return text("Device not allowed", 403);
    return text((path[0] ?? "").startsWith("cdata") ? options(serial as string) : "OK");
  } catch (e) {
    console.error("iclock GET failed", e);
    return text("Server error", 500);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path = [] } = await ctx.params;
  const serial = req.nextUrl.searchParams.get("SN");
  const table = req.nextUrl.searchParams.get("table");
  try {
    if (!(await allowed(req, serial))) return text("Device not allowed", 403);
    const body = await req.text();
    if ((path[0] ?? "").startsWith("cdata") && table === "ATTLOG") {
      const saved = await rpc<number>("att_ingest_punches", { p_serial: serial, p_punches: parseLog(body) });
      return text(`OK: ${saved}`);
    }
    return text("OK");
  } catch (e) {
    console.error("iclock POST failed", e);
    return text("Server error", 500);
  }
}
