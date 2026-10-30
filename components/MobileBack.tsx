"use client";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/* H307 (30 Oct 2026) — THE UNIVERSAL BACK BUTTON FOR THE MOBILE HEADERS.
 *
 * Rendered inside every department's mobile top bar (Karkhana's MobileBar,
 * Hub's HubTopBar, FS Traders' RetailTopBar) so a user has one familiar way
 * to step out of wherever they are. Tap → router.back().
 *
 * NO VISIBILITY CHECKS HERE.
 *   Each top bar only renders on a page where going back makes sense (not on
 *   the department chooser, not on /login). The button therefore inherits that
 *   gate rather than duplicating it. If router.back() has nowhere to go, the
 *   browser does nothing — which is the correct behaviour.
 *
 * TAP TARGET.
 *   40×40 matches the Menu and More buttons already sitting in those headers;
 *   using the same size keeps all three header controls aligned.
 */
export default function MobileBack() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      aria-label="Back"
      className="flex h-10 w-10 flex-none items-center justify-center rounded-xl2 text-ink transition active:bg-panel dark:text-white dark:active:bg-white/[0.08]"
    >
      <ArrowLeft size={20} />
    </button>
  );
}
