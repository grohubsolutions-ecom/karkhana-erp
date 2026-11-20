"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { hasAny } from "@/lib/access";

type Ctx = { ready: boolean; all: boolean; can: (req: string[] | null) => boolean };
const PermissionsCtx = createContext<Ctx>({ ready: false, all: false, can: () => false });

/* Single source of truth for the signed-in user's permissions.
   AppFrame now loads them together with the password check (lib/boot.ts) and
   passes them in as `boot`, so the provider is ready on its first render — no
   second round trip. Without `boot` it still fetches on its own, as before.
   Super admins always get full access so they can never be locked out. */
export function PermissionsProvider({ children, boot }: {
  children: ReactNode;
  boot?: { perms: string[]; all: boolean } | null;
}) {
  const [state, setState] = useState<{ ready: boolean; perms: Set<string>; all: boolean }>(
    { ready: false, perms: new Set(), all: false }
  );

  useEffect(() => {
    if (boot) return;
    if (!isSupabaseConfigured || !supabase) {
      setState({ ready: true, perms: new Set(), all: true });
      return;
    }
    let active = true;
    (async () => {
      const { data: { session } } = await supabase!.auth.getSession();
      if (!session) { if (active) setState({ ready: true, perms: new Set(), all: false }); return; }
      const [prof, permRes] = await Promise.all([
        supabase!.from("app_users").select("is_super_admin").eq("id", session.user.id).maybeSingle(),
        supabase!.rpc("my_permissions"),
      ]);
      if (!active) return;
      setState({ ready: true, perms: new Set((permRes.data as string[]) ?? []), all: !!prof.data?.is_super_admin });
    })();
    return () => { active = false; };
  }, [boot]);

  const value = useMemo<Ctx>(() => {
    if (boot) {
      const perms = new Set(boot.perms);
      return { ready: true, all: boot.all, can: (req) => boot.all || hasAny(perms, req) };
    }
    return { ready: state.ready, all: state.all, can: (req) => state.all || hasAny(state.perms, req) };
  }, [boot, state]);

  return <PermissionsCtx.Provider value={value}>{children}</PermissionsCtx.Provider>;
}

export function usePermissions() {
  return useContext(PermissionsCtx);
}
