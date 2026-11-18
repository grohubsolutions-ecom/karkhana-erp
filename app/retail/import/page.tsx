"use client";
/* THE IMPORT ROUTE, KEPT ALIVE FOR LINKS THAT ALREADY EXIST.
 *
 * There is no Import entry in the menu any more: the uploader opens inside
 * Sales, Non-cash and Expenses, which is where somebody actually is when a file
 * needs to go in. This page is the same component on a page of its own, so an
 * old bookmark, a link in a note, or the dashboard's reminder still lands
 * somewhere that works instead of on a 404.
 */
import { Shell, PageHeader } from "@/components/retail/kit";
import { ImportPanel } from "@/components/retail/ImportPanel";

export default function RetailImportPage() {
  return (
    <Shell>
      <PageHeader title="Import" subtitle="Drop any NimbusRMS export — CSV, Excel or PDF. The file says what it is." />
      <ImportPanel />
    </Shell>
  );
}
