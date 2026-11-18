"use client";
import { useCallback, useEffect, useState } from "react";
import { UsersRound, BadgeCheck } from "lucide-react";
import Topbar from "@/components/Topbar";
import TeamPeople from "@/components/karkhana/TeamPeople";
import TeamRoles from "@/components/karkhana/TeamRoles";
import { type JobRole, type CatalogueItem } from "@/components/karkhana/teamShared";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

/* TEAM & ACCESS — the Karkhana admin's room (K178).
 *
 * People: who can log in to Karkhana, and as which job role.
 * Job roles: what each job role may do.
 *
 * Everything here is Karkhana only. The Hub and FS Traders have their own
 * people and are run from Administration; this page cannot see them, and the
 * database would refuse it if it tried. The route itself needs
 * karkhana.admin (lib/access.ts).
 */
const TABS = [
  { key: "people", label: "People", Icon: UsersRound },
  { key: "roles", label: "Job roles", Icon: BadgeCheck },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function KarkhanaTeamPage() {
  const [tab, setTab] = useState<Tab>("people");
  const [roles, setRoles] = useState<JobRole[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadRoles = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const [r, c] = await Promise.all([
      supabase.rpc("karkhana_job_roles"),
      supabase.rpc("karkhana_permission_catalogue"),
    ]);
    if (r.error || c.error) {
      const m = (r.error || c.error)!.message;
      setErr(/function .* does not exist|could not find the function/i.test(m)
        ? "Team & access needs the K178 database update. Run K178_karkhana_portals.sql in Supabase, then refresh."
        : m);
    } else {
      setErr("");
      setRoles((r.data as JobRole[]) ?? []);
      setCatalogue((c.data as CatalogueItem[]) ?? []);
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadRoles(); }, [loadRoles]);

  return (
    <>
      <Topbar title="Team & access" subtitle="Who can log in to Karkhana, and what each person can do" />
      <div className="space-y-4 px-4 pb-12 sm:px-6">
        <div className="flex gap-1 rounded-full border border-line bg-surface p-1 sm:inline-flex">
          {TABS.map(({ key, label, Icon }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-semibold transition sm:flex-none ${
                tab === key ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted hover:text-ink"}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {err ? (
          <div className="rounded-card border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>
        ) : tab === "people" ? (
          loading
            ? <p className="text-[13px] text-hint">Loading…</p>
            : <TeamPeople roles={roles} catalogue={catalogue} onChanged={loadRoles} />
        ) : (
          <TeamRoles roles={roles} catalogue={catalogue} loading={loading} onChanged={loadRoles} />
        )}
      </div>
    </>
  );
}
