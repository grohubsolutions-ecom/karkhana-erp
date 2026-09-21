"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/* RETIRED PAGE.
 * The System and Chase screens were removed on request, and the database
 * functions they called (hub_system_checks, hub_chase_list, hub_chase_note)
 * were dropped in H247 — so this page could only ever show an error. It also
 * sat outside every route permission, open to any signed-in user.
 *
 * Deploying a zip cannot delete a folder, so the file stays and does nothing
 * but send the visitor to the Hub home, which takes each person to the first
 * Hub page they are allowed to open. Safe to delete this folder at any time.
 */
export default function Retired() {
  const router = useRouter();
  useEffect(() => { router.replace("/online"); }, [router]);
  return null;
}
