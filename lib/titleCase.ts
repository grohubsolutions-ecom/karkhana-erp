/* TITLE CASE FOR HEADINGS (the owner, 5 Oct 2026).
 *
 * Every word of a heading starts with a capital — his example: "The Main
 * Crowd And The Main Thing". Small words (and, of, the) are capitalised too,
 * because that is what he asked for.
 *
 * Only a lowercase first letter is raised; nothing is ever lowered. So codes
 * and names keep their own spelling — A-1020, OwnEx, TikTok, PostEx — and
 * "Hamza's" stays "Hamza's" (the s after an apostrophe is not a new word).
 *
 * Used for headings, titles and role names. Never for sentences or for what
 * someone typed as a note.
 */
export const tc = (s: string | null | undefined): string =>
  (s ?? "").replace(/(^|[\s(/"“‘[])([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase());
