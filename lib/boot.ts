"use client";
import { supabase } from "@/lib/supabase";

/* ONE START-UP CHECK, CACHED.
 *
 * Every screen used to wait for two network trips, one after the other:
 * AppFrame asked app_users for must_change_password, and only once that came
 * back did PermissionsProvider start, ask for the session again, then ask for
 * is_super_admin + my_permissions. Nothing was drawn until both had finished —
 * that wait was most of the "4 seconds" on a cold open.
 *
 * Now it is one trip (the two queries run side by side), and the answer is kept
 * in localStorage per user. On the next open the screen draws at once from the
 * kept copy and the fresh answer replaces it a moment later. The copy only
 * decides which boxes and menus are DRAWN — every read and write is still
 * checked by the database (RLS), so a stale copy can never open data a person
 * is not allowed to see. */
export type Boot = { uid: string; mustChange: boolean; perms: string[]; all: boolean };

const KEY = "kk-boot-v1";

export function readBoot(uid: string): Boot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Boot;
    return b && b.uid === uid && Array.isArray(b.perms) ? b : null;
  } catch {
    return null;
  }
}

export function writeBoot(b: Boot) {
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* private mode / full */ }
}

export function clearBoot() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export async function fetchBoot(uid: string): Promise<Boot> {
  const [prof, permRes] = await Promise.all([
    supabase!.from("app_users").select("must_change_password, is_super_admin").eq("id", uid).maybeSingle(),
    supabase!.rpc("my_permissions"),
  ]);
  if (prof.error && permRes.error) throw prof.error;
  return {
    uid,
    mustChange: !!prof.data?.must_change_password,
    perms: ((permRes.data as string[]) ?? []),
    all: !!prof.data?.is_super_admin,
  };
}
