"use client";
import { useEffect, useState, type PointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Factory, ShoppingBag, Store, ShoppingCart, ShieldCheck, Wallet, ArrowUpRight, LogOut } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import ThemeToggle from "@/components/ThemeToggle";
import { usePermissions } from "@/lib/usePermissions";
import { karkhanaLanding } from "@/lib/access";
import { clearBoot } from "@/lib/boot";

const DEPARTMENTS = [
  /* EVERY BOX NEEDS A PERMISSION, not just Administration.
     These three had none, so anyone who could log in saw all three — including
     an employee whose account grants nothing. He could not open them, because
     the routes are gated, but being shown three doors that all refuse you is
     worse than being shown none: it says the system has places for you and then
     turns you away at each one.

     A box now appears only if the person can reach something behind it. */
  { href: "/dashboard", title: "Karkhana", subtitle: "Production, materials, inventory & payroll", icon: Factory, tint: "amber", anim: "factory", chip: "dark:bg-amber",
    /* khana.view and karkhana.admin (K178): a warehouse operator and a
       Karkhana admin are Karkhana people, and neither needs reports. */
    needs: ["inventory.view", "production.view", "reports.view", "employees.manage", "payments.manage",
            "khana.view", "karkhana.admin"] },
  /* K199 — the daily wage desk is its own portal. The wage supervisor has
     only this box, so he is taken straight into it (see below); the owner
     sees it beside the other departments. */
  { href: "/wage-desk", title: "Daily Wage Desk", subtitle: "Karkhana daily workers · check in/out & cash pay", icon: Wallet, tint: "success", anim: "wallet", chip: "dark:bg-success",
    needs: ["wages.desk"] },
  { href: "/online", title: "Hub Department", subtitle: "Online orders · Little Minors, TopShop, Trenzee", icon: ShoppingBag, tint: "periwinkle", anim: "bag", chip: "dark:bg-periwinkle",
    needs: ["hub.dashboard.view", "hub.orders.view", "hub.logistics.view", "hub.finance.view", "hub.attendance.view",
            "hub.calling.work", "hub.calling.manage"] },
  /* These two permissions never existed. The table has retail.access and, since
     0119, the retail.<area>.<verb> set — "retail.view" and "retail.manage" are
     neither, so can() returned false for every normal user and this box only
     ever appeared for super admins, who skip the check. It looked fine to the
     only people who ever looked. */
  { href: "/retail", title: "Shops Sales", subtitle: "Retail shops · sales, cash book & commissions", icon: Store, tint: "salmon", anim: "store", chip: "dark:bg-salmon",
    needs: ["retail.access", "retail.dashboard.view", "retail.sales.view", "retail.cashbook.view",
            "retail.expenses.view", "retail.employees.view", "retail.payroll.view"] },
  /* K195 — Carrefour is one customer, but it pays on its own 100-day clock with
     its own deductions, so it has its own door. */
  { href: "/carrefour", title: "Carrefour", subtitle: "LPOs, invoices, returns, stock & finance", icon: ShoppingCart, tint: "lavender", anim: "cart", chip: "dark:bg-lavender",
    needs: ["carrefour.view", "carrefour.upload", "carrefour.orders.view", "carrefour.orders.manage", "carrefour.accounts.view", "carrefour.accounts.manage"] },
  /* Administration is not a business — it is the room where people and access
     are managed. It carries a `needs` list, so it only appears for someone who
     can actually manage users or roles. Staff never see it at all, which is
     better than showing a box that refuses them when they press it. */
  { href: "/administration", title: "Administration", subtitle: "Employees, logins, roles & permissions", icon: ShieldCheck, tint: "pink", anim: "shield", chip: "dark:bg-pink",
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

  /* ONE DOOR, NO LOBBY — for the calling agent (H322). Her login opens the
     Calling Agent desk and nothing else in the Hub, so she goes straight in. */
  const onlyCalling = ready && visible.length === 1 && visible[0].href === "/online"
    && can(["hub.calling.work"])
    && !can(["hub.dashboard.view", "hub.orders.view", "hub.logistics.view", "hub.finance.view", "hub.attendance.view"]);
  useEffect(() => {
    if (onlyCalling) router.replace("/online/calling");
  }, [onlyCalling, router]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user?.email ?? ""));
  }, []);

  /* Nothing to choose — do not flash a one-box chooser on the way through. */
  if (onlyKarkhana || onlyWageDesk || onlyCalling) return <div className="min-h-screen bg-canvas dark:bg-[#17140f]" />;

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    clearBoot();
    router.push("/login");
  }

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-canvas dark:bg-[#17140f]">
      {/* liquid colour drifting behind the glass */}
      <div className="aura" aria-hidden><i /><i /><i /></div>

      {/* utility bar — a floating glass pill */}
      <div className="relative z-10 px-3 pt-[calc(10px+env(safe-area-inset-top))] sm:px-6 sm:pt-5">
        <div className="glass mx-auto flex max-w-[1040px] items-center justify-between rounded-full py-1.5 pl-4 pr-1.5">
          <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">
            <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-success" aria-hidden />
            <span className="truncate">Group workspace</span>
          </span>
          <div className="flex flex-none items-center gap-1.5">
            <ThemeToggle />
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-white transition active:scale-95 hover:opacity-90 dark:bg-white dark:text-[#141414]"
            >
              <LogOut size={14} /> <span className="hidden min-[360px]:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>

      {/* chooser */}
      <div className="relative z-10 flex flex-1 items-start justify-center px-3 pb-[calc(24px+env(safe-area-inset-bottom))] pt-6 sm:items-center sm:px-6 sm:pb-12 sm:pt-8">
        <div className="w-full max-w-[1040px]">
          <div className="dept-in dept-home mb-6 flex flex-col items-center text-center sm:mb-9">
            <span className="glass-sheen mb-3.5 flex h-14 w-14 items-center justify-center rounded-[18px] bg-ink text-white shadow-card dark:bg-white dark:text-[#141414] sm:h-16 sm:w-16 sm:rounded-[20px]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5" /><path d="M12 12v10" /></svg>
            </span>
            <h1 className="text-[24px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea] sm:text-[30px]">Grohub Solutions</h1>
            <p className="mt-1 text-[13.5px] font-medium text-muted dark:text-[#a89f93] sm:text-[14.5px]">{email ? `${greet} — choose a department` : "Choose a department"}</p>
          </div>

          {/* Two to a row on a phone (left, right, then the next pair), three on
              a computer. A lone last tile takes the whole row on a phone. */}
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-3 [&>a:last-child:nth-child(odd)]:col-span-2 lg:[&>a:last-child:nth-child(odd)]:col-span-1">
            {visible.map(({ href, title, subtitle, icon: Icon, tint, anim, chip }, i) => (
              <Link
                key={href}
                href={title === "Karkhana" ? landing
                  : title === "Carrefour" && can(["carrefour.accounts.view", "carrefour.accounts.manage"]) ? "/carrefour/dashboard"
                  : title === "Carrefour" && can(["carrefour.orders.view", "carrefour.orders.manage"]) ? "/carrefour/orders"
                  : href}
                onPointerDown={ripple}
                style={{ background: `var(--tile-${tint})`, animationDelay: `${60 + i * 55}ms` }}
                className="tile-in glass-sheen group relative flex min-h-[148px] flex-col justify-between rounded-[26px] border border-white/70 p-3.5 text-ink shadow-soft outline-none transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-card focus-visible:ring-2 focus-visible:ring-ink/40 active:scale-[0.97] dark:border-white/[0.07] dark:text-[#f4f1ea] dark:shadow-none sm:min-h-[184px] sm:rounded-[30px] sm:p-5"
              >
                <span className="relative z-[1] flex items-start justify-between">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-[15px] bg-ink text-white shadow-soft dark:text-[#141414] sm:h-[52px] sm:w-[52px] sm:rounded-[17px] ${chip}`}>
                    <span className="dept-icon" data-anim={anim}><span><Icon size={22} strokeWidth={1.8} /></span></span>
                  </span>
                  <span className="glass flex h-8 w-8 items-center justify-center rounded-full text-ink transition-transform duration-200 group-hover:rotate-45 dark:text-[#f4f1ea] sm:h-9 sm:w-9">
                    <ArrowUpRight size={16} />
                  </span>
                </span>
                <span className="relative z-[1] mt-4 block min-w-0">
                  <span className="block text-[15px] font-bold leading-tight tracking-tight sm:text-[18px]">{title}</span>
                  <span className="mt-1 line-clamp-2 text-[11.5px] font-medium leading-snug text-muted dark:text-[#b3aa9d] sm:text-[13px]">{subtitle}</span>
                </span>
              </Link>
            ))}
          </div>

          <p className="mx-auto mt-6 w-fit max-w-full truncate rounded-full px-1 text-center text-[11.5px] font-medium text-hint dark:text-[#8a8175] sm:text-[12px]">Signed in as {email || "administrator"} · one login for all three businesses</p>
        </div>
      </div>
    </div>
  );
}

/* Android-style touch ripple, spreading from where the finger landed. */
function ripple(e: PointerEvent<HTMLAnchorElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.left = `${e.clientX - r.left}px`;
  dot.style.top = `${e.clientY - r.top}px`;
  el.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
  window.setTimeout(() => dot.remove(), 900);
}
