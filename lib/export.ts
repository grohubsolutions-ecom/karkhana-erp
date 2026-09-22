/* ONE EXPORTER FOR EVERY TAB — csv, excel, pdf, print.
 *
 * No libraries, deliberately. CSV is plain text. Excel is a real .xlsx and
 * PDF a real PDF, both written by hand and downloaded.
 * All of them take the SAME rows the person is looking at, so what exports
 * is exactly what was on screen — never a second query that could disagree
 * with it.
 *
 * EVERY TABLE IS RULED. Excel, PDF and print all draw a full grid — a box
 * around every cell, a shaded header — because a sheet of loose words in
 * columns is hard to read across and easy to misread by a row. The PDF used
 * to draw a single line under the header and nothing else; print drew its
 * lines in a grey most printers barely put on paper; Excel's lines depended
 * on how the file happened to be opened. CSV has no lines and cannot: it is raw
 * text for other software, not a document.
 *
 * Numbers line up on the right in PDF and print, as they do in Excel, so
 * units sit under units and a column can be run down by eye.
 */
export type ExportTable = { title: string; headers: string[]; rows: (string | number | null | undefined)[][] };

/* TWO LAYOUTS.
 *
 * KARKHANA (the default): every cell centred, every column only as wide as
 * what is in it, the table centred on the page, and — in print — fitted to
 * ONE sheet whenever that still leaves it readable. Asked for by the owner
 * (22 Sep): "single sheet, centre aligned, columns not too large".
 *
 * CLASSIC: the layout as it was — left-aligned text, numbers on the right,
 * the table stretched across the page. FS Traders' pages (/retail) keep it:
 * they share this file but are not Karkhana's to change, so their printouts
 * stay exactly as that team left them.
 */
const classic = () => typeof window !== "undefined" && window.location.pathname.startsWith("/retail");

const cell = (v: unknown) => (v == null ? "" : String(v));

/* A quantity, a price, a percentage — but not a barcode. A long run of digits
   is a code: it is text, and it must never be turned into 2.00E+12. */
const NUMERIC = /^[+\-\u2212]?\s?(Rs\.?\s?)?[+\-\u2212]?\d[\d,]*(\.\d+)?\s?%?$/;
const isCode = (s: string) => /^\d{11,}$/.test(s) || /^0\d+$/.test(s);
/* A column of codes, decided by the column, not by each value: a 7-digit
   printed barcode (2914990) looks exactly like a 7-digit amount, and Excel
   would show it as 2,914,990. The heading settles it — Barcode, Item code,
   Invoice, Delivery #, Phone — as does any value that is plainly a code.
   Checked against every heading these screens export: it marks the code
   columns and a few that are text anyway, and none of the number columns. */
const CODE_HEADING = /\b(barcode|code|manual|printed|invoice|inv|number|no|phone|cnic|id|delivery|document|str|gro|grn|wmv|ref)\b|#/i;
function codeColumns(headers: string[], rows: ExportTable["rows"]): boolean[] {
  return headers.map((h, ci) => CODE_HEADING.test(String(h))
    || rows.some((r) => r[ci] != null && typeof r[ci] !== "number" && isCode(String(r[ci]).trim())));
}
/* How a value reads on paper. A raw number gets its thousands commas —
   2797746 is hard to read, 2,797,746 is not — unless it sits in a code
   column, where 12620 is an invoice number and must stay 12620. Used by PDF
   and print; Excel formats numbers itself and CSV stays raw for software. */
const display = (v: unknown, code: boolean) =>
  typeof v === "number" && Number.isFinite(v) && !code
    ? v.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : cell(v);
function numericColumns(headers: string[], rows: ExportTable["rows"]): boolean[] {
  const codes = codeColumns(headers, rows);
  return headers.map((_, ci) => {
    if (codes[ci]) return false;
    const vals = rows.map((r) => r[ci]).filter((v) => v != null && String(v).trim() !== "");
    if (vals.length === 0) return false;
    const hits = vals.filter((v) => typeof v === "number"
      || (NUMERIC.test(String(v).trim()) && !isCode(String(v).trim()))).length;
    return hits / vals.length >= 0.8;
  });
}

export function exportCSV({ title, headers, rows }: ExportTable) {
  const esc = (v: unknown) => `"${cell(v).replaceAll('"', '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  save(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), `${slug(title)}.csv`);
}

/* EXCEL — a real .xlsx, written by hand.
 *
 * This used to be a web page renamed .xls. Excel opened it with a warning
 * that the format did not match, and whether it showed lines depended on
 * which program opened it — LibreOffice, WPS and Google Sheets showed none.
 * A real workbook carries its own formatting, so every cell has its border
 * wherever it is opened, the header is bold and shaded and stays in view
 * when scrolling, and printing it from Excel comes out landscape, one page
 * wide, with the header repeated on every page.
 *
 * Numbers go in as numbers, so a column can be summed. A long run of digits
 * is a barcode, not a number: it goes in as text, so 2000003127726 is never
 * shown as 2.00E+12 and a code with a leading zero keeps it.
 */
export function exportExcel({ title, headers, rows }: ExportTable) {
  const xml = (v: string) => v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colName = (i: number) => {
    let n = i + 1, s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  /* Styles: 1 bordered text, 2 header, 3 bordered text-as-code,
     4 whole number with thousands, 5 decimal, 6 Rupees, 7 Rupees with paisa,
     8 percent, 9 percent with decimals — all bordered. Money and percentages
     are stored as numbers and only DISPLAYED as "Rs 2,797,746" or "12%", so
     a column of them can be totalled in Excel; as text it could not. */
  const codes = codeColumns(headers, rows);
  const cellXml = (v: unknown, ref: string, ci: number) => {
    if (codes[ci]) {
      const t = cell(v);
      return `<c r="${ref}" t="inlineStr" s="3"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
    }
    if (typeof v === "number" && Number.isFinite(v))
      return `<c r="${ref}" s="${Number.isInteger(v) ? 4 : 5}"><v>${v}</v></c>`;
    const t = cell(v);
    const s = t.trim();
    const rs = /^([+-]?)\s?Rs\.?\s?([+-]?)(\d[\d,]*(?:\.\d+)?)$/.exec(s);
    if (rs) {
      const negative = rs[1] === "-" || rs[2] === "-";
      const n = (negative ? -1 : 1) * Number(rs[3].replace(/,/g, ""));
      if (Number.isFinite(n)) return `<c r="${ref}" s="${Number.isInteger(n) ? 6 : 7}"><v>${n}</v></c>`;
    }
    const pc = /^([+-]?\d+(?:\.\d+)?)\s?%$/.exec(s);
    if (pc) {
      const n = Number(pc[1]) / 100;
      if (Number.isFinite(n)) return `<c r="${ref}" s="${Number.isInteger(Number(pc[1])) ? 8 : 9}"><v>${n}</v></c>`;
    }
    if (s && !isCode(s) && /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$|^[+-]?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s.replace(/,/g, ""));
      if (Number.isFinite(n)) return `<c r="${ref}" s="${Number.isInteger(n) ? 4 : 5}"><v>${n}</v></c>`;
    }
    const style = isCode(s) ? 3 : 1;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
  };

  const compact = !classic();
  /* Compact: a column is as wide as its longest entry and no wider than 42
     characters — past that a name wraps inside its cell instead of pushing
     every other column off the sheet. */
  const widths = headers.map((h, ci) => Math.min(compact ? 42 : 60, Math.max(compact ? 6 : 8,
    String(h).length + 2, ...rows.map((r) => cell(r[ci]).length + 2))));
  const narrow = widths.reduce((a, b) => a + b, 0) <= 95;
  const al = compact ? `<alignment horizontal="center" vertical="center" wrapText="1"/>` : `<alignment vertical="top"/>`;
  const alHead = compact ? `<alignment horizontal="center" vertical="center" wrapText="1"/>` : `<alignment vertical="center"/>`;
  const sheetName = (title.replace(/[\[\]:*?/\\']/g, " ").trim() || "Sheet").slice(0, 31);
  const last = `${colName(headers.length - 1)}${rows.length + 1}`;

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<dimension ref="A1:${last}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>` +
    `<row r="1">${headers.map((h, ci) => `<c r="${colName(ci)}1" t="inlineStr" s="2"><is><t xml:space="preserve">${xml(String(h))}</t></is></c>`).join("")}</row>` +
    rows.map((r, ri) => `<row r="${ri + 2}">${headers.map((_, ci) => cellXml(r[ci], `${colName(ci)}${ri + 2}`, ci)).join("")}</row>`).join("") +
    `</sheetData>` +
    `<autoFilter ref="A1:${last}"/>` +
    /* printOptions must come before pageMargins — Excel refuses the file otherwise. */
    (compact ? `<printOptions horizontalCentered="1"/>` : "") +
    `<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>` +
    /* Compact: portrait when the columns fit it, and one sheet tall when the
       list is short enough to stay readable on one. */
    `<pageSetup orientation="${compact && narrow ? "portrait" : "landscape"}" paperSize="9" fitToWidth="1" fitToHeight="${compact && rows.length <= 60 ? 1 : 0}"/>` +
    `</worksheet>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;Rs &quot;#,##0"/>` +
    `<numFmt numFmtId="165" formatCode="&quot;Rs &quot;#,##0.00"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFE7E5E4"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left style="thin"><color rgb="FF44403C"/></left><right style="thin"><color rgb="FF44403C"/></right>` +
    `<top style="thin"><color rgb="FF44403C"/></top><bottom style="thin"><color rgb="FF44403C"/></bottom><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="10">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${alHead}</xf>` +
    `<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `<xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${al}</xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
  const files: [string, string][] = [
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`],
    ["xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames>` +
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xml(quoted)}!$A$1:$${colName(headers.length - 1)}$${rows.length + 1}</definedName>` +
      `<definedName name="_xlnm.Print_Titles" localSheetId="0">${xml(quoted)}!$1:$1</definedName>` +
      `</definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  save(new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${slug(title)}.xlsx`);
}

/* A zip with no compression — all an .xlsx needs to be valid. Each file gets
   a CRC-32 checksum, which Excel verifies and refuses the file without. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files: [string, string][]): ArrayBuffer {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out.buffer;
}

/* Helvetica and Helvetica-Bold character widths, in thousandths of the font
   size, for printable ASCII (space to ~). Taken from the standard Adobe font
   metrics. Every width in the PDF is measured with these rather than guessed:
   the old guess of half the font size per character came up 16 points short
   on an all-capitals product name, which on a ruled table means the name
   runs across the line into the next column. */
const HELV: Record<"F1" | "F2", number[]> = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
};
const textW = (t: string, font: "F1" | "F2", size: number) =>
  [...t].reduce((a, ch) => {
    const c = ch.charCodeAt(0);
    return a + (c >= 32 && c <= 126 ? HELV[font][c - 32] : 556);
  }, 0) / 1000 * size;

export function exportPDF({ title, headers, rows }: ExportTable) {
  /* A real PDF, written by hand and downloaded — not the print dialog wearing
     a PDF label. Landscape A4, Helvetica, and a ruled table: a shaded header,
     a line under every row, a line between every column, a box round it all.
     No library: a PDF dependency for one table is a lot of weight to carry.
  */
  const compact = !classic();
  const M = 28;                               // page margin, points
  const PAD = compact ? 5 : 3.5;              // text inset inside each cell
  const RH = 13, HH = 15;                     // row and header heights
  const FS = 8;                               // font size, body and header
  const right = numericColumns(headers, rows);

  /* PDF base fonts carry Latin-1 only. The marks this app uses most become
     plain equivalents first, so "Carrefour · WTC" prints as "Carrefour - WTC"
     rather than losing its separator; anything else unprintable is dropped. */
  const ascii = (t: unknown) => cell(t)
    .replace(/[\u00B7\u2022]/g, "-").replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[^\x20-\x7E]/g, "");
  /* Escaping comes last, after measuring: the backslashes it adds are not
     printed, so they must not count towards a width. */
  const pdfStr = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  /* Trim to fit its box, measured, with a full stop to show it was trimmed. */
  const fit = (t: string, w: number, font: "F1" | "F2", size = FS) => {
    if (textW(t, font, size) <= w + 0.01) return t;   /* + a hair: a width measured to fit exactly must not lose its last letter to rounding */
    let v = t;
    while (v.length > 1 && textW(v + ".", font, size) > w) v = v.slice(0, -1);
    return v + ".";
  };

  /* Column widths from what is actually in each column. If everything fits,
     spare room is shared out. If not, only the wide text columns give way —
     a quantity or a price is never the thing that gets cut short. */
  const hdr = headers.map((h) => ascii(h).toUpperCase());
  const codes = codeColumns(headers, rows);
  const body = rows.map((r) => headers.map((_, ci) => ascii(display(r[ci], codes[ci]))));
  const natural = headers.map((_, ci) => Math.max(34,
    textW(hdr[ci], "F2", FS) + PAD * 2,
    ...body.map((r) => textW(r[ci], "F1", FS) + PAD * 2)));
  const total = natural.reduce((a, b) => a + b, 0);
  /* Compact: portrait when the table fits across it — more rows to a sheet,
     so a normal invoice or day's list is one page — landscape otherwise. */
  const portrait = compact && total <= 595 - M * 2;
  const W = portrait ? 595 : 842, H = portrait ? 842 : 595;   // A4, points
  const usable = W - M * 2;
  let cw: number[];
  if (total <= usable) {
    /* Classic stretched every column to fill the page, which made a
       two-digit quantity column as wide as a product name. Compact keeps
       each column its own width and centres the table instead. */
    cw = compact ? natural.slice() : natural.map((w) => w * (usable / total));
  } else {
    const FLOOR = 90;
    const give = natural.map((w) => Math.max(0, w - FLOOR));
    const giveTotal = give.reduce((a, b) => a + b, 0);
    const excess = total - usable;
    cw = giveTotal >= excess
      ? natural.map((w, ci) => w - give[ci] * (excess / giveTotal))
      : natural.map((w) => w * (usable / total));
  }
  const tableW = cw.reduce((a, b) => a + b, 0);
  const x0 = compact ? M + Math.max(0, (usable - tableW) / 2) : M;
  const x1 = x0 + tableW;
  const edge = cw.reduce<number[]>((acc, w, i) => { acc.push(acc[i] + w); return acc; }, [x0]);

  const top0 = H - M - 30;                    // below the title and the meta line
  const perPage = Math.max(1, Math.floor((top0 - M - HH) / RH));
  const pages: string[][][] = [];
  for (let i = 0; i < body.length; i += perPage) pages.push(body.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const text = (x: number, y: number, font: "F1" | "F2", size: number, s: string) =>
    `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfStr(s)}) Tj ET\n`;
  const put = (v: string, ci: number, rowTop: number, h: number, font: "F1" | "F2") => {
    const s = fit(v, cw[ci] - PAD * 2, font);
    const y = rowTop - h / 2 - FS * 0.35;     // vertically centred in the row
    const x = compact ? edge[ci] + (cw[ci] - textW(s, font, FS)) / 2
            : right[ci] ? edge[ci + 1] - PAD - textW(s, font, FS) : edge[ci] + PAD;
    return text(x, y, font, FS, s);
  };

  const streams = pages.map((pageRows, pi) => {
    const ttl = fit(ascii(title), usable, "F2", 13);
    const meta = ascii(`${new Date().toLocaleString()} - page ${pi + 1} of ${pages.length} - ${rows.length} row(s)`);
    /* Compact: title and meta centred over the table, like the cells. */
    let t = text(compact ? (W - textW(ttl, "F2", 13)) / 2 : M, H - M, "F2", 13, ttl);
    t += text(compact ? (W - textW(meta, "F1", 8)) / 2 : M, H - M - 14, "F1", 8, meta);

    const top = top0;
    const bottom = top - HH - pageRows.length * RH;

    /* Header band first, so its text and the grid sit on top of it. */
    t += `0.88 g ${x0.toFixed(2)} ${(top - HH).toFixed(2)} ${tableW.toFixed(2)} ${HH} re f 0 g\n`;
    hdr.forEach((h, ci) => { t += put(h, ci, top, HH, "F2"); });
    pageRows.forEach((r, ri) => {
      const rowTop = top - HH - ri * RH;
      r.forEach((v, ci) => { t += put(v, ci, rowTop, RH, "F1"); });
    });

    /* The grid: a line under every row and between every column. */
    t += "0.3 G 0.5 w\n";
    for (let ri = 1; ri < pageRows.length; ri++) {
      const y = (top - HH - ri * RH).toFixed(2);
      t += `${x0.toFixed(2)} ${y} m ${x1.toFixed(2)} ${y} l S\n`;
    }
    edge.slice(1, -1).forEach((x) => {
      t += `${x.toFixed(2)} ${top} m ${x.toFixed(2)} ${bottom.toFixed(2)} l S\n`;
    });
    /* Heavier: the box round the table and the line under the header. */
    t += `0.1 G 1 w ${x0.toFixed(2)} ${bottom.toFixed(2)} ${tableW.toFixed(2)} ${(top - bottom).toFixed(2)} re S\n`;
    t += `${x0.toFixed(2)} ${(top - HH).toFixed(2)} m ${x1.toFixed(2)} ${(top - HH).toFixed(2)} l S\n`;
    return t;
  });

  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const first = 3 + pages.length;
  pages.forEach((_, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
      `/Resources << /Font << /F1 ${first + pages.length} 0 R /F2 ${first + pages.length + 1} 0 R >> >> ` +
      `/Contents ${first + i} 0 R >>`);
  });
  streams.forEach((st) => objs.push(`<< /Length ${st.length} >>\nstream\n${st}endstream`));
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  save(new Blob([pdf], { type: "application/pdf" }), slug(title) + ".pdf");
}

/* PRINT — laid out for paper, not for a PDF viewer.
 *
 * Landscape so wide tables are not cut off, a real <thead> so column names
 * repeat on every page, and a row count so nobody wonders if a page went
 * missing. The grid is near-black, not light grey: grey lines that look fine
 * on screen come out faint or not at all on an office printer. The header
 * shading is told to print — browsers drop backgrounds on paper otherwise.
 */
export function printTable(t: ExportTable) {
  if (classic()) { printClassic(t); return; }
  const { title, headers, rows } = t;
  const codes = codeColumns(headers, rows);
  const shown = rows.map((r) => headers.map((_, ci) => display(r[ci], codes[ci])));
  /* A column whose longest entry is long (a product name) may wrap inside its
     cell; every other column stays on one line at its own width. That is
     what keeps the columns from being "too large": none is stretched to fill
     the page, and none is widened by one long name in another. */
  const wraps = headers.map((_, ci) => Math.max(0, ...shown.map((r) => r[ci].length)) > 34);
  const strong = (r: string[]) => /^(sub)?total\b/i.test(r.find((v) => v.trim() !== "") ?? "");
  const td = (v: string, ci: number) =>
    `<td>${wraps[ci] ? `<span class="w">${escapeHtml(v)}</span>` : escapeHtml(v)}</td>`;
  printSheet(title,
    `<div class="head"><h1>${escapeHtml(title)}</h1>` +
    `<p class="meta">${escapeHtml(new Date().toLocaleString())} &middot; ${rows.length} row(s)</p></div>` +
    `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${shown.map((r) => `<tr${strong(r) ? ` class="tot"` : ""}>${r.map(td).join("")}</tr>`).join("")}</tbody></table>`);
}

/* PRINT ONE SHEET — shared by the table print above and the invoice print.
 *
 * The page is laid out at its natural size first, then measured. If it fits
 * on one A4 sheet — portrait or landscape, whichever needs less shrinking —
 * at 60% or more, it is scaled to exactly one sheet. Only when that would
 * make the text too small to read does it run over several pages; then it is
 * fitted to the page WIDTH, so no column is ever cut off the edge, and the
 * column headings repeat on every page.
 * Everything is centred: the title, the table on the page, the text in each
 * cell. The grid is near-black so it survives an office printer.
 */
export function printSheet(title: string, bodyHtml: string) {
  const w = window.open("", "_blank", "width=1000,height=760");
  if (!w) return;   /* pop-up blocked — nothing else to do about it here */
  w.document.write(
    `<html><head><title>${escapeHtml(title)}</title><style>
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
      html,body{margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;color:#111;text-align:center}
      #sheet{display:inline-block;text-align:center;padding:0}
      .head{margin:0 0 8px}
      h1{font-size:15px;margin:0 0 2px}
      .meta{font-size:10px;color:#57534e;margin:0}
      table{border-collapse:collapse;margin:0 auto;font-size:10px;border:1.3px solid #111}
      th,td{border:1px solid #444;padding:3px 8px;text-align:center;vertical-align:middle;white-space:nowrap;line-height:1.3}
      th{background:#e7e5e4;font-size:9px;text-transform:uppercase;letter-spacing:.03em;border-bottom:1.3px solid #111}
      td .w{display:inline-block;max-width:62mm;white-space:normal}
      tr.tot td{font-weight:bold;background:#f5f5f4}
      thead{display:table-header-group}
      tr{break-inside:avoid}
      .box{border:1.3px solid #111;padding:6px 10px;margin:0 auto 8px;display:inline-block}
      .grid{display:grid;grid-template-columns:auto auto auto auto;gap:3px 14px;font-size:10.5px;text-align:left}
      .grid b{font-weight:bold}
      .sign{display:flex;justify-content:space-between;gap:40px;margin-top:34px;font-size:10px}
      .sign span{border-top:1px solid #111;padding-top:3px;min-width:150px;text-align:center}
      .foot{font-size:9px;color:#57534e;margin-top:8px}
    </style></head><body><div id="sheet">${bodyHtml}</div>
    <script>
      (function(){
        var mm=96/25.4, m=8, sheet=document.getElementById('sheet');
        var w=sheet.scrollWidth, h=sheet.scrollHeight;
        var P={w:(210-2*m)*mm,h:(297-2*m)*mm}, L={w:(297-2*m)*mm,h:(210-2*m)*mm};
        var oneP=Math.min(1,P.w/w,P.h/h), oneL=Math.min(1,L.w/w,L.h/h);
        var o, s;
        if (Math.max(oneP,oneL) >= 0.6) { o = oneP >= oneL ? 'portrait' : 'landscape'; s = Math.max(oneP,oneL); }
        else if (w <= P.w) { o='portrait'; s=1; }
        else { o='landscape'; s=Math.min(1,L.w/w); }
        /* Several pages: the wrapper becomes an ordinary block. Measured as an
           inline block it gives the table's true width, but left that way the
           browser stops repeating the column headings on each new page. */
        if (!(Math.max(oneP,oneL) >= 0.6)) sheet.style.display='block';
        var st=document.createElement('style');
        st.textContent='@page{size:A4 '+o+';margin:'+m+'mm}';
        document.head.appendChild(st);
        if (s<1) document.body.style.zoom=s;
        document.body.setAttribute('data-fit', o+' '+s.toFixed(3));
        setTimeout(function(){window.print()},60);
      })();
    </script>
    </body></html>`
  );
  w.document.close();
}

/* The layout as it was, for FS Traders (see `classic` above). */
function printClassic({ title, headers, rows }: ExportTable) {
  const w = window.open("", "_blank", "width=1000,height=760");
  if (!w) return;   /* pop-up blocked — nothing else to do about it here */
  const right = numericColumns(headers, rows);
  const codes = codeColumns(headers, rows);
  const cls = (ci: number) => (right[ci] ? ` class="n"` : "");
  w.document.write(
    `<html><head><title>${escapeHtml(title)}</title><style>
      @page{size:A4 landscape;margin:8mm}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      body{font-family:system-ui,sans-serif;color:#1c1917;margin:0}
      h1{font-size:16px;margin:0 0 2px}
      .meta{font-size:10.5px;color:#57534e;margin:0 0 10px}
      table{border-collapse:collapse;width:100%;font-size:8.5px;border:1.2px solid #1c1917}
      th,td{border:1px solid #57534e;padding:2px 4px;text-align:left;vertical-align:top;line-height:1.25}
      th{background:#e7e5e4;font-size:7.5px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1.2px solid #1c1917}
      td.n,th.n{text-align:right;white-space:nowrap}
      thead{display:table-header-group}
      tr{break-inside:avoid}
      tfoot td{border:0;padding-top:10px;font-size:10px;color:#57534e}
    </style></head><body>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">${new Date().toLocaleString()} &middot; ${rows.length} row(s)</p>
      <table>
        <thead><tr>${headers.map((h, ci) => `<th${cls(ci)}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((v, ci) => `<td${cls(ci)}>${escapeHtml(display(v, codes[ci]))}</td>`).join("")}</tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="${headers.length}">${escapeHtml(title)} &middot; printed ${new Date().toLocaleDateString()}</td></tr></tfoot>
      </table>
      <script>window.onload=()=>{window.print()}</script>
    </body></html>`
  );
  w.document.close();
}

function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + new Date().toISOString().slice(0, 10);
}
function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
