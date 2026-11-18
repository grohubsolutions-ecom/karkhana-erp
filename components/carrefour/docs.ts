import { supabase } from "@/lib/supabase";
import { printSheet } from "@/lib/export";

const esc = (s: unknown) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const n = (v: unknown) => Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });

/* Files are stored under a random name: a person's file name is not a safe path. */
export async function uploadDoc(file: File, folder: string) {
  const ext = (file.name.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase!.storage.from("carrefour-docs").upload(path, file, { contentType: file.type || undefined });
  if (error) throw new Error(error.message);
  return { path, name: file.name };
}

export async function openDoc(path: string) {
  /* Opened first: a popup opened after an await is blocked on a phone. */
  const win = window.open("", "_blank");
  const { data, error } = await supabase!.storage.from("carrefour-docs").createSignedUrl(path, 300);
  if (error || !data) { win?.close(); throw new Error(error?.message ?? "Could not open the file."); }
  if (win) win.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}

type Inv = { lpo_no: string; shop: string; invoice_no: string | null; invoice_date: string | null; delivery_date: string | null;
  lines: { barcode: string; description: string | null; qty: number; price: number }[] };

export function printCarrefourInvoice(o: Inv) {
  const pcs = o.lines.reduce((a, l) => a + Number(l.qty), 0);
  const amt = o.lines.reduce((a, l) => a + Number(l.qty) * Number(l.price), 0);
  printSheet(`Invoice ${o.invoice_no ?? ""}`,
    `<div class="head"><h1>Invoice ${esc(o.invoice_no)}</h1><p class="meta">F.S Traders &middot; Supplier # 45142</p></div>` +
    `<div class="box"><div class="grid"><span>To</span><b>Carrefour &middot; ${esc(o.shop)}</b><span>LPO no</span><b>${esc(o.lpo_no)}</b>` +
    `<span>Invoice date</span><b>${esc(o.invoice_date)}</b><span>Delivery date</span><b>${esc(o.delivery_date)}</b>` +
    `<span>Items / pieces</span><b>${o.lines.length} / ${esc(n(pcs))}</b><span>Amount</span><b>Rs ${esc(n(amt))}</b></div></div>` +
    `<table><thead><tr><th>#</th><th>Barcode</th><th>Item description</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>` +
    o.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.barcode)}</td><td>${esc(l.description)}</td><td>${esc(n(l.qty))}</td><td>${esc(n(l.price))}</td><td>${esc(n(Number(l.qty) * Number(l.price)))}</td></tr>`).join("") +
    `<tr><td colspan="3"><b>Total</b></td><td><b>${esc(n(pcs))}</b></td><td></td><td><b>${esc(n(amt))}</b></td></tr></tbody></table>`);
}
