"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { usePermissions } from "@/lib/usePermissions";
/* requiredFor, not ROUTE_PERMS[href]: it is the same prefix-aware lookup the
   page lock in AppFrame uses. /online/finance/disputes has no entry of its own,
   so ROUTE_PERMS[...] ?? null would have read "no permission needed" and sent
   everybody there — straight into a locked page. */
import { requiredFor } from "@/lib/access";

/* THE HUB HOME IS A DOORWAY, NOT A SECOND DASHBOARD.
 *
 * The "Hub Department" card on the home page opens /online. This file used to
 * be a full copy of the dashboard, which caused two problems:
 *
 *   1. TWO DASHBOARDS DRIFT. Every fix to /online/dashboard left this copy
 *      behind. It still counted by-store sales from a 1,000-row list and still
 *      showed COD receivable as Rs 16,091 — so the card you actually click
 *      showed the broken numbers after the real page was fixed, and a fix
 *      looked like it had been undone.
 *
 *   2. IT HAD NO LOCK. /online carries no route permission, so any signed-in
 *      user could open it and read Hub sales. The database functions now
 *      require hub.dashboard.view too, but the page should not have been open
 *      in the first place.
 *
 * Now it sends each person to the first Hub page they are allowed to open, in
 * the same order as the sidebar. Whoever holds the dashboard lands on the
 * dashboard; anyone else lands on the first thing that is theirs.
 */
const LANDING = [
  "/online/dashboard",
  "/online/orders",
  "/online/articles",
  "/online/logistics",
  "/online/logistics/returns",
  "/online/finance",
  "/online/finance/disputes",
  "/online/daraz",
  "/online/attendance",
  "/online/employees",
  "/online/calling",
];

export default function HubHome() {
  const router = useRouter();
  const { ready, can } = usePermissions();
  const target = ready ? LANDING.find((href) => can(requiredFor(href))) : undefined;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (!ready || target) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="px-6 py-16 text-center">
      <p className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">Nothing in the Hub department is open to your account.</p>
      <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">Your own work and attendance are under My page.</p>
      <button onClick={() => router.push("/me")}
        className="mt-4 rounded-full bg-ink px-4 py-2 text-[12.5px] font-semibold text-white dark:bg-white dark:text-[#141414]">
        Go to My page
      </button>
    </div>
  );
}
