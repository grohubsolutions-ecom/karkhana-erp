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
    `<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>` +
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

export function downloadBoardPdf(rows: BoardRow[], o: BoardOpts) {
  const b = build(rows, o);
  const W = 842, H = 595, M = 26;
  const usable = W - M * 2;
  const SEQ = 24;
  const cw = (usable - SEQ) / Math.max(1, b.cols.length);
  const x0 = (i: number) => M + SEQ + i * cw;           // left edge of store column i
  const CH = 20, SH = 24, RH = 17;                      // courier band, store band, row
  const TOP = H - M - 48;                               // table top, below the heading
  const footerRoom = 46;               // signatures and page number
  const firstFit = Math.floor((TOP - CH - SH - M - footerRoom) / RH);
  const perPage = Math.max(1, firstFit);
  const pages: number[][] = [];
  for (let i = 0; i < Math.max(1, b.depth); i += perPage) pages.push([i, Math.min(b.depth, i + perPage)]);

  const T = (x: number, y: number, f: "F1" | "F2", s: number, t: string, rgb = "000000") =>
    `${hex(rgb)} rg BT /${f} ${s} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(ascii(t))}) Tj ET\n`;
  const TC = (cx: number, y: number, f: "F1" | "F2", s: number, t: string, rgb = "000000") =>
    T(cx - tw(ascii(t), f, s) / 2, y, f, s, t, rgb);
  const rect = (x: number, y: number, w: number, h: number, rgb: string) => `${hex(rgb)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
  const box = (x: number, y: number, w: number, h: number, rgb: string, lw = 0.8) => `${hex(rgb)} RG ${lw} w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S\n`;
  const line = (x1: number, y1: number, x2: number, y2: number, rgb: string, lw: number) =>
    `${hex(rgb)} RG ${lw} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`;

  const streams = pages.map(([from, to], pi) => {
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
    s += rect(M, yC - SH, SEQ, CH + SH, "F1EFE8");
    s += TC(M + SEQ / 2, yC - SH / 2 + 3, "F2", 9, "#", "444441");
    b.couriers.forEach((c, ci) => {
      const t = TONE[c] ?? TONE.Other;
      const x = x0(ci * b.stores.length), w = cw * b.stores.length;
      const cnt = b.cols.filter((k) => k.courier === c).reduce((a, k) => a + k.list.filter(b.pend).length, 0);
      s += rect(x, yC, w, CH, t.fill);
      s += TC(x + w / 2, yC + 6.5, "F2", 11.5, `${c}  -  ${cnt} pending`, t.ink);
    });
    // Store band
    const yS = yC - SH;
    b.cols.forEach((k, i) => {
      const t = TONE[k.courier] ?? TONE.Other;
      s += rect(x0(i), yS, cw, SH, t.fill);
      s += TC(x0(i) + cw / 2, yS + 13, "F2", 8.5, storeLabel(k.store), t.ink);
      s += TC(x0(i) + cw / 2, yS + 4, "F2", 7.5, String(k.list.filter(b.pend).length), t.ink);
    });

    // Rows
    const n = to - from;
    for (let ri = 0; ri < n; ri++) {
      const i = from + ri;
      const yTop = yS - ri * RH, y = yTop - RH;
      s += rect(M, y, SEQ, RH, "F1EFE8");
      s += TC(M + SEQ / 2, y + 5.5, "F2", 7.5, String(i + 1), "444441");
      b.cols.forEach((k, ci) => {
        const r = k.list[i];
        if (!r) return;
        const got = !b.pend(r);
        const x = x0(ci);
        if (got) s += rect(x, y, cw, RH, "EAF3DE");
        s += box(x + 4, y + 4.5, 7.5, 7.5, "222222", 0.6);
        const on = r.order_number ?? r.tracking_id;
        const ox = x + 15;
        s += T(ox, y + 5.2, "F2", 8.5, on, got ? "27500A" : "000000");
        if (got) s += line(ox, y + 8, ox + tw(ascii(on), "F2", 8.5), y + 8, "27500A", 0.8);
        s += T(ox + tw(ascii(on), "F2", 8.5) + 5, y + 5.4, "F1", 7, dateShort(r.return_date), "555555");
      });
    }
    if (!b.depth) s += TC(M + usable / 2, yS - RH + 5, "F1", 9, "No pending returns. Nothing to chase.", "444441");

    // Grid
    const bottom = yS - Math.max(1, n) * RH;
    for (let ri = 1; ri <= Math.max(1, n); ri++) s += line(M, yS - ri * RH, M + usable, yS - ri * RH, "9A9892", 0.4);
    s += line(M + SEQ, yS, M + usable, yS, "9A9892", 0.6);
    for (let i = 1; i < b.cols.length; i++) {
      const split = i % b.stores.length === 0;
      s += line(x0(i), split ? TOP : yC, x0(i), bottom, split ? "333333" : "9A9892", split ? 1.8 : 0.4);
    }
    s += line(x0(0), TOP, x0(0), bottom, "333333", 1.8);
    s += line(M, yS, M + SEQ, yS, "9A9892", 0.6);
    s += box(M, bottom, usable, TOP - bottom, "222222", 1);

    // Footer: signatures on the last page, page number on every page.
    if (pi === pages.length - 1) {
      const sy = bottom - 26, sw = (usable - 40) / 3;
      ["Prepared by", "Received by", "Cancelled in Shopify by"].forEach((lbl, k) => {
        const x = M + k * (sw + 20);
        s += line(x, sy, x + sw, sy, "000000", 0.7) + T(x, sy - 10, "F1", 8.5, lbl, "111111");
      });
    }
    s += T(W - M - 60, M - 12, "F1", 7.5, `Page ${pi + 1} of ${pages.length}`, "666666");
    return s;
  });

  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const first = 3 + pages.length;
  pages.forEach((_, i) => objs.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${first + pages.length} 0 R /F2 ${first + pages.length + 1} 0 R >> >> /Contents ${first + i} 0 R >>`));
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

/* -------------------------------------------------------------- the board */
export function boardHtml(rows: PrintRow[], o: BoardOpts) {
  const couriers = o.courier === "Both" ? ["PostEx", "OwnEx"] : [o.courier];
  // A courier or store outside the usual set is still printed, never dropped.
  for (const r of rows) { const c = r.courier || "Other"; if (!couriers.includes(c)) couriers.push(c); }
  const stores = o.store === "ALL" ? [...STORES] : [o.store];
  for (const r of rows) { const s = r.store_code || "—"; if (!stores.includes(s)) stores.push(s); }

  type HtmlCol = { courier: string; store: string; list: PrintRow[] };
  const cols: HtmlCol[] = [];
  for (const c of couriers) for (const s of stores) {
    cols.push({
      courier: c, store: s,
      list: rows.filter((r) => (r.courier || "Other") === c && (r.store_code || "—") === s)
        .sort((a, b) => String(b.return_date ?? "").localeCompare(String(a.return_date ?? ""))
                     || String(b.order_number ?? "").localeCompare(String(a.order_number ?? ""))),
    });
  }
  const depth = Math.max(0, ...cols.map((c) => c.list.length));
  const tone = (c: string) => TONE_HTML[c] ?? TONE_HTML.Other;
  const isPend = (r: PrintRow) => o.scope === "pending" || !r.person_received;

  const courierRow = `<th rowspan="2" class="seq">#</th>` + couriers.map((c) => {
    const inC = rows.filter((r) => (r.courier || "Other") === c);
    const t = tone(c);
    return `<th colspan="${stores.length}" class="courier split" style="background:${t.fill};border-color:${t.line};color:${t.ink}">
      ${escHtml(c)} <span class="cnt">· ${inC.filter(isPend).length}${o.scope === "period" ? ` pending of ${inC.length}` : " pending"}</span></th>`;
  }).join("");

  const storeRow = cols.map((col, i) => {
    const t = tone(col.courier);
    const first = i % stores.length === 0;
    return `<th class="store${first ? " split" : ""}" style="background:${t.fill};color:${t.ink}">
      <div class="sn">${escHtml(STORE_NAME[col.store] ?? col.store)}</div><div class="sc">${col.list.filter(isPend).length}</div></th>`;
  }).join("");

  let body = "";
  for (let i = 0; i < depth; i++) {
    body += `<tr><td class="seq">${i + 1}</td>` + cols.map((col, ci) => {
      const r = col.list[i];
      const split = ci % stores.length === 0 ? " split" : "";
      if (!r) return `<td class="cell${split}"></td>`;
      const got = !isPend(r);
      return `<td class="cell${got ? " got" : ""}${split}">
        <span class="bx">${got ? "&#10003;" : ""}</span><span class="on">${escHtml(r.order_number ?? r.tracking_id)}</span><span class="dt">${escHtml(dd(r.return_date))}</span>
      </td>`;
    }).join("") + "</tr>";
  }
  if (!depth) body = `<tr><td class="cell" colspan="${cols.length + 1}" style="text-align:center;padding:24px">No pending returns. Nothing to chase.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${o.scope === "pending" ? "Pending returns" : "Returns"}</title>
<style>${BASE_CSS}
  table.board { table-layout: fixed; }
  th, td { border: 1px solid #9a9892; }
  th.seq, td.seq { width: 30px; text-align: center; background: #F1EFE8; font-weight: 700; color: #444; }
  th.courier { font-size: 14px; padding: 6px 8px; text-align: center; border-width: 1.5px; }
  th.courier .cnt { font-size: 11px; font-weight: 600; }
  th.store { padding: 4px 6px; text-align: center; }
  th.store .sn { font-size: 11.5px; font-weight: 800; }
  th.store .sc { font-size: 10px; font-weight: 600; }
  td.cell { padding: 4px 6px; height: 24px; white-space: nowrap; overflow: hidden; vertical-align: middle; }
  td.cell .bx { display: inline-block; width: 11px; height: 11px; border: 1px solid #222; margin-right: 6px; vertical-align: -1px; font-size: 9px; line-height: 10px; text-align: center; }
  td.cell .on { font-weight: 700; font-size: 11.5px; }
  td.cell .dt { color: #555; font-size: 9.5px; margin-left: 6px; }
  td.cell.got { background: #EAF3DE; }
  td.cell.got .on { text-decoration: line-through; color: #27500A; }
  .split { border-left: 2.5px solid #333 !important; }
</style></head><body>
  ${boardHead(rows, o)}
  <table class="board">
    <thead><tr>${courierRow}</tr><tr>${storeRow}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="key"><b>&#9744;</b> tick when the parcel arrives &nbsp;·&nbsp; strike the order through once it is in hand and cancelled in Shopify
    &nbsp;·&nbsp; each column newest first &nbsp;·&nbsp; date = the day the courier returned it</div>
  <div class="sign"><div>Prepared by</div><div>Received by</div><div>Cancelled in Shopify by</div></div>
</body></html>`;
}


