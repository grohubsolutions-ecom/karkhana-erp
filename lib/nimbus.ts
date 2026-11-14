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
  | "comm_master" | "comm_list" | "payments" | "unknown";

export function detectKind(headers: string[]): NimbusKind {
  const has = (h: string) => headers.includes(h);
  /* Nimbus commission master is the strictest match — all three columns. */
  if (has("Account") && has("Store Name")) return "expense_multi";
  if (has("Account") && !has("Store Name") && (has("Transaction Date") || has("Amount"))) return "expense_single";
  if (has("Item Code") && has("Commission") && has("Percentage")) return "comm_master";
  if (has("Payment Mode") && has("Store Name")) return "payments";
  if (!has("Store") && has("Item Code") && has("Date") && (has("MOP") || has("Sales Amount"))) return "sales_single";
  if (has("Store")) return "sales_multi";
  /* Custom commission list — a hand-made file with a barcode column and at
     least one of commission / percentage / rate. Does not come from Nimbus, so
     it is checked LAST to avoid stealing a Nimbus file whose headers overlap.
     Case-insensitive AND substring-matched because these are hand-typed column
     names — "ITEMS BARECODE", "Barcode", "Item Barcode" should all work. */
  const lc = headers.map((h) => h.toLowerCase());
  const any = (kw: string) => lc.some((h) => h.includes(kw));
  const hasBarcode = any("barcode") || any("barecode") || any("bar code") || lc.includes("item code");
  const hasComm = any("commission") || lc.includes("rate") || lc.includes("percentage");
  if (hasBarcode && hasComm) return "comm_list";
  return "unknown";
}

export const KIND_LABEL: Record<NimbusKind, string> = {
  sales_multi: "Sales — all stores",
  sales_single: "Sales — single store",
  expense_multi: "Account transactions — all stores",
  expense_single: "Account transactions — single store",
  comm_master: "Commission master",
  comm_list: "Commission list",
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
  /** WHICH SHOP'S TILL PAID IT — the branch of the expense row this came from,
   *  not the employee's branch. Staff move between shops; the cash does not
   *  move with them. See migration 0135. */
  branch_id: number | null;
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
    /* TWO PASSES, THE SHOP'S OWN STAFF FIRST.
     *
     * This used to be one pass with `if (e.bid !== p.branch_id) continue;` —
     * only people filed at the shop whose file it is were ever considered. That
     * is right nearly always and silently wrong the moment somebody moves:
     * a worker transferred from FC DHA to FC Paragon takes an advance at
     * Paragon, Paragon's file names him, and because his record still says DHA
     * he matched nobody. The row was dropped, the cash left the till, and no
     * ledger anywhere said he owed it.
     *
     * So: the shop's own staff are tried first and win outright whenever one of
     * them fits — a local ALI must never lose to an ALI at another branch. Only
     * when NOBODY at the shop fits does it look company-wide, and there the bar
     * is higher: the match must be unique across all eight shops AND exact
     * (no one-character guesses at a name from another branch). Anything short
     * of that stays unlinked and goes to the unassigned list, where a person
     * decides. Guessing across shops is how one man's advance lands on another
     * man's salary. */
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

    /* Nobody at this shop fits. Look across the company for an EXACT, UNIQUE
       name — a transfer, almost always. */
    let away = false;
    if (best === 0) {
      let aExact = 0, aId = 0, aCount = 0;
      for (const e of pool) {
        if (e.bid === p.branch_id) continue;
        let exact = 0;
        for (const t of e.toks) if (hay.includes(" " + t + " ")) exact++;
        if (exact === 0) continue;
        /* whole name in order, or every token of the name present */
        const whole = e.toks.length > 1 && hay.includes(" " + e.toks.join(" ") + " ");
        if (!whole && exact < e.toks.length) continue;
        if (exact > aExact) { aExact = exact; aId = e.id; aCount = 1; }
        else if (exact === aExact) aCount++;
      }
      if (aExact > 0 && aCount === 1) { best = aExact * 100; bestId = aId; bestCount = 1; bestExact = aExact; away = true; }
    }

    if (best === 0) continue;
    if (bestCount > 1) { ambiguous++; continue; }

    matched++;
    who.set(p, bestId);
    /* A cross-shop match is flagged the same way a one-character match is: it
       is almost certainly right, and it is still worth a human glance. */
    if (bestExact === 0 || away) near.add(p);
    rows.push({
      employee_id: bestId, entry_date: p.expense_date,
      branch_id: p.branch_id,
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

/* ── custom commission list ──────────────────────────────────────────────
 *
 * Not a Nimbus export — a hand-made file the user creates with barcodes and
 * commission amounts or percentages. Flexible header names: Barcode / Bar Code /
 * Item Barcode / Item Code for the key, Commission / Commission Amount / Rate /
 * Percentage for the value. Item Name and Retail Price are optional.
 *
 * Returns the same CommRow shape so the import path is identical to comm_master.
 */
export function parseCommListRows(rows: string[][]): CommRow[] {
  const hdr = rows[0].map((h) => h.trim());
  /* Case-insensitive AND substring lookup — the file is hand-made, so
     "ITEMS BARECODE", "Barcode", "Item Barcode" should all work.
     `findBy` tries exact matches first, then substring contains. */
  const lcHdr = hdr.map((h) => h.toLowerCase());
  const find = (exactNames: string[], substrings: string[]) => {
    for (const n of exactNames) { const i = lcHdr.indexOf(n.toLowerCase()); if (i >= 0) return i; }
    for (const kw of substrings) { const lo = kw.toLowerCase(); const i = lcHdr.findIndex((h) => h.includes(lo)); if (i >= 0) return i; }
    return -1;
  };
  const ci = find(["Barcode", "Bar Code", "Barcode No", "Item Barcode", "Item Code"], ["barcode", "barecode", "bar code"]);
  const ni = find(["Item Name", "Name", "Article", "Article Name", "Description", "Product"], ["item name", "article", "product"]);
  const pi = find(["Retail Price", "Price", "MRP"], ["retail price", "price", "mrp"]);
  const coi = find(["Commission", "Commission Amount"], ["commission"]);
  const pci = find(["Percentage", "%", "Commission %", "Comm %"], ["percentage", "percent"]);

  if (ci < 0) return [];

  const out: CommRow[] = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const code = (r[ci] ?? "").trim();
    if (!code || /^total/i.test(code)) continue;
    const commVal = coi >= 0 ? num(r[coi] ?? "") : 0;
    const pctVal = pci >= 0 ? num(r[pci] ?? "") : 0;
    /* If only one of commission/percentage was given and the retail price is
       present, derive the other so the database row is complete. */
    const retail = pi >= 0 ? num(r[pi] ?? "") : 0;
    let finalComm = commVal;
    let finalPct = pctVal;
    if (finalComm === 0 && finalPct > 0 && retail > 0) finalComm = Math.round(retail * finalPct / 100);
    if (finalPct === 0 && finalComm > 0 && retail > 0) finalPct = Math.round((finalComm / retail) * 10000) / 100;
    out.push({
      item_code: code,
      item_name: ni >= 0 ? (r[ni] ?? "").trim() || null : null,
      retail_price: retail,
      commission: finalComm,
      percentage: finalPct,
    });
  }
  /* Deduplicate by item_code — a hand-made file may list the same barcode
     twice. Keep the LAST occurrence so the user's latest value wins. Without
     this, the Supabase upsert fails with "ON CONFLICT DO UPDATE command
     cannot affect a row a second time". */
  const seen = new Map<string, number>();
  out.forEach((r, i) => seen.set(r.item_code, i));
  return out.filter((_, i) => [...seen.values()].includes(i));
}

/* ── WHICH SHOP IS THIS FILE FROM? ────────────────────────────────────────
 *
 * A Fashion Collection export does not say. The sales report has no Store
 * column at all; the non-cash report has one that reads "Fashion collection" —
 * the chain, so Paragon's file and DHA's file are word-for-word identical in
 * it. The owner's complaint, and he is right: being handed a dropdown is being
 * asked a question the file can answer.
 *
 * It can, from the numbers already in the database:
 *
 *   SALES — THE RECEIPT SERIES. Every shop's till runs its own unbroken
 *   counter. FC DHA's imported lines stop at receipt 22552; the file he sent
 *   starts at 22553 and runs to 22895. It is the next page of that shop's
 *   book. FC Paragon's counter is at 15478, seven thousand away, and no Top
 *   Shop is past 6846 — so there is exactly one shop this file can belong to,
 *   and no dropdown should ever have been shown for it.
 *
 *   NON-CASH — THE TIMESTAMPS. That file carries no amounts and no receipts.
 *   What it does carry is the exact second of each card tap, and its whole
 *   purpose is to match sale lines already imported on shop + date + time. So
 *   the match itself identifies the shop: whichever branch owns sale lines at
 *   those exact seconds is the branch whose card machine produced the file.
 *
 * Both are evidence, not a guess, and both report how sure they are so the
 * screen can say WHY rather than just naming a shop. Ambiguity is never
 * resolved by picking the first row — it returns null and the picker appears,
 * which is the one case where asking is the right thing to do.
 */
export type ShopGuess = {
  branch_id: number;
  /** `certain` — the file's own numbers can only mean this shop.
   *  `likely`  — the best of several, worth showing but not silent. */
  confidence: "certain" | "likely";
  /** One sentence, for the screen. Written for the shopkeeper, not the log. */
  why: string;
};

/** The highest receipt number a branch has already imported. */
export type ReceiptHigh = { branch_id: number; high: number };

/** Leading integer of a Nimbus receipt. "22895(22590892)" → 22895. The number
 *  in brackets is Nimbus's own global transaction id and is NOT per-shop, so it
 *  must not be used for this. */
export const receiptNo = (s: unknown): number | null => {
  const m = String(s ?? "").trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

/** THE FILE IS THE NEXT PAGE OF WHOSE BOOK?
 *
 *  `lo`/`hi` are the file's own receipt range. A branch matches when the file
 *  carries straight on from where that branch stopped, or overlaps the series
 *  it already has (a re-import of a file already in, which must land on the
 *  same shop). A gap is allowed — days can be missed — but only forwards and
 *  only within `maxGap`, because a receipt number far past a branch's last one
 *  is not evidence of anything.
 *
 *  Two branches matching means no answer. In practice their counters are
 *  thousands apart, so one matches or none does. */
export function shopFromReceipts(lo: number, hi: number, highs: ReceiptHigh[],
  maxGap = 2000): ShopGuess | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  const hits = highs.filter((h) => h.high > 0 && lo > h.high - (hi - lo) - 1 && lo <= h.high + maxGap);
  if (hits.length !== 1) return null;
  const h = hits[0];
  const exact = lo === h.high + 1;
  return {
    branch_id: h.branch_id,
    confidence: "certain",
    why: exact
      ? `receipt ${lo.toLocaleString()} carries straight on from ${h.high.toLocaleString()}, the last one imported for this shop`
      : lo <= h.high
        ? `receipts ${lo.toLocaleString()}–${hi.toLocaleString()} are inside this shop's own series (already at ${h.high.toLocaleString()})`
        : `receipts ${lo.toLocaleString()}–${hi.toLocaleString()} follow this shop's series, which had reached ${h.high.toLocaleString()}`,
  };
}

/** How many of the file's timestamps each branch already owns a sale line for.
 *  `[branch_id, matches]`, however the caller counted them. */
export type StampHits = { branch_id: number; hits: number };

/** THE CARD TAPS LAND IN SOMEBODY'S TILL.
 *
 *  JUDGED ON THE COUNT, NOT ON THE SHARE OF THE FILE. A match here is to the
 *  exact second, which is a very specific key: three of them landing on one
 *  branch and none anywhere else is strong evidence, and each further match
 *  multiplies how unlikely a coincidence would have to be.
 *
 *  Share would be the wrong test because a low share has an innocent and very
 *  common explanation — the sales for those days are not all imported yet, and
 *  people do drop the non-cash file first. Demanding a fifth of the file would
 *  make it give up and show a dropdown in exactly the case it can answer.
 *
 *  What it still refuses: fewer than three matches, and a runner-up anywhere
 *  near the top. Two busy shops can collide on a second or two; they do not
 *  collide repeatedly. */
export function shopFromStamps(total: number, hits: StampHits[]): ShopGuess | null {
  if (total <= 0) return null;
  const ranked = hits.filter((h) => h.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!ranked.length) return null;
  const top = ranked[0], next = ranked[1]?.hits ?? 0;
  if (top.hits < 3) return null;                   /* one second could be chance */
  if (next > top.hits * 0.34) return null;         /* no clear winner */
  const share = top.hits / total;
  return {
    branch_id: top.branch_id,
    confidence: top.hits >= 10 || share >= 0.5 ? "certain" : "likely",
    why: `${top.hits} of ${total} payments match a sale already imported for this shop, to the exact second`,
  };
}

/** The shop named in a file name, if any. Weakest of the three, but free. */
export function shopFromFileName(fileName: string,
  branches: { id: number; name: string; nimbus_name?: string | null }[]): ShopGuess | null {
  const hay = normStore(fileName.replace(/\.[a-z0-9]+$/i, ""));
  if (!hay) return null;
  const hit = branches.filter((b) => {
    const ns = b.nimbus_name ? normStore(b.nimbus_name) : "";
    return (ns && hay.includes(ns)) || hay.includes(normStore(b.name));
  });
  if (hit.length !== 1) return null;
  return { branch_id: hit[0].id, confidence: "likely", why: `the file name names ${hit[0].name}` };
}

/** WHOSE SHOP DOES AN ACCOUNT FILE BELONG TO? THE PEOPLE IN IT.
 *
 *  This was the one hole left. An expense export has no Store column, no
 *  receipt numbers and no timestamps — nothing a machine can match — so it was
 *  the one file still falling back to the shop you happened to be standing in.
 *  Get that wrong and a day's expenses land on another shop's books.
 *
 *  But the Comments column is full of names: "MISS SEHAR ADVANCE", "MAM SONIA
 *  ADVANCE", "MISS BUSHRA PUFF", "MUBEEN BHAI PUFF". Those are staff, and staff
 *  belong to a shop. Four of them in one file, all on one payroll and none on
 *  any other, says whose file it is as plainly as a store name would.
 *
 *  STAFF NAMES ONLY — never branch names. That is not fussiness: this very
 *  file has a line reading "PARAGON RIDER", and a matcher that looked at shop
 *  names would read that as Fashion Collection Paragon and file a whole day of
 *  DHA's expenses to the wrong shop.
 *
 *  TWO DIFFERENT PEOPLE, not one. A single name can be a coincidence — a
 *  supplier called Sonia, a brand called Gold — and the price of being wrong
 *  here is a day of money in the wrong place. Two people from the same payroll
 *  and nobody from another is not a coincidence. A single full name matched in
 *  full counts, because "MISS SEHAR" is not how anyone writes a supplier.
 */
export function shopFromStaffNames(notes: (string | null)[], staff: StaffForMatch[]): ShopGuess | null {
  const hay = " " + notes.map((n) => (n ?? "")).join(" ")
    .toUpperCase().replace(/[^A-Z0-9\s]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  if (hay.trim().length < 3) return null;
  const words = hay.trim().split(" ");
  const fuzzable = words.filter((w) => w.length >= FUZZ_MIN);

  /* branch -> the distinct people of that branch named in the file */
  const per = new Map<number, { names: Set<string>; full: boolean }>();
  for (const e of staff) {
    if (e.branch_id == null) continue;
    const toks = nameTokens(e.name);
    if (!toks.length) continue;
    const exact = toks.filter((t) => hay.includes(" " + t + " "));
    const near = toks.filter((t) => t.length >= FUZZ_MIN && fuzzable.some((w) => oneEditApart(w, t)));
    if (!exact.length && !near.length) continue;
    /* The whole name as a run of words — decisive on its own. */
    const full = toks.length > 1 && hay.includes(" " + toks.join(" ") + " ");
    const slot = per.get(e.branch_id) ?? { names: new Set<string>(), full: false };
    slot.names.add(e.name.toUpperCase());
    if (full) slot.full = true;
    per.set(e.branch_id, slot);
  }
  const ranked = [...per].map(([branch_id, v]) => ({ branch_id, n: v.names.size, full: v.full }))
    .sort((a, b) => b.n - a.n);
  if (!ranked.length) return null;
  const top = ranked[0], next = ranked[1]?.n ?? 0;
  if (top.n < 2 && !top.full) return null;
  if (next > top.n * 0.34) return null;
  return {
    branch_id: top.branch_id,
    confidence: top.n >= 3 ? "certain" : "likely",
    why: top.n === 1
      ? `a note names ${[...per.get(top.branch_id)!.names][0]}, who is on this shop's staff`
      : `${top.n} of this shop's staff are named in the notes (${[...per.get(top.branch_id)!.names].slice(0, 3).join(", ")}${top.n > 3 ? ", …" : ""}) and nobody from another shop`,
  };
}
