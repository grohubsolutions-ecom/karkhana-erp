"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft, LayoutDashboard, FileText, CalendarClock, ReceiptText, Banknote,
  Percent, Boxes, Upload, ShoppingCart, LogOut, type LucideIcon,
} from "lucide-react";
import { useProfile } from "@/lib/useProfile";
import { usePermissions } from "@/lib/usePermissions";
import { ROUTE_PERMS, OTHER_DEPARTMENT_PERMS } from "@/lib/access";
import { supabase } from "@/lib/supabase";

/* THE CARREFOUR MENU. Its own door on the home screen (K195), so the two
   report screens moved here from the Karkhana menu: same pages, same URLs. */
const NAV: { label: string; href: string; Icon: LucideIcon }[] = [
  { label: "Dashboard", href: "/carrefour/dashboard", Icon: LayoutDashboard },
  { label: "Stock & sales", href: "/carrefour", Icon: Boxes },
  { label: "Upload report", href: "/carrefour/upload", Icon: Upload },
  { label: "Invoices", href: "/carrefour/invoices", Icon: FileText },
  { label: "Maturity", href: "/carrefour/maturity", Icon: CalendarClock },
  { label: "Debit notes", href: "/carrefour/debit-notes", Icon: ReceiptText },
  { label: "Payments", href: "/carrefour/payments", Icon: Banknote },
  { label: "Terms", href: "/carrefour/terms", Icon: Percent },
];

export default function CarrefourSidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const profile = useProfile();
  const { ready, can } = usePermissions();

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    router.replace("/login");
  }
  const links = NAV.filter((n) => can(ROUTE_PERMS[n.href] ?? null));

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[248px] shrink-0 flex-col border-r border-line bg-surface transition-transform md:static md:z-auto md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        {ready && can(OTHER_DEPARTMENT_PERMS) ? (
          <Link href="/" onClick={onClose} className="flex items-center gap-2 px-6 pt-5 text-[12.5px] font-semibold text-muted transition hover:text-ink">
            <ArrowLeft size={15} /> All departments
          </Link>
        ) : <div className="pt-5" />}
        <div className="flex items-center gap-2.5 px-6 pb-5 pt-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-white"><ShoppingCart size={18} /></span>
          <div className="leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight">Carrefour</div>
            <div className="text-[11px] text-muted">Stock &amp; accounts</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) onClose?.(); }}>
          {links.map(({ label, href, Icon }) => {
            const on = pathname === href;
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-3 rounded-xl2 px-3.5 py-2.5 text-[14px] transition ${on ? "bg-lavender-soft font-semibold text-ink" : "text-muted hover:bg-panel hover:text-ink"}`}>
                <Icon size={18} strokeWidth={2} /> {label}
              </Link>
            );
          })}
        </nav>
        <div className="m-3 flex items-center gap-2.5 rounded-xl2 bg-cream p-3">
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">{profile?.name || "…"}</div>
            <div className="text-[11px] text-muted">{profile?.roleName || ""}</div>
          </div>
          <button onClick={logout} title="Log out" className="shrink-0 rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink"><LogOut size={16} /></button>
        </div>
      </aside>
    </>
  );
}
