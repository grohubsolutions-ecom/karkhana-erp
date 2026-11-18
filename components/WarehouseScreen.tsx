"use client";
/* FINAL INVENTORY — a section that stands alone.
 *
 * Its own items, its own stock, its own in/out ledger (K138). It reads and
 * writes nothing else: not material_items, not stock_ledger, not Hub, not
 * FS Traders. One man can be given khana.view / khana.manage and he sees
 * this and nothing more.
 *
 * Barcode first, because that is how it will actually be used: scan into
 * the box, the item resolves, type the quantity, done. A scanner types the
 * code then presses Enter — so Enter is the trigger everywhere.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";

import { Boxes, Plus, Loader2, Download, Undo2, Pencil, Trash2, ArrowDownToLine, ArrowUpFromLine , Printer, BookOpen, ChevronDown } from "lucide-react";
import Topbar from "@/components/Topbar";
import ItemHistory from "@/components/ItemHistory";
import Modal, { Field } from "@/components/Modal";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { stampAt, timeNow } from "@/lib/whenStamp";
import { exportCSV, exportExcel, exportPDF, type ExportTable, printTable } from "@/lib/export";
import InvoiceBook, { MissingInvoices, scopeKey, type RegRow } from "@/components/warehouse/InvoiceBook";

type Item = { item_id: string; barcode: string; name: string; description: string | null;
              raw_material_reference: string | null; category: string | null; is_active: boolean;
              quantity: number; last_updated: string | null };
type Move = { id: string; movement_no: string | null; movement_type: "IN" | "OUT";
              quantity: number; note: string | null; created_at: string;
              voided_at: string | null; void_reason: string | null;
              invoice_no: string | null; party: string | null; branch: string | null;
              delivery_no: number | null; branch_id: string | null; party_id: string | null;
              invoice_gap_reason: string | null;
              original_quantity: number | null; edited_at: string | null;
              barcode: string; name: string;
              /* Already in v_khana_movements (K174) — the printed barcode and
                 the money, used by the New GRN list, filters and totals. */
              manual_code: string | null; cost_total: number | null; retail_total: number | null };
/* sequence_mode: whose invoice numbers run in one line — the whole party
   (Carrefour: per_party) or each branch on its own (TopShop: per_branch). */
type Party = { id: string; name: string; sequence_mode?: string };
/* How many recent movements the lists hold. When a list reaches it, the
   screen says so — an older entry missing from a filter would otherwise look
   like it never happened. Each product's own history has no such cap. */
const LIST_CAP = 1000;
type Branch = { id: string; party_id: string; party: string; branch: string; deliveries: number };
type Tab = "materials" | "stock" | "in" | "out";

const inp = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink/30";
/* Section 41 is Kids whatever the category text says — the code is the
   authority, the label is for reading. */
const SECTION_NAME: Record<string, string> = {
  "40": "Baby/Newborn", "41": "Kids", "42": "Child", "43": "Ladies",
  "44": "Men", "60": "Shoes", "61": "Accessories", zz: "Uncoded",
};
const SECTION_OF: Record<string, string> = {
  "Baby/Newborn": "40", Kids: "41", Child: "42", Ladies: "43",
  Men: "44", Shoes: "60", Accessories: "61",
};

const n = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
const rs = (v: number) => "Rs " + Math.round(Number(v) || 0).toLocaleString();
const when = (v: string) => new Date(v).toLocaleString();

function WarehouseInner({ section }: { section: Tab }) {
  const { can } = usePermissions();
  const canManage = can(["khana.manage"]);
  /* K178: what a person may RECORD is separate from full control. A
     warehouse operator brings stock in, sends it out and returns it — he does
     not add products, edit, rename, void or delete. The database refuses all
     of that on its own; these only keep the screen from offering it. */
  const canIn = can(["khana.manage", "khana.stock.in"]);
  const canOut = can(["khana.manage", "khana.stock.out"]);
  const canAdd = can(["khana.manage", "khana.products.add"]);

  /* Fixed by the route, not chosen on screen. Each warehouse job is its own
     page now, so opening Stock shows stock and nothing else — no tab bar
     offering three other screens you did not ask for. */
  const [tab] = useState<Tab>(section);
  const [items, setItems] = useState<Item[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [q, setQ] = useState("");
  /* 041 Kids · 042 Child · 043 Ladies · 044 Men — the codes on the printed
     sheets. Filtering by name is what people actually think in. */
  const [cat, setCat] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  /* add an item */
  const [itemOpen, setItemOpen] = useState(false);
  const [bc, setBc] = useState("");
  const [nm, setNm] = useState("");
  const [desc, setDesc] = useState("");
  const [rawRef, setRawRef] = useState("");
  const [busy, setBusy] = useState(false);

  /* record a movement */
  const [scan, setScan] = useState("");
  const scanBox = useRef<HTMLInputElement | null>(null);
  const [found, setFound] = useState<Item | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [mErr, setMErr] = useState("");
  /* OUT must say where it went — the party is required, the branch optional
     (some parties have none), and the invoice number is theirs, as given. */
  const [parties, setParties] = useState<Party[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [partyId, setPartyId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [invNo, setInvNo] = useState("");
  const [gapWhy, setGapWhy] = useState("");
  const [onDate, setOnDate] = useState("");
  /* The clock time that goes with a picked date (K180). Entries used to be
     stamped 12:00 noon whenever a date was chosen — a time nobody set and
     nothing happened at. It fills itself with the time now and can be
     changed to the time the goods actually moved. */
  const [onTime, setOnTime] = useState("");
  /* A basket. One invoice usually carries several items, and a form that
     clears after each line makes that impossible to enter. */
  /* Pick specific invoices to print. Without this, printing one delivery
     note means printing the whole day. */
  const [invFilter, setInvFilter] = useState("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickOpen, setPickOpen] = useState(false);
  /* EVERY LINE CARRIES ITS OWN NOTE. There used to be one note box for the
     whole basket, and Record wrote it onto every line — a GRN of three items
     with 30, 12 and 6 B pair came out as "30 B pair" three times. Now the
     note is taken onto the line when the line is added. `key` because the
     same item can now sit on two lines: 168 good and 32 B pair of one shirt
     are two lines, not one line of 200. */
  const [basket, setBasket] = useState<{ key: number; item_id: string; barcode: string;
    name: string; qty: number; note: string }[]>([]);
  const lineSeq = useRef(0);
  const [pOpen, setPOpen] = useState(false);
  const [pName, setPName] = useState("");
  const [pParty, setPParty] = useState("");
  /* No window.prompt / window.confirm anywhere. A browser dialog cannot be
     styled, cannot be cancelled with Escape reliably on every platform, and
     looks like a phishing box. Renaming and confirming happen in the row. */
  const [editRow, setEditRow] = useState<{ id: string; branch: boolean } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [killRow, setKillRow] = useState<string | null>(null);
  const [voidRow, setVoidRow] = useState<string | null>(null);
  const [voidWhy, setVoidWhy] = useState("");
  /* Editing a movement moves stock by the DIFFERENCE (K143) — the database
     does that arithmetic, never the screen. K182 opens it as a proper form:
     the product, the quantity, the day and time, the note — and on the out
     side the branch and invoice number too. Moving a line onto a different
     product is not a difference, so the database takes the whole original
     off the one it was on and puts the whole new quantity on the other. */
  const [editMv, setEditMv] = useState<Move | null>(null);
  const [eItem, setEItem] = useState("");
  const [eQty, setEQty] = useState("");
  const [eDate, setEDate] = useState("");
  const [eTime, setETime] = useState("");
  const [eInv, setEInv] = useState("");
  const [eBranch, setEBranch] = useState("");
  const [eNote, setENote] = useState("");
  const [eBusy, setEBusy] = useState(false);
  const [eErr, setEErr] = useState("");
  /* Voided rows stay out of the way by default — they are corrections, not
     work. The toggle keeps them one click away rather than gone. */
  const [showVoided, setShowVoided] = useState(false);
  const [delRow, setDelRow] = useState<string | null>(null);
  /* Quick ranges for the common questions — what moved today, this week —
     and two date boxes for anything else. Same day in both means that one
     day. Stock filters on when an item last moved, which is the only date
     a holding has. */
  const [days, setDays] = useState<number | null>(null);
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  /* Out is read by WHO it went to; In is read by WHAT came in. Different
     questions, so different dropdowns rather than one generic filter that
     answers neither well. */
  const [fParty, setFParty] = useState("");
  const [fBranch, setFBranch] = useState("");
  const [fItem, setFItem] = useState("");
  const [fCat, setFCat] = useState("");
  /* New GRN: filter by what the entry was — "opening stock", "B-pair", from
     the factory… grouped regardless of capitals, since B-pair has been typed
     three different ways. */
  const [fNote, setFNote] = useState("");
  /* Products: the product whose stock history is open. */
  const [histItem, setHistItem] = useState<Item | null>(null);
  /* Editing an item is a plain update; correcting stock is not — it writes a
     movement (K146), so the total never stops matching its own history. */
  const [editItem, setEditItem] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  /* Prices live on the ARTICLE, joined by barcode — so editing them here has
     to write to both records or the screen and the report disagree. */
  const [eManual, setEManual] = useState("");
  const [eCost, setECost] = useState("");
  const [eRetail, setERetail] = useState("");
  const [eGst, setEGst] = useState("");
  const [eBar, setEBar] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [eItemCat, setEItemCat] = useState("");
  const [stockRow, setStockRow] = useState<string | null>(null);
  const [sQty, setSQty] = useState("");
  const [sWhy, setSWhy] = useState("");

  /* K183: the printed barcode, cost, retail and GST are the WAREHOUSE'S OWN.
     They used to be read out of the factory's articles table by matching on
     the code, so deleting an article blanked them here — which is exactly
     what happened on 28 Sept. A transfer from the factory still copies them
     across once, when it creates the product; after that they are ours. */
  const [money, setMoney] = useState<Record<string, {
    cost: number | null; retail: number | null; gst: number | null;
    manual: string | null }>>({});
  /* Reloaded after every product save, not just when the page opens. It used
     to load once, so a saved barcode or price went on showing the old value
     until the page was refreshed — which looks exactly like a save that did
     not work. */
  const loadMoney = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase!.from("v_warehouse_report")
      .select("system_code,manual_code,cost_price,retail_price,gst_rate");
    const m: Record<string, { cost: number | null; retail: number | null;
      gst: number | null; manual: string | null }> = {};
    ((data as unknown as Record<string, unknown>[]) ?? []).forEach((r) => {
      m[String(r.system_code)] = {
        cost: r.cost_price == null ? null : Number(r.cost_price),
        retail: r.retail_price == null ? null : Number(r.retail_price),
        gst: r.gst_rate == null ? null : Number(r.gst_rate),
        manual: (r.manual_code as string) ?? null,
      };
    });
    setMoney(m);
  }, []);
  useEffect(() => { loadMoney(); }, [loadMoney]);

  /* Matches on our code, their barcode, or any part of the name. Ten is
     enough to choose from without becoming a second list to scroll. */
  const suggestions = useMemo(() => {
    const t = scan.trim().toLowerCase();
    if (!t) return [];
    return items.filter((x) =>
      x.barcode.toLowerCase().includes(t) ||
      x.name.toLowerCase().includes(t) ||
      String(money[x.barcode]?.manual ?? "").toLowerCase().includes(t)
    ).slice(0, 10);
  }, [scan, items, money]);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const [i, m, pa, br] = await Promise.all([
      supabase.from("v_khana_stock").select("*").order("name"),
      supabase.from("v_khana_movements").select("*").order("created_at", { ascending: false }).limit(LIST_CAP),
      supabase.from("khana_parties").select("id,name,sequence_mode").eq("is_active", true).order("name"),
      supabase.from("v_khana_branches").select("id,party_id,party,branch,deliveries").eq("is_active", true).order("branch"),
    ]);
    setParties((pa.data as Party[]) ?? []);
    setBranches((br.data as Branch[]) ?? []);
    if (i.error || m.error) setErr((i.error || m.error)!.message);
    setItems((i.data as Item[]) ?? []);
    setMoves((m.data as Move[]) ?? []);
    setLoading(false);
    loadRegister();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPickOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  /* THE INVOICE BOOK (K179): every invoice number of every party, in order,
     with the missing ones. Asked of the database, not worked out from the
     movement list — that list is capped, the sequence must not be. */
  const [register, setRegister] = useState<RegRow[]>([]);
  const [regErr, setRegErr] = useState("");
  const loadRegister = useCallback(async () => {
    if (!supabase || section !== "out") return;
    const { data, error } = await supabase.rpc("khana_invoice_register");
    if (error) {
      setRegErr(/function .* does not exist|could not find the function/i.test(error.message)
        ? "The invoice book needs the K179 database update. Run K179_invoice_book.sql in Supabase, then refresh."
        : error.message);
      return;
    }
    setRegErr("");
    setRegister((data as RegRow[]) ?? []);
  }, [section]);
  const [bookOpen, setBookOpen] = useState(false);
  const [bookFocus, setBookFocus] = useState<{ scope: string; invoice?: string } | null>(null);
  const [missOpen, setMissOpen] = useState(false);
  const missingCount = register.filter((r) => r.status === "missing").length;
  /* The pop-up opens by itself when the sequence has holes nobody has
     explained — once per sitting for the same holes; a new hole brings it
     back. */
  const missingKeys = register.filter((r) => r.status === "missing").map((r) => `${scopeKey(r)}:${r.invoice_no}`);
  const readSeen = () => {
    try { return new Set((sessionStorage.getItem("kk-missing-invoices") ?? "").split(",").filter(Boolean)); }
    catch { return new Set<string>(); }   /* private window: it just asks again */
  };
  useEffect(() => {
    if (section !== "out" || missingKeys.length === 0) return;
    const seen = readSeen();
    /* Only a hole not already put off this sitting brings it back. */
    if (missingKeys.some((k) => !seen.has(k))) setMissOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, section]);
  function closeMissing() {
    const seen = readSeen();
    missingKeys.forEach((k) => seen.add(k));
    try { sessionStorage.setItem("kk-missing-invoices", [...seen].join(",")); } catch { /* private window */ }
    setMissOpen(false);
  }
  const openBook = (focus: { scope: string; invoice?: string } | null) => { setBookFocus(focus); setBookOpen(true); };

  const inRange = (iso: string | null) => {
    if (!iso) return !days && !dFrom && !dTo;   // never moved: only in "All time"
    /* Local day, not the UTC one — see ItemHistory: a 1 AM entry in Karachi
       is still the previous day in UTC. */
    const day = new Date(iso).toLocaleDateString("en-CA");
    if (dFrom && day < dFrom) return false;
    if (dTo && day > dTo) return false;
    return true;
  };
  const hit = (...v: (string | null)[]) =>
    !q.trim() || v.some((x) => String(x ?? "").toLowerCase().includes(q.trim().toLowerCase()));
  const invoices = useMemo(() => {
    const set = new Set<string>();
    moves.forEach((m) => { if (m.invoice_no) set.add(m.invoice_no); });
    return [...set].sort().reverse();
  }, [moves]);

  const fItems = useMemo(() => {
    const list = items.filter((i) => (!cat || i.category === cat)
      /* The manual barcode lives on the article, not on this record — which is
         why searching the last digits of a printed label found nothing. */
      && hit(i.barcode, i.name, i.category, i.raw_material_reference,
             money[i.barcode]?.manual ?? null)
      && (tab === "materials" || inRange(i.last_updated)));
    /* Highest quantity first, everywhere. The question this screen answers is
       "what do we have" — so what there is most of belongs at the top, and
       the long tail of zeros belongs at the bottom. Ties fall back to name so
       the order is stable between loads. */
    return [...list].sort((a, b) =>
      Number(b.quantity) - Number(a.quantity) || a.name.localeCompare(b.name));
  }, [items, q, cat, tab, days, dFrom, dTo, money]);
  /* The last invoice this branch was given, and what should follow it.
     Purely numeric numbers get a suggestion; anything else is left alone
     rather than guessed at. */
  /* The highest invoice number this branch has been given.

     Not the newest row — that was the old bug. Rows arrive ordered by date,
     and since invoices can be backdated, the newest date is no longer the
     latest invoice: enter 12620 today but stamp it the 17th, and a 12619
     stamped the 18th sorts above it. The screen then offered 12620 again,
     for a number already used.

     The sequence is the invoice number itself, so that is what gets compared,
     as a number rather than as text — otherwise "9999" beats "12620". Refs
     that are not plain numbers cannot be compared that way, so for those the
     newest row is still the best guess available. */
  const topOf = (rows: { invoice_no: string | null }[]) => {
    const nums = rows.map((r) => r.invoice_no).filter((v): v is string => !!v && /^\d+$/.test(v));
    if (nums.length) return nums.reduce((hi, v) => (BigInt(v) > BigInt(hi) ? v : hi));
    return rows.find((r) => r.invoice_no)?.invoice_no ?? null;
  };
  /* WHOSE SEQUENCE. Carrefour numbers its invoices across all its branches,
     so its next number is the highest given to ANY Carrefour branch — asking
     per branch offered GUGRANWALA 12619 when Islamabad WTC already had it.
     TopShop and Online number each branch on its own. */
  const perParty = parties.find((p) => p.id === partyId)?.sequence_mode === "per_party";
  const inScope = (m: { party_id: string | null; branch_id: string | null }) =>
    m.party_id === partyId && (perParty || (branchId ? m.branch_id === branchId : !m.branch_id));
  const localInvoice = useMemo(() => topOf(
    moves.filter((m) => m.movement_type === "OUT" && !m.voided_at && m.invoice_no && inScope(m))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [moves, partyId, branchId, perParty]);

  /* The movement list is capped, so on a busy branch the highest invoice can
     fall off the end of it and never be seen here. One narrow query per
     branch asks the database directly. If it fails for any reason the list
     still answers — a suggestion is a convenience, never a blocker. */
  const [branchTop, setBranchTop] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    if (!supabase || !partyId) { setBranchTop(null); return; }
    (async () => {
      let qy = supabase.from("v_khana_movements").select("invoice_no")
        .eq("movement_type", "OUT").eq("party_id", partyId)
        .is("voided_at", null).not("invoice_no", "is", null);
      if (!perParty) qy = branchId ? qy.eq("branch_id", branchId) : qy.is("branch_id", null);
      const { data, error } = await qy;
      if (dead) return;
      setBranchTop(error ? null : topOf((data as { invoice_no: string | null }[]) ?? []));
    })();
    return () => { dead = true; };
  }, [partyId, branchId, moves, perParty]);

  const lastInvoice = useMemo(() => {
    const both = [branchTop, localInvoice].filter((v): v is string => !!v);
    return both.length ? topOf(both.map((invoice_no) => ({ invoice_no }))) : null;
  }, [branchTop, localInvoice]);
  const expectedInvoice = useMemo(() => {
    if (!lastInvoice || !/^\d+$/.test(lastInvoice)) return null;
    return String(BigInt(lastInvoice) + BigInt(1)).padStart(lastInvoice.length, "0");
  }, [lastInvoice]);
  /* The sequence this form is writing into, from the invoice book. */
  const scopeNow = partyId ? `${partyId}|${perParty ? "" : (branchId || "")}` : "";
  const bookRows = useMemo(() => register.filter((r) => scopeKey(r) === scopeNow), [register, scopeNow]);
  /* A number the book already lists as missing is being FILLED, not skipped. */
  const fillsGap = !!invNo.trim() && bookRows.some((r) => r.status === "missing" && r.invoice_no === invNo.trim());
  const invoiceGap = !!(expectedInvoice && invNo.trim() && invNo.trim() !== expectedInvoice) && !fillsGap;
  /* A number this branch has already been given is a mistake, not a gap —
     two deliveries under one invoice cannot be told apart afterwards. Had
     this check existed, the suggestion bug above would have been caught the
     moment it offered a used number instead of going through silently. */
  /* An invoice already on record under this number. It used to be a flat
     refusal; now it can be deliberately ADDED TO — the item forgotten from
     yesterday's invoice goes on yesterday's invoice. */
  const existingInvoice = useMemo(() => {
    const v = invNo.trim();
    if (!v || !partyId) return null;
    const fromBook = bookRows.find((r) => r.invoice_no === v && (r.status === "used" || r.status === "voided"));
    if (fromBook) return fromBook;
    const m = moves.find((x) => x.movement_type === "OUT" && x.invoice_no === v && inScope(x));
    return m ? { invoice_no: v, on_date: m.created_at, branch_id: m.branch_id, branches: m.branch,
                 lines: moves.filter((x) => x.movement_type === "OUT" && !x.voided_at && x.invoice_no === v && inScope(x)).length } : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookRows, moves, invNo, partyId, branchId, perParty]);
  const invoiceUsed = !!existingInvoice;
  const [addToExisting, setAddToExisting] = useState(false);
  useEffect(() => { setAddToExisting(false); }, [invNo, partyId, branchId]);

  const catOf = (bc: string) => items.find((i) => i.barcode === bc)?.category ?? null;
  /* One key per kind of entry. Factory transfers each carry their own STR
     number, so they are grouped as one kind rather than one option each. */
  const noteKey = (note: string | null) => {
    const t = (note ?? "").trim().toLowerCase();
    if (!t) return "(no note)";
    if (/^str-.*from factory/.test(t)) return "from factory (str)";
    if (t.startsWith("correction:")) return "stock correction";
    return t;
  };
  const noteOptions = useMemo(() => {
    const c: Record<string, number> = {};
    moves.forEach((m) => { if (m.movement_type === "IN" && !m.voided_at) c[noteKey(m.note)] = (c[noteKey(m.note)] ?? 0) + 1; });
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moves]);
  /* Categories from the products themselves, so Baby, Shoes or Accessories
     appear on their own the day something is stocked under them. */
  const catOptions = useMemo(() =>
    [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort(), [items]);
  const fMoves = useMemo(() => moves.filter((m) =>
    hit(m.barcode, m.name, m.movement_no, m.manual_code, m.note, m.invoice_no) && inRange(m.created_at)
    && (!fNote   || noteKey(m.note) === fNote)
    && (!fParty  || m.party === fParty)
    && (!fBranch || m.branch === fBranch)
    && (!fItem   || m.barcode === fItem)
    && (!fCat    || catOf(m.barcode) === fCat)
    && (invFilter === "all" || m.invoice_no === invFilter)
    /* Ticked invoices win over every other filter — when somebody has chosen
       three delivery notes, that is exactly what they want printed. */
    && (picked.size === 0 || (m.invoice_no ? picked.has(m.invoice_no) : false))
  ), [moves, items, q, days, dFrom, dTo, fParty, fBranch, fItem, fCat, fNote, invFilter, picked]);
  const visible = fMoves.filter((m) => showVoided || !m.voided_at);
  /* GR OUT IS NOT A DELIVERY.
     Goods going back to a supplier, and goods taken off the shelf because
     they should never have been on it, are OUT movements like any other —
     but they are not shipments, they have no party, no branch and no invoice,
     and they have their own screen. Listing them here put nine write-offs in
     among the deliveries to Carrefour, under a heading that says in so many
     words "not supplier returns". Told apart by how the note begins, the same
     way the GR out screen tells them apart. */
  const isGrOut = (m: Move) => /^(RETURN|STOCK OUT)/.test(String(m.note ?? ""));

  const inMoves = visible.filter((m) => m.movement_type === "IN")
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));

  /* NEWEST FIRST — the branch dealt with most recently at the top.
     It used to sort the branches by NAME, so Emporium led the list for ever
     and today's work at Karachi Lucky 1 sat at the bottom under K. Inside a
     branch it sorted by delivery number, which is not the same as time: #1,
     #2 and #3 were recorded on the 18th and still fell below #4-#13 from the
     17th. Both are now ordered by when the stock actually moved.

     The rows of one branch still have to sit together, because the heading
     is drawn whenever the party or branch changes from the row above — so
     the GROUP is placed by its most recent delivery, not each row on its
     own. */
  const outMoves = (() => {
    const rows = visible.filter((m) => m.movement_type === "OUT" && !isGrOut(m));
    const groupOf = (m: Move) => `${m.party ?? ""}|${m.branch ?? ""}`;
    const latest = new Map<string, number>();
    rows.forEach((m) => {
      const k = groupOf(m), t = +new Date(m.created_at);
      if (t > (latest.get(k) ?? -Infinity)) latest.set(k, t);
    });
    return rows.sort((a, b) => {
      const ka = groupOf(a), kb = groupOf(b);
      if (ka !== kb) return (latest.get(kb) ?? 0) - (latest.get(ka) ?? 0) || ka.localeCompare(kb);
      /* Same branch: the most recent delivery first, and when two lines share
         a moment — everything saved in one go does — the higher delivery
         number first, so an invoice stays in one piece. */
      return +new Date(b.created_at) - +new Date(a.created_at)
          || (b.delivery_no ?? 0) - (a.delivery_no ?? 0);
    });
  })();
  const voidedCount = fMoves.filter((m) => m.voided_at).length;

  /* The scanner types the code and presses Enter. Resolving on Enter — not
     on every keystroke — means a half-typed code never matches the wrong
     item and starts a movement against it. */
  useEffect(() => {
    if (expectedInvoice && !invNo) setInvNo(expectedInvoice);
  }, [expectedInvoice]);

  function resolve() {
    const code = scan.trim().toLowerCase();
    if (!code) return;
    /* Exact code first — a scanner is always exact and must not be slowed by
       a list. Then the printed barcode. Then, if exactly one thing matches
       what was typed, take it; more than one and the list does the choosing. */
    const exact = items.find((i) => i.barcode.toLowerCase() === code);
    const byManual = exact ? null
      : items.find((i) => String(money[i.barcode]?.manual ?? "").toLowerCase() === code);
    const hitOne = exact || byManual
      || (suggestions.length === 1 ? suggestions[0] : null);
    if (!hitOne) { setFound(null); setMErr(""); return; }
    setFound(hitOne); setMErr("");
  }

  const [newSection, setNewSection] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newRetail, setNewRetail] = useState("");
  const [newGst, setNewGst] = useState("");
  const [newQty, setNewQty] = useState("");
  const [madeCode, setMadeCode] = useState<string | null>(null);
  /* The add-product form has its OWN manual barcode field. Sharing `bc` with
     the scan box meant typing in one wiped the other. */
  const [bcNew, setBcNew] = useState("");

  async function addItem() {
    if (!supabase) return;
    setErr("");
    if (!nm.trim()) { setErr("Give the product a name."); return; }
    if (!newSection) { setErr("Which section does it belong to?"); return; }
    setBusy(true);
    /* One call makes BOTH halves — the article that generates the barcode and
       holds the money, and the warehouse product keyed to it. Creating them
       separately is how products ended up with no code and no price. */
    const { data, error } = await supabase.rpc("add_warehouse_product", {
      p_name: nm.trim(), p_section: newSection,
      p_manual_barcode: bcNew.trim() || null,
      p_cost: newCost === "" ? null : parseFloat(newCost),
      p_retail: newRetail === "" ? null : parseFloat(newRetail),
      p_gst: newGst === "" ? null : parseFloat(newGst),
      p_opening_qty: newQty === "" ? 0 : parseFloat(newQty),
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMadeCode(String((data as Record<string, unknown>)?.system_barcode ?? ""));
    load();
  }

  /* ONE ENTRY, AS MANY BARCODES AS THE DELIVERY HAS.
     On both tabs now: scan, quantity, Enter — and the next scan goes into the
     same list. A GRN of thirty products used to mean thirty separate
     entries, each one its own trip through the form. */
  function addLine() {
    if (!found) return;
    setMErr("");
    const q = parseFloat(qty);
    if (!(q > 0)) { setMErr("Enter a quantity."); return; }
    /* K181: what went out went out. If the balance on hand does not cover it
       — a GRN not entered yet, an opening balance never loaded — the line is
       taken anyway and the stock goes below zero until the arrival catches
       up. The lines below say where it lands. Nothing is refused. */
    const ln = note.trim();
    setBasket((b) => {
      /* The same item with the SAME note scanned twice is one line. The same
         item with a different note — good pieces and B pair — stays apart. */
      const at = b.findIndex((x) => x.item_id === found.item_id && x.note === ln);
      if (at >= 0) return b.map((x, i) => i === at ? { ...x, qty: x.qty + q } : x);
      return [...b, { key: ++lineSeq.current, item_id: found.item_id, barcode: found.barcode,
                      name: found.name, qty: q, note: ln }];
    });
    setScan(""); setFound(null); setQty("");
    /* GR in: the note belongs to the line just added, so the box empties and
       the next item does not inherit "30 B pair". STR out keeps it — a
       delivery note is usually the same for the whole invoice. */
    if (tab === "in") setNote("");
    /* Straight back to the scan box, so the scanner can keep going. */
    setTimeout(() => scanBox.current?.focus(), 0);
  }

  async function record(type: "IN" | "OUT") {
    if (!supabase) return;
    setMErr("");
    /* Whatever is in the basket, plus whatever is typed but not yet added —
       so forgetting to press Add does not silently drop a line. */
    const lines = [...basket];
    if (found && parseFloat(qty) > 0) {
      const ln = note.trim();
      const at = lines.findIndex((x) => x.item_id === found.item_id && x.note === ln);
      if (at >= 0) lines[at] = { ...lines[at], qty: lines[at].qty + parseFloat(qty) };
      else lines.push({ key: ++lineSeq.current, item_id: found.item_id, barcode: found.barcode,
                        name: found.name, qty: parseFloat(qty), note: ln });
    }
    if (lines.length === 0) { setMErr("Nothing to record — add at least one item."); return; }
    if (type === "OUT" && !partyId) { setMErr("Which party is this going to?"); return; }
    if (type === "OUT" && invoiceUsed && !addToExisting) {
      setMErr(`Invoice ${invNo.trim()} is already on record. Tick "add these items to it" if that is what you mean.`); return;
    }
    const joining = type === "OUT" && invoiceUsed && addToExisting && existingInvoice;

    setBusy(true);
    /* Added to an old invoice: it takes that invoice's date (unless a date
       was picked) and, for a party numbered across branches, that invoice's
       branch — the items belong to that delivery. */
    const stamp = onDate ? stampAt(onDate, onTime)
      : joining && existingInvoice.on_date ? existingInvoice.on_date : undefined;
    const lineBranch = joining && perParty ? (existingInvoice.branch_id ?? null) : (branchId || null);
    /* Numbers skipped by this invoice, explained by the reason typed for the
       jump — saved into the invoice book so the sequence has no silent hole. */
    const skipped: string[] = [];
    const typed = invNo.trim();
    if (type === "OUT" && invoiceGap && gapWhy.trim() && expectedInvoice && /^\d+$/.test(typed)) {
      const from = BigInt(expectedInvoice), to = BigInt(typed);
      if (to > from && to - from <= BigInt(200)) {
        for (let k = from; k < to; k++) {
          const v = String(k).padStart(expectedInvoice.length, "0");
          if (!bookRows.some((r) => r.invoice_no === v && r.status !== "missing")) skipped.push(v);
        }
      }
    }
    /* Every line carries the SAME invoice and party, which is what makes it
       one delivery rather than several that happen to share a date. */
    const { error } = await supabase.from("khana_stock_movements").insert(
      lines.map((l) => ({
        item_id: l.item_id, movement_type: type, quantity: l.qty,
        /* The line's own note — never one note copied onto every line. */
        note: l.note.trim() || null,
        /* Only include created_at when a date was actually chosen. Sending it
           as undefined lands as null, which reads back as 1 Jan 1970 — the
           epoch, not a date anybody picked. */
        ...(stamp ? { created_at: stamp } : {}),
        party_id: type === "OUT" ? partyId : null,
        branch_id: type === "OUT" ? lineBranch : null,
        invoice_no: type === "OUT" ? (invNo.trim() || null) : null,
        invoice_gap_reason: type === "OUT" && invoiceGap && !joining ? (gapWhy.trim() || null) : null,
      })));
    if (error) { setBusy(false); setMErr(error.message); return; }
    if (skipped.length) {
      const r = await supabase.rpc("khana_note_invoices", {
        p_party: partyId, p_branch: branchId || null,
        p_items: skipped.map((v) => ({ invoice_no: v, reason: gapWhy.trim() })),
      });
      /* The delivery is saved either way; say so if the note was not. */
      if (r.error) setErr(`Saved the delivery, but not the note for the skipped number(s): ${r.error.message}`);
    }
    setBusy(false);
    setScan(""); setFound(null); setQty(""); setNote(""); setInvNo(""); setGapWhy("");
    setOnDate(""); setOnTime(""); setBasket([]); load();
  }

  async function addParty() {
    if (!supabase || !pName.trim()) return;
    setBusy(true);
    const { error } = pParty
      ? await supabase.from("khana_party_branches").insert({ party_id: pParty, name: pName.trim() })
      : await supabase.from("khana_parties").insert({ name: pName.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setPOpen(false); setPName(""); setPParty(""); load();
  }

  async function saveRename() {
    if (!supabase || !editRow || !editVal.trim()) return;
    const { error } = await supabase.from(editRow.branch ? "khana_party_branches" : "khana_parties")
      .update({ name: editVal.trim() }).eq("id", editRow.id);
    if (error) { setErr(error.message); return; }
    setEditRow(null); setEditVal(""); load();
  }

  async function removeBranch(b: Branch) {
    if (!supabase) return;
    /* A branch with deliveries is hidden, not deleted — those rows point at
       it, and old paperwork still names it. Nothing with history is ever
       destroyed here. */
    const { error } = b.deliveries > 0
      ? await supabase.from("khana_party_branches").update({ is_active: false }).eq("id", b.id)
      : await supabase.from("khana_party_branches").delete().eq("id", b.id);
    if (error) { setErr(error.message); return; }
    setKillRow(null); load();
  }

  async function removeParty(pt: Party) {
    if (!supabase) return;
    const used = moves.some((m) => m.party === pt.name);
    const hasBranches = branches.some((b) => b.party_id === pt.id);
    if (used || hasBranches) {
      /* Same rule one level up: a party that has shipped anything, or still
         holds branches, is deactivated so its deliveries stay explainable. */
      const { error } = await supabase.from("khana_parties").update({ is_active: false }).eq("id", pt.id);
      if (error) { setErr(error.message); return; }
    } else {
      const { error } = await supabase.from("khana_parties").delete().eq("id", pt.id);
      if (error) { setErr(error.message); return; }
    }
    setKillRow(null); load();
  }

  async function delItem(i: Item) {
    if (!supabase) return;
    setKillRow(null);
    if (i.quantity !== 0) { setErr(`${i.name} still holds ${n(i.quantity)}. Take it out before removing the item.`); return; }
    const { error } = await supabase.from("khana_final_items").delete().eq("id", i.item_id);
    if (error) { setErr(error.message); return; }
    load();
  }

  async function voidMove(id: string) {
    if (!supabase || !voidWhy.trim()) return;
    const { error } = await supabase.rpc("khana_void_movement", { p_id: id, p_reason: voidWhy.trim() });
    if (error) { setErr(error.message); return; }
    setVoidRow(null); setVoidWhy(""); load();
  }

  function startEdit(m: Move) {
    setVoidRow(null); setEditMv(m); setEErr("");
    /* The day and time it is recorded as, read off the saved moment in the
       browser's own clock — the same clock the boxes write back with. */
    const d = new Date(m.created_at);
    const p2 = (x: number) => String(x).padStart(2, "0");
    setEItem(items.find((i) => i.barcode === m.barcode)?.item_id ?? "");
    setEQty(String(m.quantity));
    setEDate(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`);
    setETime(`${p2(d.getHours())}:${p2(d.getMinutes())}`);
    setEInv(m.invoice_no ?? ""); setEBranch(m.branch_id ?? ""); setENote(m.note ?? "");
  }

  async function saveEdit() {
    if (!supabase || !editMv) return;
    const m = editMv;
    setEErr("");
    const q = parseFloat(eQty);
    if (!(q > 0)) { setEErr("Quantity must be above zero."); return; }
    if (!eItem) { setEErr("Choose the product this line is against."); return; }
    setEBusy(true);
    const { error } = await supabase.rpc("khana_edit_movement", {
      p_id: m.id, p_quantity: q,
      p_note: eNote.trim() || null,
      /* An invoice number and a branch belong to a delivery going out. The
         database ignores them on an arrival, but there is no reason to send
         them at all. */
      p_invoice_no: m.movement_type === "OUT" ? (eInv.trim() || null) : null,
      p_branch_id: m.movement_type === "OUT" ? (eBranch || null) : null,
      p_item_id: eItem,
      p_at: stampAt(eDate, eTime) ?? null,
    });
    setEBusy(false);
    /* The database's own words, on the form the person is looking at — not at
       the top of a page they have scrolled past. */
    if (error) { setEErr(error.message); return; }
    setEditMv(null); load(); loadMoney();
  }

  async function deleteMove(id: string) {
    if (!supabase) return;
    const { error } = await supabase.rpc("khana_delete_movement", { p_id: id });
    if (error) { setErr(error.message); return; }
    setDelRow(null); load();
  }

  async function saveItem(i: Item) {
    if (!supabase) return;
    /* Shown ON THE ROW, not at the top of a page the user has scrolled past.
       A refusal nobody can see reads as a button that does nothing. */
    setRowErr("");
    if (!eName.trim()) { setRowErr("The item needs a name."); return; }
    /* If the field came up blank, keep the code the item already has rather
       than refusing the whole save. Losing an edit over a field the screen
       failed to fill is the screen's fault, not the user's. */
    const code = eBar.trim() || i.barcode;
    if (!code) { setRowErr("This item has no code at all — set one before saving."); return; }
    /* One write, all of it on the warehouse product itself (K183). This used
       to save the name and code here and push the printed barcode and prices
       onto the article — which meant a product with no article could not be
       edited at all, and deleting the article wiped what it was holding. */
    const num = (v: string) => (v === "" ? null : parseFloat(v));
    const { error } = await supabase.rpc("update_warehouse_product", {
      p_item_id: i.item_id,
      p_patch: {
        name: eName.trim(), barcode: code, category: eItemCat || null,
        manual_barcode: eManual.trim() || null,
        cost_price: num(eCost), retail_price: num(eRetail), gst_rate: num(eGst),
      },
    });
    if (error) { setRowErr(error.message); return; }

    setEditItem(null); setRowErr(""); load(); loadMoney();
  }

  async function saveStock(i: Item) {
    if (!supabase) return;
    if (!sWhy.trim()) { setErr("Say why the figure is changing."); return; }
    const { error } = await supabase.rpc("khana_set_stock", {
      p_item_id: i.item_id, p_new_quantity: parseFloat(sQty), p_reason: sWhy.trim(),
    });
    if (error) { setErr(error.message); return; }
    setStockRow(null); setSQty(""); setSWhy(""); load();
  }

  const table = (): ExportTable => tab === "materials" || tab === "stock"
    ? { title: "Warehouse Inventory",
        /* Cost, GST, cost total and last moved are left off the printout on
           purpose — they are for the screen, not for the sheet that goes round
           the warehouse. Every row below is built to these seven columns;
           the headings and the rows must stay the same width. */
        /* The printed barcode only. Ours is an internal key and does not go
           out on a sheet — it stays on the Products list where it is made. */
        headers: ["Barcode", "Item description", "Catgry", "Qty",
                  "Retail", "Retail total"],
        /* Grouped by section, highest quantity first inside each, with a
           subtotal under every group. A flat list mixes Kids and Men on the
           same page, which is not how anyone counts stock. */
        rows: (() => {
          const blank = (v: number | null | undefined) => (v ? v : "");
          const secOf = (i: Item) => {
            const m = /^(\d{2})-/.exec(i.barcode ?? "");
            return m ? m[1] : (SECTION_OF[i.category ?? ""] ?? "zz");
          };
          const groups = new Map<string, Item[]>();
          fItems.forEach((i) => {
            const k = secOf(i);
            groups.set(k, [...(groups.get(k) ?? []), i]);
          });
          const out: (string | number)[][] = [];
          [...groups.keys()].sort().forEach((sec, gi) => {
            const list = (groups.get(sec) ?? [])
              .sort((a, b) => Number(b.quantity) - Number(a.quantity) || a.name.localeCompare(b.name));
            const label = SECTION_NAME[sec] ?? "Other";
            if (gi > 0) out.push(["", "", "", "", "", ""]);
            out.push([`${sec} ${label}`.trim(), `${list.length} item(s)`, "", "", "", ""]);
            let q = 0, rt = 0;
            list.forEach((i) => {
              const m = money[i.barcode];
              const r = m?.retail == null ? null : i.quantity * m.retail;
              q += Number(i.quantity || 0); rt += r ?? 0;
              out.push([m?.manual ?? "", i.name, i.category ?? "",
                blank(i.quantity), blank(m?.retail), blank(r)]);
            });
            out.push(["", `Subtotal ${label}`, "", blank(q), "", blank(rt)]);
          });
          return out;
        })() }
    /* Only the columns that carry something. Number (mostly blank), Type
       (always the same on this screen) and a Party/Branch/Invoice set that is
       empty on every GRN line made the sheet twice as wide as its content —
       which is what pushed it onto a second page. A total closes the list. */
    : (() => {
        const list = tab === "in" ? inMoves : outMoves;
        const anyVoid = list.some((m) => m.voided_at);
        const d = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
        const pcs = list.filter((m) => !m.voided_at).reduce((a, m) => a + Number(m.quantity || 0), 0);
        if (tab === "in") {
          const headers = ["Date", "Barcode", "Item description", "Qty", "Note", ...(anyVoid ? ["Voided"] : [])];
          return { title: "Warehouse New GRN", headers,
            rows: [...list.map((m) => [d(m.created_at), m.manual_code ?? "", m.name, m.quantity, m.note ?? "",
                     ...(anyVoid ? [m.voided_at ? "voided" : ""] : [])]),
                   ["", "", "Total", pcs, "", ...(anyVoid ? [""] : [])]] };
        }
        const headers = ["Invoice", "Date", "Party", "Branch", "Del #", "Barcode", "Item description", "Qty", ...(anyVoid ? ["Voided"] : [])];
        return { title: "Warehouse STR", headers,
          rows: [...list.map((m) => [m.invoice_no ?? "", d(m.created_at), m.party ?? "", m.branch ?? "", m.delivery_no ?? "",
                   m.manual_code ?? "", m.name, m.quantity, ...(anyVoid ? [m.voided_at ? "voided" : ""] : [])]),
                 ["", "", "", "", "", "", "Total", pcs, ...(anyVoid ? [""] : [])]] };
      })();

  /* In and Out ARE the warehouse's GRNs — goods arriving and goods leaving.
     Naming them so makes the whole system speak one language. */


  return (
    <>
      <Topbar
        title={section === "in" ? "Warehouse — New GRN"
             : section === "out" ? "Warehouse — Out GRN"
             : section === "stock" ? "Warehouse — Stock" : "Warehouse Inventory"}
        subtitle={section === "in" ? "Goods arriving, by barcode"
                : section === "out" ? "Stock going out to shops, branches and online — not supplier returns"
                : section === "stock" ? "What is held right now" : "Everything this warehouse carries"} />

      <div className="space-y-4 px-6 pb-12">
        {err && <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>}

        {/* The numbers first, in colour — the same visual language as the
            other departments, so this section does not look like a bolt-on. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-card bg-periwinkle-soft p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">Items</p>
            <p className="mt-1 text-[24px] font-extrabold leading-none text-ink">{items.length}</p>
          </div>
          <div className="rounded-card bg-success-soft p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">Pieces in stock</p>
            <p className="mt-1 text-[24px] font-extrabold leading-none text-ink">{n(items.reduce((a, i) => a + Number(i.quantity || 0), 0))}</p>
          </div>
          <div className="rounded-card bg-amber-soft p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">In today</p>
            <p className="mt-1 text-[24px] font-extrabold leading-none text-ink">
              {n(moves.filter((m) => !m.voided_at && m.movement_type === "IN" && new Date(m.created_at).toDateString() === new Date().toDateString()).reduce((a, m) => a + Number(m.quantity), 0))}
            </p>
          </div>
          {/* Deliveries, and GR out named separately underneath. Counting
              both in one number is what made "Out today 9,474" sit above a
              list of deliveries that added up to nothing. */}
          {(() => {
            const todays = moves.filter((m) => !m.voided_at && m.movement_type === "OUT"
              && new Date(m.created_at).toDateString() === new Date().toDateString());
            const sum = (rows: Move[]) => rows.reduce((a, m) => a + Number(m.quantity || 0), 0);
            const shipped = sum(todays.filter((m) => !isGrOut(m)));
            const takenOut = sum(todays.filter(isGrOut));
            return (
              <div className="rounded-card bg-salmon-soft p-4">
                <p className="text-[11px] font-bold uppercase tracking-wide text-ink/55">Out today</p>
                <p className="mt-1 text-[24px] font-extrabold leading-none text-ink">{n(shipped)}</p>
                {takenOut > 0 && (
                  <p className="mt-1 text-[11px] leading-snug text-ink/60">
                    + {n(takenOut)} on GR out
                  </p>
                )}
              </div>
            );
          })()}
        </div>

        

        {(tab === "materials" || tab === "stock") && (
          <div className="flex flex-wrap gap-1.5">
            {["", "Kids", "Child", "Ladies", "Men"].map((c) => (
              <button key={c || "all"} onClick={() => setCat(c)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${cat === c ? "bg-ink text-white" : "border border-line text-ink/65 hover:bg-panel"}`}>
                {c || "All"}
                <span className="ml-1 opacity-60">{c ? items.filter((i) => i.category === c).length : items.length}</span>
              </button>
            ))}
          </div>
        )}

        {tab !== "materials" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <input type="date" value={dFrom} onChange={(e) => { setDFrom(e.target.value); setDays(null); }}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none" />
            <span className="text-[12px] text-hint">to</span>
            <input type="date" value={dTo} onChange={(e) => { setDTo(e.target.value); setDays(null); }}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none" />
          </div>
        )}

        {(tab === "in" || tab === "out") && (
          <div className="flex flex-wrap items-center gap-2">
            {tab === "out" && (
              <>
                <select value={fParty} onChange={(e) => { setFParty(e.target.value); setFBranch(""); }}
                  className="rounded-xl2 border border-line bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-ink/30">
                  <option value="">All parties</option>
                  {parties.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
                {/* Only the chosen party's branches — offering DHA under
                    Carrefour would return nothing and look broken. */}
                <select value={fBranch} onChange={(e) => setFBranch(e.target.value)} disabled={!fParty}
                  className="rounded-xl2 border border-line bg-surface px-3 py-2 text-[12.5px] outline-none disabled:opacity-45">
                  <option value="">{fParty ? "All branches" : "Pick a party first"}</option>
                  {branches.filter((b) => b.party === fParty).map((b) => <option key={b.id} value={b.branch}>{b.branch}</option>)}
                </select>
              </>
            )}
            <select value={fCat} onChange={(e) => { setFCat(e.target.value); setFItem(""); }}
              className="rounded-xl2 border border-line bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-ink/30">
              <option value="">All categories</option>
              {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {tab === "in" && noteOptions.length > 0 && (
              <select value={fNote} onChange={(e) => setFNote(e.target.value)} title="What kind of entry"
                className="rounded-xl2 border border-line bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-ink/30">
                <option value="">All notes</option>
                {noteOptions.map(([k, c]) => <option key={k} value={k}>{k} ({c})</option>)}
              </select>
            )}
              {tab === "out" && invoices.length > 0 && (
                <select value={invFilter} onChange={(e) => { setInvFilter(e.target.value); setPicked(new Set()); }}
                  className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none">
                  <option value="all">All invoices</option>
                  {invoices.map((v) => <option key={v} value={v}>Invoice {v}</option>)}
                </select>
              )}
              {/* PICK INVOICES TO PRINT — the button only. The list opens
                  BELOW this row, pushing the page down instead of floating
                  over it. The old one was a <details> holding a panel with no
                  positioned parent: it was thrown to the top of the page and
                  sat on top of the record form, hiding the party, the invoice
                  box and the Record button. */}
              {tab === "out" && invoices.length > 0 && (
                <button onClick={() => setPickOpen((o) => !o)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
                    picked.size ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink/70 hover:bg-panel"}`}>
                  {picked.size ? `${picked.size} invoice${picked.size === 1 ? "" : "s"} picked` : "Pick invoices"}
                  <ChevronDown size={13} className={pickOpen ? "rotate-180 transition" : "transition"} />
                </button>
              )}
            <select value={fItem} onChange={(e) => setFItem(e.target.value)}
              className="max-w-[15rem] rounded-xl2 border border-line bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-ink/30">
              <option value="">All products</option>
              {items.filter((i) => !fCat || i.category === fCat)
                    .map((i) => <option key={i.item_id} value={i.barcode}>{i.name} · {i.barcode}</option>)}
            </select>
            {(fParty || fBranch || fItem || fCat || fNote || q || dFrom || dTo) && (
              <button onClick={() => { setFParty(""); setFBranch(""); setFItem(""); setFCat(""); setFNote(""); setQ(""); setDFrom(""); setDTo(""); }}
                className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/60 hover:bg-panel">Clear</button>
            )}
          </div>
        )}

        {/* Opens IN the page, never over it: nothing on the form below is
            covered, on a phone or on a desktop. */}
        {tab === "out" && pickOpen && invoices.length > 0 && (
          <div className="rounded-card border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-[12px] font-bold text-ink">Print only these invoices</p>
              <p className="text-[11.5px] text-muted">Tap the ones you want. Nothing picked prints whatever the filters show.</p>
              <span className="ml-auto flex gap-1.5">
                {picked.size > 0 && (
                  <button onClick={() => setPicked(new Set())}
                    className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel">Clear</button>
                )}
                <button onClick={() => setPickOpen(false)}
                  className="rounded-full bg-ink px-4 py-1.5 text-[12px] font-semibold text-white">Done</button>
              </span>
            </div>
            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
              {invoices.map((v) => (
                <button key={v}
                  onClick={() => setPicked((pk) => { const nx = new Set(pk); if (nx.has(v)) nx.delete(v); else nx.add(v); return nx; })}
                  className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                    picked.has(v) ? "bg-ink text-white" : "border border-line text-ink/70 hover:bg-panel"}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            {/* One search box on this screen. On the product list it filters;
                on a GRN screen the scan box above does the finding. */}
            {(tab === "materials" || tab === "in") && (
              <input value={q} onChange={(e) => setQ(e.target.value)}
                placeholder={tab === "in" ? "Search the list: barcode, printed barcode, item, note…" : "Search barcode or name…"}
                className="w-full max-w-xs rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
            )}
            {q && (
              <button onClick={() => setQ("")} title="Clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink/60">
                {(tab === "materials" || tab === "stock" ? fItems.length : (tab === "in" ? inMoves : outMoves).length)} ✕
              </button>
            )}
          </div>
          <button onClick={() => exportCSV(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Download size={13} /> CSV</button>
          <button onClick={() => exportExcel(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">Excel</button>
          <button onClick={() => exportPDF(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">PDF</button>
          <button onClick={() => printTable(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Printer size={13} /> Print</button>
          {(tab === "in" || tab === "out") && voidedCount > 0 && (
            <button onClick={() => setShowVoided((v) => !v)}
              className={`rounded-full px-3 py-2 text-[12px] font-semibold transition ${showVoided ? "bg-ink text-white" : "border border-line text-ink/65 hover:bg-panel"}`}>
              {showVoided ? "Hide" : "Show"} voided ({voidedCount})
            </button>
          )}
          {tab === "out" && (
            <button onClick={() => openBook(null)}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white">
              <BookOpen size={15} /> Invoice book
              {missingCount > 0 && (
                <span className="rounded-full bg-amber px-1.5 py-0.5 text-[10.5px] font-bold text-ink">{missingCount} missing</span>
              )}
            </button>
          )}
          {tab === "materials" && canAdd && (
            <button onClick={() => setItemOpen(true)} className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white"><Plus size={15} /> Add product</button>
          )}
        </div>

        {loading && <p className="text-[13px] text-hint">Loading…</p>}

        {/* ---------- MATERIALS / STOCK ---------- */}
        {!loading && (tab === "materials" || tab === "stock") && (
          fItems.length === 0 ? (
            <div className="rounded-card border border-line bg-surface p-10 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-panel text-ink"><Boxes size={24} /></span>
              <p className="mt-3 text-[15px] font-semibold text-ink">Nothing here yet</p>
              <p className="mt-1 text-[13px] text-muted">Add a material with its barcode, then bring stock in.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                  {/* The printed barcode — the label the shops scan. Our own
                      generated code is not a column here: this screen is what
                      Reports → Stock report opens, and it gets printed. It is
                      still editable, inside the row's edit form. */}
                  <th className="px-4 py-2.5 font-bold">Barcode</th>
                  <th className="px-4 py-2.5 font-bold">Item</th>
                  <th className="px-4 py-2.5 font-bold">Category</th>
                  <th className="px-4 py-2.5 text-right font-bold">In stock</th>
                  <th className="px-4 py-2.5 text-right font-bold">Cost</th>
                  <th className="px-4 py-2.5 text-right font-bold">Retail</th>
                  <th className="px-4 py-2.5 text-right font-bold">GST</th>
                  <th className="px-4 py-2.5 text-right font-bold">Cost total</th>
                  <th className="px-4 py-2.5 text-right font-bold">Retail total</th>
                  <th className="px-4 py-2.5 font-bold">Last moved</th>
                </tr></thead>
                <tbody>
                  {fItems.map((i, ix) => (
                    <tr key={i.item_id} className={`border-b border-line/60 last:border-0 ${ix % 2 ? "bg-panel/25" : ""}`}>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-ink">
                        {money[i.barcode]?.manual ?? <span className="text-hint">no printed barcode</span>}
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-ink">
                        {editItem === i.item_id ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <input value={eName} autoFocus onChange={(e) => setEName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveItem(i); if (e.key === "Escape") setEditItem(null); }}
                              className="w-48 rounded-lg border border-ink/30 px-2 py-1 text-[12px] font-normal outline-none" />
                            <select value={eItemCat} onChange={(e) => setEItemCat(e.target.value)}
                              className="rounded-lg border border-ink/30 px-1.5 py-1 text-[12px] font-normal outline-none">
                              <option value="">no category</option>
                              {["Kids", "Child", "Ladies", "Men"].map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input value={eBar} onChange={(e) => setEBar(e.target.value)}
                              placeholder="our code"
                              title="The code this system generated. Changing it changes what the warehouse matches deliveries against."
                              className="w-28 rounded-lg border border-ink/30 px-2 py-1 font-mono text-[11.5px] font-normal outline-none" />
                            <input value={eManual} onChange={(e) => setEManual(e.target.value)}
                              placeholder="printed barcode"
                              className="w-36 rounded-lg border border-ink/30 px-2 py-1 font-mono text-[11.5px] font-normal outline-none" />
                            <input type="number" value={eCost} onChange={(e) => setECost(e.target.value)}
                              placeholder="cost"
                              className="w-20 rounded-lg border border-ink/30 px-2 py-1 text-right text-[12px] font-normal outline-none" />
                            <input type="number" value={eRetail} onChange={(e) => setERetail(e.target.value)}
                              placeholder="retail"
                              className="w-20 rounded-lg border border-ink/30 px-2 py-1 text-right text-[12px] font-normal outline-none" />
                            <input type="number" value={eGst} onChange={(e) => setEGst(e.target.value)}
                              placeholder="GST%"
                              className="w-16 rounded-lg border border-ink/30 px-2 py-1 text-right text-[12px] font-normal outline-none" />
                            <button onClick={() => saveItem(i)} className="text-[11px] font-bold text-ink">save</button>
                            <button onClick={() => { setEditItem(null); setRowErr(""); }} className="text-[11px] font-normal text-ink/50">cancel</button>
                            {rowErr && <span className="block text-[11px] font-medium text-danger">{rowErr}</span>}
                          </span>
                        ) : (<>
                          {/* Click the name for every stock-in and stock-out it has had. */}
                          <button onClick={() => setHistItem(i)} title="See its stock in and out"
                            className="text-left font-semibold text-ink underline decoration-line decoration-dotted underline-offset-4 hover:decoration-ink">
                            {i.name}
                          </button>
                          {i.description && <span className="block text-[11px] font-normal text-hint">{i.description}</span>}</>)}
                      </td>
                      <td className="px-4 py-2.5">
                        {i.category
                          ? <span className="rounded-full bg-panel px-2 py-0.5 text-[11.5px] font-semibold text-ink/75">{i.category}</span>
                          : <span className="text-muted">—</span>}
                        {i.raw_material_reference && <span className="ml-1.5 text-[11px] text-hint">{i.raw_material_reference}</span>}
                      </td>
                      <td className={`px-4 py-2.5 text-right tnum font-bold ${i.quantity > 0 ? "text-ink" : "text-hint/60"}`}>
                        {stockRow === i.item_id ? (
                          <span className="flex items-center justify-end gap-1.5">
                            <input type="number" value={sQty} autoFocus onChange={(e) => setSQty(e.target.value)}
                              className="w-20 rounded-lg border border-ink/30 px-2 py-1 text-right text-[12px] outline-none" />
                            <input value={sWhy} onChange={(e) => setSWhy(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveStock(i); if (e.key === "Escape") setStockRow(null); }}
                              placeholder="why" className="w-28 rounded-lg border border-ink/30 px-2 py-1 text-left text-[12px] outline-none" />
                            <button onClick={() => saveStock(i)} className="text-[11px] font-bold text-ink">save</button>
                            <button onClick={() => setStockRow(null)} className="text-[11px] text-ink/50">✕</button>
                          </span>
                        ) : n(i.quantity)}
                      </td>
                      {/* Blank rather than zero where no price is set — a price
                          of 0 and no price yet are different facts. */}
                      <td className="px-4 py-2.5 text-right tnum text-muted">
                        {money[i.barcode]?.cost == null ? "—" : rs(money[i.barcode]!.cost!)}
                      </td>
                      <td className="px-4 py-2.5 text-right tnum font-semibold text-ink">
                        {money[i.barcode]?.retail == null ? "—" : rs(money[i.barcode]!.retail!)}
                      </td>
                      <td className="px-4 py-2.5 text-right tnum text-muted">
                        {money[i.barcode]?.gst == null ? "—" : `${money[i.barcode]!.gst}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right tnum text-muted">
                        {!money[i.barcode]?.cost || !i.quantity ? "—" : rs(i.quantity * money[i.barcode]!.cost!)}
                      </td>
                      <td className="px-4 py-2.5 text-right tnum font-bold text-ink">
                        {!money[i.barcode]?.retail || !i.quantity ? "—" : rs(i.quantity * money[i.barcode]!.retail!)}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-muted">
                        {i.last_updated ? when(i.last_updated) : "—"}
                        {canManage && (
                          <span className="ml-2 inline-flex gap-2">
                            {tab === "stock" ? (
                              <button onClick={() => { setStockRow(i.item_id); setSQty(String(i.quantity)); setSWhy(""); }}
                                className="text-[11px] font-semibold text-ink/50 hover:text-ink">set stock</button>
                            ) : (
                              <>
                                <button onClick={() => { setEditItem(i.item_id); setEName(i.name); setEBar(i.barcode ?? ""); setEItemCat(i.category ?? ""); setRowErr("");
                                  setEManual(money[i.barcode]?.manual ?? "");
                                  setECost(money[i.barcode]?.cost == null ? "" : String(money[i.barcode]!.cost));
                                  setERetail(money[i.barcode]?.retail == null ? "" : String(money[i.barcode]!.retail));
                                  setEGst(money[i.barcode]?.gst == null ? "" : String(money[i.barcode]!.gst)); }}
                                  className="text-[11px] font-semibold text-ink/50 hover:text-ink">edit</button>
                                {killRow === i.item_id ? (
                                  <>
                                    <span className="text-[11px] text-ink/60">remove?</span>
                                    <button onClick={() => delItem(i)} className="text-[11px] font-bold text-danger">yes</button>
                                    <button onClick={() => setKillRow(null)} className="text-[11px] text-ink/50">no</button>
                                  </>
                                ) : (
                                  <button onClick={() => setKillRow(i.item_id)}
                                    className="text-[11px] font-semibold text-danger/70 hover:text-danger">remove</button>
                                )}
                              </>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-line bg-panel/40 text-[13px] font-extrabold text-ink">
                    <td className="px-4 py-3" colSpan={3}>Total &mdash; {fItems.length} item(s)</td>
                    <td className="px-4 py-3 text-right tnum">{n(fItems.reduce((a, i) => a + Number(i.quantity || 0), 0))}</td>
                    <td className="px-4 py-3" colSpan={3}></td>
                    <td className="px-4 py-3 text-right tnum">
                      {rs(fItems.reduce((a, i) => a + Number(i.quantity || 0) * (money[i.barcode]?.cost ?? 0), 0))}
                    </td>
                    <td className="px-4 py-3 text-right tnum">
                      {rs(fItems.reduce((a, i) => a + Number(i.quantity || 0) * (money[i.barcode]?.retail ?? 0), 0))}
                    </td>
                    <td className="px-4 py-3"></td>
                  </tr>
                </tfoot>
              </table></div>
            </div>
          )
        )}

        {/* ---------- IN / OUT ---------- */}
        {!loading && (tab === "in" || tab === "out") && (
          <>
            {(tab === "in" ? canIn : canOut) && (
              <div className="rounded-card border border-line bg-surface p-4">
                <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
                  {tab === "in" ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
                  {tab === "in" ? "New GRN — bring stock in" : "STR — send stock out"}
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
                  <input value={scan} autoFocus ref={scanBox}
                    onChange={(e) => { setScan(e.target.value); setFound(null); }}
                    /* Enter on a resolved item adds it to the list and comes
                       back here — one hand on the scanner, one on the keypad. */
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (found && parseFloat(qty) > 0) addLine(); else resolve(); } }}
                    onBlur={resolve}
                    placeholder="Scan, or type a barcode or product name" className={inp} />
                  <input type="number" value={qty} onChange={(e) => setQty(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLine(); } }}
                    placeholder="Quantity" className={inp} />
                  {/* No else branch: the party picker belongs to Out only, and
                      the date box below now shows on both. */}
                  {tab === "out" && (
                    <select value={partyId} onChange={(e) => { setPartyId(e.target.value); setBranchId(""); }} className={inp}>
                      <option value="">Party…</option>
                      {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  {/* On both tabs: stock that left on Tuesday should read
                      Tuesday, and an invoice entered late is the normal case,
                      not the exception. */}
                  <input type="date" value={onDate} max={new Date().toLocaleDateString("en-CA")}
                    onChange={(e) => { setOnDate(e.target.value); if (e.target.value && !onTime) setOnTime(timeNow()); }}
                    title={tab === "in" ? "Date it arrived - blank means now"
                                        : "Date it went out - blank means now"}
                    className={inp} />
                  {/* Only once a date is chosen: with no date the entry is
                      stamped at this moment anyway. */}
                  {onDate && (
                    <input type="time" value={onTime} onChange={(e) => setOnTime(e.target.value)}
                      title="Time it moved - the time now unless you change it" className={inp} />
                  )}
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tab === "in" ? "Note for this item (e.g. 30 B pair)" : "Note (optional)"} className={inp} />
                  <button onClick={addLine} disabled={!found || !(parseFloat(qty) > 0)}
                    title="Add this one and scan the next (or press Enter)"
                    className="rounded-xl2 border border-line px-4 py-2 text-[13px] font-semibold text-ink/75 hover:bg-panel disabled:opacity-40">
                    + Add item
                  </button>
                  <button onClick={() => record(tab === "in" ? "IN" : "OUT")}
                    disabled={busy || (!found && basket.length === 0) || (tab === "out" && invoiceUsed && !addToExisting)}
                    className="flex items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    Record {tab === "in" ? "in" : "out"}
                  </button>
                </div>
                {tab === "out" && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <select value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={!partyId} className={inp}>
                      <option value="">Branch (optional)…</option>
                      {branches.filter((b) => b.party_id === partyId).map((b) => <option key={b.id} value={b.id}>{b.branch}</option>)}
                    </select>
                    <input value={invNo} onChange={(e) => setInvNo(e.target.value)} placeholder="Party invoice number" className={inp} />
                    {canManage && (
                      <button onClick={() => setPOpen(true)} className="rounded-xl2 border border-line px-3 py-2 text-[12.5px] font-semibold text-ink/70 hover:bg-panel">+ Party / branch</button>
                    )}
                  </div>
                )}
                {tab === "out" && lastInvoice && (
                  <p className="mt-2 text-[12px] text-ink/70">
                    Last invoice for {perParty
                      ? `${parties.find((p) => p.id === partyId)?.name ?? ""} (all branches — one sequence)`
                      : branches.find((b) => b.id === branchId)?.branch ?? parties.find((p) => p.id === partyId)?.name}: <b className="tnum">{lastInvoice}</b>
                    {expectedInvoice && <> · next expected <b className="tnum">{expectedInvoice}</b></>}
                  </p>
                )}
                {tab === "out" && invoiceUsed && existingInvoice && (
                  <div className={`mt-2 rounded-xl2 border p-2.5 text-[12.5px] ${addToExisting ? "border-success/50 bg-success-soft/60" : "border-danger/30 bg-danger-soft"}`}>
                    <p className="font-semibold text-ink">
                      Invoice {invNo.trim()} is already on record
                      {existingInvoice.branches ? ` for ${existingInvoice.branches}` : ""}
                      {" "}— {existingInvoice.lines} item{existingInvoice.lines === 1 ? "" : "s"}
                      {existingInvoice.on_date ? `, ${new Date(existingInvoice.on_date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}.
                    </p>
                    <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-ink/85">
                      <input type="checkbox" checked={addToExisting} onChange={(e) => setAddToExisting(e.target.checked)} className="h-4 w-4 accent-[#141414]" />
                      Add these items to invoice {invNo.trim()}
                      {!onDate && existingInvoice.on_date ? " (they take its date)" : ""}
                    </label>
                    {!addToExisting && <p className="mt-1 text-[12px] text-danger">Or type a different number.</p>}
                  </div>
                )}
                {tab === "out" && fillsGap && !invoiceUsed && (
                  <p className="mt-2 rounded-xl2 border border-success/40 bg-success-soft/60 p-2.5 text-[12.5px] font-semibold text-ink">
                    Invoice {invNo.trim()} was missing from the sequence — recording it fills the gap.
                  </p>
                )}
                {tab === "out" && invoiceGap && !invoiceUsed && (
                  <div className="mt-2 rounded-xl2 border border-amber-soft bg-amber-soft/50 p-2.5">
                    <p className="text-[12.5px] font-semibold text-ink">
                      Expected {expectedInvoice}, you entered {invNo.trim()}.
                    </p>
                    <input value={gapWhy} onChange={(e) => setGapWhy(e.target.value)}
                      placeholder="why the gap? e.g. cancelled pad — saved against the skipped numbers in the invoice book"
                      className={`${inp} mt-2`} />
                  </div>
                )}
                {/* Typing a name should find the product — nobody remembers
                    13-digit barcodes. Exact scans still match instantly and
                    skip the list. */}
                {!found && scan.trim().length >= 1 && suggestions.length > 0 && (
                  <div className="mt-2 overflow-hidden rounded-xl2 border border-line">
                    <p className="border-b border-line bg-panel/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-hint">
                      {suggestions.length} match{suggestions.length === 1 ? "" : "es"} — click one
                    </p>
                    <div className="max-h-48 overflow-y-auto">
                    {suggestions.map((x) => (
                      <button key={x.item_id} onClick={() => { setScan(x.barcode); setFound(x); setMErr(""); }}
                        className="flex w-full items-center justify-between gap-3 border-b border-line/60 px-3 py-2 text-left last:border-0 hover:bg-panel">
                        <span>
                          <span className="text-[13px] font-semibold text-ink">{x.name}</span>
                          <span className="block font-mono text-[11px] text-hint">
                            {x.barcode}{money[x.barcode]?.manual ? ` · ${money[x.barcode]!.manual}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] tnum text-muted">
                          {x.quantity ? `${n(x.quantity)} in stock` : "no stock yet"}
                        </span>
                      </button>
                    ))}
                    </div>
                  </div>
                )}

                {/* A disabled button with no explanation is the worst state a
                    form can be in. Say which of the two things is missing. */}
                {!found && !scan.trim() && (
                  <p className="mt-2 text-[12.5px] text-muted">
                    Scan a barcode, or type it and press Enter. Either code works — ours (44-000012) or the printed one.
                    Then a quantity and Enter again to add it, and scan the next: everything in the list is recorded together.
                  </p>
                )}
                {/* Only when NOTHING matched. Saying "no product" while a list
                    of matches sits above it is the screen arguing with itself. */}
                {!found && scan.trim() && suggestions.length === 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-[12.5px] font-medium text-danger">
                      Nothing matches <b>{scan.trim()}</b>.
                    </p>
                    {/* Add it here rather than sending someone to another screen
                        and back. An unknown barcode at the receiving bench is
                        the moment you know the product needs creating. */}
                    {canAdd && (
                      <button
                        onClick={() => {
                          setItemOpen(true); setMadeCode(null);
                          setBcNew(scan.trim()); setNm(""); setNewSection("");
                          setNewCost(""); setNewRetail(""); setNewGst(""); setNewQty(qty || "");
                        }}
                        className="rounded-full bg-ink px-3 py-1.5 text-[12px] font-semibold text-white">
                        + Add this product
                      </button>
                    )}
                  </div>
                )}
                {found && !qty && (
                  <p className="mt-2 text-[12.5px] text-muted">How many pieces?</p>
                )}
                {basket.length > 0 && (
                  <div className="mt-3 overflow-hidden rounded-xl2 border border-line">
                    <p className="border-b border-line bg-panel/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-hint">
                      <span className="flex items-center justify-between gap-2">
                        <span>{basket.length} item(s) {tab === "in" ? "in this GRN" : "on this invoice"} · {n(basket.reduce((a, x) => a + x.qty, 0))} pieces</span>
                        <button onClick={() => setBasket([])} className="text-[11px] font-semibold text-danger/70 hover:text-danger">clear all</button>
                      </span>
                    </p>
                    {basket.map((l) => {
                      /* K181: the warning has to live on the line, not on the
                         scan box — that clears the moment the line is added,
                         and this is still here when Record is pressed. */
                      const after = tab === "out"
                        ? Number(items.find((i) => i.item_id === l.item_id)?.quantity ?? 0)
                          - basket.filter((x) => x.item_id === l.item_id).reduce((a, x) => a + x.qty, 0)
                        : 0;
                      return (
                      <div key={l.key} className="flex items-center justify-between gap-3 border-b border-line/60 px-3 py-2 last:border-0">
                        <span className="min-w-0 flex-1">
                          <span className="text-[13px] font-semibold text-ink">{l.name}</span>
                          <span className="block font-mono text-[11px] text-hint">{l.barcode}</span>
                          {/* This line's note, fixable here before Record. */}
                          <input value={l.note}
                            onChange={(e) => setBasket((b) => b.map((x) => x.key === l.key ? { ...x, note: e.target.value } : x))}
                            placeholder="note for this line (e.g. 30 B pair)"
                            className="mt-1 w-full max-w-xs rounded-lg border border-line bg-surface px-2 py-1 text-[12px] outline-none focus:border-ink/30" />
                          {after < 0 && (
                            <span className="block text-[11px] font-semibold text-danger">
                              stock goes to {n(after)} — nothing came in for these yet
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="tnum text-[13px] font-bold text-ink">{n(l.qty)}</span>
                          <button onClick={() => setBasket((b) => b.filter((x) => x.key !== l.key))}
                            className="text-[11px] font-semibold text-danger/70">remove</button>
                        </span>
                      </div>
                      );
                    })}
                  </div>
                )}
                {found && (() => {
                  /* K181: where the balance lands if this goes on — counting
                     what is already in the basket for the same item. Below
                     zero is said out loud, never refused: it means the goods
                     left before their arrival was written down. */
                  const held = Number(found.quantity);
                  const already = basket.filter((x) => x.item_id === found.item_id).reduce((a, x) => a + x.qty, 0);
                  const after = held - already - (parseFloat(qty) || 0);
                  return (
                    <p className="mt-2 text-[12.5px] text-ink/80">
                      <b>{found.name}</b>
                      <span className="ml-1.5 font-mono text-[12px] text-ink/60">{found.barcode}</span>
                      {money[found.barcode]?.manual && (
                        <span className="ml-1.5 font-mono text-[12px] text-muted">printed {money[found.barcode]!.manual}</span>
                      )}
                      {" "}· holding {n(held)}
                      {tab === "out" && after < 0 && (
                        <span className="font-semibold text-danger"> — this takes it to {n(after)}</span>)}
                    </p>
                  );
                })()}
                {mErr && <p className="mt-2 text-[12.5px] font-medium text-danger">{mErr}</p>}
              </div>
            )}

            {/* The moment a barcode is found, everything that item has ever
                done — so what is arriving can be checked against what came
                before, without leaving the bench. */}
            {tab === "in" && found && (
              <ItemHistory barcode={found.barcode} name={found.name}
                manual={money[found.barcode]?.manual ?? null}
                stockNow={found.quantity} reloadKey={moves.length} />
            )}

            <div className="overflow-hidden rounded-card border border-line bg-surface">
              <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                  {tab === "out" && <th className="px-4 py-2.5 font-bold">#</th>}
                  {/* The printed barcode, on both tabs — the same column the
                      export and the printout carry, so the sheet and the
                      screen say the same thing. */}
                  <th className="px-4 py-2.5 font-bold">Date</th><th className="px-4 py-2.5 font-bold">Barcode</th>
                  <th className="px-4 py-2.5 font-bold">Item</th>
                  <th className="px-4 py-2.5 text-right font-bold">Qty</th>
                  <th className="px-4 py-2.5 font-bold">{tab === "out" ? "Went to" : "Note"}</th><th className="px-4 py-2.5"></th>
                </tr></thead>
                <tbody>
                  {(tab === "in" ? inMoves : outMoves).map((m, mi, arr) => (
                    <Fragment key={m.id}>
                    {tab === "out" && (mi === 0 || `${arr[mi-1].party}|${arr[mi-1].branch}` !== `${m.party}|${m.branch}`) && (
                      <tr key={`h-${m.id}`} className="bg-panel/60">
                        <td colSpan={7} className="px-4 py-1.5 text-[11.5px] font-bold uppercase tracking-wide text-ink/70">
                          {m.party ?? "—"}{m.branch ? ` · ${m.branch}` : ""}
                        </td>
                      </tr>
                    )}
                    <tr key={m.id} className={`border-b border-line/60 last:border-0 ${m.voided_at ? "opacity-45" : ""}`}>
                      {/* Tick an invoice to print just that delivery note.
                          Nothing ticked means print what is filtered. */}
                      {/* The delivery number is what the party quotes back at
                          you on the phone, so it reads first and reads big —
                          not buried in a sentence at the far right. */}
                      {tab === "out" && (
                        <td className="px-4 py-2.5">
                          {m.delivery_no
                            ? <span className="tnum text-[12.5px] font-bold text-ink/70">#{m.delivery_no}</span>
                            : <span className="text-hint">—</span>}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-[12px] text-muted">{when(m.created_at)}</td>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-ink">{m.manual_code ?? "—"}</td>
                      <td className="px-4 py-2.5 font-semibold text-ink">{m.name}</td>
                      <td className="px-4 py-2.5 text-right tnum font-bold text-ink">{n(m.quantity)}</td>
                      <td className="px-4 py-2.5 text-[12px] text-hint">
                        {/* Only when the QUANTITY changed — an invoice moved to a new
                            number or date is not "edited · was 0". */}
                        {m.edited_at && !m.voided_at && m.original_quantity != null && Number(m.original_quantity) !== Number(m.quantity)
                          ? `edited · was ${n(Number(m.original_quantity))} · ` : ""}
                        {m.voided_at ? `voided — ${m.void_reason ?? ""}`
                          : m.movement_type === "OUT"
                            ? <>
                                {`${m.party ?? ""}${m.branch ? " · " + m.branch : ""}`}
                                {m.invoice_no && (
                                  <>
                                    {" · "}
                                    {/* The invoice opens as a whole: every item on it,
                                        print it, add to it, change it. */}
                                    <button onClick={() => {
                                        const r = register.find((x) => x.party_id === m.party_id && x.invoice_no === m.invoice_no
                                          && (x.sequence_mode === "per_party" || x.scope_branch_id === m.branch_id));
                                        openBook({ scope: r ? scopeKey(r) : `${m.party_id}|${m.branch_id ?? ""}`, invoice: m.invoice_no! });
                                      }}
                                      className="font-semibold text-ink/75 underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink">
                                      inv {m.invoice_no}
                                    </button>
                                  </>
                                )}
                              </>
                            : (m.note ?? "")}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canManage && m.voided_at ? (
                          delRow === m.id ? (
                            <span className="flex items-center justify-end gap-1.5">
                              <span className="text-[11px] text-ink/60">delete for good?</span>
                              <button onClick={() => deleteMove(m.id)} className="text-[11px] font-bold text-danger">yes</button>
                              <button onClick={() => setDelRow(null)} className="text-[11px] text-ink/50">no</button>
                            </span>
                          ) : (
                            <button onClick={() => setDelRow(m.id)} title="Delete this voided movement"
                              className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-danger"><Trash2 size={14} /></button>
                          )
                        ) : canManage && !m.voided_at && (voidRow === m.id ? (
                          <span className="flex items-center justify-end gap-1.5">
                            <input value={voidWhy} autoFocus placeholder="reason"
                              onChange={(e) => setVoidWhy(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") voidMove(m.id); if (e.key === "Escape") { setVoidRow(null); setVoidWhy(""); } }}
                              className="w-36 rounded-lg border border-ink/30 px-2 py-1 text-[12px] outline-none" />
                            <button onClick={() => voidMove(m.id)} disabled={!voidWhy.trim()}
                              className="text-[11px] font-bold text-danger disabled:opacity-40">void</button>
                            <button onClick={() => { setVoidRow(null); setVoidWhy(""); }} className="text-[11px] text-ink/50">cancel</button>
                          </span>
                        ) : (
                          <span className="flex items-center justify-end gap-1">
                            <button onClick={() => startEdit(m)} title="Edit"
                              className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink"><Pencil size={14} /></button>
                            <button onClick={() => { setVoidRow(m.id); setVoidWhy(""); }} title="Void this movement"
                              className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-danger"><Undo2 size={14} /></button>
                          </span>
                        ))}
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                  {(tab === "in" ? inMoves : outMoves).length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-[13px] text-muted">
                      {moves.some((x) => x.movement_type === (tab === "in" ? "IN" : "OUT")) ? "Nothing matches these filters." : "Nothing recorded yet."}
                    </td></tr>
                  )}
                </tbody>
              </table></div>
              {tab === "in" && inMoves.length > 0 && (() => {
                const live = inMoves.filter((m) => !m.voided_at);
                const pcs = live.reduce((a, m) => a + Number(m.quantity), 0);
                const cost = live.reduce((a, m) => a + Number(m.cost_total ?? 0), 0);
                const retail = live.reduce((a, m) => a + Number(m.retail_total ?? 0), 0);
                return (
                  <p className="border-t border-line bg-panel/40 px-4 py-2.5 text-[12.5px] text-ink/75">
                    {live.length} entr{live.length === 1 ? "y" : "ies"} · <b className="tnum text-ink">{n(pcs)}</b> pieces
                    {cost > 0 && <> · cost <b className="tnum text-ink">Rs {n(cost)}</b></>}
                    {retail > 0 && <> · retail <b className="tnum text-ink">Rs {n(retail)}</b></>}
                  </p>
                );
              })()}
              {moves.length >= LIST_CAP && (
                <p className="border-t border-line bg-amber-soft px-4 py-2 text-[12px] text-ink">
                  This list holds the latest {LIST_CAP.toLocaleString()} movements; older ones are not in it. Every product&apos;s
                  own history (click its name under Products, or find it above) is complete.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {tab === "out" && (
        <>
          <InvoiceBook open={bookOpen} onClose={() => setBookOpen(false)} register={register} focus={bookFocus}
            branches={branches} items={items} manualOf={(bc) => money[bc]?.manual ?? null}
            canOut={canOut} canManage={canManage} error={regErr}
            onChanged={async () => { await Promise.all([load(), loadRegister()]); }} />
          <MissingInvoices open={missOpen && !bookOpen} onClose={closeMissing} register={register} canOut={canOut}
            onSaved={loadRegister}
            onOpenBook={(scope) => { closeMissing(); openBook({ scope }); }} />
        </>
      )}

      {/* CORRECTING A LINE ALREADY SAVED (K182).
          Everything about it, not only the number: the product it is against,
          how many, the day and the time it happened, and the note. A wrong
          barcode scanned at the bench used to mean voiding the whole line and
          recording it again under a new number, for a delivery that only ever
          happened once. */}
      <Modal open={!!editMv} onClose={() => !eBusy && setEditMv(null)} wide
        title={editMv?.movement_type === "IN" ? "Edit this GRN line" : "Edit this delivery line"}
        subtitle={editMv?.movement_no ? `${editMv.movement_no} · recorded ${when(editMv.created_at)}` : undefined}>
        {editMv && (() => {
          /* Where the two balances land if this is saved. Moving a line to
             another product takes the whole original off the one it was on
             and puts the whole new quantity on the other — so both are worth
             showing. Below zero is allowed (K181); it is said, not refused. */
          const from = items.find((i) => i.barcode === editMv.barcode);
          const to = items.find((i) => i.item_id === eItem);
          const q = parseFloat(eQty) || 0;
          const sign = editMv.movement_type === "IN" ? 1 : -1;
          const moved = !!to && !!from && to.item_id !== from.item_id;
          const toAfter = to
            ? Number(to.quantity) + (moved ? sign * q : sign * (q - Number(editMv.quantity)))
            : null;
          const fromAfter = moved && from ? Number(from.quantity) - sign * Number(editMv.quantity) : null;
          return (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Product">
                  <select value={eItem} onChange={(e) => setEItem(e.target.value)}
                    className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30">
                    <option value="">Choose…</option>
                    {items.map((i) => (
                      <option key={i.item_id} value={i.item_id}>
                        {(money[i.barcode]?.manual ?? i.barcode)} — {i.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Quantity">
                  <input type="number" value={eQty} autoFocus onChange={(e) => setEQty(e.target.value)}
                    className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
                </Field>
                <Field label="Date it happened">
                  <input type="date" value={eDate} max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setEDate(e.target.value)}
                    className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
                </Field>
                <Field label="Time">
                  <input type="time" value={eTime} onChange={(e) => setETime(e.target.value)}
                    className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
                </Field>
                {editMv.movement_type === "OUT" && (
                  <>
                    <Field label="Branch">
                      <select value={eBranch} onChange={(e) => setEBranch(e.target.value)}
                        className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30">
                        <option value="">no branch</option>
                        {branches.filter((b) => b.party === editMv.party).map((b) => <option key={b.id} value={b.id}>{b.branch}</option>)}
                      </select>
                    </Field>
                    <Field label="Party invoice number">
                      <input value={eInv} onChange={(e) => setEInv(e.target.value)}
                        className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
                    </Field>
                  </>
                )}
                <div className="sm:col-span-2">
                  <Field label={editMv.movement_type === "IN" ? "Note" : "Note (optional)"}>
                    <input value={eNote} onChange={(e) => setENote(e.target.value)}
                      className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
                  </Field>
                </div>
              </div>

              {moved && from && to && (
                <p className="mt-3 rounded-xl2 bg-amber-soft/60 px-3 py-2 text-[12px] leading-relaxed text-ink/80">
                  This line moves off <b>{from.name}</b> and onto <b>{to.name}</b>.
                  {" "}{from.name} goes to {n(fromAfter ?? 0)}, {to.name} goes to {n(toAfter ?? 0)}.
                </p>
              )}
              {!moved && toAfter != null && toAfter !== Number(to?.quantity ?? 0) && (
                <p className="mt-3 text-[12px] text-ink/70">
                  Stock goes to {n(toAfter)}{toAfter < 0 && <span className="font-semibold text-danger"> — nothing came in for these yet</span>}.
                </p>
              )}
              {editMv.original_quantity != null && (
                <p className="mt-2 text-[12px] text-hint">First recorded as {n(Number(editMv.original_quantity))}.</p>
              )}
              {eErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{eErr}</p>}

              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEditMv(null)} disabled={eBusy}
                  className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
                <button onClick={saveEdit} disabled={eBusy}
                  className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
                  {eBusy && <Loader2 size={15} className="animate-spin" />} Save changes
                </button>
              </div>
            </>
          );
        })()}
      </Modal>

      <Modal open={!!histItem} onClose={() => setHistItem(null)} title="Stock in and out" wide>
        {histItem && (
          <ItemHistory framed={false} barcode={histItem.barcode} name={histItem.name}
            manual={money[histItem.barcode]?.manual ?? null} stockNow={histItem.quantity} />
        )}
      </Modal>

      <Modal open={pOpen} onClose={() => setPOpen(false)} title="Add party or branch">
        <Field label="Belongs to (leave empty to add a new party)">
          <select value={pParty} onChange={(e) => setPParty(e.target.value)} className={inp}>
            <option value="">— new party —</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="mt-3"><Field label="Name *">
          <input value={pName} onChange={(e) => setPName(e.target.value)} autoFocus
            placeholder={pParty ? "branch name" : "party name"} className={inp} />
        </Field></div>
        <div className="mt-4 max-h-64 overflow-y-auto rounded-xl2 border border-line">
          {parties.map((pt) => (
            <div key={pt.id} className="border-b border-line/60 px-3 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                {editRow?.id === pt.id && !editRow.branch ? (
                  <input value={editVal} autoFocus
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setEditRow(null); }}
                    className="flex-1 rounded-lg border border-ink/30 px-2 py-1 text-[12.5px] outline-none" />
                ) : (
                  <span className="text-[12.5px] font-bold text-ink">{pt.name}</span>
                )}
                <span className="flex shrink-0 gap-2">
                  {editRow?.id === pt.id && !editRow.branch ? (
                    <>
                      <button onClick={saveRename} className="text-[11px] font-bold text-ink">save</button>
                      <button onClick={() => setEditRow(null)} className="text-[11px] text-ink/50">cancel</button>
                    </>
                  ) : killRow === pt.id ? (
                    <>
                      <span className="text-[11px] text-ink/60">
                        {moves.some((m) => m.party === pt.name) || branches.some((b) => b.party_id === pt.id) ? "hide it?" : "remove?"}
                      </span>
                      <button onClick={() => removeParty(pt)} className="text-[11px] font-bold text-danger">yes</button>
                      <button onClick={() => setKillRow(null)} className="text-[11px] text-ink/50">no</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setEditRow({ id: pt.id, branch: false }); setEditVal(pt.name); }}
                        className="text-[11px] font-semibold text-ink/50 hover:text-ink">rename</button>
                      <button onClick={() => setKillRow(pt.id)}
                        className="text-[11px] font-semibold text-danger/70 hover:text-danger">remove</button>
                    </>
                  )}
                </span>
              </div>

              {branches.filter((b) => b.party_id === pt.id).map((b) => (
                <div key={b.id} className="mt-1 flex items-center justify-between gap-2 pl-3">
                  {editRow?.id === b.id && editRow.branch ? (
                    <input value={editVal} autoFocus
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setEditRow(null); }}
                      className="flex-1 rounded-lg border border-ink/30 px-2 py-1 text-[12px] outline-none" />
                  ) : (
                    <span className="text-[12px] text-ink/70">{b.branch}
                      {b.deliveries > 0 && <span className="ml-1 text-[10.5px] text-hint">{b.deliveries} deliveries</span>}</span>
                  )}
                  <span className="flex shrink-0 gap-2">
                    {editRow?.id === b.id && editRow.branch ? (
                      <>
                        <button onClick={saveRename} className="text-[11px] font-bold text-ink">save</button>
                        <button onClick={() => setEditRow(null)} className="text-[11px] text-ink/50">cancel</button>
                      </>
                    ) : killRow === b.id ? (
                      <>
                        <span className="text-[11px] text-ink/60">{b.deliveries > 0 ? "hide it?" : "remove?"}</span>
                        <button onClick={() => removeBranch(b)} className="text-[11px] font-bold text-danger">yes</button>
                        <button onClick={() => setKillRow(null)} className="text-[11px] text-ink/50">no</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditRow({ id: b.id, branch: true }); setEditVal(b.branch); }}
                          className="text-[11px] font-semibold text-ink/50 hover:text-ink">rename</button>
                        <button onClick={() => setKillRow(b.id)}
                          className="text-[11px] font-semibold text-danger/70 hover:text-danger">remove</button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setPOpen(false)} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70">Cancel</button>
          <button onClick={addParty} disabled={busy} className="rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">Add</button>
        </div>
      </Modal>

      <Modal open={itemOpen} onClose={() => { setItemOpen(false); setMadeCode(null); }} title="Add product" wide>
        {madeCode ? (
          <div className="text-center">
            <div className="mx-auto max-w-xs rounded-xl2 border border-[#166534]/25 bg-success-soft p-4">
              <p className="text-[11.5px] font-bold uppercase tracking-wide text-ink/55">System barcode</p>
              <p className="mt-1 font-mono text-[30px] font-extrabold tracking-tight text-ink">{madeCode}</p>
              {bcNew.trim() && <p className="mt-1.5 font-mono text-[12.5px] text-ink/70">also {bcNew.trim()}</p>}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              <button onClick={() => { setBcNew(""); setNm(""); setNewSection(""); setNewCost(""); setNewRetail(""); setNewGst(""); setNewQty(""); setMadeCode(null); }}
                className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70">Add another</button>
              <button onClick={() => { setItemOpen(false); setMadeCode(null); }}
                className="rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white">Done</button>
            </div>
          </div>
        ) : (
          <>
            <Field label="Product name *">
              <input value={nm} autoFocus onChange={(e) => setNm(e.target.value)}
                placeholder="e.g. FS MEN HOOD ZIP W026" className={inp} />
            </Field>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Section *">
                <select value={newSection} onChange={(e) => setNewSection(e.target.value)} className={inp}>
                  <option value="">Choose…</option>
                  {[["40","Baby/Newborn"],["41","Kids"],["42","Child"],["43","Ladies"],
                    ["44","Men"],["60","Shoes"],["61","Accessories"]].map(([v,l]) => (
                    <option key={v} value={v}>{v} · {l}</option>
                  ))}
                </select>
              </Field>
              <Field label="Manual barcode">
                {/* Theirs, if a label already exists. Ours is generated on save
                    and cannot be typed. */}
                <input value={bcNew} onChange={(e) => setBcNew(e.target.value)}
                  placeholder="scan it, or leave blank" className={inp} />
              </Field>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3">
              <Field label="Cost price"><input type="number" value={newCost} onChange={(e) => setNewCost(e.target.value)} className={inp} /></Field>
              <Field label="Retail price"><input type="number" value={newRetail} onChange={(e) => setNewRetail(e.target.value)} className={inp} /></Field>
              <Field label="GST %"><input type="number" value={newGst} onChange={(e) => setNewGst(e.target.value)} placeholder="18" className={inp} /></Field>
              <Field label="Opening qty"><input type="number" value={newQty} onChange={(e) => setNewQty(e.target.value)} className={inp} /></Field>
            </div>
            {newCost && newRetail && (
              <p className="mt-2.5 text-[12.5px] text-ink/70">
                Margin <b className="text-ink">Rs {(parseFloat(newRetail) - parseFloat(newCost)).toLocaleString()}</b>
                {newGst ? ` · GST Rs ${(parseFloat(newRetail) * parseFloat(newGst) / 100).toFixed(0)}` : ""}
              </p>
            )}
            <p className="mt-2 text-[12px] text-hint">
              Barcode is generated on save — {newSection || "??"}-000001 upward, counting inside its own section.
            </p>
            {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setItemOpen(false)} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
              <button onClick={addItem} disabled={busy}
                className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
                {busy && <Loader2 size={15} className="animate-spin" />} Add product
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

export default function WarehouseScreen({ section }: { section: Tab }) {
  return <Suspense fallback={null}><WarehouseInner section={section} /></Suspense>;
}
