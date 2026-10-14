/* THE MENU, AS THE OLD GROHUB RETAIL APP HAD IT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SHOPS ARE THE TOP LEVEL. SCREENS LIVE UNDER THEM.
 *
 *   ● Dashboard
 *
 *   SHOPS
 *   ● Top Shop        ▸   Sales · Expenses · Non-cash · Cash Book · Commissions
 *                         Employee ▸  Attendance · Monthly Summary · Ledger · Employees
 *   ● FC Paragon      ▸   …the same five, for that shop
 *   ● FC DHA          ▸
 *
 *   ● Head Office     ▸   Daily cash flow · End of day
 *                         Employee ▸  Attendance · Monthly Summary · Employees
 *
 *   MANAGE
 *   ● Card Reconciliation
 *   ● Bank Statements
 *   ● Salary
 *   ● Branches
 *
 * This is a direct translation of `buildNav()` and `SHOP_ITEMS` from the old
 * single-file app — same order, same grouping, same words, same accordion
 * behaviour where opening one shop closes the others. It replaces the port's
 * first attempt, which listed the screens at the top level with a branch
 * dropdown on each one. That inverted how the business is actually run: you
 * think "FC DHA, cash book", not "cash book, which shop again".
 *
 * WHAT IS DELIBERATELY NOT COPIED
 *   · Day Close is not in the old app. It sits under each shop, where the rest
 *     of that shop's day already lives.
 *   · Import is not a shop screen and is under MANAGE — see the note there.
 *   · Repayments exists in this build and had no menu entry in the old one. It
 *     is under Employee with the rest.
 *
 * Head Office is a TOP-LEVEL item placed after the shops, not inside the SHOPS
 * group — it sells nothing and is not a shop. That is how the old menu had it
 * and the distinction matters to anyone reading the list.
 */
import {
  LayoutDashboard, Receipt, Store, BookText, Percent, Wallet, Building2, Upload,
  CreditCard, Landmark, Users, CalendarCheck, CalendarRange, Coins, NotebookPen,
  Banknote, ArrowLeftRight, Briefcase, ListChecks, type LucideIcon,
} from "lucide-react";
import type { Branch } from "@/components/retail/kit";
import { shopList, type Shop } from "@/lib/retailShop";

export type NavLeaf = {
  label: string;
  short?: string;
  href: string;
  Icon: LucideIcon;
  /** The accent the old app gave this entry. Kept so the menu reads the same. */
  colour?: string;
};
export type NavItem = NavLeaf & { children?: NavLeaf[] };

/* THE FIVE SCREENS UNDER EVERY SHOP, in the old app's order and colours.
   The order is the order of the day: what sold, what went out, what was not
   cash, does the till balance, what did the shop earn. */
export const SHOP_SCREENS: NavLeaf[] = [
  { label: "Sales",       href: "/retail/sales",       Icon: Receipt,        colour: "#0891b2" },
  { label: "Expenses",    href: "/retail/expenses",    Icon: NotebookPen,    colour: "#d97706" },
  { label: "Non-cash",    href: "/retail/payments",    Icon: ArrowLeftRight, colour: "#e11d48" },
  { label: "Cash Book",   href: "/retail/cashbook",    Icon: BookText,       colour: "#059669" },
  { label: "Commissions", href: "/retail/commissions", Icon: Percent,        colour: "#7c3aed" },
  { label: "Day Close",   href: "/retail/close",       Icon: ListChecks,     colour: "#0ea5e9" },
];

/** The Employee sub-menu under a shop. The old app listed four; Repayments is
 *  the fifth because this build has the screen and hiding it helps nobody. */
export const SHOP_STAFF: NavLeaf[] = [
  { label: "Attendance",      href: "/retail/employees/attendance", Icon: CalendarCheck },
  { label: "Monthly Summary", href: "/retail/employees/summary",    Icon: CalendarRange },
  { label: "Ledger",          href: "/retail/employees/ledger",     Icon: NotebookPen },
  { label: "Repayments",      href: "/retail/employees/repayments", Icon: Coins },
  { label: "Employees",       href: "/retail/employees",            Icon: Users },
];

/** Head Office's own two screens, then its staff. Head Office has no sales, so
 *  no Sales / Non-cash / Cash Book / Commissions — exactly as before. */
export const HO_SCREENS: NavLeaf[] = [
  { label: "Daily cash flow", short: "Cash flow", href: "/retail/ho/cashflow", Icon: ArrowLeftRight },
  { label: "End of day",      href: "/retail/ho/eod",        Icon: Banknote },
];
export const HO_STAFF: NavLeaf[] = [
  { label: "Attendance",      href: "/retail/ho/attendance", Icon: CalendarCheck },
  { label: "Monthly Summary", href: "/retail/ho/summary",    Icon: CalendarRange },
  { label: "Ledger",          href: "/retail/ho/ledger",     Icon: NotebookPen },
  { label: "Repayments",      href: "/retail/ho/repayments", Icon: Coins },
  { label: "Employees",       href: "/retail/ho/employees",  Icon: Users },
];

/** The cross-shop screens. These are not about one shop, which is why they sit
 *  in their own group at the bottom rather than repeating under all nine. */
export const MANAGE: NavLeaf[] = [
  /* IMPORT IS NOT A SHOP SCREEN. It was under every shop in the first version
     of this menu, which was wrong in a way that mattered: the Nimbus files name
     their own store and the importer matches each row to a branch by
     `nimbus_name`, so one upload can file sales to six shops at once. Putting it
     under "FC DHA" told people it imports FC DHA — it does not, and a screen
     that lies about its scope is how somebody ends up uploading the same file
     nine times. The old Grohub menu had it outside the shops for this reason. */
  { label: "Import",              short: "Import", href: "/retail/import",  Icon: Upload,     colour: "#64748b" },
  { label: "Card Reconciliation", short: "Cards", href: "/retail/cards",    Icon: CreditCard, colour: "#0ea5e9" },
  { label: "Bank Statements",     short: "Bank",  href: "/retail/bank",     Icon: Landmark,   colour: "#16a34a" },
  { label: "Salary",              href: "/retail/salaries", Icon: Wallet,   colour: "#0891b2" },
  { label: "Branches",            href: "/retail/branches", Icon: Building2, colour: "#475569" },
];

export const DASHBOARD: NavLeaf = {
  label: "Dashboard", short: "Home", href: "/retail/dashboard",
  Icon: LayoutDashboard, colour: "#2563eb",
};
export const HEAD_OFFICE: NavLeaf = {
  label: "Head Office", short: "Office", href: "/retail/ho",
  Icon: Briefcase, colour: "#7c3aed",
};

/** The shops, from the live branch list. See lib/retailShop.ts for why Top Shop
 *  is one entry and each Fashion Collection branch is its own. */
export const navShops = (branches: Branch[]): Shop[] => shopList(branches);

/* ── lookups ─────────────────────────────────────────────────────────────── */

export const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(href + "/");

/** Every place in the department, flattened — for the phone bars and the title.
 *  Group parents are excluded: they redirect rather than showing anything. */
export function allLeaves(): NavLeaf[] {
  return [DASHBOARD, ...SHOP_SCREENS, ...SHOP_STAFF, ...HO_SCREENS, ...HO_STAFF, ...MANAGE];
}

/** THE PHONE TAB BAR — four places plus More.
 *  Chosen by what somebody opens standing in a shop at closing time, not by
 *  what matters most on paper: how did today go, walk me through the close,
 *  what did we spend, does the till balance. */
export const PHONE_TABS = [
  "/retail/dashboard",
  "/retail/close",
  "/retail/expenses",
  "/retail/cashbook",
] as const;

/** The name the phone header shows. Longest matching href wins, so
 *  /retail/employees/ledger beats /retail/employees. */
export function retailTitle(pathname: string, shopLabel?: string | null): string {
  let best: NavLeaf | null = null;
  for (const leaf of allLeaves()) {
    if (isActive(pathname, leaf.href) && (!best || leaf.href.length > best.href.length)) best = leaf;
  }
  if (!best) return "FS Traders";
  /* Inside Head Office, say so — "Attendance" alone is ambiguous when both the
     shops and the office have one. Under a shop, the shop's name is the more
     useful half of the title. */
  if (best.href.startsWith("/retail/ho")) return "Office " + best.label.toLowerCase();
  if (shopLabel && SHOP_SCREENS.concat(SHOP_STAFF).some((l) => l.href === best!.href)) {
    return `${shopLabel} · ${best.label}`;
  }
  return best.label;
}

/** Is this screen one that belongs to a shop? Used to decide whether the shop
 *  picker means anything on the page you are looking at. */
export const isShopScreen = (pathname: string) =>
  SHOP_SCREENS.concat(SHOP_STAFF).some((l) => isActive(pathname, l.href))
  && !pathname.startsWith("/retail/ho");

/** The siblings of the screen you are on, for the phone's sub-switcher. */
export function groupSiblings(pathname: string): { label: string; kids: NavLeaf[] } | null {
  if (pathname.startsWith("/retail/ho")) {
    const all = [...HO_SCREENS, ...HO_STAFF];
    if (all.some((l) => isActive(pathname, l.href))) return { label: "Head Office", kids: all };
  }
  if (SHOP_STAFF.some((l) => isActive(pathname, l.href))) return { label: "Employee", kids: SHOP_STAFF };
  if (SHOP_SCREENS.some((l) => isActive(pathname, l.href))) return { label: "Shop", kids: SHOP_SCREENS };
  return null;
}

/** Only the places this person may open. A group with no surviving child is
 *  dropped entirely — a heading that points at nothing is a heading that lies. */
export const visible = (
  leaves: NavLeaf[],
  can: (req: string[] | null) => boolean,
  perms: Record<string, string[] | null>,
) => leaves.filter((l) => can(perms[l.href] ?? null));
