/* THE DEFAULT SET. Unchanged — every screen that was using it keeps exactly
   the ranges it had. Orders, shipments, retail sales and the cashbook all move
   daily, so Today and Yesterday mean something there. */
export const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "5d", label: "5 days" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "60d", label: "60 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

/* FOR MONEY SCREENS ONLY, and passed in explicitly by the page that wants it.
   A courier settles on a cycle of days or weeks, so "yesterday" on a payments
   screen is almost always empty and reads as though the money has vanished.
   A receivable is judged over months.

   Kept separate rather than swapped in, because changing a shared list to suit
   one page changes every other page that never asked. */
export const MONEY_PRESETS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "1 month" },
  { key: "60d", label: "2 months" },
  { key: "90d", label: "3 months" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

/* PAKISTAN DATES, NOT UTC (2 Oct 2026).
   This used toISOString(), which gives the UTC calendar day. From midnight to
   5 am in Karachi that is still yesterday, so "Today" showed yesterday's
   orders and "Yesterday" the day before; and "This month" started on the last
   day of the previous month at every hour, because midnight on the 1st in
   Karachi is 7 pm UTC the day before. Every date these ranges filter
   (order_date, dispatch_date, sale_date, txn_date, expense_date …) is a
   Pakistan business day, so the range is built in Asia/Karachi too, whatever
   timezone the browser happens to be in. Same presets, same output shape. */
const KARACHI = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
});
const iso = (d: Date) => {
  const p: Record<string, string> = {};
  for (const x of KARACHI.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
};
/* Pakistan has no daylight saving, so a day back is always 24 hours back. */
const DAY = 86400000;

/** Today's date in Pakistan as YYYY-MM-DD — for date pickers' default and max. */
export const todayPk = () => iso(new Date());

/** A "done on" day picked in a date box, as the instant to record.
    Today (or later) → null, which the database reads as "now": noon of today
    is still in the future every morning, and was refused as "that date has
    not happened yet". An earlier day → noon of that day in Pakistan, so it
    reads as the same day whatever timezone the browser is in. */
export const doneOnIso = (day: string): string | null =>
  !day || day >= todayPk() ? null : new Date(`${day}T12:00:00+05:00`).toISOString();

/** Returns [from, to] as YYYY-MM-DD, or [null, null] for "all time". */
export function rangeDates(preset: string, cf?: string, ct?: string): [string | null, string | null] {
  const now = Date.now();
  const back = (n: number) => iso(new Date(now - n * DAY));
  const today = back(0);
  if (preset === "today") return [today, today];
  if (preset === "yesterday") { const y = back(1); return [y, y]; }
  if (preset === "7d")   return [back(6), today];
  if (preset === "5d")   return [back(4), today];
  if (preset === "30d")  return [back(29), today];
  if (preset === "60d")  return [back(59), today];
  if (preset === "90d")  return [back(89), today];
  if (preset === "180d") return [back(179), today];
  if (preset === "month") return [today.slice(0, 8) + "01", today];
  if (preset === "custom") return [cf || null, ct || null];
  return [null, null]; // all
}

export const num = (v: unknown) => Number(v) || 0;
export const rs = (n: number) => "Rs " + Math.round(n).toLocaleString("en-PK");
