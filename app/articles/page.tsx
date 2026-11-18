"use client";
/* The Articles list lived here, under Factory → Articles. It now sits beside
 * the form on Add New Article, so this only forwards — a bookmark, an old
 * link or a stale tab lands on the real screen instead of an empty one.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  useEffect(() => { router.replace("/add-article"); }, [router]);
  return <p className="p-8 text-[13px] text-muted">Opening articles…</p>;
}
