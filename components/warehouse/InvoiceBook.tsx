"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Printer, Plus, Pencil, Loader2, BookOpen, AlertTriangle, X } from "lucide-react";
import Modal, { Field } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { supabase } from "@/lib/supabase";
import { printSheet } from "@/lib/export";

/* THE INVOICE BOOK (K179) — the STR screen's invoices, as a sequence.
 *
 * Every party numbers its own invoices: Carrefour across all its branches,
 * TopShop and Online branch by branch (khana_parties.sequence_mode). This
 * shows each sequence in order — every invoice, every number recorded as
 * used without items, and every number MISSING between them — so a hole in
 * the sequence is seen, explained and saved, instead of found months later.
 *
 * From here an invoice can be opened, printed on one sheet, have an item
 * added to it, or (with full control) have its number, branch or date
 * changed as a whole. The database checks every one of those (K179); the
 * screen only offers what the person may do.
 */

export type RegRow = {
  party_id: string; party: string; sequence_mode: string;
  scope_branch_id: string | null; scope_branch: string | null;
  invoice_no: string; status: "used" | "voided" | "noted" | "missing";
  on_date: string | null; branch_id: string | null; branches: string | null;
  lines: number; pieces: number; retail: number; delivery_no: number | null;
  reason: string | null; note_id: string | null;
};
type BranchOpt = { id: string; party_id: string; branch: string };
type ItemOpt = { item_id: string; barcode: string; name: string; quantity: number };
type Line = {
  id: string; created_at: string; barcode: string; manual_code: string | null; name: string;
  quantity: number; retail_price: number | null; retail_total: number | null;
  voided_at: string | null; void_reason: string | null; branch: string | null; delivery_no: number | null;
};

export const scopeKey = (r: { party_id: string; scope_branch_id: string | null }) => `${r.party_id}|${r.scope_branch_id ?? ""}`;
export const scopeLabel = (r: RegRow) =>
  `${r.party}${r.scope_branch ? ` — ${r.scope_branch}` : r.sequence_mode === "per_party" ? " (all branches)" : " (no branch)"}`;
const numOf = (v: string) => (/^\d+$/.test(v) ? Number(v) : -1);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const localDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : "");
const n = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const inp = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink/30";
const esc = (s: unknown) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const STATUS: Record<RegRow["status"], { label: string; tone: string }> = {
  used:    { label: "Invoice",   tone: "bg-success-soft text-[#166534]" },
  voided:  { label: "Voided",    tone: "bg-panel text-muted" },
  noted:   { label: "No items",  tone: "bg-periwinkle-soft text-[#1e3a8a]" },
  missing: { label: "Missing",   tone: "bg-amber-soft text-[#7c4a03]" },
};

/* ------------------------------------------------ print one invoice */
export function printInvoice(inv: RegRow, lines: Line[]) {
  const live = lines.filter((l) => !l.voided_at);
  const pcs = live.reduce((a, l) => a + Number(l.quantity || 0), 0);
  const amt = live.reduce((a, l) => a + Number(l.retail_total || 0), 0);
  const branch = inv.branches || inv.scope_branch || "—";
  const head =
    `<div class="head"><h1>Delivery invoice ${esc(inv.invoice_no)}</h1>` +
    `<p class="meta">${esc(inv.party)} &middot; ${esc(branch)}</p></div>` +
    `<div class="box"><div class="grid">` +
    `<span>Party</span><b>${esc(inv.party)}</b><span>Invoice no</span><b>${esc(inv.invoice_no)}</b>` +
    `<span>Branch</span><b>${esc(branch)}</b><span>Date</span><b>${esc(day(inv.on_date))}</b>` +
    `<span>Delivery #</span><b>${esc(inv.delivery_no ?? "—")}</b><span>Items / pieces</span><b>${live.length} / ${esc(n(pcs))}</b>` +
    `</div></div>`;
  const table =
    `<table><thead><tr><th>#</th><th>Barcode</th><th>Item description</th>` +
    `<th>Qty</th><th>Retail</th><th>Amount</th></tr></thead><tbody>` +
    live.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.manual_code ?? "")}</td>` +
      `<td>${String(l.name ?? "").length > 34 ? `<span class="w">${esc(l.name)}</span>` : esc(l.name)}</td>` +
      `<td>${esc(n(l.quantity))}</td><td>${l.retail_price == null ? "" : esc(n(l.retail_price))}</td>` +
      `<td>${l.retail_total ? esc(n(l.retail_total)) : ""}</td></tr>`).join("") +
    `<tr class="tot"><td></td><td></td><td>Total</td><td>${esc(n(pcs))}</td><td></td><td>${amt ? esc(n(amt)) : ""}</td></tr>` +
    `</tbody></table>`;
  const foot =
    `<div class="sign"><span>Prepared by</span><span>Checked by</span><span>Received by</span></div>` +
    `<p class="foot">Printed ${esc(new Date().toLocaleString())}</p>`;
  printSheet(`Invoice ${inv.invoice_no} - ${inv.party}`, head + table + foot);
}

/* ------------------------------------------------ the book */
export default function InvoiceBook({
  open, onClose, register, focus, branches, items, manualOf, canOut, canManage, onChanged, error,
}: {
  open: boolean; onClose: () => void; register: RegRow[];
  focus: { scope: string; invoice?: string } | null;
  branches: BranchOpt[]; items: ItemOpt[]; manualOf: (barcode: string) => string | null;
  canOut: boolean; canManage: boolean; onChanged: () => Promise<void> | void; error: string;
}) {
  const confirm = useConfirm();
  const scopes = useMemo(() => {
    const m = new Map<string, RegRow>();
    register.forEach((r) => { if (!m.has(scopeKey(r))) m.set(scopeKey(r), r); });
    return [...m.entries()].sort((a, b) => scopeLabel(a[1]).localeCompare(scopeLabel(b[1])));
  }, [register]);
  const missingBy = useMemo(() => {
    const c: Record<string, number> = {};
    register.forEach((r) => { if (r.status === "missing") c[scopeKey(r)] = (c[scopeKey(r)] ?? 0) + 1; });
    return c;
  }, [register]);

  const [scope, setScope] = useState("");
  const [openInv, setOpenInv] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [newNo, setNewNo] = useState("");
  const [newWhy, setNewWhy] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr(""); setNewNo(""); setNewWhy("");
    if (focus) { setScope(focus.scope); setOpenInv(focus.invoice ?? null); return; }
    setOpenInv(null);
    const withMissing = scopes.find(([k]) => missingBy[k]);
    setScope((s) => (s && scopes.some(([k]) => k === s) ? s : (withMissing?.[0] ?? scopes[0]?.[0] ?? "")));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focus]);

  const rows = useMemo(() => register
    .filter((r) => scopeKey(r) === scope)
    .sort((a, b) => numOf(b.invoice_no) - numOf(a.invoice_no) || b.invoice_no.localeCompare(a.invoice_no)),
  [register, scope]);
  const head = rows[0];
  const used = rows.filter((r) => r.status === "used" || r.status === "voided");
  const nums = rows.map((r) => numOf(r.invoice_no)).filter((v) => v >= 0);
  const missing = rows.filter((r) => r.status === "missing");
  const current = openInv ? rows.find((r) => r.invoice_no === openInv && (r.status === "used" || r.status === "voided")) : undefined;

  const draftKey = (r: RegRow) => `${scopeKey(r)}|${r.invoice_no}`;
  const draftOf = (r: RegRow) => drafts[draftKey(r)] ?? r.reason ?? "";

  async function note(items: { invoice_no: string; reason: string }[], key: string) {
    if (!supabase || !head || items.length === 0) return;
    setBusy(key); setErr("");
    const { error } = await supabase.rpc("khana_note_invoices", {
      p_party: head.party_id, p_branch: head.scope_branch_id, p_items: items,
    });
    setBusy(null);
    if (error) { setErr(error.message); return false; }
    await onChanged();
    return true;
  }
  async function saveAllMissing() {
    const list = missing.map((r) => ({ invoice_no: r.invoice_no, reason: draftOf(r).trim() })).filter((x) => x.reason);
    if (!list.length) { setErr("Write what each missing number was used for, then save."); return; }
    await note(list, "all");
  }
  async function recordEmpty() {
    const no = newNo.trim(), why = newWhy.trim();
    if (!no) { setErr("Which invoice number?"); return; }
    if (!why) { setErr("Say what it was used for."); return; }
    if (used.some((r) => r.invoice_no === no)) { setErr(`Invoice ${no} already has items on it.`); return; }
    if (await note([{ invoice_no: no, reason: why }], "new")) { setNewNo(""); setNewWhy(""); }
  }
  async function removeNote(r: RegRow) {
    if (!supabase || !r.note_id) return;
    if (!(await confirm({ title: `Remove the note on ${r.invoice_no}?`, body: "It goes back to being a missing number (or disappears, if it was past the last invoice).", confirmLabel: "Remove note" }))) return;
    setBusy(r.note_id); setErr("");
    const { error } = await supabase.rpc("khana_delete_invoice_note", { p_id: r.note_id });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    await onChanged();
  }

  const title = current ? `Invoice ${current.invoice_no}` : "Invoice book";
  return (
    <Modal open={open} onClose={onClose} wide title={title}
      subtitle={current ? scopeLabel(current) : "Every invoice number in order — the gaps show, and each can be explained and saved"}>
      {error ? (
        <p className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{error}</p>
      ) : current ? (
        <InvoiceDetail inv={current} onBack={() => setOpenInv(null)} branches={branches} items={items}
          manualOf={manualOf} canOut={canOut} canManage={canManage}
          onChanged={async (renamed) => { await onChanged(); if (renamed) setOpenInv(renamed); }} />
      ) : scopes.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">No invoices yet. They appear here as soon as stock goes out with an invoice number.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={scope} onChange={(e) => { setScope(e.target.value); setErr(""); }} className={`${inp} max-w-sm`}>
              {scopes.map(([k, r]) => (
                <option key={k} value={k}>{scopeLabel(r)}{missingBy[k] ? ` — ${missingBy[k]} missing` : ""}</option>
              ))}
            </select>
            {head && (
              <span className="text-[12.5px] text-muted">
                {used.length} invoice{used.length === 1 ? "" : "s"}
                {nums.length > 0 && <> · {Math.min(...nums)}–{Math.max(...nums)}</>}
                {missing.length > 0 && <> · <b className="text-[#7c4a03]">{missing.length} missing</b></>}
              </span>
            )}
          </div>
          {head?.sequence_mode === "per_party" && (
            <p className="mt-1.5 text-[11.5px] text-hint">{head.party} numbers its invoices across all its branches — one sequence.</p>
          )}
          {err && <p className="mt-3 rounded-xl2 border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-ink">{err}</p>}

          {missing.length > 0 && canOut && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl2 border border-amber-strong/40 bg-amber-soft/60 px-3 py-2 text-[12.5px] text-ink">
              <AlertTriangle size={15} className="text-[#7c4a03]" />
              {missing.length} number{missing.length === 1 ? " is" : "s are"} missing. Write what each was used for and save — they stay in the sequence as used, with no items.
              <button onClick={saveAllMissing} disabled={busy === "all"}
                className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                {busy === "all" && <Loader2 size={13} className="animate-spin" />} Save all written
              </button>
            </div>
          )}

          <div className="mt-3 max-h-[52vh] overflow-auto rounded-xl2 border border-line">
            <table className="w-full text-center text-[12.5px]">
              <thead className="sticky top-0 bg-panel text-[10.5px] uppercase tracking-wide text-hint">
                <tr><th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Branch</th>
                  <th className="px-3 py-2">Items</th><th className="px-3 py-2">Pieces</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS[r.status];
                  return (
                    <tr key={r.invoice_no + r.status} className={`border-t border-line/70 ${r.status === "missing" ? "bg-amber-soft/40" : ""}`}>
                      <td className="px-3 py-2 font-mono font-bold text-ink">
                        {r.status === "used" || r.status === "voided"
                          ? <button onClick={() => setOpenInv(r.invoice_no)} className="underline decoration-line underline-offset-2 hover:decoration-ink">{r.invoice_no}</button>
                          : r.invoice_no}
                      </td>
                      <td className="px-3 py-2 text-muted">{r.status === "missing" ? "—" : day(r.on_date)}</td>
                      <td className="px-3 py-2 text-ink/80">{r.branches ?? "—"}</td>
                      <td className="px-3 py-2 tnum">{r.status === "used" ? r.lines : "—"}</td>
                      <td className="px-3 py-2 tnum">{r.status === "used" ? n(r.pieces) : "—"}</td>
                      <td className="px-3 py-2">
                        {r.status === "missing" && canOut ? (
                          <input value={draftOf(r)} placeholder="what was it used for?"
                            onChange={(e) => setDrafts((d) => ({ ...d, [draftKey(r)]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter" && draftOf(r).trim()) note([{ invoice_no: r.invoice_no, reason: draftOf(r).trim() }], draftKey(r)); }}
                            className="w-full min-w-[180px] rounded-lg border border-amber-strong/50 bg-surface px-2 py-1 text-[12px] outline-none focus:border-ink/40" />
                        ) : (
                          <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${st.tone}`}>{st.label}</span>
                            {r.reason && r.status !== "missing" && <span className="text-[12px] text-ink/75">{r.reason}</span>}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.status === "missing" && canOut && (
                          <button disabled={!draftOf(r).trim() || busy === draftKey(r)}
                            onClick={() => note([{ invoice_no: r.invoice_no, reason: draftOf(r).trim() }], draftKey(r))}
                            className="rounded-full bg-ink px-3 py-1 text-[11.5px] font-semibold text-white disabled:opacity-40">Save</button>
                        )}
                        {r.status === "noted" && canManage && (
                          <button onClick={() => removeNote(r)} disabled={busy === r.note_id} title="Remove this note"
                            className="rounded-full p-1 text-muted hover:bg-panel hover:text-danger"><X size={14} /></button>
                        )}
                        {(r.status === "used" || r.status === "voided") && (
                          <button onClick={() => setOpenInv(r.invoice_no)} className="text-[11.5px] font-semibold text-ink/60 hover:text-ink">open</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {canOut && head && (
            <div className="mt-3 rounded-xl2 border border-line p-3">
              <p className="text-[12px] font-bold text-ink">Record a number used with no items</p>
              <p className="text-[11.5px] text-muted">A cancelled invoice, a torn page, a sample — so the number is accounted for.</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_auto]">
                <input value={newNo} onChange={(e) => setNewNo(e.target.value)} placeholder="invoice no" className={`${inp} font-mono`} />
                <input value={newWhy} onChange={(e) => setNewWhy(e.target.value)} placeholder="what it was used for" className={inp} />
                <button onClick={recordEmpty} disabled={busy === "new"}
                  className="flex items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
                  {busy === "new" && <Loader2 size={14} className="animate-spin" />} Save
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------ one invoice */
function InvoiceDetail({ inv, onBack, branches, items, manualOf, canOut, canManage, onChanged }: {
  inv: RegRow; onBack: () => void; branches: BranchOpt[]; items: ItemOpt[];
  manualOf: (barcode: string) => string | null; canOut: boolean; canManage: boolean;
  onChanged: (renamedTo?: string) => Promise<void>;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"" | "edit" | "add">("");
  const [busy, setBusy] = useState(false);
  /* edit */
  const [eNo, setENo] = useState("");
  const [eDate, setEDate] = useState("");
  const [eBranch, setEBranch] = useState("");
  /* add */
  const [scan, setScan] = useState("");
  const [pick, setPick] = useState<ItemOpt | null>(null);
  const [qty, setQty] = useState("");

  async function loadLines() {
    if (!supabase) return;
    setLoading(true);
    let q = supabase.from("v_khana_movements")
      .select("id,created_at,barcode,manual_code,name,quantity,retail_price,retail_total,voided_at,void_reason,branch,delivery_no")
      .eq("movement_type", "OUT").eq("party_id", inv.party_id).eq("invoice_no", inv.invoice_no)
      .order("created_at", { ascending: true });
    if (inv.sequence_mode !== "per_party") q = inv.scope_branch_id ? q.eq("branch_id", inv.scope_branch_id) : q.is("branch_id", null);
    const { data, error } = await q;
    if (error) setErr(error.message); else setLines((data as Line[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { loadLines(); setMode(""); setErr("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv.invoice_no, inv.party_id, inv.scope_branch_id]);

  const live = lines.filter((l) => !l.voided_at);
  const pcs = live.reduce((a, l) => a + Number(l.quantity || 0), 0);
  const amt = live.reduce((a, l) => a + Number(l.retail_total || 0), 0);
  const partyBranches = branches.filter((b) => b.party_id === inv.party_id);

  const matches = useMemo(() => {
    const t = scan.trim().toLowerCase();
    if (!t || pick) return [];
    return items.filter((i) => i.barcode.toLowerCase().includes(t) || i.name.toLowerCase().includes(t)
      || String(manualOf(i.barcode) ?? "").toLowerCase().includes(t)).slice(0, 8);
  }, [scan, items, pick, manualOf]);

  function resolveScan() {
    const t = scan.trim().toLowerCase();
    if (!t) return;
    const hit = items.find((i) => i.barcode.toLowerCase() === t)
      ?? items.find((i) => String(manualOf(i.barcode) ?? "").toLowerCase() === t)
      ?? (matches.length === 1 ? matches[0] : null);
    if (hit) { setPick(hit); setScan(hit.barcode); }
  }

  async function addItem() {
    if (!supabase || !pick) return;
    const q = parseFloat(qty);
    setErr("");
    if (!(q > 0)) { setErr("How many pieces?"); return; }
    /* K181: the item is on the invoice, so it goes on the invoice. If the
       balance does not cover it the stock drops below zero and stays there
       until the arrival is entered — see the line under the picker. */
    setBusy(true);
    /* Same party, branch, number and DATE as the invoice — so the item lands
       on it, not on today. The database gives it the invoice's delivery
       number (K179). */
    const { error } = await supabase.from("khana_stock_movements").insert({
      item_id: pick.item_id, movement_type: "OUT", quantity: q,
      party_id: inv.party_id, branch_id: inv.branch_id, invoice_no: inv.invoice_no,
      ...(inv.on_date ? { created_at: inv.on_date } : {}),
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setScan(""); setPick(null); setQty("");
    await loadLines(); await onChanged();
  }

  function startEdit() {
    setENo(inv.invoice_no); setEDate(localDay(inv.on_date)); setEBranch(inv.branch_id ?? ""); setErr(""); setMode("edit");
  }
  async function saveEdit() {
    if (!supabase) return;
    const no = eNo.trim();
    if (!no) { setErr("The invoice needs a number."); return; }
    const changed = no !== inv.invoice_no || eDate !== localDay(inv.on_date) || (eBranch || null) !== (inv.branch_id || null);
    if (!changed) { setMode(""); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.rpc("khana_edit_invoice", {
      p_party: inv.party_id, p_branch: inv.scope_branch_id, p_invoice_no: inv.invoice_no,
      p_new_invoice_no: no !== inv.invoice_no ? no : null,
      p_new_branch: eBranch && eBranch !== inv.branch_id ? eBranch : null,
      p_new_date: eDate && eDate !== localDay(inv.on_date) ? eDate : null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMode("");
    await onChanged(no);
  }

  return (
    <div>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink">
        <ArrowLeft size={14} /> All invoices
      </button>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["Party", inv.party], ["Branch", inv.branches ?? inv.scope_branch ?? "—"], ["Date", day(inv.on_date)],
          ["Delivery #", inv.delivery_no ?? "—"]].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl2 bg-panel/60 px-3 py-2 text-center">
            <p className="text-[10.5px] font-bold uppercase tracking-wide text-hint">{k}</p>
            <p className="mt-0.5 text-[13px] font-semibold text-ink">{v}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => printInvoice(inv, lines)} disabled={loading || live.length === 0}
          className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:bg-panel disabled:opacity-40">
          <Printer size={14} /> Print invoice
        </button>
        {canOut && (
          <button onClick={() => { setMode(mode === "add" ? "" : "add"); setErr(""); }}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold ${mode === "add" ? "bg-ink text-white" : "border border-line text-ink hover:bg-panel"}`}>
            <Plus size={14} /> Add item
          </button>
        )}
        {canManage && (
          <button onClick={() => (mode === "edit" ? setMode("") : startEdit())}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold ${mode === "edit" ? "bg-ink text-white" : "border border-line text-ink hover:bg-panel"}`}>
            <Pencil size={14} /> Change number, date or branch
          </button>
        )}
      </div>

      {mode === "edit" && (
        <div className="mt-3 rounded-xl2 border border-line p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Invoice number"><input value={eNo} onChange={(e) => setENo(e.target.value)} className={`${inp} font-mono`} /></Field>
            <Field label="Date"><input type="date" value={eDate} max={new Date().toLocaleDateString("en-CA")} onChange={(e) => setEDate(e.target.value)} className={inp} /></Field>
            <Field label="Branch">
              <select value={eBranch} onChange={(e) => setEBranch(e.target.value)} className={inp}>
                {!inv.branch_id && <option value="">— no branch —</option>}
                {partyBranches.map((b) => <option key={b.id} value={b.id}>{b.branch}</option>)}
              </select>
            </Field>
          </div>
          <p className="mt-2 text-[11.5px] text-muted">All {lines.length} line{lines.length === 1 ? "" : "s"} move together. Stock does not change — only where and when the invoice is filed.</p>
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => setMode("")} className="rounded-full border border-line px-4 py-2 text-[12.5px] font-semibold text-ink/70">Cancel</button>
            <button onClick={saveEdit} disabled={busy} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 size={13} className="animate-spin" />} Save invoice
            </button>
          </div>
        </div>
      )}

      {mode === "add" && (
        <div className="mt-3 rounded-xl2 border border-line p-3">
          <p className="text-[12px] text-muted">Goes on invoice <b className="text-ink">{inv.invoice_no}</b>, dated {day(inv.on_date)}, to {inv.branches ?? inv.party}.</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_auto]">
            <input value={scan} autoFocus placeholder="Scan, or type a barcode or product name"
              onChange={(e) => { setScan(e.target.value); setPick(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resolveScan(); } }} className={inp} />
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Quantity" className={inp} />
            <button onClick={addItem} disabled={busy || !pick}
              className="flex items-center justify-center gap-1.5 rounded-xl2 bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
              {busy && <Loader2 size={14} className="animate-spin" />} Add to invoice
            </button>
          </div>
          {pick && (() => {
            /* K181: what this leaves behind. Shown, not enforced. */
            const after = Number(pick.quantity) - (parseFloat(qty) || 0);
            return (
              <p className="mt-1.5 text-[12.5px] text-ink/80">
                <b>{pick.name}</b> <span className="font-mono text-[12px] text-muted">{pick.barcode}</span> · holding {n(pick.quantity)}
                {after < 0 && <span className="font-semibold text-danger"> — this takes it to {n(after)}</span>}
              </p>
            );
          })()}
          {matches.length > 0 && (
            <div className="mt-2 max-h-44 overflow-y-auto rounded-xl2 border border-line">
              {matches.map((x) => (
                <button key={x.item_id} onClick={() => { setPick(x); setScan(x.barcode); }}
                  className="flex w-full items-center justify-between gap-3 border-b border-line/60 px-3 py-1.5 text-left last:border-0 hover:bg-panel">
                  <span className="text-[12.5px] font-semibold text-ink">{x.name}<span className="ml-2 font-mono text-[11px] font-normal text-hint">{x.barcode}{manualOf(x.barcode) ? ` · ${manualOf(x.barcode)}` : ""}</span></span>
                  <span className="shrink-0 text-[11.5px] text-muted">{n(x.quantity)} in stock</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {err && <p className="mt-3 rounded-xl2 border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-ink">{err}</p>}

      <div className="mt-3 overflow-x-auto rounded-xl2 border border-line">
        <table className="w-full text-center text-[12.5px]">
          <thead className="bg-panel text-[10.5px] uppercase tracking-wide text-hint">
            <tr><th className="px-3 py-2">Barcode</th><th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Qty</th><th className="px-3 py-2">Retail</th><th className="px-3 py-2">Amount</th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="py-6 text-muted">Loading…</td></tr>
            ) : lines.map((l) => (
              <tr key={l.id} className={`border-t border-line/70 ${l.voided_at ? "opacity-45 line-through" : ""}`}>
                <td className="px-3 py-2 font-mono text-[12px]">{l.manual_code ?? "—"}</td>
                <td className="px-3 py-2 font-semibold text-ink">{l.name}{l.voided_at && <span className="ml-1 text-[11px] font-normal no-underline">(voided)</span>}</td>
                <td className="px-3 py-2 tnum font-bold">{n(l.quantity)}</td>
                <td className="px-3 py-2 tnum text-muted">{l.retail_price == null ? "—" : n(l.retail_price)}</td>
                <td className="px-3 py-2 tnum">{l.retail_total ? n(l.retail_total) : "—"}</td>
              </tr>
            ))}
            {!loading && (
              <tr className="border-t-2 border-line bg-panel/40 font-extrabold">
                <td className="px-3 py-2" colSpan={2}>Total — {live.length} item{live.length === 1 ? "" : "s"}</td>
                <td className="px-3 py-2 tnum">{n(pcs)}</td><td></td><td className="px-3 py-2 tnum">{amt ? n(amt) : "—"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------ the pop-up
   Opens by itself on the STR screen when a sequence has holes nobody has
   explained yet. "Later" puts it away for this sitting; it comes back when a
   new hole appears, and the Invoice book button keeps the count in view. */
export function MissingInvoices({ open, onClose, register, canOut, onSaved, onOpenBook }: {
  open: boolean; onClose: () => void; register: RegRow[]; canOut: boolean;
  onSaved: () => Promise<void> | void; onOpenBook: (scope: string) => void;
}) {
  const missing = register.filter((r) => r.status === "missing");
  const groups = useMemo(() => {
    const m = new Map<string, RegRow[]>();
    missing.forEach((r) => m.set(scopeKey(r), [...(m.get(scopeKey(r)) ?? []), r]));
    return [...m.entries()];
  }, [missing]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (open) { setErr(""); } }, [open]);
  const key = (r: RegRow) => `${scopeKey(r)}|${r.invoice_no}`;
  const val = (r: RegRow) => drafts[key(r)] ?? r.reason ?? "";

  async function save() {
    if (!supabase) return;
    setErr("");
    const todo = groups.map(([, rs]) => ({ head: rs[0], items: rs.map((r) => ({ invoice_no: r.invoice_no, reason: val(r).trim() })).filter((x) => x.reason) }))
      .filter((g) => g.items.length);
    if (!todo.length) { setErr("Write what at least one number was used for."); return; }
    setBusy(true);
    for (const g of todo) {
      const { error } = await supabase.rpc("khana_note_invoices", { p_party: g.head.party_id, p_branch: g.head.scope_branch_id, p_items: g.items });
      if (error) { setBusy(false); setErr(`${scopeLabel(g.head)}: ${error.message}`); await onSaved(); return; }
    }
    setBusy(false);
    await onSaved();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Invoices missing from the sequence"
      subtitle="These numbers sit between invoices already given, but nothing is recorded under them. Say what each was used for — cancelled, spoiled, sample — so the sequence stays complete.">
      <div className="max-h-[55vh] space-y-3 overflow-y-auto">
        {groups.map(([k, rs]) => (
          <div key={k} className="rounded-xl2 border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[12.5px] font-bold text-ink">{scopeLabel(rs[0])}</p>
              <button onClick={() => onOpenBook(k)} className="flex items-center gap-1 text-[11.5px] font-semibold text-ink/60 hover:text-ink">
                <BookOpen size={13} /> see the sequence
              </button>
            </div>
            {rs.map((r) => (
              <div key={r.invoice_no} className="mt-1.5 grid grid-cols-[72px_1fr] items-center gap-2">
                <span className="rounded-lg bg-amber-soft px-2 py-1.5 text-center font-mono text-[12.5px] font-bold text-[#7c4a03]">{r.invoice_no}</span>
                {canOut ? (
                  <input value={val(r)} onChange={(e) => setDrafts((d) => ({ ...d, [key(r)]: e.target.value }))}
                    placeholder="what was it used for?" className={inp} />
                ) : <span className="text-[12px] text-muted">{r.reason ?? "not explained yet"}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {err && <p className="mt-3 rounded-xl2 border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-ink">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-full border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70">Later</button>
        {canOut && (
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-full bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Save descriptions
          </button>
        )}
      </div>
    </Modal>
  );
}
