"use client";
/* THE PHONE CHROME FOR FS TRADERS.
 *
 * Below 768px there is no sidebar at all. A 248px drawer on a 390px screen
 * covers the thing you were looking at, and the people using this are standing
 * in a shop with a phone in one hand. So the phone gets what a phone app has: a
 * header saying which shop and which screen, a bar of four places at the bottom
 * where a thumb already is, and everything else one tap away under More.
 *
 * THE SHOP COMES FIRST HERE TOO. On a computer the shops are the left menu; on
 * a phone they are the pill in the header. Tapping it lists the shops, choosing
 * one keeps you on the screen you were already looking at — FC DHA's cash book
 * becomes Top Shop's cash book, which is the comparison somebody actually makes
 * at closing time. That is the same model as the sidebar, in the shape a phone
 * can hold.
 *
 * Everything in this file is `md:hidden`. At 768px and up it renders nothing,
 * which is why the computer site is untouched.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Store, MoreHorizontal, ArrowLeft, LogOut, ChevronLeft, Menu, ChevronDown, Check,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { ROUTE_PERMS } from "@/lib/access";
import ThemeToggle from "@/components/ThemeToggle";
import { Sheet, useBranches, useUnclassifiedCount } from "@/components/retail/kit";
import {
  SHOP_SCREENS, SHOP_STAFF, HO_SCREENS, HO_STAFF, MANAGE, DASHBOARD, HEAD_OFFICE,
  PHONE_TABS, allLeaves, isActive, retailTitle, groupSiblings, visible, isShopScreen,
  navShops, type NavLeaf,
} from "@/components/retail/retailNav";
import { useShopKey, setShopKey, findShop } from "@/lib/retailShop";

/* ─────────────────────────────────────────────────────────────────────────────
   TOP BAR  (phone only)
   Sticky, and deliberately a SOLID background rather than a backdrop blur: a
   blurred element becomes the containing block for any `position: fixed` child,
   which silently traps a sheet opened from inside it at the header's height.
   That bug cost an afternoon on the Hub; it is not repeated here.
   ───────────────────────────────────────────────────────────────────────────── */
export function RetailTopBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const { can } = usePermissions();
  const { branches } = useBranches();
  const shopKey = useShopKey();
  const [pick, setPick] = useState(false);

  const shop = findShop(branches, shopKey);
  const title = retailTitle(pathname, shop?.label ?? null);
  const group = groupSiblings(pathname);
  const kids = (group?.kids ?? []).filter((c) => can(ROUTE_PERMS[c.href] ?? null));

  /* The pill is only meaningful on a screen whose figures belong to one shop.
     On the Dashboard, Cards, Bank or Salary it would offer a choice that
     changes nothing on screen, which is worse than not offering it. */
  const showShop = isShopScreen(pathname) && navShops(branches).length > 1;

  return (
    <>
      <header className="rt-topbar sticky top-0 z-[45] border-b border-line bg-surface md:hidden dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-ink text-white dark:bg-white dark:text-[#141414]">
            <Store size={17} />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[15.5px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{title}</div>
            <div className="text-[10.5px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Shops Sales</div>
          </div>
          {showShop && (
            <button onClick={() => setPick(true)}
              className="flex min-h-[40px] max-w-[42vw] flex-none items-center gap-1 rounded-full bg-panel px-3 text-[12.5px] font-bold text-ink dark:bg-white/[0.08] dark:text-white">
              <span className="truncate">{shop?.label ?? "All shops"}</span>
              <ChevronDown size={14} className="flex-none" />
            </button>
          )}
          <button onClick={onMore} aria-label="Menu"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-xl2 text-ink transition active:bg-panel dark:text-white dark:active:bg-white/[0.06]">
            <Menu size={21} />
          </button>
        </div>

        {/* SUB-SWITCHER. "Attendance" and "Monthly Summary" are the same job on
            the same people; on a computer they are two lines in a group, and on
            a phone they are this strip, so moving between them is one tap and
            not four. Only shown when the screen belongs to a group. */}
        {kids.length > 1 && (
          <div className="rt-scroll-x -mt-0.5 px-3 pb-2">
            <div className="flex w-max gap-1.5">
              {kids.map((c) => {
                const on = pathname === c.href;
                return (
                  <Link key={c.href} href={c.href}
                    /* 40px, not the 30px this was: the header sits outside
                       `.rt-clip`, so the stylesheet's tap-target floor never
                       reached it, and these chips are how somebody moves
                       between Attendance and the month summary all afternoon. */
                    className={`flex min-h-[40px] items-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-semibold transition ${
                      on ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
                         : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
                    {c.short ?? c.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <ShopPicker open={pick} onClose={() => setPick(false)} />
    </>
  );
}

/** THE SHOP SHEET. Choosing a shop does not navigate — it changes which shop
 *  the screen you are already on is about. "All shops" is kept as an option
 *  because the combined figure is a real question, not an absence of a choice. */
function ShopPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { branches } = useBranches();
  const shopKey = useShopKey();
  const shops = navShops(branches);

  return (
    <Sheet open={open} onClose={onClose} title="Which shop" subtitle="Changes the figures on this screen">
      <div className="space-y-1.5">
        <ShopOption label="All shops" sub={`${shops.length} shops together`}
          on={!shopKey} onPick={() => { setShopKey(null); onClose(); }} />
        {shops.map((s) => (
          <ShopOption key={s.key} label={s.label}
            sub={s.ids.length > 1 ? `${s.ids.length} branches` : s.chain}
            on={shopKey === s.key}
            onPick={() => { setShopKey(s.key); onClose(); }} />
        ))}
      </div>
    </Sheet>
  );
}

function ShopOption({ label, sub, on, onPick }: { label: string; sub?: string; on: boolean; onPick: () => void }) {
  return (
    <button onClick={onPick}
      className={`flex min-h-[52px] w-full items-center gap-3 rounded-card border px-3.5 text-left transition ${
        on ? "border-transparent bg-salmon-soft dark:bg-white/[0.10]"
           : "border-line bg-surface dark:border-white/[0.06] dark:bg-white/[0.03]"}`}>
      <span className="min-w-0 flex-1 leading-tight">
        <span className={`block truncate text-[14px] ${on ? "font-bold text-ink dark:text-white" : "font-semibold text-muted dark:text-[#a89f93]"}`}>{label}</span>
        {sub && <span className="block truncate text-[11px] text-hint dark:text-[#8a8175]">{sub}</span>}
      </span>
      {on && <Check size={17} className="flex-none text-ink dark:text-white" />}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   BOTTOM TAB BAR  (phone only)
   Four places plus More. The four are not the four most important screens on
   paper — they are the four somebody opens standing in a shop at closing time:
   how did today go, walk me through the close, what did we spend, does the till
   balance. A screen opened once a week belongs in More and loses nothing by it.
   ───────────────────────────────────────────────────────────────────────────── */
export function RetailTabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const pathname = usePathname();
  const { can } = usePermissions();

  const leaves = allLeaves();
  const tabs = PHONE_TABS
    .map((href) => leaves.find((l) => l.href === href))
    .filter((l): l is NavLeaf => !!l && can(ROUTE_PERMS[l.href] ?? null));

  const onTab = tabs.some((t) => isActive(pathname, t.href));

  return (
    <nav className="rt-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden dark:border-white/[0.06] dark:bg-[#201c17]">
      <div className="flex">
        {tabs.map(({ href, label, short, Icon }) => {
          const on = isActive(pathname, href);
          return (
            <Link key={href} href={href}
              className={`flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1 px-1 py-2 transition ${
                on ? "text-ink dark:text-white" : "text-hint dark:text-[#8a8175]"}`}>
              <Icon size={21} strokeWidth={on ? 2.4 : 2} />
              <span className={`text-[10.5px] leading-none ${on ? "font-bold" : "font-medium"}`}>{short ?? label}</span>
            </Link>
          );
        })}
        <button onClick={onMore} aria-label="More"
          className={`flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1 px-1 py-2 transition ${
            moreOpen || !onTab ? "text-ink dark:text-white" : "text-hint dark:text-[#8a8175]"}`}>
          <MoreHorizontal size={21} strokeWidth={moreOpen || !onTab ? 2.4 : 2} />
          <span className={`text-[10.5px] leading-none ${moreOpen || !onTab ? "font-bold" : "font-medium"}`}>More</span>
        </button>
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MORE SHEET  (phone only)
   The whole department in one scroll, in the sidebar's order so that somebody
   who learned the menu on a computer finds the same things in the same places:
   the shop you are in and its screens, then Head Office, then Manage. Plus the
   three things that lived at the bottom of the sidebar — theme, sign out, back
   to the other departments — which on a phone had nowhere else to go.
   ───────────────────────────────────────────────────────────────────────────── */
export function RetailMoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { can } = usePermissions();
  const { branches } = useBranches();
  const shopKey = useShopKey();

  const shop = findShop(branches, shopKey);
  const shopScreens = visible(SHOP_SCREENS, can, ROUTE_PERMS);
  const shopStaff   = visible(SHOP_STAFF,   can, ROUTE_PERMS);
  const hoScreens   = visible(HO_SCREENS,   can, ROUTE_PERMS);
  const hoStaff     = visible(HO_STAFF,     can, ROUTE_PERMS);
  const manage      = visible(MANAGE,       can, ROUTE_PERMS);
  const unc = useUnclassifiedCount(shopScreens.some((l) => l.href === "/retail/payments"));

  async function logout() { if (supabase) await supabase.auth.signOut(); router.replace("/login"); }

  return (
    <Sheet open={open} onClose={onClose} title="Shops Sales" subtitle="Everything in this department">
      <div className="space-y-4">
        {can(ROUTE_PERMS[DASHBOARD.href] ?? null) && (
          <div className="grid grid-cols-2 gap-2">
            <MoreLink leaf={DASHBOARD} pathname={pathname} onClose={onClose} />
          </div>
        )}

        {shopScreens.length > 0 && (
          <Block label={shop ? shop.label : "Any shop"}>
            {shopScreens.map((l) => (
              <MoreLink key={l.href} leaf={l} pathname={pathname} onClose={onClose}
                badge={l.href === "/retail/payments" ? unc : null} />
            ))}
          </Block>
        )}

        {shopStaff.length > 0 && (
          <Block label="Employee">
            {shopStaff.map((l) => <MoreLink key={l.href} leaf={l} pathname={pathname} onClose={onClose} />)}
          </Block>
        )}

        {(hoScreens.length > 0 || hoStaff.length > 0) && (
          <Block label={HEAD_OFFICE.label}>
            {[...hoScreens, ...hoStaff].map((l) => (
              <MoreLink key={l.href} leaf={l} pathname={pathname} onClose={onClose}
                onPick={() => setShopKey(null)} />
            ))}
          </Block>
        )}

        {manage.length > 0 && (
          <Block label="Manage">
            {manage.map((l) => <MoreLink key={l.href} leaf={l} pathname={pathname} onClose={onClose} />)}
          </Block>
        )}

        <div className="space-y-1 border-t border-line pt-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between px-1 py-1.5">
            <span className="text-[12.5px] text-muted dark:text-[#a89f93]">Theme</span><ThemeToggle />
          </div>
          <Link href="/" onClick={onClose}
            className="flex min-h-[44px] items-center gap-2.5 rounded-xl2 px-2 text-[13.5px] font-semibold text-muted dark:text-[#a89f93]">
            <ArrowLeft size={16} /> All departments
          </Link>
          <button onClick={logout}
            className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl2 px-2 text-[13.5px] font-semibold text-muted dark:text-[#a89f93]">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">{label}</div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function MoreLink({
  leaf, pathname, onClose, onPick, badge,
}: {
  leaf: NavLeaf; pathname: string; onClose: () => void;
  onPick?: () => void; badge?: number | null;
}) {
  const on = isActive(pathname, leaf.href);
  return (
    <Link href={leaf.href} onClick={() => { onPick?.(); onClose(); }}
      className={`flex min-h-[56px] items-center gap-2.5 rounded-card border px-3 py-2.5 text-[13px] font-semibold transition ${
        on ? "border-transparent bg-salmon-soft text-ink dark:bg-white/[0.10] dark:text-white"
           : "border-line bg-surface text-muted dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[#a89f93]"}`}>
      <leaf.Icon size={17} className="flex-none" strokeWidth={2}
        style={!on && leaf.colour ? { color: leaf.colour } : undefined} />
      <span className="min-w-0 flex-1 leading-tight">{leaf.label}</span>
      {!!badge && (
        <span className="flex-none rounded-full bg-danger px-1.5 py-[1px] text-[10px] font-bold leading-[14px] text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIDEBAR TAB  (768–1023px only)
   A tablet, or a phone held sideways. 248px of permanent menu out of 768 leaves
   520 for the work, which is not enough for the Cash Book. So the menu hides
   and this arrow brings it back. Hidden below 768 (no sidebar there at all) and
   above 1023 (the menu is permanent and this would be clutter).
   ───────────────────────────────────────────────────────────────────────────── */
export function RetailSidebarTab({ onOpen, hidden }: { onOpen: () => void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button onClick={onOpen} aria-label="Show menu"
      className="fixed left-0 top-3 z-30 hidden h-[44px] w-[34px] items-center justify-center rounded-r-xl2 border border-l-0 border-line bg-surface text-muted shadow-sm transition hover:text-ink md:flex lg:hidden dark:border-white/[0.08] dark:bg-[#201c17] dark:text-[#a89f93] dark:hover:text-white">
      <Menu size={17} />
    </button>
  );
}

/** ‹ Hide menu — inside the drawer, below 1024 only. The backdrop closes it
 *  too, but a labelled button is what somebody looks for first. */
export function RetailHideMenu({ onClose }: { onClose: () => void }) {
  return (
    <button onClick={onClose}
      className="mx-3 mb-1 hidden items-center gap-1.5 rounded-xl2 px-2.5 py-2 text-[12px] font-semibold text-muted transition hover:bg-panel hover:text-ink md:flex lg:hidden dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white">
      <ChevronLeft size={15} /> Hide menu
    </button>
  );
}

/** Closes the drawer whenever the route changes. Without this, choosing a page
 *  on a tablet leaves the menu sitting over what you just opened. */
export function useCloseOnRoute(close: () => void) {
  const pathname = usePathname();
  useEffect(() => { close(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pathname]);
}
