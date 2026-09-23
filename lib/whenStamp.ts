/* WHEN A MOVEMENT HAPPENED (K180).
 *
 * Every screen that lets a date be picked used to stamp the entry at 12:00
 * noon — so a whole STR list read "12:00:00 PM" fourteen times over, and the
 * only rows carrying a real time were the ones recorded without picking a
 * date at all. Noon was never true; it was there to keep a date clear of
 * midnight and the time-zone slip on either side of it.
 *
 * The rule now:
 *   nothing picked        now
 *   a date                that date, at the clock time it is being recorded
 *   a date and a time     exactly that
 *
 * Built from the browser's own clock, so the day is the day the person is
 * standing in, not the day it happens to be in UTC.
 */

/** "16:20" — the clock time right now, for the time box. */
export function timeNow(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The moment to record, or undefined for "leave it to the database" (now). */
export function stampAt(date: string, time?: string): string | undefined {
  if (!date) return undefined;
  const t = /^\d{1,2}:\d{2}/.test(time ?? "") ? (time as string) : timeNow();
  const [h, m] = t.split(":");
  const when = new Date(`${date}T${h.padStart(2, "0")}:${m.slice(0, 2)}:00`);
  /* A date the browser cannot read is not worth guessing at — let the
     database stamp it instead of writing 1 Jan 1970. */
  return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
}
