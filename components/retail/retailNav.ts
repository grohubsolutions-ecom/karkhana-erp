/* ONE LIST OF PLACES IN FS TRADERS.
 *
 * The sidebar, the phone tab bar, the More sheet and the phone header title all
 * read this. They used to be three separate lists in three files, which is how
 * a page ends up reachable on a computer and invisible on a phone — nobody
 * notices until somebody in a shop says "it's not there on mine".
 *
 * Mirrors components/hubNav.ts in shape on purpose. It is a SEPARATE file, not
 * an import of it: departments stay isolated, so nothing done for the shops can
 * reach the Hub, and vice versa.
 */
import {
  LayoutDashboard, Receipt, Store, BookText, Percent, Wallet, Building2, Upload,
  CreditCard, Landmark, Users, CalendarCheck, CalendarRange, Coins, NotebookPen,
  Banknote, ArrowLeftRight, Briefcase, ListChecks, type LucideIcon,
} from "lucide-react";

export type NavLeaf = { label: string; short?: string; href: string; Icon: LucideIcon };
export type NavItem = NavLeaf & { children?: NavLeaf[] };

/* `short` is the phone label. "Card Reconciliation" is 19 characters and a tab
   is about 70px wide, so the phone gets "Cards" and the computer keeps the full
   name — the same word in both places, just not the same length. */
export const RETAIL_NAV: NavItem[] = [
  { label: "Dashboard", short: "Home", href: "/retail/dashboard", Icon: LayoutDashboard },
  { label: "Day Close", short: "Close", href: "/retail/close", Icon: ListChecks },
  { label: "Sales", href: "/retail/sales", Icon: Receipt },
  { label: "Import", href: "/retail/import", Icon: Upload },
  { label: "Expenses", href: "/retail/expenses", Icon: NotebookPen },
  { label: "Non-cash", href: "/retail/payments", Icon: ArrowLeftRight },
  { label: "Cash Book", short: "Cash", href: "/retail/cashbook", Icon: BookText },
  { label: "Commissions", short: "Comm.", href: "/retail/commissions", Icon: Percent },

  { label: "Employee", href: "/retail/employees", Icon: Users, children: [
      { label: "Attendance",      href: "/retail/employees/attendance", Icon: CalendarCheck },
      { label: "Monthly Summary", short: "Summary", href: "/retail/employees/summary", Icon: CalendarRange },
      { label: "Ledger",          href: "/retail/employees/ledger",     Icon: NotebookPen },
      { label: "Repayments",      href: "/retail/employees/repayments", Icon: Coins },
      { label: "Employees",       href: "/retail/employees",            Icon: Users },
  ] },

  { label: "Head Office", short: "Office", href: "/retail/ho", Icon: Briefcase, children: [
      { label: "Daily cash flow", short: "Cash flow", href: "/retail/ho/cashflow",   Icon: ArrowLeftRight },
      { label: "End of day",      href: "/retail/ho/eod",        Icon: Banknote },
      { label: "Attendance",      href: "/retail/ho/attendance", Icon: CalendarCheck },
      { label: "Monthly Summary", short: "Summary", href: "/retail/ho/summary",    Icon: CalendarRange },
      { label: "Employees",       href: "/retail/ho/employees",  Icon: Users },
      { label: "Ledger",          href: "/retail/ho/ledger",     Icon: NotebookPen },
      { label: "Repayments",      href: "/retail/ho/repayments", Icon: Coins },
  ] },

  { label: "Card Reconciliation", short: "Cards", href: "/retail/cards", Icon: CreditCard },
  { label: "Bank Statements", short: "Bank", href: "/retail/bank", Icon: Landmark },
  { label: "Salary", href: "/retail/salaries", Icon: Wallet },
  { label: "Branches", href: "/retail/branches", Icon: Building2 },
];

/* THE PHONE TAB BAR — five slots, and the fifth is More.
 *
 * Chosen by what somebody actually opens standing in a shop at closing time,
 * not by what is most important on paper: how did today go, walk me through
 * the close, what did we spend, does the till balance. Everything else is one
 * tap further away in More, which is the right distance for a screen opened
 * once a week. */
export const PHONE_TABS = [
  "/retail/dashboard",
  "/retail/close",
  "/retail/expenses",
  "/retail/cashbook",
] as const;

/** Flattened, for lookups. A group's own href is excluded — it redirects. */
export function allLeaves(): NavLeaf[] {
  const out: NavLeaf[] = [];
  RETAIL_NAV.forEach((n) => {
    if (n.children) out.push(...n.children);
    else out.push(n);
  });
  return out;
}

/** Only the places this person can open. A group with no surviving child is
 *  dropped entirely — a heading that points at nothing is a heading that lies. */
export function visibleNav(can: (req: string[] | null) => boolean, perms: Record<string, string[] | null>): NavItem[] {
  return RETAIL_NAV.map((n) => {
    if (n.children) {
      const kids = n.children.filter((c) => can(perms[c.href] ?? null));
      return kids.length ? { ...n, children: kids } : null;
    }
    return can(perms[n.href] ?? null) ? n : null;
  }).filter((n): n is NavItem => n !== null);
}

export const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(href + "/");

/** The title the phone header shows. The page itself hides its own h1 on a
 *  phone, so this is the only place the screen is named there. */
export function retailTitle(pathname: string): string {
  let best: NavLeaf | null = null;
  for (const leaf of allLeaves()) {
    if (isActive(pathname, leaf.href) && (!best || leaf.href.length > best.href.length)) best = leaf;
  }
  if (best) {
    /* Inside a group, say which group — "Attendance" alone is ambiguous when
       both the shops and Head Office have one. */
    const parent = RETAIL_NAV.find((n) => n.children?.some((c) => c.href === best!.href));
    if (parent && parent.label === "Head Office") return "Office " + best.label.toLowerCase();
    return best.label;
  }
  return "FS Traders";
}

/** For a page that belongs to a group: its siblings, for the phone sub-switcher. */
export function groupSiblings(pathname: string): { parent: NavItem; kids: NavLeaf[] } | null {
  for (const n of RETAIL_NAV) {
    if (!n.children) continue;
    if (n.children.some((c) => isActive(pathname, c.href)) || isActive(pathname, n.href)) {
      return { parent: n, kids: n.children };
    }
  }
  return null;
}
