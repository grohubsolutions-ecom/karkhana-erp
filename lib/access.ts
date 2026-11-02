// Which permission(s) each area needs. A user sees/enters an area if they
// have ANY of the listed permissions. null = always allowed (e.g. Home).
// Security is still enforced in the database (RLS/RPCs); this tailors the UI.
export const ROUTE_PERMS: Record<string, string[] | null> = {
  "/": null,
  "/dashboard": ["reports.view", "inventory.view", "production.view"],
  "/inventory": ["inventory.view"],
  "/grn": ["inventory.view"],
  "/machine-process": ["production.view", "production.entry"],
  "/staff/induction": ["production.view", "production.entry"],
  /* K178 — the warehouse is split by what a person does there. Seeing the
     warehouse (khana.view) no longer opens its staff wages or its reports:
     a warehouse operator records stock in, stock out and GR out, and that is
     all his screen shows. Full control (khana.manage) still opens everything. */
  "/warehouse/staff/payroll": ["khana.manage", "payroll.view"],
  "/warehouse/staff/induction": ["khana.manage", "process.manage"],
  "/staff/payroll": ["production.view", "production.entry"],
  "/edit-record": ["production.entry", "grn.create"],
  "/reports/factory/grn": ["inventory.view", "production.view"],
  "/reports/factory/grout": ["inventory.view", "production.view"],
  "/reports/factory/str": ["inventory.view", "production.view"],
  "/reports/factory/low": ["inventory.view", "production.view"],
  "/reports/factory/blocked": ["inventory.view", "production.view"],
  "/reports/factory/stock": ["inventory.view", "production.view"],
  "/reports/factory/graph": ["inventory.view", "production.view"],
  "/reports/warehouse/grn": ["khana.manage", "khana.reports"],
  "/reports/warehouse/grout": ["khana.manage", "khana.reports"],
  "/reports/warehouse/str": ["khana.manage", "khana.reports"],
  "/reports/warehouse/low": ["khana.manage", "khana.reports"],
  "/reports/warehouse/blocked": ["khana.manage", "khana.reports"],
  "/reports/warehouse/graph": ["khana.manage", "khana.reports"],
  "/str/factory": ["production.view", "production.entry"],
  "/str/warehouse": ["khana.manage", "khana.stock.out"],
  "/warehouse/products": ["khana.view"],
  "/warehouse/grn-in": ["khana.view"],
  "/warehouse/grn-out": ["khana.view"],
  "/warehouse/returns": ["khana.manage", "khana.return"],
  /* K192 — Carrefour shop stock reports. Seeing them and uploading them are
     separate: someone may read the sold figures without loading files. */
  "/carrefour": ["carrefour.view", "carrefour.upload"],
  "/carrefour/upload": ["carrefour.upload"],
  /* K195 — the money side. Reading shop stock does not open these. */
  "/carrefour/dashboard": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/carrefour/invoices": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/carrefour/maturity": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/carrefour/debit-notes": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/carrefour/payments": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/carrefour/terms": ["carrefour.accounts.view", "carrefour.accounts.manage"],
  "/grn/out": ["inventory.view", "inventory.issue"],
  "/packing": ["production.view", "production.entry"],
  "/grn/stitching": ["production.view", "production.entry"],
  "/grn/final": ["production.view", "production.entry"],
  /* K119 gave finished garments their own permission. This used to sit under
     inventory.view, which is the permission for raw material — someone who can
     see fabric on a shelf is not automatically someone who should see finished
     output and its value. inventory.view stays listed so nobody currently
     working loses the page overnight. */
  "/inventory/final-products": ["finished.view", "inventory.view"],
  "/inventory/sorting": ["inventory.view", "inventory.sort"],
  "/stock": ["inventory.view"],
  "/process": ["process.view"],
  "/movements": ["inventory.view"],
  "/raw-materials": ["inventory.view"],
  "/production": ["production.view", "production.entry", "production.approve", "production.manage"],
  "/articles": ["production.view", "production.entry", "production.approve", "production.manage"],
  "/add-article": ["articles.manage", "production.entry"],
  "/orders": ["production.view", "production.entry", "production.approve", "production.manage"],
  "/employees": ["employees.manage"],
  "/suppliers": ["suppliers.manage"],
  "/payments": ["payments.manage"],
  "/reports": ["reports.view"],
  "/approvals": ["inventory.approve", "production.approve", "grn.approve"],
  "/administration": ["users.manage", "roles.manage"],
  /* The Karkhana admin's own room: Karkhana logins and job roles only. */
  "/karkhana/team": ["karkhana.admin"],

  /* THE HUB. Until now not one /online/* path was listed here, so every Hub
     page was open to anyone who could log in — Finance included. The
     permissions have existed since 0090; nothing was checking them.

     `.manage` is listed alongside `.view` on each line because someone who can
     change a thing can obviously look at it, and a role granted only manage
     should not be locked out of the page it manages.

     /me is deliberately absent: the employee portal is for whoever is signed
     in, it takes no parameter, and every figure on it is filtered by auth.uid()
     inside Postgres. Requiring a permission would lock employees out of their
     own wages. */
  "/online": null,
  "/online/dashboard": ["hub.dashboard.view"],
  "/online/orders": ["hub.orders.view", "hub.orders.manage"],
  "/online/logistics": ["hub.logistics.view", "hub.logistics.manage"],
  "/online/logistics/returns": ["hub.logistics.view", "hub.logistics.manage"],
  /* H276 — the first-attempt desk. returns.rescue is Abdullah's own key:
     it opens this page and nothing else, and it is not the key that opens
     Abdul Rehman's returns print sheet. The logistics permissions are
     listed too so the office can see the same worklist. */
  "/online/logistics/first-attempt": ["returns.rescue", "hub.logistics.view", "hub.logistics.manage"],
  "/online/finance": ["hub.finance.view", "hub.finance.manage"],
  "/online/attendance": ["hub.attendance.view", "hub.attendance.manage"],
  "/online/employees": ["hub.attendance.view", "hub.attendance.manage"],
  /* H273 — Performance. `.manage` ONLY, with no `.view` beside it: the pages
     above are the roster, which a supervisor may read; this one ranks his
     colleagues against each other. The database refuses it to the same people
     regardless (hub_performance checks hub.attendance.manage itself); this
     line is what keeps the page out of their menu and out of their address
     bar. */
  "/online/performance": ["hub.attendance.manage"],
  "/me": null,
};

/* WHERE A KARKHANA PERSON LANDS.
   The Karkhana box used to open /dashboard, which needs reports or stock
   permissions — so a warehouse operator pressing it met a locked door. He is
   taken to the first Karkhana screen he can actually use instead. */
const KARKHANA_LANDING = [
  "/dashboard", "/warehouse/grn-in", "/warehouse/grn-out", "/warehouse/returns",
  "/warehouse/products", "/add-article", "/grn", "/machine-process", "/stock",
  "/karkhana/team",
];
export function karkhanaLanding(can: (req: string[] | null) => boolean): string {
  return KARKHANA_LANDING.find((p) => can(ROUTE_PERMS[p] ?? null)) ?? "/dashboard";
}

/* Anything that opens a door OTHER than Karkhana on the home screen: the Hub,
   FS Traders, Administration. Someone with none of these has one department
   only, so "All departments" would lead him in a circle. Mirrors the `needs`
   lists on the home screen (app/page.tsx). */
export const OTHER_DEPARTMENT_PERMS = [
  "hub.dashboard.view", "hub.orders.view", "hub.logistics.view", "hub.finance.view", "hub.attendance.view",
  "retail.access", "retail.dashboard.view", "retail.sales.view", "retail.cashbook.view",
  "retail.expenses.view", "retail.employees.view", "retail.payroll.view",
  "carrefour.view", "carrefour.upload", "carrefour.accounts.view", "carrefour.accounts.manage",
  "users.manage", "roles.manage",
];

export function hasAny(perms: Set<string>, required: string[] | null): boolean {
  if (!required || required.length === 0) return true;
  return required.some((p) => perms.has(p));
}

// Required permissions for a path (exact match, else longest matching prefix).
export function requiredFor(pathname: string): string[] | null {
  if (pathname in ROUTE_PERMS) return ROUTE_PERMS[pathname];
  let best: string | null = null;
  for (const key of Object.keys(ROUTE_PERMS)) {
    if (key === "/") continue;
    if (pathname === key || pathname.startsWith(key + "/")) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? ROUTE_PERMS[best] : null;
}
