/* SHARING A DAY ON WHATSAPP.
 *
 * WHY THIS EXISTS
 *   The old Grohub app had shareShopSummary / shareOfficeSummary /
 *   shareBossSummary and they were used every single evening, because that is
 *   how the business actually reports: a shop sends its day to the group, the
 *   accounts person sends the office figures to the owner, and nobody logs in to
 *   read a dashboard. Those three functions were the one part of the old system
 *   that never got ported, and without them somebody retypes the same eight
 *   figures into WhatsApp by hand every night — which is slow and, more to the
 *   point, is where the numbers stop matching the system.
 *
 * WHY PLAIN TEXT AND NOT AN IMAGE
 *   A pasted screenshot cannot be searched, quoted or copied out of, and on a
 *   2GB phone in a shop it is the thing that fails to send. Text sends on any
 *   connection, reads in the notification, and can be forwarded into a
 *   spreadsheet. The old app shared text too.
 *
 * HOW IT SHARES
 *   `navigator.share` where the browser has it — on a phone that opens the
 *   system sheet, so the person picks WhatsApp, or Telegram, or a note, or the
 *   group they always send it to. Everywhere else it falls back to the
 *   clipboard, and the caller tells the person it was copied. No wa.me link with
 *   a hardcoded number: who the day goes to is not ours to decide, and a share
 *   sheet remembers the last recipient better than we can.
 *
 * FORMATTING RULES, learned from the old messages
 *   · No markdown tables. WhatsApp renders them as a wall of pipes.
 *   · `*bold*` for headings only — WhatsApp's own syntax, one asterisk.
 *   · Right-aligning with spaces is pointless: WhatsApp's font is proportional.
 *     So every line is "Label: Rs 1,234", which reads fine at any width.
 *   · Zero lines are left out. A nine-line message where three lines say zero is
 *     a message people stop reading.
 */

/** Rupees the way every other screen in the department writes them. Deliberately
 *  not imported from the kit: this file is also used by server-ish code paths and
 *  must not pull a React module in behind it. */
const rs = (n: number) => "Rs " + Math.round(n || 0).toLocaleString("en-PK");

/** A date a person reads, not an ISO string. "Mon 5 Oct 2026".
 *  Parsed AND formatted in UTC so the two agree — a bare date string carries no
 *  timezone, and reading it as local midnight then formatting it is how a day
 *  silently becomes the day before. */
export const dayLabel = (ds: string) =>
  new Date(ds + "T00:00:00Z").toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export type ShareLine = { k: string; v: number | string | null | undefined; always?: boolean };

/** Builds the message. A line is dropped when its value is zero, null, empty or
 *  a dash, unless it is marked `always` — a cash difference of zero is the whole
 *  point of the message and must be printed. */
export function shareText(title: string, subtitle: string, lines: ShareLine[], tail?: string): string {
  const body = lines
    .filter((l) => l.always || !(l.v === null || l.v === undefined || l.v === "" || l.v === "—" || l.v === 0))
    .map((l) => `${l.k}: ${typeof l.v === "number" ? rs(l.v) : l.v}`)
    .join("\n");
  return [`*${title}*`, subtitle, "", body, tail ? "\n" + tail : ""]
    .join("\n")
    /* Collapses the gap left by an absent subtitle or tail. Two blank lines in a
       row is what makes a WhatsApp message look like a forward. */
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

/** Hands the text to the phone. Returns what happened so the caller can say so —
 *  "Copied" and "Sent" are different outcomes and a button that claims the wrong
 *  one is a button nobody trusts.
 *
 *  A cancelled share sheet throws AbortError. That is the person changing their
 *  mind, not a failure, so it is reported as such rather than falling through to
 *  the clipboard and claiming success. */
export async function shareOrCopy(text: string, title?: string): Promise<ShareResult> {
  try {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      await nav.share({ title, text });
      return "shared";
    }
  } catch (e) {
    /* Dismissing the share sheet is a decision, not a fault. Reporting it as a
       failure made the button read as broken every time somebody changed their
       mind. */
    if ((e as DOMException)?.name === "AbortError") return "cancelled";
    /* Any other share failure — a desktop browser that advertises share but has
       no target, a permissions policy — falls through to the clipboard. */
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/* ── the three messages the business actually sends ─────────────────────────── */

export type ShopDay = {
  shop: string; date: string;
  gross?: number; net?: number; returns?: number;
  cash?: number; card?: number; jazz?: number; credit?: number; online?: number;
  receipts?: number;
  expenses?: number; income?: number; ho?: number;
  /** Deliberately no closing balance and no difference. Those belong to the cash
   *  book, which owns the running chain from one day to the next; a single day's
   *  row cannot produce either, and this message goes to the owner. */
  physical?: number | null;
};

/** What a shop sends to the group at closing time.
 *  Order is the order the questions get asked: what did we sell, how was it
 *  paid, what went out, does the till balance. */
export function shopSummary(d: ShopDay): string {
  const counted = d.physical !== null && d.physical !== undefined;
  return shareText(
    `${d.shop} — day close`,
    dayLabel(d.date),
    [
      { k: "Gross sale", v: d.gross },
      { k: "Net sale", v: d.net, always: true },
      { k: "Returns", v: d.returns },
      { k: "— Cash", v: d.cash },
      { k: "— Card", v: d.card },
      { k: "— JazzCash", v: d.jazz },
      { k: "— Credit (udhaar)", v: d.credit },
      { k: "— Online", v: d.online },
      { k: "Bills", v: d.receipts ? String(d.receipts) : undefined },
      { k: "Expenses", v: d.expenses },
      { k: "Misc income", v: d.income },
      { k: "Sent to HO", v: d.ho },
      /* Printed even when nobody has counted: "not counted yet" is the single
         most useful line in this message, and leaving it out reads as done. */
      { k: "Cash counted", v: counted ? rs(d.physical as number) : "not counted yet", always: true },
    ],
  );
}

export type OfficeDay = {
  date: string;
  /** What the figures cover, when it is not one day — "1–30 Sep 2026",
   *  "last 7 days". The dashboard reports a range, so it passes this; Day Close
   *  reports one day and lets `date` speak for itself. */
  label?: string;
  sales?: number; margin?: number; expenses?: number; income?: number; net?: number;
  receipts?: number; shops?: number;
  byShop?: { name: string; sales: number }[];
};

/** What the accounts person sends the owner: the company, not a shop.
 *  The per-shop list is capped — twelve lines is a message, thirty is a document,
 *  and the owner reads this on a lock screen. */
export function officeSummary(d: OfficeDay, maxShops = 12): string {
  const lines: ShareLine[] = [
    { k: "Total sales", v: d.sales, always: true },
    { k: "Gross margin", v: d.margin },
    { k: "Expenses", v: d.expenses },
    { k: "Misc income", v: d.income },
    { k: "Net profit", v: d.net, always: true },
    { k: "Bills", v: d.receipts ? String(d.receipts) : undefined },
    { k: "Shops selling", v: d.shops ? String(d.shops) : undefined },
  ];
  const shops = (d.byShop ?? []).filter((s) => s.sales).slice(0, maxShops);
  const tail = shops.length
    ? "*By shop*\n" + shops.map((s) => `${s.name}: ${rs(s.sales)}`).join("\n")
      + ((d.byShop ?? []).filter((s) => s.sales).length > maxShops ? `\n…and ${(d.byShop ?? []).filter((s) => s.sales).length - maxShops} more` : "")
    : undefined;
  return shareText("FS Traders — summary", d.label ?? dayLabel(d.date), lines, tail);
}
