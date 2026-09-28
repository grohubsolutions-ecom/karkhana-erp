"use client";
/* GR OUT — stock leaving without being sold.
 *
 * Not the same thing as STR. STR moves stock on: factory to warehouse,
 * warehouse to a shop. GR out is everything else that leaves.
 *
 * TWO REASONS IT LEAVES (K186):
 *
 *   Back to a supplier    material came from an outside company and is going
 *                         back to them — wrong goods, wrong quality, not
 *                         wanted. Needs a supplier and a reason: it is a
 *                         conversation with someone who will ask.
 *
 *   Taken out of stock    nowhere to send it back to. The warehouse has no
 *                         supplier — its stock comes off the factory floor —
 *                         so a wrong entry, a damaged piece or a sample had
 *                         no way of being recorded, and the only way out was
 *                         to invent a supplier and write a return to them.
 *                         That put a lie in the book. Now it is its own
 *                         thing, and the note is optional.
 *
 * Both are ordinary OUT movements on the same ledger as everything else, told
 * apart by how the note begins — the same way returns already were.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2, Download, Printer, Loader2, Plus } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { stampAt, timeNow } from "@/lib/whenStamp";
import { exportCSV, exportExcel, exportPDF, printTable, type ExportTable } from "@/lib/export";

type Row = { id: string; movement_no: string; created_at: string; quantity: number;
             note: string | null; barcode: string; name: string;
             manual_code: string | null; section: string | null;
             cost_price: number | null; retail_price: number | null;
             cost_total: number | null; retail_total: number | null;
             voided_at: string | null };
type Item = { item_id: string; barcode: string; name: string; quantity: number;
              /* K186: the PRINTED barcode, so the search finds a product by
                 the label on it and not only by our own code. */
              manual_barcode: string | null };
/* Which of the two things is being recorded. */
type Kind = "supplier" | "writeoff";

const inp = "mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30";
const n = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const rs = (v: number) => "Rs " + Math.round(Number(v) || 0).toLocaleString();
const when = (v: string) => new Date(v).toLocaleString();

export default function ReturnsPage() {
  const { can } = usePermissions();
  /* K178: GR out is its own permission — an operator can return goods to
     the supplier without holding full control of the warehouse. */
  const canDo = can(["khana.manage", "khana.return"]);

  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState("");
  const [qty, setQty] = useState("");
  const [kind, setKind] = useState<Kind>("writeoff");
  const [why, setWhy] = useState("");
  const [supplier, setSupplier] = useState("");
  const [onDate, setOnDate] = useState("");
  /* K180: the time of day goes with the date, instead of a made-up noon. */
  const [onTime, setOnTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [fErr, setFErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true);
    const [m, i] = await Promise.all([
      supabase.from("v_khana_movements").select("*")
        .eq("movement_type", "OUT").order("created_at", { ascending: false }),
      supabase.from("v_khana_stock").select("item_id,barcode,name,quantity,manual_barcode"),
    ]);
    if (m.error) setErr(m.error.message);
    /* Both kinds are OUT movements whose note marks them as such — the same
       ledger as every other movement, so stock stays in one place. */
    setRows(((m.data as Row[]) ?? []).filter((r) => {
      const t = String(r.note ?? "");
      return t.startsWith("RETURN") || t.startsWith("STOCK OUT");
    }));
    setItems((i.data as unknown as Item[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /* K186: our code, the printed barcode, or any part of the name. A scanner
     fires the printed one; a person usually types part of the name. */
  const hits = useCallback((x: Item, t: string) =>
    x.barcode.toLowerCase().includes(t)
    || String(x.manual_barcode ?? "").toLowerCase().includes(t)
    || x.name.toLowerCase().includes(t), []);

  const found = useMemo(() => {
    const t = scan.trim().toLowerCase();
    if (!t) return null;
    /* An exact code wins outright — a scan must never be ambiguous. */
    const exact = items.find((x) => x.barcode.toLowerCase() === t)
      ?? items.find((x) => String(x.manual_barcode ?? "").toLowerCase() === t);
    if (exact) return exact;
    const near = items.filter((x) => hits(x, t));
    return near.length === 1 ? near[0] : null;
  }, [scan, items, hits]);

  const suggestions = useMemo(() => {
    const t = scan.trim().toLowerCase();
    if (!t || found) return [];
    return items.filter((x) => hits(x, t)).slice(0, 8);
  }, [scan, items, found, hits]);

  const view = useMemo(() => rows.filter((r) => {
    const d = String(r.created_at).slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    return [r.movement_no, r.name, r.barcode, r.manual_code, r.note]
      .some((x) => String(x ?? "").toLowerCase().includes(t));
  }), [rows, q, from, to]);

  const pieces = view.filter((r) => !r.voided_at).reduce((a, r) => a + Number(r.quantity || 0), 0);
  const value = view.filter((r) => !r.voided_at).reduce((a, r) => a + Number(r.cost_total || 0), 0);

  async function save() {
    if (!supabase || !found) return;
    setFErr("");
    if (!(parseFloat(qty) > 0)) { setFErr("How many pieces?"); return; }
    /* K181: goods leaving have already left the shelf. If the balance does
       not cover them it goes below zero — the line under the box says so
       before this is pressed. */
    /* A supplier will ask why; nobody asks why about a wrong entry, so that
       note stays optional (K186). */
    if (kind === "supplier" && !why.trim()) {
      setFErr("Why is it going back? The supplier will ask."); return;
    }
    if (kind === "supplier" && !supplier.trim()) {
      setFErr("Which supplier is it going back to?"); return;
    }
    setBusy(true);
    const stamp = stampAt(onDate, onTime);
    /* Only send created_at when a date was actually picked. Passing undefined
       arrives at the database as an explicit null, which the column now
       refuses outright — and before that refusal existed it read back as
       1 Jan 1970. Leaving the key out lets the column's own default stand. */
    const { error } = await supabase.from("khana_stock_movements").insert({
      item_id: found.item_id, movement_type: "OUT", quantity: parseFloat(qty),
      /* How the note begins is what tells the two apart, here and in every
         report that reads them back. */
      note: kind === "supplier"
        ? `RETURN to ${supplier.trim()} — ${why.trim()}`
        : `STOCK OUT${why.trim() ? " — " + why.trim() : ""}`,
      ...(stamp ? { created_at: stamp } : {}),
    });
    setBusy(false);
    if (error) { setFErr(error.message); return; }
    setOpen(false); setScan(""); setQty(""); setWhy(""); setSupplier(""); setOnDate(""); setOnTime(""); load();
  }

  const table = (): ExportTable => ({
    title: "Warehouse GR out",
    /* The printed barcode only — ours is internal and stays off the sheet. */
    headers: ["GRO", "Date", "Barcode", "Item description", "Catgry",
              "Qty", "Cost", "Cost total", "Kind", "Reason"],
    rows: view.map((r) => [r.movement_no, when(r.created_at),
      r.manual_code ?? "", r.name, r.section ?? "", r.quantity,
      r.cost_price ?? "", r.cost_total ?? "",
      String(r.note ?? "").startsWith("RETURN") ? "Back to supplier" : "Taken out",
      r.note ?? ""]),
  });

  return (
    <>
      <Topbar title="Warehouse — GR out"
        subtitle="Stock leaving without being sold — back to a supplier, or taken out" />

      <div className="space-y-4 px-6 pb-12">
        {err && <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-card bg-salmon-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Pieces out</p>
            <p className="mt-1.5 text-[32px] font-extrabold leading-none tracking-tight text-ink">{n(pieces)}</p>
            <p className="mt-1 text-[12px] text-ink/60">
              {view.filter((r) => String(r.note ?? "").startsWith("RETURN")).length} to suppliers ·{" "}
              {view.filter((r) => !String(r.note ?? "").startsWith("RETURN")).length} taken out
            </p>
          </div>
          <div className="rounded-card bg-amber-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Value out</p>
            <p className="mt-1.5 text-[32px] font-extrabold leading-none tracking-tight text-ink">{rs(value)}</p>
          </div>
          <div className="rounded-card bg-periwinkle-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Sending stock on?</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/70">
              Shipments to shops and branches go under <b>STR</b>. This screen is for stock that leaves
              without being sold — back to a supplier, or taken out of stock because it should not be there.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none" />
          <span className="text-[12px] text-hint">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] outline-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, code, reason…"
            className="w-full max-w-xs rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
          <button onClick={() => exportCSV(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Download size={13} /> CSV</button>
          <button onClick={() => exportExcel(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">Excel</button>
          <button onClick={() => exportPDF(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">PDF</button>
          <button onClick={() => printTable(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Printer size={13} /> Print</button>
          {canDo && (
            <button onClick={() => { setOpen(true); setScan(""); setQty(""); setWhy(""); setSupplier(""); setOnDate(""); setFErr(""); }}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white">
              <Plus size={15} /> New GR out
            </button>
          )}
        </div>

        {loading && <p className="text-[13px] text-hint">Loading…</p>}

        {!loading && view.length === 0 && (
          <div className="rounded-card border border-line bg-surface p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-panel text-ink"><Undo2 size={24} /></span>
            <p className="mt-3 text-[15px] font-semibold text-ink">Nothing returned</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
              A return is recorded when goods go back to whoever supplied them. Stock leaves and the reason stays on the record.
            </p>
          </div>
        )}

        {!loading && view.length > 0 && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className="px-4 py-3 font-bold">GRO</th>
                <th className="px-4 py-3 font-bold">Item</th>
                <th className="px-4 py-3 font-bold">Kind</th>
                <th className="px-4 py-3 text-right font-bold">Qty</th>
                <th className="px-4 py-3 text-right font-bold">Cost total</th>
                <th className="px-4 py-3 font-bold">Reason</th>
              </tr></thead>
              <tbody>
                {view.map((r, ix) => (
                  <tr key={r.id} className={`border-b border-line/60 last:border-0 ${r.voided_at ? "opacity-45" : ix % 2 ? "bg-panel/25" : ""}`}>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[12.5px] font-bold text-ink">{r.movement_no}</span>
                      <span className="block text-[11px] text-hint">{when(r.created_at)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-ink">{r.name}</span>
                      {/* The printed barcode — ours is internal and stays off
                          the lists that get read and printed. */}
                      <span className="block font-mono text-[11px] text-hint">
                        {r.manual_code ?? "no printed barcode"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {String(r.note ?? "").startsWith("RETURN") ? (
                        <span className="rounded-full bg-amber-soft px-2.5 py-1 text-[11.5px] font-semibold text-ink/80">Back to supplier</span>
                      ) : (
                        <span className="rounded-full bg-panel px-2.5 py-1 text-[11.5px] font-semibold text-ink/70">Taken out</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tnum text-[15px] font-extrabold text-ink">{n(r.quantity)}</td>
                    <td className="px-4 py-3 text-right tnum text-muted">{r.cost_total ? rs(r.cost_total) : "—"}</td>
                    <td className="max-w-[280px] px-4 py-3 text-[12px] text-muted">
                      {/* The prefix is what tells the two apart in the
                          database; the column beside this already says it, so
                          it is not repeated in every row. */}
                      {String(r.note ?? "").replace(/^STOCK OUT( — )?/, "").replace(/^RETURN (to )?/, "") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)}
        title={kind === "supplier" ? "Send goods back to the supplier" : "Take stock out"}
        subtitle={kind === "supplier"
          ? "Material that came from an outside company and is going back to them."
          : "A wrong entry, a damaged piece, a sample — stock leaving with nowhere to go back to."}>
        {/* WHICH OF THE TWO. The warehouse has no supplier, so it opens on
            the one that actually applies there and the other is a click away
            for the factory's material. */}
        <div className="mb-4 grid grid-cols-2 gap-2">
          {([["writeoff", "Taken out of stock"], ["supplier", "Back to a supplier"]] as [Kind, string][]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setKind(k); setFErr(""); }}
              className={`rounded-xl2 border px-3 py-2.5 text-[12.5px] font-semibold transition ${
                kind === k ? "border-ink bg-ink text-white" : "border-line text-ink/70 hover:bg-panel"}`}>
              {label}
            </button>
          ))}
        </div>
        <Field label="Item">
          <input value={scan} autoFocus onChange={(e) => setScan(e.target.value)}
            placeholder="scan, or type our code, the printed barcode, or the name" className={inp} />
        </Field>
        {suggestions.length > 0 && (
          <div className="mt-2 overflow-hidden rounded-xl2 border border-line">
            {suggestions.map((x) => (
              <button key={x.item_id} onClick={() => setScan(x.barcode)}
                className="flex w-full items-center justify-between gap-3 border-b border-line/60 px-3 py-2 text-left last:border-0 hover:bg-panel">
                <span>
                  <span className="text-[13px] font-semibold text-ink">{x.name}</span>
                  <span className="block font-mono text-[11px] text-hint">
                    {x.manual_barcode ?? x.barcode}
                    {x.manual_barcode && <span className="ml-1.5 text-hint/70">{x.barcode}</span>}
                  </span>
                </span>
                <span className="text-[12px] tnum text-muted">{n(x.quantity)}</span>
              </button>
            ))}
          </div>
        )}
        {found && (() => {
          /* K181: what goes back to the supplier is recorded whether or not
             the balance covers it. Below zero is shown here, not refused. */
          const after = Number(found.quantity) - (parseFloat(qty) || 0);
          return (
            <p className="mt-2 text-[12.5px] text-ink/80">
              <b>{found.name}</b> · holding {n(found.quantity)}
              {after < 0 && <span className="font-semibold text-danger"> — this takes it to {n(after)}</span>}
            </p>
          );
        })()}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="How many *">
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} className={inp} />
          </Field>
          <Field label="Date">
            <input type="date" value={onDate} max={new Date().toLocaleDateString("en-CA")}
              onChange={(e) => { setOnDate(e.target.value); if (e.target.value && !onTime) setOnTime(timeNow()); }}
              className={inp} />
          </Field>
          {onDate && (
            <Field label="Time">
              <input type="time" value={onTime} onChange={(e) => setOnTime(e.target.value)} className={inp} />
            </Field>
          )}
        </div>
        {kind === "supplier" && (
          <div className="mt-3"><Field label="Back to (supplier) *">
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. F S Traders" className={inp} />
          </Field></div>
        )}
        <div className="mt-3"><Field label={kind === "supplier" ? "Why is it going back? *" : "Note (optional)"}>
          <input value={why} onChange={(e) => setWhy(e.target.value)}
            placeholder={kind === "supplier"
              ? "wrong size, damaged, not ordered…"
              : "entered twice by mistake, damaged, sample…"}
            className={inp} />
        </Field></div>

        {fErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{fErr}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setOpen(false)} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70">Cancel</button>
          <button onClick={save} disabled={busy || !found}
            className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {kind === "supplier" ? "Record return" : "Take it out"}
          </button>
        </div>
      </Modal>
    </>
  );
}
