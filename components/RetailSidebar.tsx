"use client";
/* THE FS TRADERS MENU — computer and tablet. The phone has its own, in
 * components/retail/RetailPhoneChrome.tsx.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SHOPS AT THE TOP, SCREENS UNDERNEATH. The old app's shape, restored.
 *
 *   Dashboard
 *
 *   SHOPS
 *   › Top Shop          →  Sales · Import · Expenses · Non-cash · Cash Book
 *                          Commissions · Day Close · Employee ▸
 *   › FC Paragon        →  the same, for that shop
 *   › FC DHA
 *   …
 *
 *   › Head Office       →  Daily cash flow · End of day · Employee ▸
 *
 *   MANAGE
 *   Card Reconciliation · Bank Statements · Salary · Branches
 *
 * The first port of this department had it the other way round: the seven
 * screens at the top level with a branch dropdown on each. Same data, same
 * figures — and wrong, because it asks you to re-state which shop you mean
 * every time you move. Nobody thinks "cash book, which shop again". They think
 * "FC DHA" and then spend ten minutes inside FC DHA. The shop is the context;
 * the screen is what you are doing to it. That is why this reads as the old app
 * did, down to the accordion closing one shop when you open another.
 *
 * WHAT THE MENU DOES BEYOND NAVIGATE: choosing anything under a shop sets the
 * selected shop (lib/retailShop.ts), and every shop screen starts from that.
 * So Top Shop → Cash Book → Expenses stays in Top Shop, with no second picker
 * to set. Head Office and the Manage screens clear it, because they are not
 * about one shop.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Store, ArrowLeft, LogOut, ChevronRight, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { ROUTE_PERMS } from "@/lib/access";
import ThemeToggle from "@/components/ThemeToggle";
import { useIsHandheldWide, useBranches, useUnclassifiedCount } from "@/components/retail/kit";
import { RetailHideMenu } from "@/components/retail/RetailPhoneChrome";
import {
  SHOP_SCREENS, SHOP_STAFF, HO_SCREENS, HO_STAFF, MANAGE, DASHBOARD, HEAD_OFFICE,
  navShops, isActive, visible, type NavLeaf,
} from "@/components/retail/retailNav";
import { useShopKey, setShopKey, shopCovers } from "@/lib/retailShop";

export default function RetailSidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const handheldWide = useIsHandheldWide();
  const { branches } = useBranches();
  const shopKey = useShopKey();

  const shops = navShops(branches);
  const inHO = pathname.startsWith("/retail/ho");

  /* WHICH ACCORDION IS OPEN. One at a time, as before: a nine-shop menu with
     every shop expanded is 90 lines and a scrollbar. `null` means all closed;
     'ho' is Head Office. Seeded from where you are standing, so arriving on a
     shop screen from a link opens that shop rather than showing a closed list
     with no indication of where you are. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => {
    if (inHO) { setOpenKey("ho"); return; }
    /* The covering shop, not the raw key: a Top Shop branch chosen on a screen
       is stored as 'b7', and it is Top Shop's menu entry that should open. */
    const owner = shops.find((s) => shopCovers(s, shopKey));
    if (owner) setOpenKey(owner.key);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [inHO, shopKey, branches.length]);

  /* THE SCREENS THIS PERSON MAY OPEN. Until the permission work this was a
     no-op filter and every line showed for everybody; now the shop accounts
     person sees Expenses and Cash Book and not Bank Statements. A shop with no
     surviving screen is dropped from the list entirely — an entry that expands
     to nothing is worse than no entry. */
  const shopScreens = visible(SHOP_SCREENS, can, ROUTE_PERMS);
  const shopStaff   = visible(SHOP_STAFF,   can, ROUTE_PERMS);
  const hoScreens   = visible(HO_SCREENS,   can, ROUTE_PERMS);
  const hoStaff     = visible(HO_STAFF,     can, ROUTE_PERMS);
  const manage      = visible(MANAGE,       can, ROUTE_PERMS);
  const canDash     = can(ROUTE_PERMS[DASHBOARD.href] ?? null);

  /* The badge only makes sense to somebody who can open the screen it points
     at, and asking for the count otherwise would just be a 403 in the console. */
  const unc = useUnclassifiedCount(shopScreens.some((l) => l.href === "/retail/payments"));

  async function logout() { if (supabase) await supabase.auth.signOut(); router.replace("/login"); }

  /** Pressing a shop's name: select it and go to its first screen. The old app
   *  landed on Sales; if this person cannot see Sales it lands on whatever of
   *  their screens comes first rather than on a page that will bounce them. */
  function openShop(key: string) {
    setShopKey(key);
    setOpenKey(key);
    if (shopScreens.length) router.push(shopScreens[0].href);
  }

  /* A drawer that is off-screen must not be reachable by Tab, or the first
     press of Tab on a tablet lands in a menu nobody can see. Only in the
     768–1023 band: below it the panel is `hidden`, above it always visible. */
  const hiddenDrawer = handheldWide && !open;

  return (
    <>
      {open && <div className="fixed inset-0 z-40 hidden bg-black/40 md:block lg:hidden" onClick={onClose} />}

      <aside
        {...(hiddenDrawer ? { inert: true as unknown as boolean } : {})}
        className={`hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface md:flex md:fixed md:inset-y-0 md:left-0 md:z-50 md:transition-transform lg:static lg:z-auto lg:translate-x-0 dark:border-white/[0.06] dark:bg-[#201c17] ${
          open ? "md:translate-x-0" : "md:-translate-x-full"}`}
      >
        <Link href="/" onClick={onClose} className="flex items-center gap-2 px-5 pt-5 text-[12.5px] font-semibold text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
          <ArrowLeft size={15} /> All departments
        </Link>
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-white dark:bg-white dark:text-[#141414]"><Store size={18} /></span>
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight dark:text-[#f4f1ea]">Shops Sales</div>
            <div className="text-[11px] text-muted dark:text-[#a89f93]">Retail shops</div>
          </div>
        </div>

        {onClose && <RetailHideMenu onClose={onClose} />}

        <nav className="flex-1 overflow-y-auto px-3 pb-2">
          {ready && (
            <>
              {canDash && (
                <TopRow leaf={DASHBOARD} on={isActive(pathname, DASHBOARD.href)}
                  onClick={() => { setShopKey(null); setOpenKey(null); onClose?.(); }} />
              )}

              {shops.length > 0 && shopScreens.length > 0 && <GroupLabel>Shops</GroupLabel>}

              {shopScreens.length > 0 && shops.map((s) => {
                const expanded = openKey === s.key;
                /* "Current" is the selected shop, which is not the same as
                   "expanded": you can leaf through the other shops' menus
                   without leaving the one you are working in, and the dot
                   stays on the one your figures belong to.
                   shopCovers, not ===, so drilling into one Top Shop branch
                   from a screen's own picker keeps Top Shop lit. */
                const current = shopCovers(s, shopKey) && !inHO;
                return (
                  <div key={s.key}>
                    <AccordionRow
                      label={s.label}
                      sub={s.ids.length > 1 ? `${s.ids.length} branches` : undefined}
                      current={current}
                      expanded={expanded}
                      onOpen={() => { openShop(s.key); onClose?.(); }}
                      onToggle={() => setOpenKey(expanded ? null : s.key)}
                    />
                    {expanded && (
                      <Children>
                        {shopScreens.map((l) => (
                          <ChildLink key={l.href} leaf={l} pathname={pathname} current={current}
                            badge={l.href === "/retail/payments" ? unc : null}
                            onClick={() => { setShopKey(s.key); onClose?.(); }} />
                        ))}
                        {shopStaff.length > 0 && (
                          <SubGroup label="Employee" icon={Users}
                            openWhen={shopStaff.some((l) => isActive(pathname, l.href))}>
                            {shopStaff.map((l) => (
                              <ChildLink key={l.href} leaf={l} pathname={pathname} current={current} nested
                                onClick={() => { setShopKey(s.key); onClose?.(); }} />
                            ))}
                          </SubGroup>
                        )}
                      </Children>
                    )}
                  </div>
                );
              })}

              {/* HEAD OFFICE IS NOT A SHOP. It sells nothing, it has no till and
                  no commissions, and it sits outside the SHOPS group for the
                  same reason it did in the old menu: so that nobody reads it as
                  the tenth shop. */}
              {(hoScreens.length > 0 || hoStaff.length > 0) && (
                <div className="mt-1">
                  <AccordionRow
                    label={HEAD_OFFICE.label}
                    icon={HEAD_OFFICE.Icon}
                    colour={HEAD_OFFICE.colour}
                    current={inHO}
                    expanded={openKey === "ho"}
                    onOpen={() => {
                      setShopKey(null); setOpenKey("ho");
                      if (hoScreens.length) router.push(hoScreens[0].href);
                      onClose?.();
                    }}
                    onToggle={() => setOpenKey(openKey === "ho" ? null : "ho")}
                  />
                  {openKey === "ho" && (
                    <Children>
                      {hoScreens.map((l) => (
                        <ChildLink key={l.href} leaf={l} pathname={pathname} current={inHO}
                          onClick={() => { setShopKey(null); onClose?.(); }} />
                      ))}
                      {hoStaff.length > 0 && (
                        <SubGroup label="Employee" icon={Users}
                          openWhen={hoStaff.some((l) => isActive(pathname, l.href))}>
                          {hoStaff.map((l) => (
                            <ChildLink key={l.href} leaf={l} pathname={pathname} current={inHO} nested
                              onClick={() => { setShopKey(null); onClose?.(); }} />
                          ))}
                        </SubGroup>
                      )}
                    </Children>
                  )}
                </div>
              )}

            </>
          )}
        </nav>

        {/* ── MANAGE IS PINNED, NOT SCROLLED ──────────────────────────────
            It used to sit at the end of the scrolling list. With a shop
            expanded — seven screens plus the Employee group — the list is
            taller than the panel, so MANAGE fell off the bottom and Import,
            Cards, Bank, Salary and Branches could not be found at all without
            knowing to scroll past nine rows first. These five are short, fixed
            and used from anywhere, so they get their own place that nothing can
            push away. The shops scroll; these do not.

            `max-h-[45%]` with its own overflow is the short-window case: on a
            600px laptop the five would otherwise squeeze the shop list down to
            nothing, so they give way at the point where they would start
            crowding it out. */}
        {ready && manage.length > 0 && (
          <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line px-3 py-2 dark:border-white/[0.06]">
            <GroupLabel>Manage</GroupLabel>
            {manage.map((l) => (
              <TopRow key={l.href} leaf={l} on={isActive(pathname, l.href)}
                onClick={() => { setShopKey(null); setOpenKey(null); onClose?.(); }} />
            ))}
          </div>
        )}

        <div className="space-y-1 border-t border-line p-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between px-2 py-1"><span className="text-[11px] text-hint dark:text-[#8a8175]">Theme</span><ThemeToggle /></div>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-xl2 px-3.5 py-2.5 text-[13.5px] font-semibold text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white"><LogOut size={16} /> Sign out</button>
        </div>
      </aside>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE PIECES
   Small components rather than one long render, because the shop accordion and
   the Head Office accordion must stay identical — the moment they are two
   copies of the same markup, one of them gets a fix and the other does not.
   ───────────────────────────────────────────────────────────────────────────── */

const ACTIVE = "bg-salmon-soft font-semibold text-ink dark:bg-white/[0.10] dark:text-white";
const IDLE   = "text-muted hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white";

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-[0.07em] text-hint dark:text-[#8a8175]">
      {children}
    </div>
  );
}

/** Dashboard and the Manage screens: a plain row, no children. */
function TopRow({ leaf, on, onClick }: { leaf: NavLeaf; on: boolean; onClick: () => void }) {
  return (
    <Link href={leaf.href} onClick={onClick}
      className={`flex items-center gap-3 rounded-xl2 px-3.5 py-2.5 text-[14px] transition ${on ? ACTIVE : IDLE}`}>
      <leaf.Icon size={18} strokeWidth={2} />
      <span className="flex-1 truncate">{leaf.label}</span>
    </Link>
  );
}

/** A shop, or Head Office.
 *
 *  THE NAME IS A LINK AND THE ARROW IS A BUTTON, as two siblings. They used to
 *  be a button nested inside the link, which meant every press of the arrow had
 *  to be cancelled with preventDefault + stopPropagation, and a thumb landing
 *  3px off navigated instead of expanding. Separate elements, no cancelling. */
function AccordionRow({
  label, sub, icon: Icon, colour, current, expanded, onOpen, onToggle,
}: {
  label: string; sub?: string; icon?: NavLeaf["Icon"]; colour?: string;
  current: boolean; expanded: boolean; onOpen: () => void; onToggle: () => void;
}) {
  return (
    <div className={`flex items-center gap-1 rounded-xl2 pr-1 transition ${current ? ACTIVE : IDLE}`}>
      <button type="button" onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl2 py-[9px] pl-3.5 text-left text-[14px]">
        {Icon
          ? <Icon size={17} strokeWidth={2} className="flex-none" />
          /* The old menu marked each shop with its chain's colour dot. Kept:
             with nine shops it is how you find the one you want without
             reading, and Top Shop and the FC branches group by eye. */
          : <span className="h-[7px] w-[7px] flex-none rounded-full"
              style={{ background: current ? "currentColor" : (colour ?? "#9aa0a6") }} />}
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate">{label}</span>
          {sub && <span className="block truncate text-[10.5px] font-normal text-hint dark:text-[#8a8175]">{sub}</span>}
        </span>
      </button>
      <button type="button" aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
        aria-expanded={expanded} onClick={onToggle}
        className="flex-none rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10">
        <ChevronRight size={15} className={`transition ${expanded ? "rotate-90" : ""}`} />
      </button>
    </div>
  );
}

function Children({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-4 mt-0.5 mb-1 space-y-0.5 border-l border-line pl-2.5 dark:border-white/[0.08]">
      {children}
    </div>
  );
}

/** One screen under a shop.
 *
 *  `current` matters: the highlight is only right when BOTH the route matches
 *  and this is the shop you are in. Without it, expanding FC DHA while looking
 *  at Top Shop's cash book highlights Cash Book under FC DHA — telling you that
 *  you are looking at numbers you are not. */
function ChildLink({
  leaf, pathname, current, nested, badge, onClick,
}: {
  leaf: NavLeaf; pathname: string; current: boolean; nested?: boolean;
  badge?: number | null; onClick: () => void;
}) {
  const on = isActive(pathname, leaf.href) && current;
  return (
    <Link href={leaf.href} onClick={onClick}
      className={`flex items-center gap-2.5 rounded-xl2 py-[7px] pr-2 text-[13px] transition ${nested ? "pl-5" : "pl-2.5"} ${
        on ? "bg-salmon-soft font-semibold text-ink dark:bg-white/[0.10] dark:text-white"
           : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
      <leaf.Icon size={15} strokeWidth={2} className="flex-none"
        style={!on && leaf.colour ? { color: leaf.colour } : undefined} />
      <span className="min-w-0 flex-1 truncate">{leaf.label}</span>
      {/* THE BACKLOG COUNT. The one number the old menu carried, because it is
          the only warning the app gives that money has come in and nobody has
          said what kind of money it was. Hidden at zero — a badge reading 0 is
          a badge you stop reading. */}
      {!!badge && (
        <span className="flex-none rounded-full bg-danger px-1.5 py-[1px] text-[10px] font-bold leading-[14px] text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

/** The Employee sub-menu, one level deeper. Collapsed by default because four
 *  of the five screens under it are opened once a month, and expanded when you
 *  are already on one of them. */
function SubGroup({
  label, icon: Icon, openWhen, children,
}: {
  label: string; icon: NavLeaf["Icon"]; openWhen: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(openWhen);
  useEffect(() => { if (openWhen) setOpen(true); }, [openWhen]);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl2 py-[7px] pl-2.5 pr-2 text-[13px] text-muted transition hover:text-ink dark:text-[#a89f93] dark:hover:text-white">
        <Icon size={15} strokeWidth={2} className="flex-none" />
        <span className="flex-1 truncate text-left">{label}</span>
        <ChevronRight size={13} className={`flex-none transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}
