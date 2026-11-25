/* DARAZ SELLER CENTER EXPORTS → ROWS FOR THE DATABASE.
 *
 * Daraz's Open API is paid, so Daraz reaches the Hub as two uploaded files:
 *
 *   ORDERS     Seller Center → Orders → Manage Orders → (All) → Export
 *              One row per ORDER ITEM. Keyed on "Order Item Id".
 *   STATEMENT  Seller Center → Finance → Account Statements → Transaction
 *              Overview / Statement → Export. One row per fee or credit.
 *
 * Headers are matched by meaning, not by position, and loosely (case, spaces
 * and punctuation ignored), because Daraz renames and reorders columns between
 * export versions. Every original column is also kept in `raw`, so nothing in
 * the file is lost even if a column is not mapped today. */

export type DarazKind = "orders" | "statement";

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* field → header spellings seen in Daraz / Lazada exports */
const ORDER_COLS: Record<string, string[]> = {
  order_item_id: ["Order Item Id", "Order Item No", "Order Item No.", "OrderItemId", "Order Item ID"],
  order_number: ["Order Number", "Order No", "Order No.", "Order ID", "Order Id", "OrderNumber"],
  created_at_dz: ["Created at", "Created At", "Order Date", "Create Time", "Order Created"],
  updated_at_dz: ["Updated at", "Updated At", "Update Time", "Last Updated"],
  seller_sku: ["Seller SKU", "SellerSku", "Seller Sku"],
  shop_sku: ["Lazada SKU", "Daraz SKU", "Shop SKU", "ShopSku", "Lazada Id"],
  item_name: ["Item Name", "Product Name", "Name"],
  variation: ["Variation", "Variant"],
  unit_price: ["Unit Price", "Item Price", "Price"],
  paid_price: ["Paid Price", "Paid Amount", "Item Paid Price"],
  seller_discount: ["Seller Discount Total", "Seller Discount", "Seller Voucher"],
  shipping_fee: ["Shipping Fee", "Shipping Fee Paid By Customer"],
  customer_name: ["Customer Name", "Shipping Name", "Buyer Name", "Customer First Name"],
  phone: ["Shipping Phone", "Shipping Phone Number", "Phone", "Customer Phone", "Billing Phone"],
  city: ["Shipping City", "City", "Shipping Address3", "Shipping Region"],
  address: ["Shipping Address", "Address", "Shipping Address1"],
  payment_method: ["Payment Method", "Payment Type"],
  shipping_provider: ["Shipping Provider", "CD Shipping Provider", "Delivery Partner"],
  tracking_code: ["Tracking Code", "CD Tracking Code", "Tracking Number", "Tracking No"],
  status: ["Status", "Order Status", "Item Status", "Order Item Status"],
  reason: ["Buyer Failed Delivery Reason", "Buyer Cancellation Reason", "Cancel Reason", "Return Reason", "Reason"],
};

const STATEMENT_COLS: Record<string, string[]> = {
  txn_date: ["Transaction Date", "Date", "Created Date", "Release Date"],
  txn_type: ["Transaction Type", "Type"],
  fee_name: ["Fee Name", "Fee Type", "Fee", "Transaction Name"],
  txn_number: ["Transaction Number", "Transaction No", "Transaction No.", "Transaction ID"],
  details: ["Details", "Description"],
  seller_sku: ["Seller SKU", "SellerSku"],
  amount: ["Amount", "Amount (PKR)", "Amount(PKR)", "Amount (Rs)", "Amount Incl VAT"],
  vat: ["VAT in Amount", "VAT", "VAT Amount"],
  wht: ["WHT Amount", "WHT", "Withholding Tax"],
  statement: ["Statement", "Statement Period", "Statement Number", "Statement Name"],
  paid_status: ["Paid Status", "Payment Status", "Paid", "Release Status"],
  order_number: ["Order No.", "Order No", "Order Number", "Order ID"],
  order_item_id: ["Order Item No.", "Order Item No", "Order Item Id", "Order Item ID"],
  item_status: ["Order Item Status", "Item Status"],
  reference: ["Reference", "Comment", "PaymentRefId", "Payment Ref Id"],
};

function mapHeader(header: string[], cols: Record<string, string[]>) {
  const idx: Record<string, number> = {};
  const hk = header.map(key);
  for (const [field, names] of Object.entries(cols)) {
    for (const n of names) {
      const i = hk.indexOf(key(n));
      if (i >= 0 && !Object.values(idx).includes(i)) { idx[field] = i; break; }
    }
  }
  return idx;
}

/* Which file is it, and where is the header row? A statement has a fee name
   and an amount; an orders file has order + status + item columns. */
export function detect(grid: string[][]): { kind: DarazKind; headerRow: number } | null {
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const h = grid[r] ?? [];
    const s = mapHeader(h, STATEMENT_COLS);
    if ((s.fee_name !== undefined || s.txn_type !== undefined) && s.amount !== undefined) return { kind: "statement", headerRow: r };
    const o = mapHeader(h, ORDER_COLS);
    if (o.order_number !== undefined && o.status !== undefined && (o.item_name !== undefined || o.seller_sku !== undefined || o.order_item_id !== undefined))
      return { kind: "orders", headerRow: r };
  }
  return null;
}

/* "Rs 1,250.00", "(120)", "-1,250", "1.250,00"? — Daraz PK uses 1,250.00. */
export function money(v: unknown): number {
  let s = String(v ?? "").trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^(rs\.?|pkr)\s*/i, ""));
  s = s.replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n: number) => String(n).padStart(2, "0");

/* Any Daraz date → "YYYY-MM-DDTHH:mm:00+05:00" (Pakistan time). Returns null
   if it cannot be read rather than guessing. Day-first is assumed for 05/06/26
   style dates, as in Pakistan, unless the numbers make that impossible. */
export function pkDateTime(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let y = 0, m = 0, d = 0;
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let hh = t ? Number(t[1]) : 0; const mm = t ? Number(t[2]) : 0;
  if (t?.[4]) { const pm = t[4].toLowerCase() === "pm"; if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  let a: RegExpMatchArray | null;
  if ((a = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +a[1]; m = +a[2]; d = +a[3]; }
  else if ((a = s.match(/(\d{1,2})[\s\-/]([A-Za-z]{3})[A-Za-z]*[\s\-/,]+(\d{2,4})/))) { d = +a[1]; m = MONTHS[a[2].toLowerCase()] ?? 0; y = +a[3]; }
  else if ((a = s.match(/([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})/))) { m = MONTHS[a[1].toLowerCase()] ?? 0; d = +a[2]; y = +a[3]; }
  else if ((a = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    const x = +a[1], z = +a[2]; y = +a[3];
    if (x > 12) { d = x; m = z; } else if (z > 12) { m = x; d = z; } else { d = x; m = z; }
  } else if (/^\d{5}(\.\d+)?$/.test(s)) {           // Excel serial
    const ms = Math.round((Number(s) - 25569) * 86400000);
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}T${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:00+05:00`;
  }
  if (y && y < 100) y += 2000;
  if (!y || !m || !d || m > 12 || d > 31) return null;
  return `${y}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:00+05:00`;
}
const pkDate = (v: unknown) => pkDateTime(v)?.slice(0, 10) ?? null;

async function sha1(text: string) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ParsedFile = {
  kind: DarazKind;
  rows: Record<string, unknown>[];
  mapped: string[];          // fields found
  missing: string[];         // important fields not found
  preview: { label: string; value: string }[];
};

const IMPORTANT: Record<DarazKind, string[]> = {
  orders: ["order_item_id", "order_number", "created_at_dz", "paid_price", "status", "seller_sku"],
  statement: ["txn_date", "fee_name", "amount", "order_number", "paid_status", "statement"],
};

export async function parseDaraz(grid: string[][]): Promise<ParsedFile | null> {
  const found = detect(grid);
  if (!found) return null;
  const { kind, headerRow } = found;
  const header = grid[headerRow];
  const idx = mapHeader(header, kind === "orders" ? ORDER_COLS : STATEMENT_COLS);
  const get = (r: string[], f: string) => (idx[f] === undefined ? "" : String(r[idx[f]] ?? "").trim());
  const body = grid.slice(headerRow + 1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const seen = new Map<string, number>();
  const rows: Record<string, unknown>[] = [];

  for (const r of body) {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { if (h) raw[h] = String(r[i] ?? ""); });
    if (kind === "orders") {
      const order_number = get(r, "order_number").replace(/^#/, "");
      if (!order_number || /^total/i.test(order_number)) continue;
      let id = get(r, "order_item_id");
      if (!id) {
        const base = `${order_number}|${get(r, "seller_sku") || get(r, "item_name")}`;
        const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
        id = `${base}#${n}`;
      }
      rows.push({
        order_item_id: id, order_number,
        created_at_dz: pkDateTime(get(r, "created_at_dz")), updated_at_dz: pkDateTime(get(r, "updated_at_dz")),
        seller_sku: get(r, "seller_sku") || null, shop_sku: get(r, "shop_sku") || null,
        item_name: get(r, "item_name") || null, variation: get(r, "variation") || null,
        unit_price: money(get(r, "unit_price")), paid_price: money(get(r, "paid_price") || get(r, "unit_price")),
        seller_discount: Math.abs(money(get(r, "seller_discount"))), shipping_fee: money(get(r, "shipping_fee")),
        customer_name: get(r, "customer_name") || null, phone: get(r, "phone") || null,
        city: get(r, "city") || null, address: get(r, "address") || null,
        payment_method: get(r, "payment_method") || null, shipping_provider: get(r, "shipping_provider") || null,
        tracking_code: get(r, "tracking_code") || null, status: get(r, "status") || null,
        reason: get(r, "reason") || null, raw,
      });
    } else {
      const amountTxt = get(r, "amount");
      if (!amountTxt && !get(r, "fee_name")) continue;
      const parts = ["txn_date", "txn_type", "fee_name", "txn_number", "order_number", "order_item_id", "seller_sku", "amount", "details", "reference"]
        .map((f) => (f === "txn_date" ? pkDate(get(r, f)) ?? get(r, f) : f === "amount" ? String(money(amountTxt)) : get(r, f)));
      const base = parts.join("|");
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      rows.push({
        line_key: await sha1(`${base}#${n}`),
        txn_date: pkDate(get(r, "txn_date")), txn_type: get(r, "txn_type") || null,
        fee_name: get(r, "fee_name") || null, txn_number: get(r, "txn_number") || null,
        details: get(r, "details") || null, seller_sku: get(r, "seller_sku") || null,
        amount: money(amountTxt), vat: get(r, "vat") ? money(get(r, "vat")) : null,
        wht: get(r, "wht") ? money(get(r, "wht")) : null,
        statement: get(r, "statement") || null, paid_status: get(r, "paid_status") || null,
        order_number: get(r, "order_number").replace(/^#/, "") || null, order_item_id: get(r, "order_item_id") || null,
        item_status: get(r, "item_status") || null, reference: get(r, "reference") || null, raw,
      });
    }
  }

  const rs = (n: number) => "Rs " + Math.round(n).toLocaleString("en-PK");
  const dates = rows.map((x) => String((kind === "orders" ? x.created_at_dz : x.txn_date) ?? "").slice(0, 10)).filter(Boolean).sort();
  const span = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "no dates read";
  const preview = kind === "orders"
    ? [
        { label: "Item rows", value: rows.length.toLocaleString() },
        { label: "Orders", value: new Set(rows.map((x) => x.order_number)).size.toLocaleString() },
        { label: "Order dates", value: span },
        { label: "Paid value", value: rs(rows.reduce((t, x) => t + Number(x.paid_price || 0), 0)) },
      ]
    : [
        { label: "Statement lines", value: rows.length.toLocaleString() },
        { label: "Orders referenced", value: new Set(rows.map((x) => x.order_number).filter(Boolean)).size.toLocaleString() },
        { label: "Transaction dates", value: span },
        { label: "Net amount", value: rs(rows.reduce((t, x) => t + Number(x.amount || 0), 0)) },
      ];

  return {
    kind, rows, preview,
    mapped: Object.keys(idx),
    missing: IMPORTANT[kind].filter((f) => idx[f] === undefined),
  };
}

/* Daraz order status → the colour the Hub uses for it. */
export function groupClass(g: string) {
  switch (g) {
    case "Delivered": return "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success";
    case "Shipped": return "bg-periwinkle-soft text-periwinkle-strong dark:bg-white/[0.08] dark:text-periwinkle";
    case "Cancelled": return "bg-danger-soft text-danger dark:bg-white/[0.08] dark:text-danger";
    case "Returned": return "bg-salmon-soft text-red-800 dark:bg-white/[0.08] dark:text-danger";
    default: return "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber";
  }
}
export function settleClass(s: string) {
  if (s === "Paid") return "bg-success-soft text-success dark:bg-white/[0.08] dark:text-success";
  if (s === "Part paid" || s.startsWith("In statement")) return "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber";
  return "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]";
}
