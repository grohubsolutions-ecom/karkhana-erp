/* READ A FILE INTO A GRID — CSV, EXCEL OR PDF.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The retail importer accepted `.csv` and nothing else, while the two courier
 * screens in this same project have taken `.csv,.xls,.xlsx,.pdf` for months.
 * That is not a small gap in practice: Nimbus will export a sale report as
 * Excel, people open a CSV in Excel to look at it and save it back as .xlsx
 * without thinking, and the account statements arrive as PDF. Every one of
 * those was simply refused, and the only way through was to convert the file by
 * hand first.
 *
 * Everything downstream of here already works on a plain grid of strings —
 * `detectKind()` reads the header row, `parseSalesRows()` / `parseExpenseRows()`
 * / `parsePaymentRows()` read the rest. So the whole fix is to produce that
 * grid from three formats instead of one. No parsing rule changes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE FORMATS ARE NOT EQUALLY TRUSTWORTHY, AND THE CALLER IS TOLD SO
 *
 *   CSV    — exact. The bytes are the table.
 *   EXCEL  — exact. Cells are cells; this only flattens them to text.
 *   PDF    — RECONSTRUCTED. A PDF has no table in it, only glyphs at
 *            coordinates. The rows and columns below are inferred from where
 *            the text sits on the page. For a machine-generated report that is
 *            reliable, and it is still inference.
 *
 * So `readGrid` returns `exact: false` for a PDF, and the import screen shows a
 * warning telling the operator to check the totals against the report before
 * importing. The screen already previews the parsed figures — line count, shops
 * matched, shop-days, total sales — so the operator can see a bad reconstruction
 * rather than discover it in next month's accounts. That preview is what makes
 * accepting PDF defensible at all; without it this file should not exist.
 */
import { parseCsvRows } from "@/lib/nimbus";

export type Grid = {
  rows: string[][];
  /** false when the table was inferred rather than read — PDF only. */
  exact: boolean;
  /** 'csv' | 'excel' | 'pdf', for the message the screen shows. */
  format: "csv" | "excel" | "pdf";
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** CSV, Excel or PDF → a grid of trimmed strings. Throws nothing: an
 *  unreadable file comes back as an empty grid and the caller says so. */
export async function readGrid(
  file: File,
  /** Does this row of cells look like the header? A PDF needs it: its columns
   *  are taken from where the HEADINGS sit, because a heading with nothing
   *  under it is still a column. CSV and Excel ignore it. */
  isHeaderRow?: (cells: string[]) => boolean,
): Promise<Grid> {
  const name = file.name.toLowerCase();

  if (/\.pdf$/.test(name) || file.type === "application/pdf") {
    return { rows: await readPdf(file, isHeaderRow), exact: false, format: "pdf" };
  }
  if (/\.xlsx?$/.test(name) || /spreadsheet|excel/.test(file.type)) {
    return { rows: await readExcel(file), exact: true, format: "excel" };
  }
  return { rows: parseCsvRows(await file.text()).map((r) => r.map(clean)), exact: true, format: "csv" };
}

/* ── EXCEL ────────────────────────────────────────────────────────────────
   `header: 1` gives the sheet as a grid rather than objects keyed by the first
   row, which is what the Nimbus parsers want and also what lets the header row
   be found below rather than assumed to be row 1.

   `raw: false` so dates and numbers arrive as the strings the sheet displays.
   The parsers already handle Nimbus's own date and number formats; handing them
   a JavaScript Date or a float would mean two code paths for every field.

   Only the FIRST sheet is read. A Nimbus export has one; a workbook somebody
   has added notes to in sheet 2 should not have those notes silently imported. */
async function readExcel(file: File): Promise<string[][]> {
  const XLSX = await import("xlsx");   // ~400 kB, loaded only when a sheet is chosen
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", raw: false, cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
  return grid.map((r) => (r ?? []).map(clean));
}

/* ── PDF ──────────────────────────────────────────────────────────────────
   A PDF stores glyphs with coordinates and nothing else — no rows, no columns,
   no cells. Both have to be inferred:

   ROWS come from the vertical position. Fragments whose baseline is within a
   couple of points of each other are the same line. This is the same grouping
   the courier load-sheet reader uses and it is the reliable half.

   COLUMNS COME FROM THE HEADER ROW, and that is the whole trick.

   The obvious approach — cluster every fragment's x across the document and
   keep the positions that enough lines share — was tried and is WRONG in a way
   that does not announce itself. A column whose cells are all empty (Online
   Order #, Customer: blank on every walk-in sale) has no data fragment at its
   x, so its position is supported by the header row alone, falls below any
   sensible threshold, and is dropped. The grid then comes out two columns
   narrower than the file, the header "Receipt" and "Online Order #" collapse
   into one cell reading "Receipt Online Order #", and `idx["Receipt"]` is
   undefined — so every receipt number imports blank.

   Worse, the figures still looked right. parseSalesRows counts its money
   columns backwards from the payment-mode cell, and both dropped columns were
   to its left, so nothing shifted. Put an empty column to the RIGHT of the
   payment mode instead and every amount would have been wrong, with no error
   anywhere. That is the shape of defect this file exists to avoid.

   So the columns are taken from where the HEADINGS are, which is what a table's
   columns actually are. A heading with nothing under it still makes a column.
   Each fragment then goes to the heading whose span is nearest its own centre,
   so it does not matter whether the cell is left- or right-aligned.
*/
type Frag = { page: number; y: number; x: number; w: number; t: string };

async function readPdf(file: File, isHeaderRow?: (cells: string[]) => boolean): Promise<string[][]> {
  const pdfjsLib = await import("pdfjs-dist");
  /* SERVED BY THIS APP, NOT BY A CDN.
     The two courier screens fetch this worker from cdnjs. That is a dependency
     on a third-party host sitting in the middle of a money import: if cdnjs is
     slow, blocked by a shop's network, or simply unreachable, the file silently
     refuses to open and the only message is "Setting up fake worker failed".
     `public/pdf.worker.min.mjs` is copied from the installed pdfjs-dist, so it
     is the exact version this build expects and it comes from the same origin
     as the page. Keep the two in step: refresh the copy whenever pdfjs-dist is
     upgraded. */
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  const frags: Frag[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const item of content.items as { str?: string; width?: number; transform?: number[] }[]) {
      const t = clean(item.str);
      if (!t || !item.transform) continue;
      frags.push({ page: p, x: item.transform[4], y: Math.round(item.transform[5]),
                   w: Number(item.width ?? 0), t });
    }
  }
  if (!frags.length) return [];

  /* ── rows ──────────────────────────────────────────────────────────────
     Bucketed per page, because y is measured from the bottom of each page and
     line 1 of page 2 sits at the same y as line 1 of page 1. */
  const lines: Frag[][] = [];
  const byPage = new Map<number, Frag[]>();
  frags.forEach((f) => byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]));

  [...byPage.keys()].sort((a, b) => a - b).forEach((p) => {
    const buckets = new Map<number, Frag[]>();
    for (const f of byPage.get(p)!) {
      /* 2.5pt: tighter than one line of 9pt text, loose enough that a cell
         whose baseline is a hair off still joins its own row. */
      const key = [...buckets.keys()].find((k) => Math.abs(k - f.y) <= 2.5) ?? f.y;
      buckets.set(key, [...(buckets.get(key) ?? []), f]);
    }
    [...buckets.entries()]
      .sort((a, b) => b[0] - a[0])                 // top of the page downwards
      .forEach(([, parts]) => lines.push(parts.sort((a, b) => a.x - b.x)));
  });

  /* ── columns, from the headings ────────────────────────────────────────
     The first line the caller recognises as a header row defines them. A
     heading split across two fragments ("Online Order" + "#") is one heading:
     they are joined when the gap between them is smaller than a space. */
  let anchors: { x: number; end: number }[] = [];
  if (isHeaderRow) {
    const hdr = lines.slice(0, 25).find((l) => isHeaderRow(l.map((f) => f.t)));
    if (hdr) {
      for (const f of hdr) {
        const last = anchors[anchors.length - 1];
        if (last && f.x - last.end < 3) { last.end = f.x + f.w; continue; }
        anchors.push({ x: f.x, end: f.x + f.w });
      }
    }
  }

  /* No header found — a report whose headings this caller does not know, or a
     PDF that is prose rather than a table. One cell per fragment at least keeps
     the words in order, so the caller can see what it got and refuse it. */
  if (anchors.length < 2) return lines.map((parts) => parts.map((f) => f.t));

  /* The boundary between two columns is the midpoint of the gap between them,
     so a right-aligned number under a left-aligned heading still lands in its
     own column and not in the one before it. */
  const bounds: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    bounds.push((anchors[i - 1].end + anchors[i].x) / 2);
  }

  return lines.map((parts) => {
    const cells: string[] = new Array(anchors.length).fill("");
    for (const f of parts) {
      const mid = f.x + f.w / 2;
      let i = 0;
      while (i < bounds.length && mid > bounds[i]) i++;
      cells[i] = cells[i] ? `${cells[i]} ${f.t}` : f.t;
    }
    return cells;
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   WHERE DOES THE TABLE START?

   A CSV straight out of Nimbus begins with its header row. An Excel file often
   does not — exports carry a title, a date range, sometimes a logo row — and a
   PDF almost never does, because the report has a heading above the table.

   Rather than guess which row "looks like headers", this asks the thing that
   actually knows: `detectKind`. The first row that it recognises as a Nimbus
   header IS the header. That is exact, not a heuristic, and it costs one cheap
   call per candidate row.
   ────────────────────────────────────────────────────────────────────────── */
export function findHeaderRow(
  rows: string[][],
  recognises: (headers: string[]) => boolean,
  scan = 25,
): number {
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    if (recognises((rows[i] ?? []).map(clean))) return i;
  }
  return -1;
}

/** Drop repeats of the header further down the file. A multi-page PDF reprints
 *  its column headings on every page, and those would otherwise arrive as data
 *  rows — a sale with the item code "Item Code". */
export function dropRepeatedHeaders(rows: string[][], header: string[]): string[][] {
  const key = header.join("\u0001");
  return rows.filter((r, i) => i === 0 || r.join("\u0001") !== key);
}
