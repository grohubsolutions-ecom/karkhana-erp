/* NimbusRMS export parsing — ported verbatim from the Grohub single-file app.
 *
 * WHY THIS IS A SEPARATE FILE AND WHY IT COPIES RATHER THAN IMPROVES
 *   Every rule in here was learned from a real file that broke something. The
 *   temptation with a CSV importer is to write a tolerant one — fuzzy header
 *   matching, best-effort dates, "looks like a card payment". That is exactly
 *   what produces a silent 3% error in a sales figure nobody can trace.
 *
 *   So this matches the original byte for byte where it matters: the same
 *   column names, the same date format, the same MOP rules, and above all the
 *   same line_hash, because a hash that differs from the old app's is a hash
 *   that will re-import three years of history as new rows.
 */

/* ── dates ────────────────────────────────────────────────────────────────
 * Nimbus writes 13/Jul/2026. Not ISO, not DD/MM/YYYY — a three-letter month.
 * A generic date parser reads "13/Jul/2026" as invalid and returns null, and a
 * row with no date is a row the import skips, so a tolerant parser here means
 * an import that silently drops every line in the file.
 */
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/* ── dates, as Nimbus actually writes them ────────────────────────────────
 *
 * There is no one Nimbus date format. The same system, exporting on the same
 * afternoon, produced all three of these:
 *
 *     sale report      10-Oct-26                dash, two-digit year
 *     account report   10/Oct/2026              slash, four-digit year
 *     wallet report    10/10/2026 9:32:54 PM    all numeric, with a time
 *
 * Both readers here used to demand slashes and a month NAME, so two of those
 * three parsed to nothing — not "some rows skipped", every row, silently, with
 * the screen reporting 0 and no reason given. 1,030 sale lines and 85 card
 * payments, gone on a punctuation mark.
 *
 * So: day, month and year in any of the separators, month as a name or a
 * number, year in two digits or four.
 *
 * THE ALL-NUMERIC CASE IS NOT A FORMAT, IT IS A GUESS, and it is the one place
 * in this file where being clever could lose a day's money quietly. `10/9/2026`
 * is 9 October to an American report writer and 10 September to everybody else,
 * and nothing in the cell says which. Worse, the non-cash file joins to sale
 * lines on branch + date + exact time, so a date read a month out does not
 * error — it matches nothing, tags nothing, and looks like a clean import of a
 * file that changed no figures.
 *
 * It is therefore decided ONCE PER FILE, from all the dates in it, by
 * `numericDateOrder` below — never per row, never from one cell.
 */
const MONTH_RE = "(\\d{1,2})\\s*[\\/\\-\\. ]\\s*([A-Za-z]{3,}|\\d{1,2})\\s*[\\/\\-\\. ]\\s*(\\d{2,4})";

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const fullYear = (y: number) => (y < 100 ? y + 2000 : y);

/** Day/month/year pulled out of a cell, month still ambiguous when numeric.
 *  `null` means the cell is not a date at all. */
function dateParts(s: unknown): { a: number; b: number; y: number; named: boolean } | null {
  if (s == null || s === "") return null;
  const m = String(s).trim().match(new RegExp(MONTH_RE));
  if (!m) return null;
  const y = fullYear(parseInt(m[3], 10));
  if (!y || y < 1990 || y > 2999) return null;
  const a = parseInt(m[1], 10);
  if (/^\d+$/.test(m[2])) return { a, b: parseInt(m[2], 10), y, named: false };
  const mo = MONTHS[m[2].slice(0, 3).toUpperCase()];
  if (!mo) return null;
  return { a, b: mo, y, named: true };
}

/** `none` = this file has no all-numeric dates, so there is nothing to decide
 *  and nothing to tell the person. `unknowable` = it HAS them and they cannot
 *  be told apart; that one has to be said out loud. */
export type NumericDateOrder = "dmy" | "mdy" | "unknowable" | "none";

/** WHICH WAY ROUND ARE THIS FILE'S NUMERIC DATES? Decided from the whole file.
 *
 *  1. A first component over 12 can only be a day       → d/m.
 *  2. A second component over 12 can only be a day      → m/d.
 *  3. Otherwise, take the reading that puts the file in the SMALLER date span.
 *     An export is a date-range report: a few consecutive days. Read
 *     `10/10, 10/9, 10/8, 10/7` as m/d and you get 7–10 October, four days in
 *     a row. Read it as d/m and you get the 10th of July, August, September
 *     and October — four months apart, always the same day of the month, which
 *     no report produces. The tighter reading is the true one, and this also
 *     gets `01/07 … 05/07` right in the other direction (1–5 July as d/m beats
 *     five 7ths in five different months as m/d).
 *  4. A file whose dates are all d == m (or just one row) cannot be told apart
 *     by any of this, and says so rather than pretending. */
export function numericDateOrder(cells: unknown[]): NumericDateOrder {
  const parts = cells.map(dateParts).filter((p): p is NonNullable<typeof p> => !!p && !p.named);
  if (!parts.length) return "none";
  if (parts.some((p) => p.a > 12)) return "dmy";
  if (parts.some((p) => p.b > 12)) return "mdy";
  const span = (pick: (p: { a: number; b: number; y: number }) => [number, number]) => {
    const days = parts.map((p) => { const [m, d] = pick(p); return Date.UTC(p.y, m - 1, d); });
    return Math.max(...days) - Math.min(...days);
  };
  const asDmy = span((p) => [p.b, p.a]);
  const asMdy = span((p) => [p.a, p.b]);
  if (asDmy === asMdy) return "unknowable";
  return asDmy < asMdy ? "dmy" : "mdy";
}

/** A Nimbus date cell → `YYYY-MM-DD`. `order` only matters for all-numeric
 *  cells and comes from `numericDateOrder` over the whole file; left out, an
 *  all-numeric cell is read day-first, the way most of the world writes it. */
export function parseNimbusDate(s: unknown, order: NumericDateOrder = "dmy"): string | null {
  const p = dateParts(s);
  if (!p) return null;
  if (p.named) return iso(p.y, p.b, p.a);
  const [mo, d] = order === "mdy" ? [p.a, p.b] : [p.b, p.a];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return iso(p.y, mo, d);
}

/** Kept as its own name because the expense importer calls it; the two readers
 *  are now the same code, since the formats were never actually different. */
export const parseDMY2 = parseNimbusDate;

/* ── times ────────────────────────────────────────────────────────────────
 *
 * The non-cash file is matched to sale lines on branch + date + THE EXACT TIME
 * STRING, so the two sides have to be spelled identically or the whole file
 * tags nothing.
 *
 * They were not. The sale export writes `09:39:59 PM`; the wallet export of
 * the same shop writes `9:32:54 PM`, no leading zero. All 58,303 sale lines
 * already in the database are in the padded form, so padded is the canonical
 * one — converting everything to 24-hour would orphan every row already there.
 * A 24-hour input is converted up rather than left to disagree. */
export function normTime(s: unknown): string {
  const raw = String(s ?? "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/);
  if (!m) return raw;
  let h = parseInt(m[1], 10);
  const mins = m[2], secs = m[3] ?? "00";
  /* m[4] is the single letter A or P — the M is matched but not captured, so
     it has to be put back. Returning "09:39:59 P" would have been worse than
     failing: it parses, it looks almost right, and it matches nothing in a
     table of 58,303 rows that all end "PM". */
  let mer = m[4] ? (m[4].toUpperCase() === "P" ? "PM" : "AM") : "";
  if (!mer) {                                   /* 24-hour in, 12-hour out */
    mer = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12; else if (h > 12) h -= 12;
  } else if (h === 0) h = 12;
  return `${String(h).padStart(2, "0")}:${mins}:${secs} ${mer}`;
}

/* ── csv ─────────────────────────────────────────────────────────────────── */

/** Rows as raw arrays. The sales parser needs positions, not a keyed object. */
export function parseCsvRows(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (q) {
      if (ch === '"') { if (clean[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
};
export const normStore = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/* ── which file is this? ──────────────────────────────────────────────────
 * One drop zone, six file types, told apart by EXACT header names. Exact,
 * not fuzzy: two of these files both carry `Store Name` and `Date`, and a
 * matcher loose enough to be helpful is loose enough to run an expense file
 * through the sales importer.
 */
export type NimbusKind =
  | "sales_multi" | "sales_single"
  | "expense_multi" | "expense_single"
  | "comm_master" | "payments" | "unknown";

export function detectKind(headers: string[]): NimbusKind {
  const has = (h: string) => headers.includes(h);
  if (has("Account") && has("Store Name")) return "expense_multi";
  if (has("Account") && !has("Store Name") && (has("Transaction Date") || has("Amount"))) return "expense_single";
  if (has("Item Code") && has("Commission") && has("Percentage")) return "comm_master";
  if (has("Payment Mode") && has("Store Name")) return "payments";
  if (!has("Store") && has("Item Code") && has("Date") && (has("MOP") || has("Sales Amount"))) return "sales_single";
  if (has("Store")) return "sales_multi";
  return "unknown";
}

export const KIND_LABEL: Record<NimbusKind, string> = {
  sales_multi: "Sales — all stores",
  sales_single: "Sales — single store",
  expense_multi: "Account transactions — all stores",
  expense_single: "Account transactions — single store",
  comm_master: "Commission master",
  payments: "Non-cash payments",
  unknown: "Not a Nimbus export",
};

/* ── sales ────────────────────────────────────────────────────────────────── */

export type SaleRow = {
  _store: string; _ns: string;
  branch_id: number | null;
  sale_date: string; sale_time: string; day: string;
  receipt_no: string; receipt_txn: string; online_order_no: string | null;
  salesperson: string | null; customer: string | null;
  item_code: string | null; item_name: string | null;
  department: string | null; size: string | null; color: string | null;
  retail_price: number; quantity: number; sales: number; discount: number;
  cust_discount: number; mkt_discount: number; adj_discount: number;
  net_sales: number; tax: number; sales_amount: number;
  cost_price: number; gross_margin: number;
  mop_raw: string | null; payment_method: string; serial_no: string | null;
  source: "nimbus";
};

/* MOP -> payment_method, exactly as the old app decides it.
 *
 * READ THIS BEFORE "IMPROVING" IT: a Nimbus sales export knows about cash,
 * credit, other and online. It does NOT know card from JazzCash — both arrive
 * as "Other Payment" and are resolved later by the separate Non-cash payments
 * file, matched on store + date + exact time. So a sales row can never map to
 * meezan_card or jazzcash here, and code that tries will mislabel every one of
 * them.
 *
 * `credit` is udhaar — goods on account — not a credit card. Counting it as
 * card is what made FC DHA's 1 Sep card figure read 36,100 instead of 33,400.
 */
export function mapSalesMop(mop: string, onlineOrderNo: string): string {
  if (/credit/i.test(mop)) return "credit";
  if (/other/i.test(mop)) return "unclassified";
  if (/cash/i.test(mop)) return "cash";
  if (onlineOrderNo) return "online";
  return "unclassified";
}

/** `RCP-88(10423)` → `10423`. Falls back to the whole string. */
export function receiptTxn(receipt: string): string {
  const m = receipt.match(/\((\d+)\)/);
  return m ? m[1] : receipt;
}

/* THE NUMERIC BLOCK IS POSITIONAL, ANCHORED ON THE MOP CELL.
 *
 * Not read by header name, on purpose. An item name containing a comma inside
 * an unquoted field shifts every column after it, and a header-indexed read
 * then takes "quantity" from whatever landed in that slot — silently, with a
 * plausible number. Anchoring on the LAST cell that looks like a payment mode
 * and counting backwards survives that, because the shift happens to the left
 * of the anchor and the offsets are measured from the right.
 *
 * Offsets are the original's, unchanged. Note sales_amount and net_sales are
 * deliberately the same cell (mi-5) — that is what the old app stores.
 */
const MOP_CELL = /^(cash|credit|other payment|online)/i;

/** Does this cell hold the payment mode?
 *
 *  Exported because the sales parser reads its MONEY COLUMNS BY OFFSET from
 *  this cell — `nA(12)` is twelve columns to its left — so a grid with one
 *  column too many or too few does not fail, it silently reads retail price
 *  where quantity should be. For CSV and Excel the grid is the file and that
 *  cannot happen. For a PDF, where the columns are inferred from the page
 *  layout, it can, and the import screen uses this to refuse the file rather
 *  than import shifted figures. */
export const looksLikeMopCell = (v: unknown) => MOP_CELL.test(String(v ?? "").trim());

export function parseSalesRows(rows: string[][], forceBranchId: number | null,
  resolveBranch: (ns: string) => number | null): { parsed: SaleRow[]; unknownStores: Set<string>; dateOrder: NumericDateOrder } {
  const hdr = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  hdr.forEach((h, i) => { idx[h] = i; });
  const get = (r: string[], name: string) => { const i = idx[name]; return i == null ? "" : (r[i] ?? ""); };

  const parsed: SaleRow[] = [];
  const unknownStores = new Set<string>();
  /* Read once, from the whole column, before any row is parsed. */
  const dateOrder = numericDateOrder(rows.slice(1).map((r) => get(r, "Date")));

  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const itemCode = (get(r, "Item Code") || "").trim();
    if (/^total/i.test(itemCode)) continue;          // footer row
    if (!r.join("").trim()) continue;                // blank row

    const store = (get(r, "Store") || "").trim();
    if (forceBranchId == null && !store) continue;
    const ns = normStore(store);
    let bid = forceBranchId;
    if (bid == null) {
      bid = resolveBranch(ns);
      if (bid == null) unknownStores.add(store);
    }

    let mi = -1;
    for (let k = r.length - 1; k >= 0; k--) {
      if (MOP_CELL.test(String(r[k] ?? "").trim())) { mi = k; break; }
    }
    if (mi < 0) mi = r.length - 2;
    const nA = (b: number) => num(r[mi - b]);

    const mop = String(r[mi] ?? "").trim();
    const online = (get(r, "Online Order #") || "").trim();
    const receipt = (get(r, "Receipt") || "").trim();
    const sdate = parseNimbusDate(get(r, "Date"), dateOrder);
    if (!sdate) continue;

    parsed.push({
      _store: store, _ns: ns, branch_id: bid,
      sale_date: sdate,
      /* Canonical, so the non-cash file can join to it. */
      sale_time: normTime(get(r, "Time")),
      day: (get(r, "Day") || "").trim(),
      receipt_no: receipt, receipt_txn: receiptTxn(receipt),
      online_order_no: online || null,
      salesperson: (get(r, "Salesperson") || "").trim() || null,
      customer: (get(r, "Customer") || "").trim() || null,
      item_code: itemCode || null,
      item_name: (get(r, "Item Name") || "").trim() || null,
      department: (get(r, "Department") || "").trim() || null,
      size: (get(r, "Size") || "").trim() || null,
      color: (get(r, "Color") || "").trim() || null,
      retail_price: nA(12), quantity: nA(11), sales: nA(10), discount: nA(9),
      cust_discount: nA(8), mkt_discount: nA(7), adj_discount: nA(6),
      net_sales: nA(5), tax: nA(4), sales_amount: nA(5),
      cost_price: nA(2), gross_margin: nA(1),
      mop_raw: mop || null,
      payment_method: mapSalesMop(mop, online),
      serial_no: (r[mi + 1] ?? "").trim() || null,
      source: "nimbus",
    });
  }
  return { parsed, unknownStores, dateOrder };
}

/* THE LINE HASH — DO NOT CHANGE THE SHAPE OF THIS STRING.
 *
 * It is a plain joined string, not a digest. That is not laziness: it is what
 * three years of rows in the old database already carry, and the column is
 * unique. Hash the same line differently — reorder a field, swap in SHA-256,
 * use serial_no instead of sale_time — and every migrated row stops matching
 * its own re-import. The file that was a safe no-op yesterday becomes a full
 * duplicate of the history today, and nothing reports an error because from
 * the database's point of view they are new rows.
 *
 * The `|#2`, `|#3` suffix is for genuinely repeated lines on one receipt: two
 * of the same shirt at the same price on the same bill are two real sales, and
 * collapsing them would under-count both the sale and the commission.
 */
export function withLineHashes<T extends { branch_id: number | null; sale_date: string; receipt_txn: string; item_code: string | null; quantity: number; sales_amount: number; sale_time: string }>(
  parsed: T[]
): (T & { line_hash: string })[] {
  const seen: Record<string, number> = {};
  return parsed.map((r) => {
    const base = [r.branch_id, r.sale_date, r.receipt_txn, r.item_code, r.quantity, r.sales_amount, r.sale_time].join("|");
    const n = (seen[base] = (seen[base] || 0) + 1);
    return { ...r, line_hash: n === 1 ? base : base + "|#" + n };
  });
}

/* ── expenses ─────────────────────────────────────────────────────────────── */

export type ExpenseRow = {
  _store: string; _ns: string;
  branch_id: number | null;
  expense_date: string; amount: number;
  txn_type: "expense" | "income";
  category: string; description: string | null;
  paid_via: string; source: "nimbus";
};

/* Category guessing, including the misspellings that actually appear in the
   Comments column. "recived" and "receieved" are in here because they are in
   the data, not because anybody approves of them. */
export function guessCat(desc: string | null): string {
  const d = (desc || "").toLowerCase();
  if (/h\.?\s*o\b|head\s*office|receiv|recived|receieved|farooq|yasir|yaser/.test(d)) return "Head Office";
  if (/sal(a|e)ry|salery/.test(d)) return "Salary";
  if (isAdvance(d)) return "Advance";
  if (/purchas|market|trader|neeker|nikar|baik|stock/.test(d)) return "Purchasing";
  return "Expense";
}

export function isAdvance(desc: string | null): boolean {
  const d = (desc || "").toLowerCase();
  return /\badv/.test(d) || /advanc|advnc|advc\b|adva\b|peshg|paishg|pesh\s*gi/.test(d);
}

/* ── advances: the money left the till, but WHO got it? ──────────────────────
 *
 * An advance is the one expense that is also a debt. Nimbus records it as money
 * out of the shop and nothing more — there is no employee column in that export
 * and there never will be. Until the row is attached to a person, their
 * outstanding balance is understated by exactly that amount and Repayments does
 * not list them, which is the whole point of recording it.
 *
 * The old app solved this by stopping the import and walking the operator
 * through every flagged row in a modal, one at a time, with a staff dropdown on
 * each. That is where `_employee_id` came from. It worked, and nobody enjoyed
 * it: a month of files is 80-odd dialogs, and the answer is almost always
 * written in the Comments column already — "adv to Bilal", "peshgi Ahmed".
 *
 * So the name is read out of the note instead. The rule that matters is the
 * last one:
 *
 *   · only staff AT THAT ROW'S SHOP are candidates;
 *   · a whole-word run of the person's full name beats a single name token,
 *     so "Muhammad Ali" wins over "Muhammad Hassan" on "adv muhammad ali";
 *   · AND IF TWO PEOPLE FIT EQUALLY WELL, NOBODY IS PICKED. Four Muhammads at
 *     one shop and a note that says "adv muhammad" is not a near-miss to be
 *     resolved by taking the first row — it is a genuinely unanswerable
 *     question, and charging the wrong person's ledger is far worse than
 *     leaving it unlinked where it shows up as a number on screen.
 *
 * Two rules below exist because of what the 244 advances already in the
 * database actually look like, not because they seemed like a good idea:
 *
 *   LEAVERS COUNT. 12 of them (Rs 49,370) name somebody who has since been
 *   ended — DANISH, ALI ASGHAR, ADEEBA, KASHIF. A debt belongs to whoever took
 *   the money; it does not stop being owed because they stopped working here,
 *   and their ledger is kept for exactly this reason. The old dropdown listed
 *   active staff only, which was survivable when a human could see the name was
 *   missing and go and look. Nothing here can see that, so leavers stay in.
 *
 *   ONE TYPO IS ALLOWED, NARROWLY. Another 36 (Rs 83,820) spell the name one
 *   character away from the staff record: SAHAR for SEHAR, SWEEPER for SWEAPER,
 *   MUBEEN for MOBEEN, SHAZIM for SHAHZIM, javad for JAVED, clener for ALI
 *   CLEANER. Half the unlinked money is in that bucket, and a human reads every
 *   one of them without hesitating. So a word may be one edit away from a name
 *   — but only a word of five characters or more (at three, "ALI" and "ADI" are
 *   one edit apart and are different people), only when exactly one person fits,
 *   and never where an exact match exists: the scores below are tiered so that
 *   no exactly-matched row can ever be changed by this. Near matches are
 *   reported separately so the preview can mark them for a second look.
 *
 * Unlinked rows still import as expenses. The till is right either way; what is
 * at stake is only whether the debt is attached, and the count of what could
 * not be attached is shown before anything is written.
 */
export type StaffForMatch = { id: number; name: string; branch_id: number | null; active?: boolean };

/** A row for `retail_employee_ledger` — keys exactly as the import function
 *  reads them, and identical to the old app's shape so re-imports dedupe
 *  against rows the old app wrote. */
export type AdvRow = {
  employee_id: number; entry_date: string;
  advance: number; purchase_credit: number; paid: number;
  purchase_details: string; source: "nimbus";
};

export type AdvanceLink = {
  rows: AdvRow[];
  /** row → employee id, for showing the match in the preview. Keyed by object
   *  identity: the preview renders these very rows. */
  who: Map<ExpenseRow, number>;
  /** the subset of `who` that matched one character out rather than exactly.
   *  Worth a second look, so the preview marks them. */
  near: Set<ExpenseRow>;
  /** advance-category expense rows seen (linked or not) */
  seen: number;
  matched: number;
  /** names read but fitting two or more people equally — deliberately unlinked */
  ambiguous: number;
};

/** Name tokens worth matching on. Three letters and up: "M", "MD" and initials
 *  identify nobody, and letting them match turns one typo into a wrong ledger. */
const nameTokens = (s: string): string[] =>
  s.toUpperCase().replace(/[^A-Z\s]+/g, " ").split(/\s+/).filter((t) => t.length >= 3);

/** Levenshtein, abandoned as soon as it cannot be 1. Only ever asked whether
 *  two words are one edit apart, so there is no reason to compute further. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 1) return false;
    prev = cur;
  }
  return prev[b.length] === 1;
}

/** Five characters and up. Below that one edit is a different person, not a
 *  typo — ALI / ADI / ASI are three people at one shop. */
const FUZZ_MIN = 5;

export function linkAdvances(parsed: ExpenseRow[], staff: StaffForMatch[]): AdvanceLink {
  const rows: AdvRow[] = [];
  const who = new Map<ExpenseRow, number>();
  const near = new Set<ExpenseRow>();
  let seen = 0, matched = 0, ambiguous = 0;

  /* Tokenise each candidate once, not once per row. Leavers included — see the
     note above: an advance is owed by whoever took it. */
  const pool = staff
    .filter((e) => e.branch_id != null)
    .map((e) => ({ id: e.id, bid: e.branch_id as number, toks: nameTokens(e.name), live: e.active !== false }))
    .filter((e) => e.toks.length > 0);

  for (const p of parsed) {
    if (p.txn_type !== "expense" || p.category !== "Advance" || p.branch_id == null) continue;
    seen++;

    /* Padded on both sides so `includes(" ALI ")` is a whole-word test rather
       than a substring one — otherwise "ALI" matches "KHALID". */
    const words = (p.description || "").toUpperCase().replace(/[^A-Z0-9\s]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const hay = " " + words.join(" ") + " ";
    const fuzzable = words.filter((w) => w.length >= FUZZ_MIN);

    /* TIERED, so a looser read can never outrank or displace a tighter one:
         whole name, in order, as its own run of words  +1000
         each name token present exactly                 +100
         each name token one edit from a word              +2
         still on the payroll                             +1
       More exact tokens always beat fewer, one exact beats any number of near
       (a name would need fifty fuzzy tokens to catch up), and a tie at the top
       is left unlinked whatever tier produced it.

       THE +1 IS NOT COSMETIC, and it is here because the measurement said so.
       Letting leavers in put a second AHMAD and a second HASEEB in range at
       their shops, and twelve rows that had been reading correctly for months
       collapsed into dead ties — the change paid for twelve leaver matches by
       destroying twelve certain ones. Where an active employee and an ended one
       fit a note equally well, the person still on the payroll is who a current
       advance note means; that is a real signal, not a coin toss, and it only
       ever decides a tie that would otherwise resolve to nobody. A leaver can
       still win outright when no active name fits, which is the whole point. */
    let best = 0, bestId = 0, bestCount = 0, bestExact = 0;
    for (const e of pool) {
      if (e.bid !== p.branch_id) continue;
      let exact = 0, fuzz = 0;
      for (const t of e.toks) {
        if (hay.includes(" " + t + " ")) exact++;
        else if (t.length >= FUZZ_MIN && fuzzable.some((w) => oneEditApart(w, t))) fuzz++;
      }
      if (exact === 0 && fuzz === 0) continue;
      let score = exact * 100 + fuzz * 2 + (e.live ? 1 : 0);
      if (e.toks.length > 1 && hay.includes(" " + e.toks.join(" ") + " ")) score += 1000;
      if (score > best) { best = score; bestId = e.id; bestCount = 1; bestExact = exact; }
      else if (score === best) bestCount++;
    }

    if (best === 0) continue;
    if (bestCount > 1) { ambiguous++; continue; }

    matched++;
    who.set(p, bestId);
    if (bestExact === 0) near.add(p);
    rows.push({
      employee_id: bestId, entry_date: p.expense_date,
      advance: p.amount, purchase_credit: 0, paid: 0,
      purchase_details: (p.description || "Advance") + " (import)",
      source: "nimbus",
    });
  }
  return { rows, who, near, seen, matched, ambiguous };
}

export function parseExpenseRows(rows: string[][], forceBranchId: number | null,
  resolveBranch: (ns: string) => number | null): { parsed: ExpenseRow[]; unknown: Set<string>; minD: string | null; maxD: string | null; dateOrder: NumericDateOrder } {
  const hdr = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  hdr.forEach((h, i) => { idx[h] = i; });
  const get = (r: string[], name: string) => { const i = idx[name]; return i == null ? "" : (r[i] ?? ""); };

  const parsed: ExpenseRow[] = [];
  const unknown = new Set<string>();
  let minD: string | null = null, maxD: string | null = null;
  const dateOrder = numericDateOrder(rows.slice(1).map((r) => get(r, "Transaction Date")));

  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const store = (get(r, "Store Name") || "").trim();
    if (forceBranchId == null && !store) continue;

    /* THE SIGN IS THE DIRECTION. Negative is money out, positive is money in.
       The amount is stored absolute with txn_type carrying the sign, because a
       column that is sometimes negative makes every SUM() in the app a
       conditional one. */
    const amt = num(get(r, "Amount"));
    if (amt === 0) continue;

    const dt = parseNimbusDate(get(r, "Transaction Date"), dateOrder);
    if (!dt) continue;

    const ns = normStore(store);
    let bid = forceBranchId;
    if (bid == null) {
      bid = resolveBranch(ns);
      if (bid == null) unknown.add(store);
    }

    /* THE COLUMN HAS TWO NAMES. Older exports head it "Wallet / Card", the
       current one "Payment Type". Reading only the first made every row cash,
       so a card-paid expense reconciled against nothing. */
    const wallet = ((get(r, "Wallet / Card") || get(r, "Payment Type")) || "").trim().toLowerCase();
    const pv = /jazz/.test(wallet) ? "jazzcash"
      : /meezan|card/.test(wallet) ? "meezan_card"
      : /bank/.test(wallet) ? "bank" : "cash";

    if (!minD || dt < minD) minD = dt;
    if (!maxD || dt > maxD) maxD = dt;

    const desc = (get(r, "Comments") || "").replace(/\s+/g, " ").trim() || null;
    const acct = (get(r, "Account") || "").trim();
    let cat: string;
    if (amt >= 0) cat = acct || "Misc Income";
    else if (/head\s*office/i.test(acct)) cat = "Head Office";
    else cat = guessCat(desc);

    /* ADVANCE WINS OVER EVERY CATEGORY BUT HEAD OFFICE.
     *
     * `guessCat` tests salary before advance, so "salary advance for Bilal"
     * comes back "Salary" — and an advance filed as salary is never attached to
     * anybody and never comes back out of their pay. The old app corrected this
     * in a second pass before its review wizard (`p.category="Advance"` for any
     * expense that is not Head Office and reads like an advance); that pass is
     * folded in here, so there is one place a category is decided instead of
     * two that can disagree. Head Office stays Head Office: that is money owed
     * between the shop and the office, not to a person. */
    if (amt < 0 && cat !== "Head Office" && (cat === "Advance" || isAdvance(desc))) cat = "Advance";

    parsed.push({
      _store: store, _ns: ns, branch_id: bid,
      expense_date: dt, amount: Math.abs(amt),
      txn_type: amt < 0 ? "expense" : "income",
      category: cat, description: desc, paid_via: pv, source: "nimbus",
    });
  }
  return { parsed, unknown, minD, maxD, dateOrder };
}

/* ── non-cash payments ────────────────────────────────────────────────────
 * This file is what turns "Other Payment" into card or JazzCash. It carries no
 * amounts — only store, a combined date+time stamp, and the mode — and is
 * matched against already-imported sale lines on branch + date + EXACT time.
 * So the shop's sales have to be imported first; otherwise there is nothing to
 * tag and the run reports zero.
 */
export type PaymentRow = { ns: string; store: string; branch_id: number | null; date: string; time: string; pm: string; modeRaw: string };

/** `forceBranchId` is for the shop you are standing in. The non-cash export
 *  carries a Store Name, but a Fashion Collection one says "Fashion
 *  collection" — the chain, not the shop — so Paragon's file and DHA's file
 *  are word-for-word identical in that column and neither can route itself.
 *  The rest of the importer already solved this for files with no Store column
 *  at all; this one has a column that does not identify a branch, which comes
 *  to the same thing, so it gets the same answer. A name that DOES resolve
 *  still wins, because a genuine all-stores export must still fan out. */
export function parsePaymentRows(rows: string[][], forceBranchId: number | null = null,
  resolveBranch: (ns: string) => number | null = () => null,
): { parsed: PaymentRow[]; unknown: Set<string>; dateOrder: NumericDateOrder } {
  const hdr = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  hdr.forEach((h, i) => { idx[h] = i; });
  const get = (r: string[], name: string) => { const i = idx[name]; return i == null ? "" : (r[i] ?? ""); };

  const parsed: PaymentRow[] = [];
  const unknown = new Set<string>();
  /* The date half of every cell, read as a whole column — see numericDateOrder.
     This file is the reason that function exists: its dates are all-numeric. */
  const dateOrder = numericDateOrder(rows.slice(1).map((r) => String(get(r, "Date")).trim().split(/\s+/)[0]));

  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const store = (get(r, "Store Name") || "").trim();
    const dt = (get(r, "Date") || "").trim();
    if (!store || !dt) continue;

    /* ONE CELL, TWO VALUES: the day, and the time it will be matched on.
       Split on the first space run — the date half has no spaces in any of the
       shapes Nimbus writes, while the time half may ("9:32:54 PM"). The old
       split demanded `13/Jul/2026 14:32:07` exactly and dropped all 85 rows of
       a file reading `10/10/2026 9:32:54 PM`. */
    const sp = dt.indexOf(" ");
    if (sp < 0) continue;
    const dISO = parseNimbusDate(dt.slice(0, sp), dateOrder);
    if (!dISO) continue;
    const time = normTime(dt.slice(sp + 1));
    if (!time) continue;

    const ns = normStore(store);
    let bid = resolveBranch(ns);
    if (bid == null) {
      if (forceBranchId != null) bid = forceBranchId;
      else unknown.add(store);
    }

    const modeRaw = (get(r, "Payment Mode") || "").trim();
    /* Any card acquirer — Meezan, Standard Chartered, whoever — goes in the
       card bucket. Only JazzCash is its own thing. */
    const pm = /jazz/i.test(modeRaw) ? "jazzcash" : "meezan_card";
    parsed.push({ ns, store, branch_id: bid, date: dISO, time, pm, modeRaw });
  }
  return { parsed, unknown, dateOrder };
}

/* ── commission master ────────────────────────────────────────────────────── */

export type CommRow = { item_code: string; item_name: string | null; retail_price: number; commission: number; percentage: number };

export function parseCommRows(rows: string[][]): CommRow[] {
  const hdr = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  hdr.forEach((h, i) => { idx[h] = i; });
  const get = (r: string[], name: string) => { const i = idx[name]; return i == null ? "" : (r[i] ?? ""); };

  const out: CommRow[] = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const code = (get(r, "Item Code") || "").trim();
    if (!code || /^total/i.test(code)) continue;
    out.push({
      item_code: code,
      item_name: (get(r, "Item Name") || "").trim() || null,
      retail_price: num(get(r, "Retail Price") || get(r, "Rate")),
      commission: num(get(r, "Commission")),
      percentage: num(get(r, "Percentage")),
    });
  }
  return out;
}
