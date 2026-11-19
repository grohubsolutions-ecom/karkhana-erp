"use client";
/* CPR / settlement import.
 *
 * Drop the file a courier gives you; this reads it, shows you what it read, and
 * refuses to write anything unless the numbers agree with the file's own.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD IS ONLY REAL IF THE DECLARED FIGURES COME FROM OUTSIDE THE PARSE
 *
 *   OwnEx PDF  — states its own totals in the header ("Delivered 149
 *                341,043.84"), so those are read from the file and the check is
 *                genuine: parse vs. the courier's own arithmetic.
 *
 *   PostEx CSV — has NO totals row. Computing the "declared" figures from the
 *                same rows we parsed would compare a number to itself and pass
 *                every time, including on a completely wrong column mapping.
 *                So for CSV you TYPE the count and total off the PostEx portal
 *                screen. Tedious once, and it is the only version of this check
 *                that can actually fail.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FILES ACTUALLY LOOK LIKE  (measured, not assumed)
 *
 *   PostEx CSV_Transactions export
 *     TRACKING_NUMBER · STATUS · COD_AMOUNT · NET_AMOUNT
 *     NET = COD − SHIPPING_CHARGES − GST − WH_INCOME_TAX − WH_SALES_TAX
 *     verified exact: 2299.00 − 222.40 − 35.58 − 45.98 − 45.98 = 1949.06
 *     202 rows on the 25 Aug export — 147 Delivered and 55 RETURN. A PostEx
 *     settlement is not all money coming in; the returns are money going out.
 *
 *   OwnEx invoice PDF
 *     Sr · Order Ref · Tracking No · Wt · Pickup · Origin · Delivery City ·
 *     Status · D/R Date · COD · Upfront · Reserved · Charges · Tax · Net Total
 *     Net Total is NEGATIVE when the courier owes you.
 *     Order Ref is NOT reliable — row 37 of INV-20250018 reads "tayyaba".
 *     Keyed on tracking number only.
 *     Up to INV-20250025 fuel (20% of charges) was charged once at invoice
 *     level and the Tax column read 0.00. From INV-20250026 (OwnEx's new
 *     system, Oct 2026) fuel is on every row. See parseOwnExInvoice.
 */
import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { parseCsv, matchHeader, toNum } from "@/lib/csv";
import Modal, { btnPrimary, btnGhost } from "@/components/Modal";

type CprRow = {
  tracking_id: string; status: string;
  cod: number; net: number; fee: number; tax: number; paid_on: string | null;
  /* H320 (19 Nov 2026) — PostEx CPRs only. Each row carries two extra numbers:
       upfront  = v[1], the ~70% of COD PostEx paid us at dispatch (every parcel)
       reserve  = v[2], the balance PostEx is paying with THIS CPR (delivered +
                  returns clawback — often small, sometimes negative on returns)
     Bank total = Upfront + Reserve  (what hit the account across both payouts)
     OwnEx has no upfront, so these stay undefined on OwnEx rows. */
  upfront?: number; reserve?: number;
};
/** One settlement. A PostEx CPR export can hold 93 of these in a single PDF. */
type Batch = {
  ref: string;
  date: string;                    // yyyy-mm-dd
  rows: CprRow[];
  declaredCount?: number;          // the file's own parcel count
  declaredNet?: number;            // the file's own net, computed from its summary
  computedNet?: number;            // the same figure summed from the rows
  /* The receipt's own working, stored so the page can show the calculation the
     way the courier does instead of one unexplained number.
     H320: upfront_* / reserve_* sum the per-row columns above, split by
     delivered vs returned, so the panel can show "bank got X, this CPR covers Y,
     earlier upfront covered Z". PostEx-only; OwnEx leaves them at 0. */
  summary?: { gross: number; shipping: number; gst: number;
              wh_income: number; wh_sales: number; net: number;
              upfront_total?: number; reserve_total?: number;
              upfront_delivered?: number; upfront_returns?: number };
  courier: "PostEx" | "OwnEx";
  problem?: string;                // set when the file contradicts itself
};
type Parsed = {
  batches: Batch[];
  source: "csv" | "pdf";
  note?: string;
};

const n2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const money = (v: unknown) => "Rs " + n2(v).toLocaleString("en-PK");
/* A courier's own word for the row. Anything that is not a delivery is a
   charge, never a payment — see hub_cpr_import, which obeys this literally. */
const isDelivered = (s: string) => /^deliver/i.test(String(s || "").trim());

/* ---------------------------------------------------------------- CSV / XLS */
async function readSheet(file: File): Promise<Parsed> {
  let headers: string[], raw: Record<string, string>[];

  if (/\.csv$/i.test(file.name)) {
    ({ headers, rows: raw } = parseCsv(await file.text()));
  } else {
    const XLSX = await import("xlsx");                    // on demand, not on page load
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", raw: false });
    const grid = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]],
      { header: 1, blankrows: false, defval: "" });
    headers = (grid[0] ?? []).map(String);
    raw = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "")])));
  }

  // matchHeader is forgiving about spacing and case, so a courier renaming
  // "COD_AMOUNT" to "COD Amount" does not break the import.
  const col = {
    tracking: matchHeader(headers, ["tracking_number", "tracking no", "tracking", "cn"]),
    status:   matchHeader(headers, ["status", "shipment status", "order status"]),
    cod:      matchHeader(headers, ["cod_amount", "cod amount", "cod"]),
    net:      matchHeader(headers, ["net_amount", "net total", "net"]),
    ship:     matchHeader(headers, ["shipping_charges", "charges", "shipping charge"]),
    gst:      matchHeader(headers, ["gst", "sales tax"]),
    wht:      matchHeader(headers, ["wh_income_tax (2%)", "wh_income_tax", "income tax"]),
    wst:      matchHeader(headers, ["wh_sales_tax (2%)", "wh_sales_tax"]),
    date:     matchHeader(headers, ["d/r date", "dr date", "delivery date", "date"]),
    /* THE CPR NUMBER, IF THE EXPORT CARRIES ONE.
       A PostEx transactions CSV usually has a settlement reference per row —
       the same CPR the PDF is named after. When it is there the file can be
       split into batches exactly like a merged PDF, and nothing needs typing.
       Only when it is absent does anything have to be entered by hand. */
    cpr:      matchHeader(headers, ["cpr_number", "cpr number", "cpr", "cpr no",
                                    "settlement", "settlement_number", "batch",
                                    "batch_number", "payment_reference", "reference"]),
  };
  if (!col.tracking) throw new Error("No tracking-number column found. Columns seen: " + headers.join(", "));

  // Grouped by settlement when the file names one, so a CSV covering several
  // CPRs imports as several batches rather than one undifferentiated lump.
  const groups = new Map<string, CprRow[]>();
  const dates = new Map<string, string>();
  for (const r of raw) {
    const tracking = String(r[col.tracking] ?? "").trim();
    if (!tracking) continue;
    const ref = col.cpr ? String(r[col.cpr] ?? "").trim() : "";
    // PostEx splits its deductions across four columns. The store cares about
    // two numbers: what the courier kept, and what the government kept.
    const fee = n2(toNum(r[col.ship])) + n2(toNum(r[col.gst]));
    const tax = n2(toNum(r[col.wht])) + n2(toNum(r[col.wst]));
    const paid_on = (String(r[col.date] ?? "").trim().slice(0, 10)) || null;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref)!.push({
      tracking_id: tracking,
      status: String(r[col.status] ?? "Delivered").trim(),
      cod: n2(toNum(r[col.cod])), net: n2(toNum(r[col.net])),
      fee, tax, paid_on,
    });
    if (paid_on && !dates.has(ref)) dates.set(ref, paid_on);
  }

  const batches = [...groups.entries()].map(([ref, rows]) => ({
    ref,
    date: dates.get(ref) ?? new Date().toISOString().slice(0, 10),
    rows,
    courier: "PostEx" as const,
    computedNet: n2(rows.reduce((t, r) => t + r.net, 0)),
  }));

  /* WHEN THE FILE NAMES ITS SETTLEMENTS, IT NEEDS NOTHING TYPED.
     A CSV carrying a CPR reference per row is as self-describing as the PDF:
     the batches are its own, and the guard compares each one against the
     portal's figure for that CPR.

     Without that column the file is just a list of rows. Deriving the "declared"
     totals from those same rows would compare the parse against itself and pass
     however wrong it was — which is not a check, it is the appearance of one.
     That is the only case that still asks for anything by hand. */
  const named = col.cpr && batches.some((b) => b.ref);
  return {
    batches,
    source: "csv",
    note: named
      ? undefined
      : "This export names no settlement, so the count and COD have to come from the PostEx portal. Deriving them from the file would check the parse against itself and pass no matter what. An export with a CPR column, or a CPR PDF, needs none of this.",
  };
}

/* -------------------------------------------------------------------- PDF */

/** Flatten a PDF to a single whitespace-normalised string.
 *
 *  Deliberately NOT line-based. A PostEx CPR wraps one parcel across three
 *  visual lines, and pdf.js orders text differently from any other extractor,
 *  so anything that depends on line structure is fragile by construction.
 *  Flatten, then anchor on things that cannot move: the 14-digit tracking
 *  number, and the summary labels. */
async function pdfText(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const byRow = new Map<number, { x: number; t: string }[]>();
    for (const item of content.items as { str: string; transform: number[] }[]) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      const key = [...byRow.keys()].find((k) => Math.abs(k - y) <= 3) ?? y;
      const b = byRow.get(key) ?? []; b.push({ x: item.transform[4], t: item.str }); byRow.set(key, b);
    }
    [...byRow.entries()].sort((a, b) => b[0] - a[0])
      .forEach(([, parts]) => out.push(parts.sort((a, b) => a.x - b.x).map((c) => c.t).join(" ")));
  }
  return out.join(" ").replace(/\s+/g, " ");
}

const unParen = (s?: string) => {
  const v = Number(String(s ?? "").replace(/,/g, "").replace(/[()]/g, ""));
  return isNaN(v) ? 0 : v;
};

/* ---------------------------------------------------------------------------
   PostEx Cash Payment Receipt — one PDF can hold many.

   Verified against the real 549-page export: 95 blocks, 93 distinct CPRs,
   8,547 parcels. Both guards below passed on all 95, none unparseable.

   TWO INDEPENDENT PATHS TO THE SAME NUMBER, which is what makes the guard
   worth having:
       declared = Total − shipping − GST − WH income − WH sales   (the summary)
       computed = the sum of every row's own Net Amount           (the rows)
   A mapping error moves one and not the other.

   The "Net Total" label does not survive text extraction — its value sits in a
   different column — so it is recomputed from the summary rather than read.

   NOTE ON THE SUMMARY'S "Returned" LINE: it is a SERVICE-TYPE split
   (Delivered / Same Day / Returned), not an outcome. On CPR-RU8QE504774 it
   reads "Returned 2" while 47 rows actually say Return. The row status is the
   truthful one and is the only thing used here.

   PER-ROW ARITHMETIC, verified to the paisa:
       Delivered  net = COD − shipping − GST − WH income − WH sales
       Return     net = −(shipping + GST)      no COD, no withholding
   A returned parcel COSTS money. Across your year: −Rs 453,358.85.
--------------------------------------------------------------------------- */
function parsePostExCpr(flat: string): Batch[] {
  const parts = flat.split(/(?=CPR Number CPR-)/).filter((p) => /^CPR Number CPR-/.test(p));
  const out: Batch[] = [];
  /* THE SAME CPR CAN APPEAR TWICE IN ONE FILE.
     A merged export of a year's settlements is assembled by hand, and two of
     the 95 blocks in the real one were the same receipt included twice.

     The unique index on (courier, cpr_number) already stops the DATABASE
     double-counting. But the summary on screen is computed here, and an earlier
     version added both copies — reporting 8,724 parcels and Rs 11,646,120.01
     when the truth was 8,547 and Rs 11,326,378.51. Correct import, wrong number
     in front of the person deciding whether to trust it.

     First occurrence wins; the rest are counted and named. */
  const seen = new Set<string>();
  let duplicates = 0;

  for (const p of parts) {
    const ref  = /CPR Number (CPR-[A-Z0-9]+)/.exec(p)?.[1];
    const d    = /CPR Date (\d{2})\/(\d{2})\/(\d{4})/.exec(p);
    const ship = /Shipping Charges (\d+) \(([\d.,]+)\)/.exec(p);
    const gst  = /GST \(([\d.,]+)\)/.exec(p);
    const whi  = /WH Income Tax \(2%\) \(([\d.,]+)\)/.exec(p);
    const whs  = /WH Sales Tax \(2%\) \(([\d.,]+)\)/.exec(p);
    const tot  = /Total ([\d,]+\.\d{2})/.exec(p);
    if (!ref || !d) continue;
    if (seen.has(ref)) { duplicates++; continue; }
    seen.add(ref);

    const rows: CprRow[] = [];
    const re = /(\d{14})\s+(.*?)(?=\d{14}\s|Developed by PostEx|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      const rest = m[2];
      const st = /\b(Delivered|Return)\b/.exec(rest);
      if (!st) continue;
      const ns = rest.match(/\(?-?[\d,]+\.\d{2}\)?/g);
      if (!ns || ns.length < 9) continue;
      // COD · Upfront · Reserve · Shipping · UpfrontChg · GST · WHinc · WHsales · Net
      const v = ns.slice(0, 9).map((x) => Number(x.replace(/,/g, "").replace("(", "-").replace(")", "")));
      /* H320: keep the per-parcel upfront (v[1]) and reserve (v[2]). Signs are
         preserved — on a returned row the reserve is negative (clawback) and
         the upfront is still positive (it was paid earlier). The panel wants
         the magnitude of the returns' upfront for display; summation keeps the
         raw value. */
      rows.push({
        tracking_id: m[1], status: st[1],
        cod: n2(v[0]), fee: n2(v[3] + v[5]), tax: n2(v[6] + v[7]), net: n2(v[8]),
        upfront: n2(v[1]), reserve: n2(v[2]),
        paid_on: `${d[3]}-${d[2]}-${d[1]}`,
      });
    }

    const declaredNet = (ship && gst && whi && whs && tot)
      ? n2(unParen(tot[1]) - unParen(ship[2]) - unParen(gst[1]) - unParen(whi[1]) - unParen(whs[1]))
      : undefined;
    const computedNet = n2(rows.reduce((t, r) => t + r.net, 0));

    let problem: string | undefined;
    if (!rows.length) problem = "no parcel rows could be read";
    else if (!ship) problem = "summary totals missing — cannot be checked";
    else if (rows.length !== Number(ship[1]))
      problem = `read ${rows.length} parcels, the file says ${ship[1]}`;
    else if (declaredNet !== undefined && Math.abs(declaredNet - computedNet) > 1)
      problem = `rows total ${computedNet}, the summary says ${declaredNet}`;

    /* H320: sum the per-row upfront/reserve, split by delivered vs returned.
         upfront_total     = Σ upfront, every row (what PostEx paid at dispatch)
         reserve_total     = Σ reserve, every row (what this CPR is paying now)
         upfront_delivered = Σ upfront, delivered rows only
         upfront_returns   = Σ upfront, returned rows only (stored as magnitude —
                             these are the returns PostEx paid for earlier and
                             is now clawing back, so the panel can show the
                             clawback line clearly).
       bank_total = upfront_total + reserve_total, computed on read. */
    const sumUp     = n2(rows.reduce((t, r) => t + (r.upfront ?? 0), 0));
    const sumRes    = n2(rows.reduce((t, r) => t + (r.reserve ?? 0), 0));
    const sumUpDel  = n2(rows.filter((r) => isDelivered(r.status))
                           .reduce((t, r) => t + (r.upfront ?? 0), 0));
    const sumUpRet  = n2(Math.abs(rows.filter((r) => !isDelivered(r.status))
                           .reduce((t, r) => t + (r.upfront ?? 0), 0)));
    out.push({ ref, date: `${d[3]}-${d[2]}-${d[1]}`, rows, courier: "PostEx",
               declaredCount: ship ? Number(ship[1]) : undefined,
               declaredNet, computedNet, problem,
               summary: (ship && gst && whi && whs && tot) ? {
                 gross: unParen(tot[1]), shipping: unParen(ship[2]), gst: unParen(gst[1]),
                 wh_income: unParen(whi[1]), wh_sales: unParen(whs[1]),
                 net: declaredNet ?? 0,
                 upfront_total: sumUp, reserve_total: sumRes,
                 upfront_delivered: sumUpDel, upfront_returns: sumUpRet,
               } : undefined });
  }
  if (duplicates) out.push({ ref: "__dupes__", date: "", rows: [], courier: "PostEx",
                             problem: `${duplicates} duplicate receipt${duplicates === 1 ? "" : "s"} in this file, ignored` });
  return out;
}

/* ---------------------------------------------------------------------------
   OwnEx invoice. One per file, and a different shape from a PostEx CPR.

   ANCHORED ON THE TRACKING NUMBER, NOT THE ROW LAYOUT. OwnEx lets agents type
   anything into Order Ref ("Intzar ali", "tayyaba"), so the 12-digit tracking
   number is the only thing on a row that is anchored on. The FIRST six amounts
   after it are COD · Upfront · Reserved · Charges · Fuel · Net Total.

   OCTOBER 2026: OwnEx moved to a new system (courier-portal.com, ~10 Oct) and
   its invoice changed. INV-20250026 read 108 parcels against 122:
     1. Amounts arrive in two pieces. pdf.js hands "-2,207.00" over as "-2,207"
        and ".00" (21 times on INV-26) and "256,107" as "256," + "107". Neither
        half is an amount, so a row holding one had fewer than six and was
        dropped — exactly the 14 missing. They are glued back first. The split
        can also fall before the comma: INV-20250027 has "7,997.00" as "7" and
        ",997.00", which read as 997 and put delivered COD 14,000 short.
     2. The header became a row of labels over a row of values
            INVOICE NUMBER  INVOICE DATE  BOOKINGS  STATUS
            INV-20250026    10/10/2026    122       Paid
        so the number read as the word "INVOICE" and the date as today. The
        number is now the INV-nnnn pattern itself, the date the first date after
        its label. A missing number or date blocks the import.
     3. Fuel is now charged PER ROW (the fifth amount, 20% of the charge) and the
        row's net includes it. Older invoices carry 0.00 there and charge fuel
        once at the bottom. Both are handled: a row's stored net is COD less the
        charge, and fuel is taken off once, from the rows or from the summary.

   THE DATE IS READ AS WRITTEN (M/D/YYYY). new Date("8/9/2026").toISOString()
   in Pakistan gives 2026-08-08 — every earlier OwnEx invoice was stored one day
   early. No time zone is involved now.

   THE SIGN IS OwnEx's. Net Total is negative when the courier owes you and
   positive when you owe it — a return, and also a delivered exchange with COD 0
   or COD below the charge. Taking abs() of a delivered row turned those costs
   into money received. Every row is now   net = fuel − Net Total = COD − charge.

   WHAT HAS TO AGREE before anything is offered, all from the invoice itself:
     parcel count · delivered COD · charges · fuel (when on the rows) ·
     Payable − Receivable = Grand Total · the payout from the summary =
     COD − charges − fuel · the payout from the rows.
   The summary's net is Payable − Receivable — the money actually paid.

   Verified on the real files: INV-20250010 and 12–18 (old layout, 1,175
   parcels) and INV-20250026 (new layout, 122 parcels, Rs 224,271), every guard
   passing on every one, and a check-only run of INV-26 against the live
   database: 122 read, 121 matched, net 224,271, nothing written.
--------------------------------------------------------------------------- */
/* An amount starts with a digit. ",529.00" — the tail of a split "-7,529.00" —
   used to match as 529 and was taken for a real figure. */
const AMT = String.raw`-?\d[\d,]*\.\d{2}`;
const amt = (s?: string) => n2(unParen(s));

function parseOwnExInvoice(raw: string): Batch[] {
  /* 1. Glue split amounts: "-2,207 .00" → "-2,207.00", "256, 107" → "256,107". */
  const flat = raw
    .replace(/(\d)\s+(?=[.,]\d)/g, "$1")          // "-2,207 .00", "-7 ,529.00"
    .replace(/(\d,)\s+(?=\d{3}(?!\d))/g, "$1");   // "256, 107.00"

  /* 2. Number and date, whichever way the header is laid out. */
  const ref = /\bINV-\d{5,}\b/.exec(flat)?.[0] ?? "";
  /* Old: "INVOICE DATE: 8/9/2026". New: "INVOICE DATE BOOKINGS STATUS
     INV-20250026 10/10/2026". Matched exactly — a loose search would find a
     pickup date in the rows if the invoice date were ever missing. */
  const dm = /INVOICE DATE:?\s*(?:BOOKINGS\s+STATUS\s+\S+\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(flat);
  const date = dm ? `${dm[3]}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}` : "";

  /* 3. The invoice's own figures. "Grand Total Rs. A Rs. B Rs. C" lists Total
        Payable, Total Service Charges and the Grand Total in that order on both
        layouts — the first of the three is NOT the grand total. */
  const declDel  = new RegExp(String.raw`Delivered\s+(\d+)\s+(${AMT})`, "i").exec(flat);
  const declShip = new RegExp(String.raw`Shipping Charges\s+(\d+)\s+(${AMT})`, "i").exec(flat);
  const fuelM    = new RegExp(String.raw`Fuel Surcharge\s+\d+\s+(${AMT})`, "i").exec(flat);
  const payRec   = new RegExp(String.raw`Payable\s+(${AMT})\s+Receivable\s+(${AMT})`, "i").exec(flat);
  const grandM   = new RegExp(String.raw`Grand Total\s*Rs\.?\s*(${AMT})\s*Rs\.?\s*(${AMT})\s*Rs\.?\s*(${AMT})`, "i").exec(flat);

  /* 4. The rows. */
  const rows: CprRow[] = [];
  let sumCharges = 0, sumFuel = 0, sumOwnexNet = 0;
  /* EVERY ROW CHECKS ITSELF: Net Total = charge + fuel − reserved, to the
     rupee, on every row of every invoice (1,297 rows across INV-10…18 and
     INV-26, delivered and returned alike). A misread amount breaks it on that
     row, so the import can name the parcel instead of only a total being off.
     INV-20250027: #TS4220 "7,997.00" arrived as "7" + ",997.00" and read as 997. */
  const unbalanced: string[] = [];
  /* NOVEMBER 2026 LAYOUT (INV-20250029 onwards): the row columns became
       UPFRONT · RESERVED (COD) · SHIPPING CHARGES · ADD. W. · NET TOTAL
     — five amounts, not six, upfront FIRST, no fuel on the row, an extra
     additional-weight charge, and Net Total = COD − shipping − add. weight,
     POSITIVE when the courier owes you (the old sign was the other way).
     Fuel went back to one line at the bottom. Every row of INV-29 was dropped
     for having fewer than six amounts, so the import read 0 of 387.
     Recognised by its header; the older layouts are read exactly as before. */
  const addWLayout = /\bADD\.?\s*W\.?\s+NET TOTAL\b/i.test(flat);
  const re = /(\d{12})\s+(.*?)(?=\d{12}\s|Developed by Own Express|Own Express · Invoice|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const rest = m[2];
    const st = /\b(Delivered|Returned|Return)\b/i.exec(rest);
    if (!st) continue;
    const ns = rest.match(new RegExp(AMT, "g"));
    if (addWLayout) {
      if (!ns || ns.length < 5) continue;
      const [up, cod, ship, addW, netTotal] = ns.slice(0, 5).map((x) => Number(x.replace(/,/g, "")));
      if (Math.abs(cod - up - ship - addW - netTotal) > 1) unbalanced.push(m[1]);
      sumCharges += ship + addW; sumOwnexNet += netTotal;
      rows.push({ tracking_id: m[1], status: st[1],
                  cod: n2(cod), fee: n2(ship + addW), tax: 0,
                  net: n2(netTotal),
                  paid_on: date || null });
      continue;
    }
    if (!ns || ns.length < 6) continue;
    const v = ns.slice(0, 6).map((x) => Number(x.replace(/,/g, "")));
    if (Math.abs(v[3] + v[4] - v[2] - v[5]) > 1) unbalanced.push(m[1]);
    sumCharges += v[3]; sumFuel += v[4]; sumOwnexNet += v[5];
    rows.push({ tracking_id: m[1], status: st[1],
                cod: n2(v[0]), fee: n2(v[3]), tax: n2(v[4]),
                net: n2(v[4] - v[5]),
                paid_on: date || null });
  }
  sumCharges = n2(sumCharges); sumFuel = n2(sumFuel); sumOwnexNet = n2(sumOwnexNet);

  const delivered     = rows.filter((r) => isDelivered(r.status));
  const codDelivered  = n2(delivered.reduce((t, r) => t + r.cod, 0));
  const declaredCount = declShip ? Number(declShip[1]) : undefined;
  const declaredCod   = declDel ? amt(declDel[2]) : undefined;
  const shipping      = declShip ? amt(declShip[2]) : undefined;
  const fuel          = fuelM ? amt(fuelM[1]) : 0;
  const payout        = payRec ? n2(amt(payRec[1]) - amt(payRec[2])) : undefined;
  const grand         = grandM ? amt(grandM[3]) : undefined;
  const fuelOnRows    = sumFuel !== 0;
  const fromRows      = n2(rows.reduce((t, r) => t + r.net, 0) - (fuelOnRows ? sumFuel : fuel));

  const off = (a: number, b: number) => Math.abs(a - b) > 1;
  let problem: string | undefined;
  if (!ref) problem = "the invoice number could not be read";
  else if (!date) problem = "the invoice date could not be read";
  else if (!rows.length) problem = "no parcel rows could be read";
  else if (unbalanced.length)
    problem = `${unbalanced.length} row${unbalanced.length === 1 ? "" : "s"} misread — the amounts do not add up on tracking ${unbalanced.slice(0, 5).join(", ")}${unbalanced.length > 5 ? "…" : ""}`;
  else if (!declaredCount) problem = "the invoice's own parcel count could not be read";
  else if (rows.length !== declaredCount)
    problem = `read ${rows.length} parcels, the invoice says ${declaredCount}`;
  else if (declaredCod === undefined)
    problem = "the invoice's delivered COD could not be read";
  else if (off(codDelivered, declaredCod))
    problem = `delivered COD totals ${codDelivered}, the invoice says ${declaredCod}`;
  else if (shipping !== undefined && off(sumCharges, shipping))
    problem = `the rows' charges total ${sumCharges}, the invoice says ${shipping}`;
  else if (fuelOnRows && off(sumFuel, fuel))
    problem = `the rows' fuel surcharge totals ${sumFuel}, the invoice says ${fuel}`;
  else if (payout === undefined || grand === undefined)
    problem = "the invoice's payable, receivable or grand total could not be read";
  else if (off(payout, -grand))
    problem = `payable less receivable is ${payout}, the grand total says ${-grand}`;
  else if (shipping !== undefined && off(payout, n2(declaredCod - shipping - fuel)))
    problem = `the invoice carries other charges of ${n2(declaredCod - shipping - fuel - payout)} (adjustment, upfront or pre-delivery) that this import does not record — check the invoice`;
  else if (off(fromRows, payout))
    problem = `the rows come to ${fromRows}, the invoice pays ${payout}`;
  else if (fuelOnRows && off(sumOwnexNet, grand))
    problem = `the rows' net totals ${sumOwnexNet}, the grand total says ${grand}`;
  /* November layout: "Payable Details … Total 470,255.00" is COD − shipping, the
     rows' Net Totals added up — one more figure from the invoice to agree with. */
  else if (addWLayout && shipping !== undefined && off(sumOwnexNet, n2(declaredCod - shipping)))
    problem = `the rows' net totals ${sumOwnexNet}, the invoice's payable details say ${n2(declaredCod - shipping)}`;

  return [{
    ref, date, rows, courier: "OwnEx", declaredCount,
    declaredNet: payout,
    computedNet: fromRows,
    problem,
    summary: (declaredCod !== undefined && shipping !== undefined && payout !== undefined)
      ? { gross: declaredCod, shipping, gst: fuel, wh_income: 0, wh_sales: 0, net: payout }
      : undefined,
  }];
}

async function readPdf(file: File): Promise<Parsed> {
  const flat = await pdfText(file);
  if (/CPR Number CPR-/.test(flat)) {
    const batches = parsePostExCpr(flat);
    return { batches, source: "pdf",
             note: `${batches.filter((b) => b.ref !== "__dupes__").length} settlement${batches.filter((b) => b.ref !== "__dupes__").length === 1 ? "" : "s"} found in this file. Each is checked against its own summary before anything is written; any that disagrees is skipped and named.` };
  }
  return { batches: parseOwnExInvoice(flat), source: "pdf",
           note: "Checked against the invoice's own figures: parcel count, delivered COD, charges, fuel surcharge, and Payable − Receivable = Grand Total." };
}

/* ======================================================================== */
type Result = { ref: string; ok: boolean; report: Record<string, unknown> };

/* Parcels per shopify-writeback call. One order costs about 1.9 s there (the
   write, the tag, the audit row, and a 550 ms pause for Shopify's rate limit),
   and the function is cut off at 150 s. All 122 parcels of INV-20250026 in one
   call ran 3 minutes: the browser got a 504 after 150 s, and 16 orders were
   never reached. 30 a call comes back in about a minute. */
const SHOPIFY_CHUNK = 30;
/* The first "mark delivered" batch per store is small. A store whose Shopify
   app lacks write_fulfillments refuses every order identically — TopShop
   answered 56 of 56 on INV-20250027, 3 minutes spent learning one fact. */
const SHOPIFY_PROBE = 5;

/** One settlement's Shopify follow-up, shown on its own line. */
type ShopLine = { ref: string; text: string; ok: boolean; running: boolean };

/* SHOPIFY RUNS IN THE BACKGROUND.
   INV-20250027 imported in about 3 seconds and then held this window for
   6½ minutes: 104 orders marked paid at 1.9 s each, then 106 marked
   delivered at 1.7 s each, one after the other — and 56 of those deliveries
   were TopShop orders its Shopify app is not allowed to touch.

   Now:
     · the settlement is saved and shown as imported straight away;
     · Shopify is queued and worked here while the app stays open — the
       window can be closed, and the Finance page used;
     · the stores run side by side — Shopify limits each shop separately, so
       Little Minors and TopShop do not wait for one another — and in each
       store "paid" and "delivered" run together, one order at a time each, at
       the pace shopify-writeback keeps;
     · a store that refuses "mark delivered" for want of permission is
       stopped after one small batch and reported, not tried order by order.
   Settlements queue behind one another, so a 95-CPR PostEx file does not
   fire 95 jobs at three shops at once. Anything left over is finished by
   Send again on the settlement — the function skips what it already did.

   It lives here, outside the component, because the component only exists
   while the CPR tab is open: switching to Payments would otherwise drop the
   progress (and the leave-page warning) while the work carried on unseen. */
const shopStore = {
  lines: [] as ShopLine[],
  queue: Promise.resolve() as Promise<void>,
  subs: new Set<() => void>(),
};
function warnBeforeLeaving(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = ""; }
function setShopLines(f: (prev: ShopLine[]) => ShopLine[]) {
  const was = shopStore.lines.some((l) => l.running);
  shopStore.lines = f(shopStore.lines);
  const now = shopStore.lines.some((l) => l.running);
  if (typeof window !== "undefined" && was !== now) {
    if (now) window.addEventListener("beforeunload", warnBeforeLeaving);
    else window.removeEventListener("beforeunload", warnBeforeLeaving);
  }
  shopStore.subs.forEach((fn) => fn());
}

function queueShopify(cprRef: string, tracking: string[]) {
  setShopLines((prev) => [...prev.filter((l) => l.ref !== cprRef),
    { ref: cprRef, text: "Shopify: waiting to start…", ok: true, running: true }]);
  shopStore.queue = shopStore.queue
    .then(() => pushShopify(cprRef, tracking))
    .catch((e) => setShopLines((prev) => [...prev.filter((l) => l.ref !== cprRef),
      { ref: cprRef, ok: false, running: false,
        text: `Shopify stopped: ${e instanceof Error ? e.message : String(e)}. The import is saved — press Send again on the settlement.` }]));
}

async function pushShopify(cprRef: string, tracking: string[]) {
  if (!supabase) return;
  const sb = supabase;
  const put = (text: string, ok: boolean, running: boolean) =>
    setShopLines((prev) => [...prev.filter((l) => l.ref !== cprRef), { ref: cprRef, text, ok, running }]);

  // Which shop each parcel belongs to. Parcels we do not hold are left out —
  // shopify-writeback could not find their order either.
  const byStore = new Map<string, string[]>();
  for (let k = 0; k < tracking.length; k += 300) {
    const { data, error } = await sb.from("online_logistics")
      .select("tracking_id,store_code").in("tracking_id", tracking.slice(k, k + 300));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { tracking_id: string; store_code: string | null }[]) {
      const st = r.store_code || "?";
      byStore.set(st, [...(byStore.get(st) ?? []), r.tracking_id]);
    }
  }
  const total = 2 * [...byStore.values()].reduce((t, l) => t + l.length, 0);
  if (!total) { put("Shopify: none of these parcels are in our records — nothing to update.", true, false); return; }

  type Tally = { done: number; skipped: number; failed: number; lost: number; blocked: number; why: string[] };
  const mk = (): Tally => ({ done: 0, skipped: 0, failed: 0, lost: 0, blocked: 0, why: [] });
  const tally = { paid: mk(), deliver: mk() };
  const refused = new Set<string>();
  let handled = 0;
  const tick = () => put(`Shopify: updating in the background — ${handled} of ${total}. ` +
    "You can close this window; keep the app open until it finishes.", true, true);
  tick();

  /* Every store, and within a store "paid" and "delivered", run side by side —
     at most two calls per shop at a time, well inside its rate limit. They are
     different things in Shopify (a payment, a fulfillment event), and both add
     the same tags, so working one order from both sides cannot clash; the
     delivered pass still starts from the far end so they rarely meet. */
  await Promise.all([...byStore.entries()].flatMap(([store, all]) => (["paid", "deliver"] as const).map(async (action) => {
    const list = action === "deliver" ? [...all].reverse() : all;
    {
      const t = tally[action];
      for (let k = 0; k < list.length;) {
        const size = action === "deliver" && k === 0 ? SHOPIFY_PROBE : SHOPIFY_CHUNK;
        const part = list.slice(k, k + size);
        k += part.length;
        const { data: sd, error: se } = await sb.functions.invoke("shopify-writeback", {
          body: { action, tracking: part, dry_run: false, max: 200 },
        });
        handled += part.length;
        if (se) {
          t.lost += part.length;
          if (!t.why.includes(se.message)) t.why.push(se.message);
        } else {
          const r = (sd ?? {}) as { closed?: number; skipped?: number; failed?: number;
                                     sample?: { failed?: string }[] };
          t.done += r.closed ?? 0; t.skipped += r.skipped ?? 0; t.failed += r.failed ?? 0;
          const why = (r.sample?.find((x) => x.failed)?.failed ?? "").replace(/[.\s]+$/, "");
          if (why && !t.why.includes(why) && !/access denied/i.test(why)) t.why.push(why);
          if (action === "deliver" && !(r.closed ?? 0) && /access denied/i.test(why)) {
            /* A missing permission, not a failure a retry could fix — counted
               as "not tried", so Send again is not suggested for it. */
            refused.add(store);
            t.failed -= r.failed ?? 0;
            t.blocked += (r.failed ?? 0) + (list.length - k);
            handled += list.length - k;
            k = list.length;
          }
        }
        tick();
      }
    }
  })));

  const line = (label: string, t: Tally) =>
    `${label} ${t.done}` +
    (t.skipped ? ` · ${t.skipped} already done or not in Shopify` : "") +
    (t.failed ? ` · ${t.failed} failed` : "") +
    (t.lost ? ` · ${t.lost} not reached` : "") +
    (t.blocked ? ` · ${t.blocked} not tried` : "");
  const notes = [...tally.paid.why, ...tally.deliver.why];
  if (refused.size) notes.push(`${[...refused].join(", ")}: the Shopify app is not allowed to mark deliveries ` +
    "(needs the write_fulfillments permission)");
  const bad = tally.paid.failed + tally.paid.lost + tally.deliver.failed + tally.deliver.lost + tally.deliver.blocked;
  put(`Shopify: ${line("marked paid", tally.paid)}; ${line("marked delivered", tally.deliver)}.` +
      (notes.length ? ` ${notes.join(". ")}.` : "") +
      (tally.paid.failed + tally.paid.lost + tally.deliver.failed + tally.deliver.lost
        ? " The import is saved — press Send again on the settlement to retry." : ""),
      bad === 0, false);
}


export default function CprImport({ onDone }: { onDone?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [courier, setCourier] = useState<"PostEx" | "OwnEx">("PostEx");
  const [dCount, setDCount] = useState("");
  const [dTotal, setDTotal] = useState("");
  const [ref, setRef] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState("");
  const [checked, setChecked] = useState(false);
  const [committed, setCommitted] = useState(false);

  // The Shopify follow-up of every import this session — see shopStore.
  const [shopLines, setShopLinesView] = useState<ShopLine[]>(shopStore.lines);
  useEffect(() => {
    const fn = () => setShopLinesView(shopStore.lines);
    shopStore.subs.add(fn); fn();
    return () => { shopStore.subs.delete(fn); };
  }, []);
  const shopRunning = shopLines.some((l) => l.running);

  const all = (parsed?.batches ?? []).filter((b) => b.ref !== "__dupes__");
  const dupeNote = (parsed?.batches ?? []).find((b) => b.ref === "__dupes__")?.problem;
  const good = all.filter((b) => !b.problem);
  const bad = all.filter((b) => b.problem);
  const many = all.length > 1;
  /* DOES THE FILE DECLARE ITS OWN FIGURES?
     This, not the number of settlements, is what decides whether anything has
     to be typed. An OwnEx invoice carries "Delivered 55", its own COD and its
     own Grand Total — every one of those is checked against the parse before
     the batch is even offered, so demanding the same numbers by hand is asking
     the person to retype what the file already proved.

     The earlier version keyed this off `many`, so a merged PostEx PDF skipped
     the form and a single OwnEx invoice demanded it. Only the PostEx CSV — the
     one export with no totals of its own — actually needs typing. */
  const selfDeclaring = all.length > 0 && all.every((b) => b.declaredCount != null);
  const totals = good.reduce((a, b) => ({
    parcels: a.parcels + b.rows.length,
    delivered: a.delivered + b.rows.filter((r) => isDelivered(r.status)).length,
    returned: a.returned + b.rows.filter((r) => !isDelivered(r.status)).length,
    net: a.net + (b.computedNet ?? 0),
    returnCost: a.returnCost + b.rows.filter((r) => !isDelivered(r.status)).reduce((t, r) => t + r.net, 0),
  }), { parcels: 0, delivered: 0, returned: 0, net: 0, returnCost: 0 });

  async function pick(file: File) {
    setErr(""); setResults([]); setChecked(false); setCommitted(false); setBusy(true); setProgress("Reading…");
    try {
      const p = /\.pdf$/i.test(file.name) ? await readPdf(file) : await readSheet(file);
      if (!p.batches.filter((x) => x.ref !== "__dupes__").length) throw new Error("No settlement could be read from this file.");
      setParsed(p);
      setCourier(p.batches.find((x) => x.ref !== "__dupes__")!.courier);
      const real = p.batches.filter((x) => x.ref !== "__dupes__");
      if (real.length === 1) {
        setRef(real[0].ref); setDate(real[0].date);
        if (real[0].declaredCount) setDCount(String(real[0].declaredCount));
      }
      setOpen(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setOpen(true); }
    finally { setBusy(false); setProgress(""); }
  }

  /* Run every settlement in sequence.
     Sequential on purpose: hub_cpr_import writes, and firing 93 concurrent
     writes at the same rows is how a race gets introduced into the one part of
     this system that moves money. Slower and correct. */
  async function run(dry: boolean) {
    if (!parsed || !supabase) return;
    setBusy(true); setErr(""); setResults([]);
    const acc: Result[] = [];
    /* ONLY WHAT PASSED, ALWAYS.
       This read `many ? good : all`, so a single file that failed its own
       check was imported anyway: INV-20250027 showed "1 will be skipped —
       delivered COD totals 229067, the invoice says 243067" and was written
       regardless, because the server's dry run only re-checks the parcel
       count. A settlement that disagrees with itself is never sent. */
    const list = good;

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      setProgress(`${dry ? "Checking" : "Importing"} ${i + 1} of ${list.length} · ${b.ref || "settlement"}`);
      // Kept so the Shopify push below knows what this settlement covered.
      const deliveredNums = [...new Set(b.rows.filter((r) => /deliver/i.test(r.status))
        .map((r) => r.tracking_id))];
      const { data, error } = await supabase.rpc("hub_cpr_import", {
        p_courier: many ? b.courier : courier,
        p_cpr_number: (many ? b.ref : ref).trim(),
        p_cpr_date: many ? b.date : date,
        // A CPR carries its own count. Only the CSV, which carries none, falls
        // back to what was typed from the portal.
        p_declared_count: b.declaredCount ?? (dCount ? Number(dCount) : null),
        /* Only sent when the file declares nothing. A courier's own COD figure
           counts DELIVERED parcels, while the rows include returns that also
           carry a COD, so the two are not comparable — the delivered-COD check
           happens in the parser instead, and a batch that fails it never gets
           this far. */
        p_declared_total: b.declaredCount != null ? null : (dTotal ? Number(dTotal) : null),
        p_rows: b.rows,
        p_dry_run: dry,
        // The receipt's own figures. Without these the stored amount is only
        // the subset we could match, which is what made our list disagree with
        // the portal on CPR-V5DYF677330 (11,619.34 vs 8,267).
        p_summary: b.summary ?? null,
      });
      if (error) { acc.push({ ref: b.ref, ok: false, report: { error: error.message } }); }
      else acc.push({ ref: b.ref, ok: (data as { ok?: boolean })?.ok === true, report: data as Record<string, unknown> });
      setResults([...acc]);

      /* SHOPIFY IS UPDATED AUTOMATICALLY FOR WHAT WAS DELIVERED.
         A delivered COD order that Shopify still shows as payment-pending makes
         its revenue reports read zero for money already collected. That is not
         a judgement call — the courier settled it, the cash exists, and marking
         it paid states a fact.

         Only on a real import, never a dry run: a check that writes to three
         live shops is not a check.

         Cancelling a return is NOT done here. That decision stays with a person
         — see the panel on the settlement, which lists what the agents missed
         and waits to be told. */
      /* SHOPIFY IS QUEUED, NOT AWAITED. The settlement is saved the moment the
         call above returns; marking the orders paid and delivered in Shopify
         carries on in the background (see pushShopify) and reports on its own
         line, so the import no longer holds this window for 5–7 minutes. */
      if (!dry && !error && (data as { ok?: boolean })?.ok === true && deliveredNums.length) {
        queueShopify(b.ref, deliveredNums);
      }
    }
    setBusy(false); setProgress("");
    if (dry) setChecked(acc.every((r) => r.ok));
    else if (acc.some((r) => r.ok)) { setCommitted(true); onDone?.(); }
  }

  const passed = results.length > 0 && results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const guardReady = selfDeclaring || (!!ref.trim() && !!dCount && !!dTotal);

  return (
    <>
      <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx,.pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
      <button onClick={() => fileRef.current?.click()} className={btnPrimary} disabled={busy}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
        Import settlement
      </button>
      {/* Shopify still being updated after the window was closed — one tap
          brings the progress back. */}
      {shopRunning && !open && (
        <button type="button" onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-muted transition hover:bg-panel dark:border-white/15 dark:text-[#a89f93]">
          <Loader2 size={13} className="animate-spin" /> Shopify updating…
        </button>
      )}

      <Modal open={open} onClose={() => !busy && setOpen(false)} wide title="Import courier settlement">
        {err && (
          <div className="mb-3 flex gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{err}</span>
          </div>
        )}

        {parsed && (
          <>
            {/* WHAT THIS FILE CONTAINS, BEFORE ANYTHING IS WRITTEN.
                Every figure below is read from the file itself and checked
                against the file's own declared totals. Nothing is written until
                a dry run has passed, and the commit button stays dead until
                then. Laid out as a grid so it stays readable on a phone. */}
            <div className="mb-3 rounded-card border border-line bg-panel p-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex flex-wrap items-baseline justify-between gap-1">
                <span className="text-[13px] font-semibold text-ink dark:text-[#f4f1ea]">
                  {all.length.toLocaleString()} settlement{all.length === 1 ? "" : "s"} read
                </span>
                {all.length === 1 && all[0].ref && (
                  <span className="font-mono text-[12px] text-muted dark:text-[#a89f93]">{all[0].ref} · {all[0].date}</span>
                )}
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                <div>
                  <div className="text-[15px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{totals.parcels.toLocaleString()}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">parcels in file</div>
                </div>
                <div>
                  <div className="text-[15px] font-bold tabular-nums text-emerald-700">{totals.delivered.toLocaleString()}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">delivered — will be paid</div>
                </div>
                <div>
                  <div className="text-[15px] font-bold tabular-nums text-danger">{totals.returned.toLocaleString()}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">returned — charged, not paid</div>
                </div>
                <div>
                  <div className="text-[15px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{money(totals.net)}</div>
                  <div className="text-[11px] text-muted dark:text-[#a89f93]">net the courier paid</div>
                </div>
              </div>

              {totals.returnCost !== 0 && (
                <div className="mt-2 text-[12px] text-muted dark:text-[#a89f93]">
                  Returns cost you <b className="text-danger">{money(Math.abs(totals.returnCost))}</b> —
                  the courier bills the shipping on a delivery that failed. Those parcels
                  keep their status and stay unpaid; only the charge is recorded.
                </div>
              )}
              {dupeNote && (
                <div className="mt-1.5 text-[12px] text-muted dark:text-[#a89f93]">
                  {dupeNote} — the same receipt was included more than once when this file
                  was merged. Counted once here.
                </div>
              )}
              {parsed.note && <div className="mt-1.5 text-[11.5px] text-hint dark:text-[#8a8175]">{parsed.note}</div>}
            </div>

            {bad.length > 0 && (
              <div className="mb-3 rounded-card border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={14} /> {bad.length} will be skipped — the file disagrees with itself
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {bad.slice(0, 6).map((b) => <li key={b.ref}>{b.ref || "(no number)"} — {b.problem}</li>)}
                  {bad.length > 6 && <li>…and {bad.length - 6} more</li>}
                </ul>
              </div>
            )}

            {!many && !selfDeclaring && (
              <div className="grid grid-cols-2 gap-2 text-[13px]">
                <label className="block"><span className="text-muted">Courier</span>
                  <select value={courier} onChange={(e) => setCourier(e.target.value as "PostEx" | "OwnEx")}
                          className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5">
                    <option>PostEx</option><option>OwnEx</option>
                  </select></label>
                <label className="block"><span className="text-muted">CPR / invoice number</span>
                  <input value={ref} onChange={(e) => setRef(e.target.value)}
                         className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
                <label className="block"><span className="text-muted">Settlement date</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                         className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
                <div />
                <label className="block"><span className="text-muted">Parcel count (from the portal)</span>
                  <input value={dCount} onChange={(e) => setDCount(e.target.value)} inputMode="numeric"
                         className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
                <label className="block"><span className="text-muted">COD total (from the portal)</span>
                  <input value={dTotal} onChange={(e) => setDTotal(e.target.value)} inputMode="decimal"
                         className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5" /></label>
              </div>
            )}

            {!selfDeclaring && parsed.source === "csv" && (
              <div className="mt-2 flex gap-2 rounded-card border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-900">
                <ShieldCheck size={15} className="mt-0.5 shrink-0" />
                <span>Type these from the PostEx portal, not from the file. Copied from what was
                just parsed, the check compares the parse to itself and cannot fail.</span>
              </div>
            )}

            {selfDeclaring && !many && (
              <div className="rounded-card border border-line p-2.5 text-[12px] text-muted dark:border-white/10 dark:text-[#a89f93]">
                This file declares its own totals — {all[0].declaredCount} parcels
                {all[0].summary ? <> and {money(all[0].summary.gross)} delivered COD</> : null} — and the
                parse was checked against them before anything was offered. Nothing to type.
              </div>
            )}

            {progress && (
              <div className="mt-3 flex items-center gap-2 text-[13px] text-muted">
                <Loader2 size={14} className="animate-spin" /> {progress}
              </div>
            )}

            {results.length > 0 && (() => {
              /* ONE SETTLEMENT, ONE LINE.
                 A file is checked and then imported, and both attempts were
                 pushed into this list — so importing one invoice successfully
                 read "1 of 2 passed · 1 refused", which looks like half the file
                 was rejected. Nothing had been. Keeping only the latest outcome
                 per settlement makes the count mean what it says. */
              const latest = [...new Map(results.map((r) => [r.ref || "—", r])).values()];
              const bad = latest.filter((r) => !r.ok);
              return (
              <div className="mt-3">
                <div className="mb-1.5 text-[13px] font-semibold text-ink">
                  {bad.length === 0
                    ? `${latest.length} settlement${latest.length === 1 ? "" : "s"} imported`
                    : <>{latest.length - bad.length} of {latest.length} imported
                        <span className="text-red-700"> · {bad.length} refused</span></>}
                </div>
                <div className="max-h-56 overflow-auto rounded-card border border-line">
                  {latest.map((r, i) => (
                    <div key={i} className={`flex items-start gap-2 border-b border-line px-2.5 py-1.5 text-[12px] last:border-0 ${r.ok ? "" : "bg-red-50"}`}>
                      {r.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
                            : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-red-600" />}
                      <span className="font-mono">{r.ref || "—"}</span>
                      <span className="text-muted">
                        {String(r.report.report ?? r.report.guard ?? r.report.error ?? "")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              );
            })()}

            {/* The Shopify follow-up, one line per settlement, apart from the
                import's own result: sharing the settlement's number, it once
                replaced that result and a Shopify timeout read as "refused". */}
            {shopLines.map((l) => (
              <div key={l.ref}
                   className={`mt-2 flex items-start gap-2 rounded-card border px-2.5 py-1.5 text-[12px] ${
                     l.running ? "border-line bg-panel text-ink dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]"
                     : l.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                            : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                {l.running ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
                 : l.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
                        : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />}
                <span><span className="font-mono">{l.ref}</span> · {l.text}</span>
              </div>
            ))}

            {/* Wraps on a phone: with justify-end the overflow went off the LEFT
                edge, where it could not be scrolled to, hiding Close. */}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>Close</button>
              <button className={btnGhost} disabled={busy || !guardReady || !good.length} onClick={() => run(true)}>
                Check {many ? `all ${good.length}` : "only"}
              </button>
              {/* Unreachable until every dry run passed. A guard that can be
                  skipped is decoration. */}
              <button className={btnPrimary} disabled={busy || !checked || committed || !good.length} onClick={() => run(false)}>
                {committed ? <><CheckCircle2 size={15} /> Imported</> : "Import for real"}
              </button>
            </div>

            {/* A disabled button with no explanation is just a wall. */}
            <div className="mt-1.5 text-right text-[11.5px] text-hint dark:text-[#8a8175]">
              {committed ? "Imported. Re-importing the same file is safe — it updates rather than duplicates."
               : !good.length ? "Nothing can be imported — the file disagrees with itself (see above)."
               : !guardReady ? "Fill in the count and COD total from the courier's portal to run the check."
               : !checked ? <>Run <b>Check only</b> first — nothing can be written until it passes.</>
               : results.length && failed.length ? `${failed.length} settlement${failed.length === 1 ? "" : "s"} refused; only the ones that passed will be written.`
               : "Checked. Safe to import."}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
