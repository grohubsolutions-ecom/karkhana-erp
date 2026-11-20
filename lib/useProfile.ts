"use client";
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export type Profile = { name: string; email: string; isSuperAdmin: boolean; roleName: string };

/** Loads the signed-in user's profile (full name + role) once. */
/* Kept for the life of the tab: the sidebar re-mounts on every department
   switch and used to fetch this again each time — through getUser(), which is
   a round trip to the auth server, before the app_users query could even start.
   getSession() reads the stored session instantly; the name is only shown. */
let cached: Profile | null = null;
if (typeof window !== "undefined" && supabase) {
  supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") cached = null; });
}

export function useProfile(): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(cached);

  useEffect(() => {
    if (!supabase || cached) return;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;
      const { data } = await supabase
        .from("app_users")
        .select("full_name, is_super_admin, user_roles(roles(name))")
        .eq("id", user.id)
        .maybeSingle();

      const isSA = !!data?.is_super_admin;
      const urs = (data as { user_roles?: { roles?: { name?: string } }[] } | null)?.user_roles;
      const firstRole = urs && urs.length > 0 ? urs[0].roles?.name : undefined;
      const roleName = isSA ? "Super Admin" : (firstRole || "User");

      cached = {
        name: data?.full_name || user.email || "",
        email: user.email || "",
        isSuperAdmin: isSA,
        roleName,
      };
      setProfile(cached);
    })();
  }, []);

  return profile;
}
