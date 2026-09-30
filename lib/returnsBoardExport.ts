/* THE RETURNS BOARD AS A FILE — a real .xlsx and a real .pdf, no libraries.
 *
 * Same board as the printout: # · PostEx (LM · TS · TRZ) · OwnEx (LM · TS · TRZ),
 * order number and return date in every cell, newest first, the date it was
 * taken at the top.
 *
 * WHY NOT lib/export.ts
 *   That exporter is shared with the Karkhana screens and writes one flat
 *   table: a single header row, no merged cells, no colour bands. The board
 *   needs a courier heading spanning three stores and a store heading spanning
 *   Order + Date. Rather than change a file another department depends on, the
 *   board has its own writer here. The zip and the font metrics follow the
 *   same method as lib/export.ts, so both produce files Excel and every PDF
 *   reader accept.
 */

export type BoardRow = {
  tracking_id: string; order_number: string | null; store_code: string | null;
  courier: string | null; return_date: string | null; person_received?: boolean;
};
export type BoardOpts = { scope: "pending" | "period"; from: string | null; to: string | null; courier: string; store: string };

const STORES = ["LM", "TS", "TRZ"];
const STORE_NAME: Record<string, string> = { ALL: "All stores", LM: "Little Minors", TS: "TopShop", TRZ: "Trenzee" };

/* ----------------------------------------------------------- the model */
type Col = { courier: string; store: string; list: BoardRow[] };
function build(rows: BoardRow[], o: BoardOpts) {
  const couriers = o.courier === "Both" ? ["PostEx", "OwnEx"] : [o.courier];
  for (const r of rows) { const c = r.courier || "Other"; if (!couriers.includes(c)) couriers.push(c); }
  const stores = o.store === "ALL" ? [...STORES] : [o.store];
  for (const r of rows) { const s = r.store_code || "-"; if (!stores.includes(s)) stores.push(s); }
  const cols: Col[] = [];
  for (const c of couriers) for (const s of stores) {
    cols.push({
      courier: c, store: s,
      list: rows.filter((r) => (r.courier || "Other") === c && (r.store_code || "-") === s)
        .sort((a, b) => String(b.return_date ?? "").localeCompare(String(a.return_date ?? ""))
                     || String(b.order_number ?? "").localeCompare(String(a.order_number ?? ""))),
    });
  }
  const depth = Math.max(0, ...cols.map((c) => c.list.length));
  const pend = (r: BoardRow) => o.scope === "pending" || !r.person_received;
  const now = new Date();
  const printed = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    + ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const title = o.scope === "pending" ? "Pending returns" : "Returns";
  const scope = `${STORE_NAME[o.store] ?? o.store} - ${o.courier === "Both" ? "PostEx & OwnEx" : o.courier}`
    + (o.scope === "period" ? ` - returned ${o.from && o.to ? `${o.from} to ${o.to}` : "at any time"}` : "");
  return { couriers, stores, cols, depth, pend, printed, title, scope,
           pendingCount: rows.filter(pend).length, total: rows.length };
}
const storeLabel = (s: string) => STORE_NAME[s] ?? s;
const dateShort = (s: string | null) => {
  if (!s) return "-";
  const x = new Date(s + "T00:00:00");
  return isNaN(x.getTime()) ? s : x.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const fileName = (title: string, ext: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.${ext}`;
function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ================================================================ EXCEL */
export function downloadBoardExcel(rows: BoardRow[], o: BoardOpts) {
  const b = build(rows, o);
  const xml = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const col = (i: number) => {                 // 0 -> A
    let n = i + 1, s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  /* Styles (cellXfs index):
     1 bordered text · 2 grey header · 3 title · 4 meta · 5 PostEx band ·
     6 OwnEx band · 7 other band · 8 bordered bold order · 9 bordered centred ·
     10 bordered date · 11 bordered bold order, struck (received) */
  const band = (c: string) => (c === "PostEx" ? 5 : c === "OwnEx" ? 6 : 7);
  const str = (ref: string, v: string, s: number) =>
    `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  const serial = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  };

  const nCols = 1 + b.cols.length * 2;          // # then Order+Date per store
  const lastCol = col(nCols - 1);
  const HEAD = 4;                               // table starts on row 4
  const rowsXml: string[] = [];
  const merges: string[] = [];

  rowsXml.push(`<row r="1" ht="22" customHeight="1">${str("A1", b.title, 3)}</row>`);
  merges.push(`A1:${lastCol}1`);
  rowsXml.push(`<row r="2">${str("A2", `Printed on ${b.printed}   |   ${o.scope === "pending" ? "Pending" : "Pending of " + b.total}: ${b.pendingCount}   |   ${b.scope}`, 4)}</row>`);
  merges.push(`A2:${lastCol}2`);

  // Courier band
  let r1 = str(`A${HEAD}`, "#", 2);
  b.couriers.forEach((c, ci) => {
    const start = 1 + ci * b.stores.length * 2;
    const end = start + b.stores.length * 2 - 1;
    const cnt = b.cols.filter((x) => x.courier === c).reduce((t, x) => t + x.list.filter(b.pend).length, 0);
    for (let k = start; k <= end; k++) r1 += str(`${col(k)}${HEAD}`, k === start ? `${c}  (${cnt} pending)` : "", band(c));
    merges.push(`${col(start)}${HEAD}:${col(end)}${HEAD}`);
  });
  rowsXml.push(`<row r="${HEAD}" ht="20" customHeight="1">${r1}</row>`);
  // Store band
  let r2 = str(`A${HEAD + 1}`, "", 2);
  b.cols.forEach((x, i) => {
    const c0 = 1 + i * 2;
    r2 += str(`${col(c0)}${HEAD + 1}`, `${storeLabel(x.store)}  (${x.list.filter(b.pend).length})`, band(x.courier));
    r2 += str(`${col(c0 + 1)}${HEAD + 1}`, "", band(x.courier));
    merges.push(`${col(c0)}${HEAD + 1}:${col(c0 + 1)}${HEAD + 1}`);
  });
  rowsXml.push(`<row r="${HEAD + 1}" ht="18" customHeight="1">${r2}</row>`);
  merges.push(`A${HEAD}:A${HEAD + 2}`);
  // Order | Date
  let r3 = str(`A${HEAD + 2}`, "", 2);
  b.cols.forEach((_, i) => {
    const c0 = 1 + i * 2;
    r3 += str(`${col(c0)}${HEAD + 2}`, "Order", 2) + str(`${col(c0 + 1)}${HEAD + 2}`, "Returned", 2);
  });
  rowsXml.push(`<row r="${HEAD + 2}">${r3}</row>`);

  for (let i = 0; i < b.depth; i++) {
    const rn = HEAD + 3 + i;
    let cells = `<c r="A${rn}" s="9"><v>${i + 1}</v></c>`;
    b.cols.forEach((x, ci) => {
      const c0 = 1 + ci * 2;
      const r = x.list[i];
      if (!r) { cells += str(`${col(c0)}${rn}`, "", 1) + str(`${col(c0 + 1)}${rn}`, "", 1); return; }
      cells += str(`${col(c0)}${rn}`, r.order_number ?? r.tracking_id, b.pend(r) ? 8 : 11);
      cells += r.return_date && /^\d{4}-\d{2}-\d{2}$/.test(r.return_date)
        ? `<c r="${col(c0 + 1)}${rn}" s="10"><v>${serial(r.return_date)}</v></c>`
        : str(`${col(c0 + 1)}${rn}`, "-", 9);
    });
    rowsXml.push(`<row r="${rn}">${cells}</row>`);
  }
  if (!b.depth) {
    const rn = HEAD + 3;
    rowsXml.push(`<row r="${rn}">${str(`A${rn}`, "No pending returns.", 1)}</row>`);
    merges.push(`A${rn}:${lastCol}${rn}`);
  }
  const lastRow = HEAD + 2 + Math.max(1, b.depth);

  const widths = [5, ...b.cols.flatMap(() => [13, 11])];
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEAD + 2}" topLeftCell="A${HEAD + 3}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="16"/>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${rowsXml.join("")}</sheetData>` +
    `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` +
    `<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>` +
    `<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="1"/>` +
    `</worksheet>`;

  const border = `<border><left style="thin"><color rgb="FF5F5E5A"/></left><right style="thin"><color rgb="FF5F5E5A"/></right><top style="thin"><color rgb="FF5F5E5A"/></top><bottom style="thin"><color rgb="FF5F5E5A"/></bottom><diagonal/></border>`;
  const fill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const centre = `<alignment horizontal="center" vertical="center"/>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="166" formatCode="dd mmm yyyy"/></numFmts>` +
    `<fonts count="6">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +                                   // 0
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +                               // 1
    `<font><b/><sz val="15"/><name val="Calibri"/></font>` +                               // 2
    `<font><sz val="10"/><color rgb="FF444441"/><name val="Calibri"/></font>` +            // 3
    `<font><b/><strike/><sz val="11"/><color rgb="FF27500A"/><name val="Calibri"/></font>` + // 4
    `<font><b/><sz val="12"/><name val="Calibri"/></font>` +                               // 5
    `</fonts>` +
    `<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    fill("E7E5E4") + fill("E6F1FB") + fill("E1F5EE") + fill("F1EFE8") + fill("EAF3DE") + `</fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="12">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +                                                        // 0
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>` +                                        // 1
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 2
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +                                          // 3
    `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +                                          // 4
    `<xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 5 PostEx
    `<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 6 OwnEx
    `<xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 7 other
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>` +                          // 8 order
    `<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 9 # / centred
    `<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${centre}</xf>` + // 10 date
    `<xf numFmtId="0" fontId="4" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +            // 11 struck
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  /* fitToHeight 1: Excel prints it on one sheet too, like the PDF and the
     printout — the owner's one-page rule (30 Sep). */
  const sheetName = b.title.slice(0, 31);
  const files: [string, string][] = [
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${xml(sheetName)}'!$${HEAD}:$${HEAD + 2}</definedName></definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  save(new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileName(b.title, "xlsx"));
}

/* ================================================================== PDF */
/* Helvetica / Helvetica-Bold widths (thousandths of the font size) for
   printable ASCII — the standard Adobe metrics, as in lib/export.ts. */
const HELV: Record<"F1" | "F2", number[]> = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
};
const tw = (t: string, f: "F1" | "F2", s: number) =>
  [...t].reduce((a, ch) => { const c = ch.charCodeAt(0); return a + (c >= 32 && c <= 126 ? HELV[f][c - 32] : 556); }, 0) / 1000 * s;
const ascii = (t: string) => t.replace(/[·•]/g, "-").replace(/[–—]/g, "-").replace(/[^\x20-\x7E]/g, "");
const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const hex = (h: string) => [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
const TONE: Record<string, { fill: string; ink: string; line: string }> = {
  PostEx: { fill: "E6F1FB", ink: "0C447C", line: "185FA5" },
  OwnEx:  { fill: "E1F5EE", ink: "085041", line: "0F6E56" },
  Other:  { fill: "F1EFE8", ink: "444441", line: "5F5E5A" },
};

/* ============================================== ONE PAGE, WHATEVER THE COUNT
   The owner's rule (30 Sep 2026): the board goes on ONE landscape sheet — ten
   returns or a hundred. A second page carrying three rows is paper thrown away,
   and it was happening as soon as one store column passed about 23.

     1. Up to about 30 deep it is the drawing as it always was — one list per
        store, the # column down the side — with the rows made shorter as the
        list grows.
     2. Deeper than that, a long store column splits into two or more lists
        side by side (newest first: down the first list, then the next) and
        takes the width the short columns do not need. The print stays large
        enough to tick with a pencil.
     3. Only past roughly a thousand returns does it spill onto a second page;
        no single sheet could be read at that size anyway.
   The PDF and the printout share this arithmetic, so they come out alike. */
export type BoardFit = {
  rh: number; f: number; fd: number; bs: number;   // row height, order and date font, tick box (points)
  lanes: number[]; widths: number[];                // per store column: side-by-side lists, width
  seq: boolean;                                     // the # column — only while every column is one list
  perPage: number; pages: number;                   // rows a page can take, pages used
};
const RH_MAX = 17, RH_CLASSIC = 13.5, RH_MIN = 7.75, SEQ_W = 24;
const fontFor = (rh: number) => Math.min(8.5, Math.floor(rh * 0.52 * 4) / 4);
const dateFont = (f: number) => Math.max(3.5, Math.round(f * 0.82 * 4) / 4);
const boxFor = (f: number) => Math.max(3.5, Math.round(f * 0.88 * 4) / 4);

export function fitBoard(cols: { store: string; list: BoardRow[] }[], usable: number, rowsH: number): BoardFit {
  const counts = cols.map((c) => c.list.length);
  const orders = cols.flatMap((c) => c.list.map((r) => ascii(r.order_number ?? r.tracking_id)));
  const headW = cols.map((c) => tw(ascii(storeLabel(c.store)), "F2", 8.5) + 10);
  const laneW = (f: number) =>
    3 + boxFor(f) + 3.5 + Math.max(tw("#LM00000", "F2", f), ...orders.map((t) => tw(t, "F2", f)))
      + 4 + tw("00 Mmm", "F1", dateFont(f)) + 3;
  const need = (lanes: number[], f: number) => { const w = laneW(f); return lanes.map((l, i) => Math.max(l * w, headW[i])); };
  const fits = (lanes: number[], f: number, seq: boolean) =>
    need(lanes, f).reduce((a, x) => a + x, 0) + (seq ? SEQ_W : 0) <= usable + 0.01;
  const make = (rh: number, lanes: number[], seq: boolean, perPage: number): BoardFit => {
    const f = fontFor(rh), n = need(lanes, f);
    const spare = Math.max(0, usable - (seq ? SEQ_W : 0) - n.reduce((a, x) => a + x, 0));
    const all = lanes.reduce((a, x) => a + x, 0) || 1;
    return {
      rh, f, fd: dateFont(f), bs: boxFor(f), lanes, seq, perPage,
      widths: n.map((x, i) => x + spare * (lanes[i] / all)),
      pages: Math.max(1, ...counts.map((c, i) => Math.ceil(c / (lanes[i] * perPage)))),
    };
  };
  const depth = Math.max(0, ...counts);
  for (let rh = RH_MAX; rh >= RH_CLASSIC - 1e-9; rh -= 0.25) {            // 1. as it always was
    const per = Math.floor(rowsH / rh), one = counts.map(() => 1);
    if (depth <= per && fits(one, fontFor(rh), true)) return make(rh, one, true, per);
  }
  for (let rh = RH_MAX; rh >= RH_MIN - 1e-9; rh -= 0.25) {                // 2. long columns split
    const per = Math.floor(rowsH / rh);
    const lanes = counts.map((c) => Math.max(1, Math.ceil(c / per)));
    if (fits(lanes, fontFor(rh), false)) return make(rh, lanes, false, per);
  }
  const per = Math.floor(rowsH / RH_MIN), lanes = counts.map(() => 1);     // 3. more than a sheet holds
  for (;;) {
    let worst = -1, most = 1;
    counts.forEach((c, i) => { const p = Math.ceil(c / (lanes[i] * per)); if (p > most) { most = p; worst = i; } });
    if (worst < 0) break;
    lanes[worst]++;
    if (!fits(lanes, fontFor(RH_MIN), false)) { lanes[worst]--; break; }
  }
  return make(RH_MIN, lanes, false, per);
}

/* Where every return sits: page, row, store column, list. */
function placeAll(cols: { list: BoardRow[] }[], fit: BoardFit) {
  const at = new Map<string, BoardRow>();
  const rowsOn: number[] = Array.from({ length: fit.pages }, () => 1);
  cols.forEach((c, ci) => {
    const lanes = fit.lanes[ci], cap = lanes * fit.perPage;
    const len = fit.pages === 1 ? Math.max(1, Math.ceil(c.list.length / lanes)) : fit.perPage;
    c.list.forEach((r, i) => {
      const page = Math.floor(i / cap), j = i - page * cap;
      const lane = Math.floor(j / len), row = j % len;
      at.set(`${page}:${row}:${ci}:${lane}`, r);
      rowsOn[page] = Math.max(rowsOn[page], row + 1);
    });
  });
  return { at, rowsOn };
}

export function downloadBoardPdf(rows: BoardRow[], o: BoardOpts) {
  const b = build(rows, o);
  const W = 842, H = 595, M = 26;
  const usable = W - M * 2;
  const CH = 20, SH = 24;                               // courier band, store band
  const TOP = H - M - 48;                               // table top, below the heading
  const footerRoom = 46;                                // signatures and page number
  const fit = fitBoard(b.cols, usable, TOP - CH - SH - M - footerRoom);
  const { at, rowsOn } = placeAll(b.cols, fit);
  const left = M + (fit.seq ? SEQ_W : 0);
  const xs: number[] = [];
  fit.widths.reduce((x, w) => { xs.push(x); return x + w; }, left);
  const laneW = (c: number) => fit.widths[c] / fit.lanes[c];
  const nS = b.stores.length;

  const T = (x: number, y: number, f: "F1" | "F2", s: number, t: string, rgb = "000000") =>
    `${hex(rgb)} rg BT /${f} ${s} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(ascii(t))}) Tj ET\n`;
  const TC = (cx: number, y: number, f: "F1" | "F2", s: number, t: string, rgb = "000000") =>
    T(cx - tw(ascii(t), f, s) / 2, y, f, s, t, rgb);
  const rect = (x: number, y: number, w: number, h: number, rgb: string) => `${hex(rgb)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
  const box = (x: number, y: number, w: number, h: number, rgb: string, lw = 0.8) => `${hex(rgb)} RG ${lw} w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S\n`;
  const line = (x1: number, y1: number, x2: number, y2: number, rgb: string, lw: number, dash = "") =>
    `${dash ? `[${dash}] 0 d ` : ""}${hex(rgb)} RG ${lw} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S${dash ? " [] 0 d" : ""}\n`;

  const streams = Array.from({ length: fit.pages }, (_, pi) => {
    let s = "";
    // Heading: title and scope on the left, Pending and Printed-on cards on the right.
    s += T(M, H - M - 14, "F2", 17, b.title);
    s += T(M, H - M - 28, "F1", 8.5, `Grohub Solutions - ${b.scope}`, "444441");
    s += T(M, H - M - 39, "F1", 8.5, o.scope === "pending" ? "Not yet received or cancelled - the same list as the Pending tab" : "", "444441");
    const cardW2 = 190, cardW1 = 96, cardH = 38, cy = H - M - cardH;
    const c2x = W - M - cardW2, c1x = c2x - 8 - cardW1;
    s += rect(c1x, cy, cardW1, cardH, "EEEDFE") + box(c1x, cy, cardW1, cardH, "534AB7");
    s += TC(c1x + cardW1 / 2, cy + 26, "F2", 7.5, o.scope === "pending" ? "PENDING" : `PENDING OF ${b.total}`, "3C3489");
    s += TC(c1x + cardW1 / 2, cy + 8, "F2", 16, String(b.pendingCount), "3C3489");
    s += rect(c2x, cy, cardW2, cardH, "F1EFE8") + box(c2x, cy, cardW2, cardH, "5F5E5A");
    s += TC(c2x + cardW2 / 2, cy + 26, "F2", 7.5, "PRINTED ON", "444441");
    s += TC(c2x + cardW2 / 2, cy + 10, "F2", 9.5, b.printed, "111111");

    // Courier band
    const yC = TOP - CH;
    if (fit.seq) {
      s += rect(M, yC - SH, SEQ_W, CH + SH, "F1EFE8");
      s += TC(M + SEQ_W / 2, yC - SH / 2 + 3, "F2", 9, "#", "444441");
    }
    b.couriers.forEach((c, ci) => {
      const t = TONE[c] ?? TONE.Other;
      const first = ci * nS, x = xs[first];
      const w = fit.widths.slice(first, first + nS).reduce((a, v) => a + v, 0);
      const cnt = b.cols.filter((k) => k.courier === c).reduce((a, k) => a + k.list.filter(b.pend).length, 0);
      s += rect(x, yC, w, CH, t.fill);
      s += TC(x + w / 2, yC + 6.5, "F2", 11.5, `${c}  -  ${cnt} pending`, t.ink);
    });
    // Store band
    const yS = yC - SH;
    b.cols.forEach((k, i) => {
      const t = TONE[k.courier] ?? TONE.Other;
      s += rect(xs[i], yS, fit.widths[i], SH, t.fill);
      s += TC(xs[i] + fit.widths[i] / 2, yS + 13, "F2", 8.5, storeLabel(k.store), t.ink);
      s += TC(xs[i] + fit.widths[i] / 2, yS + 4, "F2", 7.5, String(k.list.filter(b.pend).length), t.ink);
    });

    // Rows
    const n = rowsOn[pi], rh = fit.rh;
    const thin = rh < 10 ? 0.3 : 0.4;
    for (let ri = 0; ri < n; ri++) {
      const y = yS - (ri + 1) * rh;
      if (fit.seq) {
        s += rect(M, y, SEQ_W, rh, "F1EFE8");
        s += TC(M + SEQ_W / 2, y + (rh - Math.min(7.5, fit.f) * 0.72) / 2, "F2", Math.min(7.5, fit.f), String(ri + 1), "444441");
      }
      b.cols.forEach((_, ci) => {
        for (let l = 0; l < fit.lanes[ci]; l++) {
          const r = at.get(`${pi}:${ri}:${ci}:${l}`);
          if (!r) continue;
          const got = !b.pend(r);
          const x = xs[ci] + l * laneW(ci);
          if (got) s += rect(x, y, laneW(ci), rh, "EAF3DE");
          s += box(x + 3, y + (rh - fit.bs) / 2, fit.bs, fit.bs, "222222", fit.bs > 5 ? 0.6 : 0.45);
          const on = ascii(r.order_number ?? r.tracking_id);
          const ox = x + 3 + fit.bs + 3.5, base = y + (rh - fit.f * 0.72) / 2, onW = tw(on, "F2", fit.f);
          s += T(ox, base, "F2", fit.f, on, got ? "27500A" : "000000");
          if (got) s += line(ox, base + fit.f * 0.33, ox + onW, base + fit.f * 0.33, "27500A", 0.7);
          s += T(ox + onW + 4, base, "F1", fit.fd, dateShort(r.return_date), "555555");
        }
      });
    }
    if (!b.depth) s += TC(M + usable / 2, yS - rh + (rh - 9 * 0.72) / 2, "F1", 9, "No pending returns. Nothing to chase.", "444441");

    // Grid
    const bottom = yS - n * rh;
    for (let ri = 1; ri <= n; ri++) s += line(M, yS - ri * rh, M + usable, yS - ri * rh, "9A9892", thin);
    s += line(left, yS, M + usable, yS, "9A9892", 0.6);
    b.cols.forEach((_, ci) => {
      for (let l = 1; l < fit.lanes[ci]; l++) {
        const x = xs[ci] + l * laneW(ci);
        s += line(x, yS, x, bottom, "B4B2AA", 0.4, "1.2 1.4");
      }
      if (ci === 0) return;
      const split = ci % nS === 0;
      s += line(xs[ci], split ? TOP : yC, xs[ci], bottom, split ? "333333" : "9A9892", split ? 1.8 : 0.4);
    });
    s += line(left, TOP, left, bottom, "333333", fit.seq ? 1.8 : 1);
    if (fit.seq) s += line(M, yS, left, yS, "9A9892", 0.6);
    s += box(M, bottom, usable, TOP - bottom, "222222", 1);

    // Footer: signatures on the last page, page number on every page.
    if (pi === fit.pages - 1) {
      const sy = bottom - 26, sw = (usable - 40) / 3;
      ["Prepared by", "Received by", "Cancelled in Shopify by"].forEach((lbl, k) => {
        const x = M + k * (sw + 20);
        s += line(x, sy, x + sw, sy, "000000", 0.7) + T(x, sy - 10, "F1", 8.5, lbl, "111111");
      });
    }
    s += T(W - M - 60, M - 12, "F1", 7.5, `Page ${pi + 1} of ${fit.pages}`, "666666");
    return s;
  });

  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${streams.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${streams.length} >>`);
  const first = 3 + streams.length;
  streams.forEach((_, i) => objs.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${first + streams.length} 0 R /F2 ${first + streams.length + 1} 0 R >> >> /Contents ${first + i} 0 R >>`));
  streams.forEach((st) => objs.push(`<< /Length ${st.length} >>\nstream\n${st}endstream`));
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((ob, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${ob}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  save(new Blob([pdf], { type: "application/pdf" }), fileName(b.title, "pdf"));
}

/* ------------------------------------------------------ zip, stored only */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files: [string, string][]): ArrayBuffer {
  const enc = new TextEncoder();
  const now = new Date();
  const dt = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dd = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dt, true); cd.setUint16(14, dd, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out.buffer;
}

/* ------------------------------------------ the printable board (HTML) */
const escHtml = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const dd = (s: string | null) => dateShort(s);
const longDate = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const TONE_HTML: Record<string, { fill: string; line: string; ink: string }> = {
  PostEx: { fill: "#E6F1FB", line: "#185FA5", ink: "#0C447C" },
  OwnEx:  { fill: "#E1F5EE", line: "#0F6E56", ink: "#085041" },
  Other:  { fill: "#F1EFE8", line: "#5F5E5A", ink: "#444441" },
};
export type PrintRow = BoardRow & { [k: string]: unknown };

export const BASE_CSS = `
  @page { size: A4 landscape; margin: 9mm 8mm 11mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10px/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 10px; background: #fff; }
  @media screen { body { max-width: 1140px; margin: 0 auto; } }
  .head { display: flex; justify-content: space-between; align-items: stretch; gap: 10px; margin-bottom: 9px; }
  .head h1 { font-size: 18px; margin: 0; }
  .head .sub { font-size: 10.5px; color: #444; margin-top: 3px; }
  .card { border: 1px solid #5F5E5A; background: #F1EFE8; border-radius: 7px; padding: 5px 14px; text-align: center; min-width: 150px; }
  .card .k { font-size: 10px; font-weight: 700; color: #444441; }
  .card .v { font-size: 17px; font-weight: 800; line-height: 1.2; }
  .card.pend { background: #EEEDFE; border-color: #534AB7; color: #3C3489; }
  .card.pend .k { color: #3C3489; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .sign { display: flex; gap: 26px; margin-top: 14px; font-size: 10.5px; }
  .sign div { flex: 1; border-top: 1px solid #000; padding-top: 4px; }
  .key { font-size: 9.5px; color: #333; margin-top: 7px; }
`;

export function boardHead(rows: PrintRow[], o: BoardOpts) {
  const printed = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const title = o.scope === "pending" ? "Pending returns" : "Returns";
  const what = o.scope === "pending"
    ? "Not yet received or cancelled — the same list as the Pending tab"
    : `Returned ${o.from && o.to ? `${longDate(o.from)} – ${longDate(o.to)}` : "at any time"}`;
  const scope = `${STORE_NAME[o.store] ?? o.store} · ${o.courier === "Both" ? "PostEx & OwnEx" : o.courier}`;
  const count = o.scope === "pending" ? rows.length : rows.filter((r) => !r.person_received).length;
  return `
  <div class="head">
    <div><h1>${escHtml(title)}</h1><div class="sub">Grohub Solutions · ${escHtml(scope)}</div><div class="sub">${escHtml(what)}</div></div>
    <div style="display:flex;gap:10px">
      <div class="card pend"><div class="k">${o.scope === "pending" ? "PENDING" : "PENDING OF " + rows.length}</div><div class="v">${count}</div></div>
      <div class="card"><div class="k">PRINTED ON</div><div class="v" style="font-size:13px">${escHtml(printed)}</div><div class="k" style="font-weight:400">${escHtml(time)}</div></div>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- the board
   ONE SHEET, LIKE THE PDF. The page is A4 landscape with 26pt margins, so the
   board is laid out for exactly 790 x 543 points, in points, with the same
   fitBoard() arithmetic as the PDF. Two nets underneath it:
     - a few lines of script measure the sheet once it is drawn and shrink it
       (CSS zoom) if a font came out larger than the sums expected;
     - a phone or printer that insists on portrait gets the sheet scaled to
       the narrower page instead of cut in two. */
const SHEET_W = 790, SHEET_H = 543;
/* Heading 48 + gap 6 + bands 44 + key 15 + signatures 29, and 10 to spare. */
const HTML_ROWS_H = SHEET_H - 48 - 6 - 44 - 15 - 29 - 10;

export function boardHtml(rows: PrintRow[], o: BoardOpts) {
  const b = build(rows, o);
  const fit = fitBoard(b.cols, SHEET_W - 2, HTML_ROWS_H);
  const { at, rowsOn } = placeAll(b.cols, fit);
  const tone = (c: string) => TONE_HTML[c] ?? TONE_HTML.Other;
  const L = fit.lanes, nS = b.stores.length;
  const allLanes = L.reduce((a, x) => a + x, 0);
  const pt = (n: number) => `${n.toFixed(2)}pt`;

  const now = new Date();
  const printed = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const what = o.scope === "pending"
    ? "Not yet received or cancelled — the same list as the Pending tab"
    : `Returned ${o.from && o.to ? `${longDate(o.from)} – ${longDate(o.to)}` : "at any time"}`;
  const scope = `${STORE_NAME[o.store] ?? o.store} · ${o.courier === "Both" ? "PostEx & OwnEx" : o.courier}`;
  const head = `
    <div class="hd">
      <div><h1>${escHtml(b.title)}</h1><div class="sub">Grohub Solutions · ${escHtml(scope)}</div><div class="sub">${escHtml(what)}</div></div>
      <div class="cards">
        <div class="card pend"><div class="k">${o.scope === "pending" ? "PENDING" : "PENDING OF " + b.total}</div><div class="v">${b.pendingCount}</div></div>
        <div class="card pr"><div class="k">PRINTED ON</div><div class="v">${escHtml(printed)}, ${escHtml(time)}</div></div>
      </div>
    </div>`;

  const cols = (fit.seq ? `<col style="width:${pt(SEQ_W)}">` : "")
    + b.cols.map((_, c) => `<col style="width:${pt(fit.widths[c] / L[c])}">`.repeat(L[c])).join("");
  const courierRow = (fit.seq ? `<th rowspan="2" class="seq">#</th>` : "") + b.couriers.map((c, ci) => {
    const mine = b.cols.slice(ci * nS, ci * nS + nS);
    const span = L.slice(ci * nS, ci * nS + nS).reduce((a, x) => a + x, 0);
    const pend = mine.reduce((a, k) => a + k.list.filter(b.pend).length, 0);
    const total = mine.reduce((a, k) => a + k.list.length, 0);
    const t = tone(c);
    return `<th colspan="${span}" class="courier split" style="background:${t.fill};color:${t.ink}">${escHtml(c)}
      <span class="cnt">· ${pend}${o.scope === "period" ? ` pending of ${total}` : " pending"}</span></th>`;
  }).join("");
  const storeRow = b.cols.map((k, i) => {
    const t = tone(k.courier);
    return `<th colspan="${L[i]}" class="store${i % nS === 0 ? " split" : ""}" style="background:${t.fill};color:${t.ink}">
      <div class="sn">${escHtml(STORE_NAME[k.store] ?? k.store)}</div><div class="sc">${k.list.filter(b.pend).length}</div></th>`;
  }).join("");

  const footer = `
    <div class="key"><b>&#9744;</b> tick when the parcel arrives &nbsp;·&nbsp; strike the order through once it is in hand and cancelled in Shopify
      &nbsp;·&nbsp; each column newest first${fit.seq ? "" : ", down one list then the next"} &nbsp;·&nbsp; date = the day the courier returned it</div>
    <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div></div>`;

  const sheets = rowsOn.map((n, p) => {
    let body = "";
    for (let r = 0; r < n; r++) {
      body += `<tr>${fit.seq ? `<td class="seq">${r + 1}</td>` : ""}` + b.cols.map((_, c) => {
        let cells = "";
        for (let l = 0; l < L[c]; l++) {
          const e = at.get(`${p}:${r}:${c}:${l}`);
          const cls = `cell${l === 0 && c % nS === 0 ? " split" : ""}${l > 0 ? " lane" : ""}`;
          if (!e) { cells += `<td class="${cls}"></td>`; continue; }
          const got = !b.pend(e);
          cells += `<td class="${cls}${got ? " got" : ""}"><span class="bx">${got ? "&#10003;" : ""}</span><span class="on">${escHtml(e.order_number ?? e.tracking_id)}</span><span class="dt">${escHtml(dd(e.return_date))}</span></td>`;
        }
        return cells;
      }).join("") + "</tr>";
    }
    if (!b.depth) body = `<tr><td class="cell empty" colspan="${allLanes + (fit.seq ? 1 : 0)}">No pending returns. Nothing to chase.</td></tr>`;
    return `<div class="sheet">${head}
      <table class="board"><colgroup>${cols}</colgroup>
        <thead><tr>${courierRow}</tr><tr>${storeRow}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${p === rowsOn.length - 1 ? footer : `<div class="key">Continued on page ${p + 2} of ${rowsOn.length}.</div>`}
    </div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(b.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @page { size: A4 landscape; margin: 26pt; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  @media screen { body { padding: 16px; } }
  .sheet { width: ${SHEET_W}pt; zoom: var(--fit, 1); break-inside: avoid; page-break-inside: avoid; }
  .sheet + .sheet { break-before: page; page-break-before: always; margin-top: 16px; }
  @media print and (orientation: portrait) { .sheet { zoom: calc(var(--fit, 1) * 0.68); } }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 10pt; height: 48pt; overflow: hidden; }
  .hd h1 { font-size: 17pt; line-height: 1.05; margin: 0; }
  .hd .sub { font-size: 8.5pt; line-height: 1.25; color: #444; margin-top: 2pt; }
  .cards { display: flex; gap: 8pt; }
  .card { height: 38pt; border: 0.8pt solid #5F5E5A; background: #F1EFE8; border-radius: 5pt; padding: 0 10pt;
          display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .card .k { font-size: 7.5pt; font-weight: 700; color: #444441; }
  .card .v { font-size: 9.5pt; font-weight: 800; margin-top: 2pt; }
  .card.pend { min-width: 96pt; background: #EEEDFE; border-color: #534AB7; color: #3C3489; }
  .card.pend .k { color: #3C3489; } .card.pend .v { font-size: 16pt; line-height: 1; }
  .card.pr { min-width: 190pt; }
  table.board { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 6pt; }
  .board th, .board td { border: 0.5pt solid #9a9892; padding: 0; overflow: hidden; }
  .board th.courier { height: 20pt; font-size: 11.5pt; font-weight: 800; text-align: center; white-space: nowrap; }
  .board th.courier .cnt { font-size: 9pt; font-weight: 600; }
  .board th.store { height: 24pt; text-align: center; line-height: 1.1; white-space: nowrap; }
  .board .sn { font-size: 8.5pt; font-weight: 800; } .board .sc { font-size: 7.5pt; font-weight: 700; }
  .board .seq { background: #F1EFE8; color: #444; font-weight: 700; text-align: center; font-size: ${pt(Math.min(7.5, fit.f))}; }
  .board tbody tr { height: ${pt(fit.rh)}; }
  /* The cell's own text size is the fitted one: left at the page default
     (16px) it props every row open to 17px, whatever the board asked for. */
  .board td { font-size: ${pt(fit.f)}; line-height: 1; }
  .board td.cell { white-space: nowrap; padding: 0 3pt; vertical-align: middle; }
  .board td.lane { border-left: 0.5pt dashed #b4b2aa; }
  .board td.got { background: #EAF3DE; }
  .board td.empty { text-align: center; font-size: 9pt; color: #444; }
  .bx { display: inline-block; width: ${pt(fit.bs)}; height: ${pt(fit.bs)}; border: ${fit.bs > 5 ? "0.6pt" : "0.45pt"} solid #222;
        margin-right: 3.5pt; vertical-align: middle; font-size: ${pt(fit.bs * 0.8)}; line-height: ${pt(fit.bs)}; text-align: center; }
  .on { font-size: ${pt(fit.f)}; font-weight: 700; vertical-align: middle; }
  .dt { font-size: ${pt(fit.fd)}; color: #555; margin-left: 4pt; vertical-align: middle; }
  .got .on { text-decoration: line-through; color: #27500A; }
  .board .split { border-left: 1.8pt solid #333; }
  .key { height: 10pt; margin-top: 5pt; font-size: 7.5pt; line-height: 10pt; color: #333; white-space: nowrap; overflow: hidden; }
  .sign { display: flex; gap: 20pt; margin-top: 16pt; font-size: 8.5pt; }
  .sign div { flex: 1; border-top: 0.7pt solid #000; padding-top: 3pt; }
</style></head><body>
${sheets}
<script>
(function () {
  /* The safety net: if the drawn sheet came out taller or wider than the page,
     shrink it to fit rather than let the printer start a second sheet. */
  var H = ${SHEET_H} * 96 / 72 - 3, W = ${SHEET_W} * 96 / 72;
  function fit() {
    var all = document.querySelectorAll('.sheet');
    for (var i = 0; i < all.length; i++) {
      var s = all[i]; s.style.setProperty('--fit', '1');
      var r = s.getBoundingClientRect(), k = Math.min(1, H / r.height, W / r.width);
      if (k < 0.999) s.style.setProperty('--fit', String(Math.floor(k * 1000) / 1000));
    }
  }
  fit();
  window.addEventListener('beforeprint', fit);
})();
</script>
</body></html>`;
}
