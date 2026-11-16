"use client";
import { Search, Plus } from "lucide-react";
import Link from "next/link";
import Clock from "./Clock";
import KarkhanaBell from "./KarkhanaBell";

export default function Topbar({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: { label: string; href: string };
}) {
  return (
    /* Phone: the clock and the search box are hidden — the clock took three
       lines of a 390px screen, and the box searches nothing (it has never had
       a handler). The title is a size smaller. Computer: unchanged. */
    <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 md:px-6 md:py-5">
      <div className="min-w-0">
        <h1 className="text-[21px] font-extrabold tracking-tight text-ink md:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2.5 empty:hidden">
        <div className="hidden md:block"><Clock /></div>
        <div className="hidden items-center gap-2 rounded-full md:flex border border-line bg-surface px-3.5 py-2">
          <Search size={15} className="text-hint" />
          <input
            placeholder="Search GRN, material, employee…"
            className="w-40 bg-transparent text-[13px] outline-none placeholder:text-hint lg:w-56"
          />
        </div>
        {/* Was a picture of a bell with a red dot that never changed. It is a
            real one now (K178). On a phone the bell lives in the sticky phone
            header instead, where it cannot scroll away — up to 1023px now,
            since the phone header shows up to there. */}
        <div className="hidden lg:block"><KarkhanaBell /></div>
        {action && (
          <Link href={action.href} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white">
            <Plus size={16} /> {action.label}
          </Link>
        )}
      </div>
    </header>
  );
}
