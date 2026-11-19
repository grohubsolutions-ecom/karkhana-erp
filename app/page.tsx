"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Factory, ShoppingBag, Store, ShoppingCart, ShieldCheck, Wallet, ChevronRight, LogOut } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import ThemeToggle from "@/components/ThemeToggle";
import { usePermissions } from "@/lib/usePermissions";
import { karkhanaLanding } from "@/lib/access";

const DEPARTMENTS = [
  /* EVERY BOX NEEDS A PERMISSION, not just Administration.
     These three had none, so anyone who could log in saw all three — including
     an employee whose account grants nothing. He could not open them, because
     the routes are gated, but being shown three doors that all refuse you is
     worse than being shown none: it says the system has places for you and then
     turns you away at each one.

     A box now appears only if the person can reach something behind it. */
  { href: "/dashboard", title: "Karkhana", subtitle: "Production, materials, inventory & payroll", icon: Factory, light: "bg-amber-soft", chip: "dark:bg-amber",
    /* khana.view and karkhana.admin (K178): a warehouse operator and a
       Karkhana admin are Karkhana people, and neither needs reports. */
    needs: ["inventory.view", "production.view", "reports.view", "employees.manage", "payments.manage",
            "khana.view", "karkhana.admin"] },
  /* K199 — the daily wage desk is its own portal. The wage supervisor has
     only this box, so he is taken straight into it (see below); the owner
     sees it beside the other departments. */
  { href: "/wage-desk", title: "Daily Wage Desk", subtitle: "Karkhana daily workers · check in/out & cash pay", icon: Wallet, light: "bg-success-soft", chip: "dark:bg-success",
    needs: ["wages.desk"] },
  { href: "/online", title: "Hub Department", subtitle: "Online orders · Little Minors, TopShop, Trenzee", icon: ShoppingBag, light: "bg-periwinkle-soft", chip: "dark:bg-periwinkle",
    needs: ["hub.dashboard.view", "hub.orders.view", "hub.logistics.view", "hub.finance.view", "hub.attendance.view"] },
  /* These two permissions never existed. The table has retail.access and, since
     0119, the retail.<area>.<verb> set — "retail.view" and "retail.manage" are
     neither, so can() returned false for every normal user and this box only
     ever appeared for super admins, who skip the check. It looked fine to the
     only people who ever looked. */
  { href: "/retail", title: "Shops Sales", subtitle: "Retail shops · sales, cash book & commissions", icon: Store, light: "bg-salmon-soft", chip: "dark:bg-salmon",
    needs: ["retail.access", "retail.dashboard.view", "retail.sales.view", "retail.cashbook.view",
            "retail.expenses.view", "retail.employees.view", "retail.payroll.view"] },
  /* K195 — Carrefour is one customer, but it pays on its own 100-day clock with
     its own deductions, so it has its own door. */
  { href: "/carrefour", title: "Carrefour", subtitle: "LPOs, invoices, returns, stock & finance", icon: ShoppingCart, light: "bg-lavender-soft", chip: "dark:bg-lavender",
    needs: ["carrefour.view", "carrefour.upload", "carrefour.orders.view", "carrefour.orders.manage", "carrefour.accounts.view", "carrefour.accounts.manage"] },
  /* Administration is not a business — it is the room where people and access
     are managed. It carries a `needs` list, so it only appears for someone who
     can actually manage users or roles. Staff never see it at all, which is
     better than showing a box that refuses them when they press it. */
  { href: "/administration", title: "Administration", subtitle: "Employees, logins, roles & permissions", icon: ShieldCheck, light: "bg-periwinkle-soft", chip: "dark:bg-periwinkle",
    needs: ["users.manage", "roles.manage"] },
];

export default function DepartmentChooser() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const { ready, can } = usePermissions();

  /* Hidden until permissions have actually loaded. Rendering first and
     removing after would flash Administration at every employee for a moment,
     which is exactly the sort of thing people notice and remember. */
  const visible = DEPARTMENTS.filter((d) => !d.needs || (ready && can(d.needs)));

  /* SOMEBODY WITH NO DEPARTMENT DOES NOT GET A DEPARTMENT CHOOSER.
     An employee's account grants nothing, so every box is filtered out and this
     page becomes an empty screen asking them to choose. Their portal is the
     whole application as far as they are concerned, so they are sent there
     instead of being shown a lobby with no doors. */
  useEffect(() => {
    if (ready && visible.length === 0) router.replace("/me");
  }, [ready, visible.length, router]);

  /* ONE DOOR, NO LOBBY — for Karkhana people.
     A Karkhana employee (or the Karkhana admin) has exactly one box here. A
     chooser with a single choice is a click that tells him nothing, so he is
     taken straight to his first Karkhana screen. Only Karkhana: the Hub and
     FS Traders decide their own front doors. */
  const onlyKarkhana = ready && visible.length === 1 && visible[0].title === "Karkhana";
  const landing = ready ? karkhanaLanding(can) : "/dashboard";
  useEffect(() => {
    if (onlyKarkhana) router.replace(landing);
  }, [onlyKarkhana, landing, router]);

  /* ONE DOOR, NO LOBBY — for the wage supervisor (K199).
     His login opens the wage desk and nothing else. Without this he fell
     through to /me ("Not linked yet"), and on a phone every cold open of the
     app lands here first, so a bookmark to /wage-desk never survived. */
  const onlyWageDesk = ready && visible.length === 1 && visible[0].href === "/wage-desk";
  useEffect(() => {
    if (onlyWageDesk) router.replace("/wage-desk");
  }, [onlyWageDesk, router]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user?.email ?? ""));
  }, []);

  /* Nothing to choose — do not flash a one-box chooser on the way through. */
  if (onlyKarkhana || onlyWageDesk) return <div className="min-h-screen bg-canvas dark:bg-[#17140f]" />;

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas dark:bg-[#17140f]">
      {/* utility bar */}
      <div className="flex items-center justify-between px-5 py-4 sm:px-8">
        <span className="text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">Group workspace</span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={signOut}
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      {/* chooser */}
      <div className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-[560px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-[18px] bg-ink text-white shadow-card dark:bg-white dark:text-[#141414]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5" /><path d="M12 12v10" /></svg>
            </span>
            <h1 className="text-[26px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Grohub Solutions</h1>
            <p className="mt-1.5 text-[14px] font-medium text-muted dark:text-[#a89f93]">{email ? "Welcome back — choose a department" : "Choose a department"}</p>
          </div>

          <div className="flex flex-col gap-3.5">
            {visible.map(({ href, title, subtitle, icon: Icon, light, chip }) => (
              <Link
                key={href}
                href={title === "Karkhana" ? landing
                  : title === "Carrefour" && can(["carrefour.accounts.view", "carrefour.accounts.manage"]) ? "/carrefour/dashboard"
                  : title === "Carrefour" && can(["carrefour.orders.view", "carrefour.orders.manage"]) ? "/carrefour/orders"
                  : href}
                className={`reveal group flex items-center gap-4 rounded-card border border-line ${light} px-5 py-[18px] shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card dark:border-white/[0.06] dark:bg-[#201c17] dark:shadow-none dark:hover:bg-[#26221b]`}
              >
                <span className={`flex h-12 w-12 flex-none items-center justify-center rounded-[15px] bg-ink text-white dark:text-[#141414] ${chip}`}>
                  <Icon size={24} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16.5px] font-bold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</span>
                  <span className="mt-0.5 block text-[13px] font-medium text-muted dark:text-[#a89f93]">{subtitle}</span>
                </span>
                <ChevronRight size={18} className="flex-none text-hint transition group-hover:translate-x-0.5 dark:text-[#8a8175]" />
              </Link>
            ))}
          </div>

          <p className="mt-6 text-center text-[12px] font-medium text-hint dark:text-[#8a8175]">Signed in as {email || "administrator"} · one login for all three businesses</p>
        </div>
      </div>
    </div>
  );
}
