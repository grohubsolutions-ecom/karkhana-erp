"use client";

/* ---------------------------------------------------------------------------
   DELIVERY UNDER REVIEW — the office's view of the same desk Abdullah works.
   (The folder is still called first-attempt so the address does not change.)

   It is one component and one pair of database functions, used here and in the
   employee portal, so the office and the man on the phone can never be looking
   at two different lists. Everything the screen does is described in
   components/FirstAttemptDesk.tsx.
--------------------------------------------------------------------------- */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import FirstAttemptDesk from "@/components/FirstAttemptDesk";

export default function FirstAttemptPage() {
  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="hidden md:block">
        <Link href="/online/logistics/returns"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
          <ArrowLeft size={14} /> Returns
        </Link>
        <h1 className="mt-2 text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Delivery Under Review</h1>
        <p className="mt-1 max-w-[70ch] text-[13px] text-muted dark:text-[#a89f93]">
          Parcels a courier has failed to deliver, sorted by which attempt they are on, while they are still
          in the customer&rsquo;s city. Ring the customer, copy the rows into the courier&rsquo;s group, type the
          rider&rsquo;s number when they reply, ring him too — before it becomes a return.
        </p>
      </div>
      <FirstAttemptDesk />
    </div>
  );
}
