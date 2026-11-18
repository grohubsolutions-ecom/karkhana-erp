"use client";
import { useEffect } from "react";

/* PHONE TABLES — EVERY TABLE IN KARKHANA BECOMES A STACK OF CARDS ON A PHONE.
 *
 * The factory, warehouse, payments, Carrefour, reports and Administration
 * screens hold ~50 hand-written <table>s. On a 390px phone each one either
 * squeezed five columns into 70px slivers or slid off the right edge inside its
 * own sideways scroller. Rewriting fifty tables one by one is fifty chances to
 * break a figure; this does it once, without touching any of them.
 *
 * WHAT IT DOES
 *   Reads each table's header row and writes the header text onto every cell
 *   below it as `data-label`. kk-mobile.css then, below 768px only, hides the
 *   header row and lays each <tr> out as a card: first cell as the card's
 *   title, every other cell as "Label ........ value". Computer and tablet
 *   widths never see a change — the attributes are inert without the CSS.
 *
 * WHAT IT NEVER DOES
 *   Change a value, reorder anything, or remove a cell. Buttons, inputs and
 *   links inside cells are the same elements, so every click handler still
 *   works. It only adds attributes and classes.
 *
 * A table with no heading row gets `kk-flow` instead: each row wraps its
 * cells onto as many lines as it needs, first cell full width.
 *
 * OPT-OUT
 *   A table (or any ancestor) with `data-keep-table` is left as a table — for a
 *   grid that only makes sense read across, like a month calendar. Tables with
 *   more than 16 columns are treated the same way automatically.
 *
 * It re-runs when the page changes (data arriving, a tab switch, a dialog
 * opening), batched to one pass per animation frame. */

const MAX_COLS = 16;

/* The heading row: the last row of <thead>, or — for tables written without a
   <thead> — a first row made only of <th> cells (marked kk-head so the CSS can
   hide it the same way). */
function headerRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const head = table.tHead;
  if (head && head.rows.length) return head.rows[head.rows.length - 1];
  const first = table.rows[0];
  if (first && first.cells.length > 1 && Array.from(first.cells).every((c) => c.tagName === "TH")) {
    first.classList.add("kk-head");
    return first;
  }
  return null;
}

function headerLabels(table: HTMLTableElement): string[] | null {
  const row = headerRow(table);
  if (!row) return null;
  const labels: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
    for (let i = 0; i < (cell.colSpan || 1); i++) labels.push(text);
  }
  return labels;
}

/* The card's title should be the thing's NAME. Many tables lead with a code
   column ("SUP-0012", "GRN-2026-0041") and put the name second, so a heading
   that says what the row is wins over plain column order — but only within
   the first four columns, so a name buried at the end does not jump up. */
const NAME_HEAD = /(^|\b)(name|company|item|article|employee|worker|staff|person|material|product|supplier|description|party|shop|branch|customer|title)(\b|$)/i;
function titleColumn(labels: string[]): number | null {
  for (let i = 0; i < Math.min(4, labels.length); i++) if (NAME_HEAD.test(labels[i])) return i;
  return null;
}

function hasControl(el: Element) {
  return !!el.querySelector("button, a, input, select, textarea, svg, img");
}

function labelTable(table: HTMLTableElement) {
  if (table.closest("[data-keep-table]")) return;
  const labels = headerLabels(table);
  if (!labels) {
    // No heading row at all — usually a short list (name · count · button).
    // Nothing to label with, so the row just wraps onto lines instead of
    // running off the right edge.
    const first = table.rows[0];
    if (first && first.cells.length > 1 && first.cells.length <= MAX_COLS) table.classList.add("kk-flow");
    return;
  }
  if (labels.length < 2 || labels.length > MAX_COLS) return;
  table.classList.add("kk-cards");
  const preferred = titleColumn(labels);

  const bodies = [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])];
  for (const body of bodies) {
    for (const row of Array.from(body.rows)) {
      if (row.classList.contains("kk-head")) continue;
      const cells = Array.from(row.cells);
      // "No records" / section-heading rows span the whole table: show them
      // as one full-width line, not as a card with one labelled value.
      if (cells.length === 1 && (cells[0].colSpan || 1) > 1) {
        row.classList.add("kk-full");
        continue;
      }
      row.classList.remove("kk-full");
      // Which cell is the title: the name column if this row has text there,
      // otherwise the first cell with text.
      let col = 0;
      let titleCell: HTMLTableCellElement | null = null;
      for (const cell of cells) {
        if (preferred !== null && col === preferred && (cell.textContent || "").trim()) titleCell = cell;
        col += cell.colSpan || 1;
      }
      if (!titleCell) titleCell = cells.find((c) => (c.textContent || "").trim()) ?? null;
      col = 0;
      for (const cell of cells) {
        const label = labels[col] ?? "";
        col += cell.colSpan || 1;
        const text = (cell.textContent || "").trim();
        const control = hasControl(cell);
        const empty = !text && !control;
        cell.classList.toggle("kk-empty", empty);
        if (cell === titleCell) {
          cell.setAttribute("data-kk-title", "");
          cell.removeAttribute("data-label");
          continue;
        }
        cell.removeAttribute("data-kk-title");
        if (label) {
          if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
          cell.removeAttribute("data-kk-actions");
        } else {
          cell.removeAttribute("data-label");
          // A column with no heading is almost always the row's buttons.
          if (control) cell.setAttribute("data-kk-actions", "");
          else cell.removeAttribute("data-kk-actions");
        }
      }
    }
  }
}

export default function PhoneTables() {
  useEffect(() => {
    let frame = 0;
    const run = () => {
      frame = 0;
      document.querySelectorAll<HTMLTableElement>("table").forEach(labelTable);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    run();
    const obs = new MutationObserver((records) => {
      // Our own attribute writes must not wake us up again.
      if (records.every((r) => r.type === "attributes")) return;
      schedule();
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return null;
}
