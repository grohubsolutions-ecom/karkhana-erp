/* Shared shapes and helpers for Team & access (K178). */
import { supabase } from "@/lib/supabase";

export type JobRole = {
  id: string; name: string; description: string | null;
  locked: "admin" | "preset" | null; perms: string[]; members: number;
};
export type CatalogueItem = { code: string; grp: string; label: string; sort: number };
export type Member = {
  user_id: string; full_name: string | null; email: string | null; phone: string | null;
  role_id: string | null; role_name: string | null; is_self: boolean;
  created_at: string; last_sign_in_at: string | null;
};

/* The database's own words when it refuses — never a guess of ours. The
   edge function puts its reason in the body; supabase-js hides it behind a
   generic "non-2xx" message unless it is read out of the response. */
export async function callTeam(body: Record<string, unknown>): Promise<string | null> {
  if (!supabase) return "Not connected.";
  const { data, error } = await supabase.functions.invoke("karkhana-team", { body });
  if (error) {
    let msg = error.message || "Something went wrong.";
    try {
      const ctx = (error as { context?: unknown }).context as Response | undefined;
      if (ctx && typeof ctx.json === "function") { const b = await ctx.json(); if (b?.error) msg = b.error; }
    } catch { /* keep msg */ }
    if (/failed to send|not found|404|fetch/i.test(msg)) {
      msg = "The karkhana-team function is not deployed yet. Deploy it in Supabase → Edge Functions, then try again.";
    }
    return msg;
  }
  const e = (data as { error?: string } | null)?.error;
  return e ?? null;
}

/* A password someone can read out over the phone: no 0/O or 1/l/I. */
export function makePassword(): string {
  const a = "abcdefghjkmnpqrstuvwxyz", A = "ABCDEFGHJKMNPQRSTUVWXYZ", d = "23456789";
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  return pick(A) + pick(a) + pick(a) + pick(a) + pick(a) + "-" + pick(d) + pick(d) + pick(d) + pick(d);
}

export function lastSeen(iso: string | null): string {
  if (!iso) return "Never signed in";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return "Active just now";
  if (s < 86400) return `Last seen ${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `Last seen ${Math.floor(s / 86400)}d ago`;
  return `Last seen ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}

export const SYNTH = "@karkhana.local";
