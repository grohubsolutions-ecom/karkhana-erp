import { LayoutDashboard, ClipboardList, Truck, Wallet, CalendarCheck, Users, Undo2, AlertTriangle, PackageSearch, Gauge, PhoneCall, type LucideIcon } from "lucide-react";
import { requiredFor } from "@/lib/access";

/* ONE LIST OF HUB PLACES, READ BY BOTH THE DESKTOP SIDEBAR AND THE PHONE BARS.
   Two copies would drift: a page added to the sidebar and forgotten on the
   phone is a page phone users cannot reach. */
/* `short` is what the phone strip under the header shows when three children
   share 390px — "Delivery Under Review" does not fit a third of a phone. */
export type HubChild = { label: string; href: string; Icon: LucideIcon; short?: string };
export type HubNavItem = {
  label: string; short: string; href: string; Icon: LucideIcon; soon?: boolean;
  children?: HubChild[];
};

/* Returns sit under Logistics, not Finance. A return is a parcel problem before
   it is a money problem, and the people chasing one are the logistics team. */
export const HUB_NAV: HubNavItem[] = [
  { label: "Dashboard", short: "Home", href: "/online/dashboard", Icon: LayoutDashboard },
  { label: "Orders", short: "Orders", href: "/online/orders", Icon: ClipboardList },
  /* ARTICLES — the product-launch pipeline. It sits above Logistics because a
     product is created before it is ever shipped. */
  { label: "Articles Management", short: "Articles", href: "/online/articles", Icon: PackageSearch },
  { label: "Logistics", short: "Shipping", href: "/online/logistics", Icon: Truck, children: [
      { label: "Shipments", href: "/online/logistics", Icon: Truck },
      { label: "Returns", href: "/online/logistics/returns", Icon: Undo2 },
      /* A parcel that failed an attempt is not a return yet — it is the last
         chance to stop one. It sits beside Returns because it is the same team
         and the same parcel, one step earlier. Named after PostEx's own screen,
         as the owner asked; the URL keeps its first name so links do not break. */
      { label: "Delivery Under Review", short: "Under review", href: "/online/logistics/first-attempt", Icon: PhoneCall },
  ] },
  /* Disputes are a separate job with its own worklist, not a tab inside the
     settlements screen. */
  { label: "Finance", short: "Finance", href: "/online/finance", Icon: Wallet, children: [
      { label: "Settlements", href: "/online/finance", Icon: Wallet },
      { label: "Disputes", href: "/online/finance/disputes", Icon: AlertTriangle },
  ] },
  /* People, grouped. Adding staff and marking attendance is one job. Logins and
     permissions stay in Administration. */
  { label: "People", short: "People", href: "/online/attendance", Icon: CalendarCheck, children: [
      { label: "Attendance", href: "/online/attendance", Icon: CalendarCheck },
      { label: "Employees",  href: "/online/employees",  Icon: Users },
      /* Performance reads the same roster and the same pipeline, so it belongs
         beside them rather than on a page of its own. It is locked tighter than
         its neighbours: seeing how everyone is doing is a manager's business,
         not something a colleague should reach by typing the address. */
      { label: "Performance", href: "/online/performance", Icon: Gauge },
  ] },
];

/* THE MENU SHOWS ONLY WHAT THE PERSON CAN OPEN. A parent disappears when none
   of its children survive, and a parent whose first child is refused points at
   the first child that is not. */
export function visibleNav(can: (req: string[] | null) => boolean): HubNavItem[] {
  return HUB_NAV.map((n) => {
    if (n.children) {
      const kids = n.children.filter((c) => can(requiredFor(c.href)));
      return kids.length ? { ...n, href: kids[0].href, children: kids } : null;
    }
    return can(requiredFor(n.href)) ? n : null;
  }).filter((n): n is HubNavItem => n !== null);
}

const under = (path: string, href: string) => path === href || path.startsWith(href + "/");

/* Which child is open. The most specific match wins, so /online/logistics/returns
   is Returns, not Shipments. */
export function activeChild(path: string, item: HubNavItem): HubChild | undefined {
  return [...(item.children ?? [])].sort((a, b) => b.href.length - a.href.length).find((c) => under(path, c.href));
}
export function isActive(path: string, item: HubNavItem) {
  return item.children ? !!activeChild(path, item) : under(path, item.href);
}

/* The phone header names the page you are on. */
export function hubTitle(path: string): string {
  if (/^\/online\/articles\/[^/]+/.test(path)) return "Article";
  for (const n of HUB_NAV) {
    const c = activeChild(path, n);
    if (c) return c.label;
    if (!n.children && under(path, n.href)) return n.label === "Articles Management" ? "Articles" : n.label;
  }
  return "Hub";
}
