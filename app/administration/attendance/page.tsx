"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import Topbar from "@/components/Topbar";
import { Segmented } from "@/components/HubUI";
import { isSupabaseConfigured } from "@/lib/supabase";
import TodayTab from "@/components/attendance/TodayTab";
import StaffTab from "@/components/attendance/StaffTab";
import ShiftsTab from "@/components/attendance/ShiftsTab";
import ReviewTab from "@/components/attendance/ReviewTab";
import PlannerTab from "@/components/attendance/PlannerTab";
import ReportsTab from "@/components/attendance/ReportsTab";
import PayrollTab from "@/components/attendance/PayrollTab";
import WagesTab from "@/components/attendance/WagesTab";

type Tab = "today" | "staff" | "shifts" | "review" | "planner" | "wages" | "payroll" | "reports";
const TABS: { key: Tab; label: string; short?: string }[] = [
  { key: "today", label: "Today" },
  { key: "staff", label: "Staff" },
  { key: "shifts", label: "Shifts & departments", short: "Shifts" },
  { key: "review", label: "Review" },
  { key: "planner", label: "Leave & extras", short: "Leave" },
  { key: "wages", label: "Daily wages", short: "Wages" },
  { key: "payroll", label: "Payroll" },
  { key: "reports", label: "Reports" },
];

export default function AttendancePage() {
  const [tab, setTab] = useState<Tab>("today");
  return (
    <>
      <Topbar title="Attendance & payroll" subtitle="Machine punches, shifts, wages and salaries" />
      <div className="px-6 pb-10">
        <Link href="/administration" className="mb-4 flex w-fit items-center gap-1.5 text-[13px] font-semibold text-muted transition hover:text-ink">
          <ArrowLeft size={15} /> Administration
        </Link>
        {!isSupabaseConfigured ? (
          <div className="rounded-card bg-surface p-8 text-center text-[14px] text-muted shadow-card">Connect Supabase to use attendance.</div>
        ) : (
          <>
            <Segmented className="mb-5 w-full" value={tab} onChange={setTab} options={TABS} />
            {tab === "today" && <TodayTab />}
            {tab === "staff" && <StaffTab />}
            {tab === "shifts" && <ShiftsTab />}
            {tab === "review" && <ReviewTab />}
            {tab === "planner" && <PlannerTab />}
            {tab === "wages" && <WagesTab />}
            {tab === "payroll" && <PayrollTab />}
            {tab === "reports" && <ReportsTab />}
          </>
        )}
      </div>
    </>
  );
}
