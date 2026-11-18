/* WHICH SHOP YOU ARE LOOKING AT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS A COPY OF THE OLD APP'S shopList()
 *
 * The old Grohub retail app put the SHOPS at the top of the menu and the
 * screens underneath each one. You picked Top Shop, then Cash Book — and when
 * you moved to Expenses you were still in Top Shop. The shop was the context
 * you worked inside; the screen was just what you were doing to it.
 *
 * The port inverted that: screens at the top level, a branch dropdown on each
 * one, and the dropdown reset every time you navigated. Same data, same
 * figures, but it asks you to re-state which shop you mean on every screen —
 * which is why it feels slower to use even when it is not slower to load.
 *
 * This file restores the old model. It is deliberately a direct translation of
 * the old app's `shopList()` and `state.navShop`, not an improvement on them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A "SHOP" IS, AND WHY IT IS NOT A BRANCH
 *
 * A shop in the menu is not always one row in retail_branches:
 *
 *   · TOP SHOP IS ONE SHOP covering all six of its branches. It exports as one
 *     combined all-stores file, it is reconciled as one, and the upload log
 *     keys it as the single unit "topshop". Six menu entries would be six ways
 *     to ask one question.
 *   · EACH FASHION COLLECTION BRANCH IS ITS OWN SHOP. They export separately,
 *     they are counted separately, and FC DHA has its own commission rates.
 *   · HEAD OFFICE IS NEITHER. It sells nothing. It is its own section of the
 *     menu with its own screens, exactly as it was.
 *
 * That grouping is the same rule `unitForBranch()` in the kit uses for the
 * upload log, and the two must not drift: if one calls Top Shop a single unit
 * and the other calls it six, the dashboard's "you still owe a file" reminder
 * and the menu disagree about what a shop is.
 */
"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Branch } from "@/components/retail/kit";

export type Shop = {
  /** 'ts' for Top Shop, 'b<id>' for a single branch. Same keys the old app used. */
  key: string;
  label: string;
  /** Every branch id this shop covers. Six for Top Shop, one for the rest. */
  ids: number[];
  chain: string;
};

/** True for the Head Office branch row. Kept identical to the kit's own test so
 *  the two cannot disagree about who is office staff. */
const isHO = (b: Branch) => (b.chain ?? "").toLowerCase().includes("head office");

/** THE MENU'S SHOPS, IN THE OLD APP'S ORDER.
 *
 *  Top Shop first as one entry, then each Fashion Collection branch by id, then
 *  anything else a branch row has grown since — a new chain appears on its own
 *  rather than vanishing because this function had never heard of it.
 *  Head Office is excluded: it is its own menu section. */
export function shopList(branches: Branch[]): Shop[] {
  const live = branches.filter((b) => b.active !== false && !isHO(b));
  const out: Shop[] = [];

  const ts = live.filter((b) => b.chain === "Topshop").map((b) => b.id);
  if (ts.length) out.push({ key: "ts", label: "Top Shop", ids: ts, chain: "Topshop" });

  live
    .filter((b) => b.chain === "Fashion Collection")
    .sort((a, b) => a.id - b.id)
    /* "Fashion Collection DHA" is 22 characters in a 248px menu. The old app
       shortened it to "FC DHA" and so does this. */
    .forEach((b) => out.push({
      key: "b" + b.id,
      label: (b.name ?? "").replace("Fashion Collection ", "FC "),
      ids: [b.id],
      chain: "Fashion Collection",
    }));

  live
    .filter((b) => b.chain !== "Topshop" && b.chain !== "Fashion Collection")
    .sort((a, b) => a.id - b.id)
    .forEach((b) => out.push({ key: "b" + b.id, label: b.name ?? "—", ids: [b.id], chain: b.chain ?? "" }));

  return out;
}

export const findShop = (branches: Branch[], key: string | null): Shop | null =>
  key ? shopList(branches).find((s) => s.key === key) ?? null : null;

/** A SCREEN THAT WORKS ON ONE BRANCH AT A TIME — a till, a day close.
 *
 *  The cash book is a single shop's cash drawer; "Top Shop" is six drawers and
 *  has no combined answer, so these screens cannot simply take `scope.ids`.
 *  What they do instead: follow the shop when it names one branch, narrow the
 *  dropdown to that shop's branches when it names several, and fall back to the
 *  first of them so the screen has something to show on arrival.
 *
 *  `pool` is the screen's own candidate list where it has one — Day Close
 *  excludes Head Office, which has no till.
 *
 *  Choosing in the dropdown writes the shared shop, so the menu follows along
 *  and the choice survives to the next screen. */
export function useScopedBranchId(branches: Branch[], pool?: Branch[]): {
  id: string; list: Branch[]; shop: ShopScope; set: (v: string) => void;
} {
  const shop = useShopScope(branches);
  const all = pool ?? branches;
  /* Memoised for the same reason as useShopScope above: `list` in a dependency
     array must not be a new array on every render. */
  return useMemo(() => {
    const list = shop.ids ? all.filter((b) => shop.ids!.includes(b.id)) : all;
    return {
      id: shop.single || (list[0] ? String(list[0].id) : ""),
      list, shop,
      set: shop.set,
    };
  }, [shop, all]);
}

/** THE STAFF SCREENS' BRANCH FILTER — Attendance, Monthly Summary, Ledger,
 *  Repayments, Employees.
 *
 *  Each of these has two copies: one under a shop and one under Head Office,
 *  from the same component. The shop copy follows the menu. The HEAD OFFICE
 *  COPY MUST NOT: Head Office is not a shop, and having its staff list jump
 *  because somebody picked FC DHA two screens ago would be a bug that looks
 *  like missing data. Hence `follow`.
 *
 *  Both hooks are called either way — a hook behind an `if` is a hook that
 *  changes order between renders. */
export function useStaffScope(branches: Branch[], pool: Branch[], follow: boolean): {
  branch: string;
  setBranch: (v: string) => void;
  pickable: Branch[];
  /** Is this person inside the shop on screen? What a blank picker has to mean
   *  once Top Shop exists: "everyone HERE", not everyone in the business. */
  inPool: (branchId: unknown) => boolean;
} {
  const shop = useShopScope(branches);
  const [local, setLocal] = useState("");

  /* MEMOISED — see the note on useShopScope. `inPool` goes into the dependency
     array of the `people` memo on all four of these screens, and `people` feeds
     the employee-id list that the loader keys on. A new function here meant a
     new id list every render, a new loader every render, and an effect that
     fired for ever. */
  return useMemo(() => {
    const pickable = follow && shop.ids
      /* Top Shop narrows the list to its own six. */
      ? pool.filter((b) => shop.ids!.includes(b.id))
      : pool;
    const allowed = new Set(pickable.map((b) => b.id));
    return {
      branch: follow ? shop.single : local,
      setBranch: follow ? shop.set : setLocal,
      pickable,
      inPool: (id: unknown) => allowed.has(Number(id)),
    };
  }, [shop, pool, follow, local]);
}

/** The branch ids a screen should show. No shop chosen means every shop — the
 *  Dashboard and the Manage screens are deliberately all-shops. */
export const shopBranchIds = (branches: Branch[], key: string | null): number[] => {
  const s = findShop(branches, key);
  return s ? s.ids.slice() : branches.filter((b) => !isHO(b)).map((b) => b.id);
};

/** The value a screen's single-branch picker should take. Top Shop covers six
 *  branches, so there is no one id to select and the picker stays on "all" —
 *  the screen then filters by `shopBranchIds` instead. */
export const shopSingleBranch = (branches: Branch[], key: string | null): string => {
  const s = findShop(branches, key);
  return s && s.ids.length === 1 ? String(s.ids[0]) : "";
};

/* ──────────────────────────────────────────────────────────────────────────
   THE SELECTED SHOP, REMEMBERED ACROSS SCREENS

   A plain module-level value with subscribers, read through
   useSyncExternalStore — the same mechanism the kit uses for its media
   queries. Not React context, because every screen would then need a provider
   above it, and not the URL, because the shop is not what the page IS, it is
   what you are looking at.

   It is mirrored into sessionStorage so a refresh keeps you where you were.
   sessionStorage and not localStorage on purpose: this is "where am I right
   now", and it should not still be FC DHA when somebody opens the app next
   week. Every read and write is wrapped — a private window throws on access,
   and a menu that crashes the app because storage is blocked is worse than a
   menu that forgets.
   ────────────────────────────────────────────────────────────────────────── */

const KEY = "fsShop";
let current: string | null = null;
let loaded = false;
const subs = new Set<() => void>();

function hydrate() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { current = window.sessionStorage.getItem(KEY) || null; } catch { current = null; }
}

export function getShopKey(): string | null {
  hydrate();
  return current;
}

export function setShopKey(key: string | null) {
  hydrate();
  if (current === key) return;
  current = key;
  try {
    if (key) window.sessionStorage.setItem(KEY, key);
    else window.sessionStorage.removeItem(KEY);
  } catch { /* storage blocked — the choice still holds for this page's lifetime */ }
  subs.forEach((f) => f());
}

export function subscribeShop(cb: () => void) {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** The server renders with no shop chosen, which is the all-shops view — so the
 *  first paint is never wrong, only less specific than it will be a tick later. */
export const serverShopKey = () => null;

/** WHICH SHOP IS SELECTED, as a hook. useSyncExternalStore and not useState +
 *  useEffect because the latter paints the wrong answer first and corrects it a
 *  frame later — which on this menu means the highlight jumping after load. */
export function useShopKey(): string | null {
  return useSyncExternalStore(subscribeShop, getShopKey, serverShopKey);
}

/** Does this menu shop cover the selected key? Top Shop covers 'ts' and also
 *  'b<id>' for each of its six branches — somebody can drill into one Top Shop
 *  branch from a screen's own picker, and Top Shop should stay lit while they
 *  are in there rather than the menu losing track of where they are. */
export const shopCovers = (shop: Shop, key: string | null): boolean =>
  !!key && (key === shop.key || shop.ids.some((id) => "b" + id === key));

/* ──────────────────────────────────────────────────────────────────────────
   THE SCOPE A SHOP SCREEN WORKS IN

   WHY THIS IS ONE CONTROL AND NOT TWO. The port had a branch dropdown on every
   screen, holding its own useState, reset on every navigation. Restoring the
   old menu put a second selector above it — and two controls for one question
   is how you end up reading FC DHA's cash book under Top Shop's heading.

   So the dropdown and the menu are now the same value. The menu writes it, the
   dropdown writes it, both read it, and it survives the move to the next
   screen. The dropdown keeps its full reach: it can still name one branch
   inside Top Shop, which the menu cannot express and which is genuinely useful
   when a single till does not balance.

   `ids` is what a query must filter by, and it is deliberately a LIST. Top Shop
   is six branches; `.eq("branch_id", …)` cannot say that and `branch === ""`
   would quietly widen it to include Fashion Collection. A screen that reads
   `ids` and applies `.in()` is right for every case, including the one-branch
   case, which is why there is no second code path for it.
   ────────────────────────────────────────────────────────────────────────── */
export type ShopScope = {
  /** The raw store value, for the menu's highlight. */
  key: string | null;
  /** Branch ids to filter by. `null` means every shop — apply no filter. */
  ids: number[] | null;
  /** The value a `BranchPicker` should show: "" unless it is exactly one branch. */
  single: string;
  /** What to call it on screen: "All stores", "Top Shop", "FC DHA", a branch name. */
  label: string;
  /** Set it from a menu key ('ts', 'b7') or null for every shop. The primitive. */
  pick: (key: string | null) => void;
  /** Set it from a bare branch id, the way the old single-branch pickers did.
   *  "" clears back to every shop. */
  set: (branchValue: string) => void;
  /** One step out, for a drill-down's back control. From one Top Shop branch
   *  that is Top Shop, not every shop — going back should land where you came
   *  from. From a shop it is every shop. */
  back: () => void;
  /** What `back()` will land on, so the button can say where it goes. A back
   *  control that does not name its destination is a control people stop
   *  pressing. */
  backLabel: string;
};

/* ──────────────────────────────────────────────────────────────────────────
   THIS RESULT IS MEMOISED, AND THAT IS NOT AN OPTIMISATION.

   It used to build a fresh object on every render: a new `ids` array, a new
   `set`, a new `back`. Anything downstream that listed one of those in a
   dependency array therefore re-ran on EVERY render — and on the four staff
   screens that closed a loop:

       inPool is new  ->  `people` useMemo recomputes  ->  `ids` useMemo gets a
       new array  ->  the `load` useCallback is new  ->  useEffect([load]) fires
       ->  setLoading / setDay  ->  render  ->  inPool is new …

   The screen never settled. It sat on its skeleton with every tile reading "—",
   flickering, and hammering the database with the same query for as long as it
   was open. Attendance, Monthly Summary, Ledger and Repayments all did it.

   So the object is built once per (branches, key) and handed back by reference.
   A dependency array containing `scope`, `scope.ids` or `inPool` is then stable
   by construction, and the loop cannot come back by somebody adding one.
   ────────────────────────────────────────────────────────────────────────── */
export function useShopScope(branches: Branch[], allLabel = "All stores"): ShopScope {
  const key = useShopKey();
  return useMemo(() => {
    const shop = findShop(branches, key);

    /* A 'b<id>' key that is not itself a menu shop is a Top Shop branch picked
       from a screen. It is still a perfectly good scope — one branch. */
    let ids: number[] | null = null;
    let label = allLabel;
    if (shop) { ids = shop.ids; label = shop.label; }
    else if (key && key.startsWith("b")) {
      const id = Number(key.slice(1));
      const b = branches.find((x) => x.id === id);
      if (b) { ids = [id]; label = b.name ?? "—"; }
    }

    /* One step out: a Top Shop branch falls back to Top Shop, a shop falls back
       to every shop. Worked out once here so `back()` and `backLabel` cannot
       disagree about where the button goes. */
    const owner = key ? shopList(branches).find((s) => shopCovers(s, key)) : undefined;
    const up = owner && owner.key !== key ? owner : null;

    return {
      key,
      ids,
      single: ids && ids.length === 1 ? String(ids[0]) : "",
      label,
      pick: setShopKey,
      set: (v: string) => setShopKey(v ? "b" + v : null),
      back: () => { if (key) setShopKey(up ? up.key : null); },
      backLabel: up ? up.label : allLabel,
    };
  }, [branches, key, allLabel]);
}
