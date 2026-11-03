"use client";
/* Lines shared by LPOs and returns: type them by barcode, or paste the table
   out of an email. Carrefour's stores head their columns differently (QTY,
   PHQTPR; CP, PP, UNIT PRICE, CSTPPR), so columns are found by heading. */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { inp, qty as fmt, rs, useLoad } from "@/components/carrefour/kit";

export type Line = { barcode: string; description: string; qty: string; price: string };
export type Article = { id: string; barcode: string; item_no: string | null; name: string; cp: number | null };

const find = (cells: string[], re: RegExp) => cells.findIndex((c) => re.test(c.trim()));
const num = (s: string) => Number(String(s ?? "").replace(/,/g, "").trim());

export function parsePasted(text: string): { lines: Line[]; skipped: number } {
  const rows = text.split(/\r?\n/).map((r) => r.split("\t")).filter((r) => r.some((c) => c.trim()));
  const h = rows.findIndex((r) => find(r, /barcod|bacd/i) >= 0);
  if (h < 0) return { lines: [], skipped: rows.length };
  const head = rows[h];
  const bc = find(head, /barcod|bacd/i);
  const q = find(head, /^(qty|quantity|phqtpr|order qty)$/i);
  const pr = find(head, /^(cp|pp|unit price|cstppr|price)$/i);
  const d = find(head, /desc|itmdsc|idscpr/i);
  if (q < 0) return { lines: [], skipped: rows.length };
  const lines: Line[] = []; let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const code = (r[bc] ?? "").replace(/\s/g, "");
    const n = num(r[q]);
    if (!/^\d{6,}$/.test(code) || !(n > 0)) { skipped++; continue; }
    lines.push({ barcode: code, description: d >= 0 ? (r[d] ?? "").trim() : "", qty: String(n), price: pr >= 0 && num(r[pr]) >= 0 ? String(num(r[pr])) : "" });
  }
  return { lines, skipped };
}

export const lineTotals = (ls: Line[]) => ({
  pieces: ls.reduce((a, l) => a + (Number(l.qty) || 0), 0),
  gross: ls.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0),
});

export function useArticles() {
  return useLoad<Article[]>(() => supabase!.from("carrefour_articles").select("id,barcode,item_no,name,cp").order("name").limit(5000));
}

export default function LineEditor({ lines, onChange, articles }: { lines: Line[]; onChange: (l: Line[]) => void; articles: Article[] }) {
  const [paste, setPaste] = useState(false);
  const [msg, setMsg] = useState("");
  const totals = useMemo(() => lineTotals(lines), [lines]);

  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, x) => (x === i ? { ...l, ...patch } : l)));
  function lookup(i: number) {
    const b = lines[i].barcode.replace(/\s/g, "");
    if (!b) return;
    const hits = articles.filter((a) => a.barcode === b);
    const a = hits[0] ?? (() => { const e = articles.filter((x) => x.barcode.endsWith(b)); return e.length === 1 ? e[0] : undefined; })();
    if (a) set(i, { barcode: a.barcode, description: lines[i].description || a.name, price: lines[i].price || (a.cp == null ? "" : String(a.cp)) });
  }
  function onPaste(text: string) {
    const r = parsePasted(text);
    if (!r.lines.length) { setMsg("No lines found. Copy the table with its heading row."); return; }
    onChange([...lines.filter((l) => l.barcode.trim()), ...r.lines]);
    setMsg(`${r.lines.length} lines added${r.skipped ? `, ${r.skipped} skipped` : ""}.`);
    setPaste(false);
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl2 border border-line p-2 sm:grid-cols-[150px_1fr_80px_90px_auto]">
            <input aria-label="Barcode" placeholder="Barcode" value={l.barcode} onChange={(e) => set(i, { barcode: e.target.value })} onBlur={() => lookup(i)} className={`${inp} col-span-3 font-mono sm:col-span-1`} />
            <input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => set(i, { description: e.target.value })} className={`${inp} col-span-3 sm:col-span-1`} />
            <input aria-label="Quantity" placeholder="Qty" type="number" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} className={inp} />
            <input aria-label="Price" placeholder="Price" type="number" inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} className={inp} />
            <button type="button" aria-label="Remove line" onClick={() => onChange(lines.filter((_, x) => x !== i))} className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-[#b42318]"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onChange([...lines, { barcode: "", description: "", qty: "", price: "" }])} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12.5px] font-semibold text-ink"><Plus size={14} /> Add line</button>
        <button type="button" onClick={() => { setMsg(""); setPaste((p) => !p); }} className="rounded-full border border-line px-3 py-2 text-[12.5px] font-semibold text-ink">Paste table</button>
      </div>
      {paste && <textarea autoFocus rows={4} placeholder="Copy the table from the email, with its heading row, and paste here" onPaste={(e) => { e.preventDefault(); onPaste(e.clipboardData.getData("text")); }} className={inp} />}
      {msg && <p className="text-[12px] text-muted">{msg}</p>}
      <p className="text-[13px] font-bold text-ink">Gross: {fmt(totals.pieces)} pcs · {rs(totals.gross)}</p>
    </div>
  );
}
