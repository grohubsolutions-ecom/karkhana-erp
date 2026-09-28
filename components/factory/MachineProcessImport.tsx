"use client";
/* IMPORTING A DAY'S MACHINE-PROCESS SHEET (K187).
 *
 * The floor keeps its day on one spreadsheet: four blocks side by side, one
 * per machine, each with Date · Description · Rate · Qty. This reads that
 * sheet as it is actually written rather than asking anyone to reshape it.
 *
 * WHAT IT DOES NOT DO:
 *   It does not guess. A description that matches no article is shown as
 *   unmatched and left out; a row with no rate is shown as needing one. The
 *   database takes only the rows that are complete, and the rest come back
 *   named so they can be fixed in the sheet and imported again.
 *
 *   It does not double. The database skips a row that is already recorded —
 *   same floor, same day, same article, same rate, same quantity — so
 *   importing the same sheet twice changes nothing the second time. That is
 *   also why re-importing after fixing two rows is safe: the 64 that landed
 *   the first time are skipped, and only the two new ones go in.
 *
 * THE DATE IS READ FROM EACH ROW, not from the block heading. Kashif's sheet
 * is headed "Cutting (18-09-26)" and has two rows dated the 24th inside it.
 */
import { useMemo, useRef, useState } from "react";
import { Upload, Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle } from "lucide-react";
import Modal, { Field } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

export type Staff = { id: string; name: string; dept_code: string | null };

type Parsed = {
  row: number; process: string; processLabel: string;
  worked_on: string | null; article: string; rate: number | null; quantity: number | null;
  worker_name: string;
};
type Result = { row: number; status: string; article: string; reason?: string; entry?: string };

/* The heading a block carries, and the process it means. Matched with the
   spacing and case taken out, so "Over Lock", "overlock" and "OVER-LOCK" all
   land on the same floor. */
const FLOORS: [RegExp, string, string][] = [
  [/^cutting/, "cutting", "Cutting"],
  [/^overlock/, "overlock", "Over Lock"],
  [/^flatlock/, "flatlock", "Flat Lock"],
  [/^singerlock|^singlelock/, "singerlock", "Singer Lock"],
];
const squash = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Excel hands a date back as a serial number, a Date, or text, depending on
   how the cell was typed. All three have to end up as one day — THE DAY THE
   SHEET SAYS, not a day either side of it.
 *
 * This is read as a SERIAL NUMBER on purpose. Asking the reader for Date
 * objects gives a moment in time, and a moment has a timezone: 18 Sept in
 * the sheet came back as 17 Sept once the browser applied its own offset,
 * which would have dated every entry on this page a day early. A serial is
 * just a count of days and cannot drift. The Date branch below is the
 * fallback, and reads its parts in UTC for the same reason. */
function asDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    /* Excel counts days from 30 Dec 1899. */
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  /* 18-09-26 — day first, as the sheet writes it. */
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const asNum = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export default function MachineProcessImport({
  open, onClose, staff, onDone,
}: { open: boolean; onClose: () => void; staff: Staff[]; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [parsed, setParsed] = useState<Parsed[]>([]);
  const [byFloor, setByFloor] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result[] | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; needs_attention: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const floors = useMemo(
    () => Array.from(new Set(parsed.map((p) => p.process))).sort(),
    [parsed]);
  const labelOf = (p: string) => FLOORS.find(([, k]) => k === p)?.[2] ?? p;

  function reset() {
    setParsed([]); setResult(null); setSummary(null); setErr(""); setName(""); setByFloor({});
    if (file.current) file.current.value = "";
  }

  async function pick(f: File) {
    reset(); setName(f.name); setBusy(true);
    try {
      /* Loaded only when a sheet is actually chosen — it is a large library
         and nobody visiting this page should pay for it until they import. */
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer());
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
      if (grid.length < 3) throw new Error("That sheet has no rows under its headings.");

      /* Row 1 names the blocks; row 2 names the columns inside each. Reading
         row 2 rather than counting columns means a block with an extra
         column — an Employee column, say — still lines up. */
      const heads = grid[0] ?? [];
      const cols = grid[1] ?? [];
      const blocks: { at: number; process: string; label: string; c: Record<string, number> }[] = [];
      heads.forEach((h, ci) => {
        const key = squash(h);
        if (!key) return;
        const hit = FLOORS.find(([re]) => re.test(key));
        if (!hit) return;
        const c: Record<string, number> = {};
        for (let k = ci; k < Math.min(ci + 8, cols.length); k++) {
          const t = squash(cols[k]);
          if (!t) continue;
          if (k > ci && heads[k]) break;                 // the next block starts here
          if (/^date/.test(t)) c.date = k;
          else if (/^desc|^item|^article|^product/.test(t)) c.article = k;
          else if (/^rate/.test(t)) c.rate = k;
          else if (/^qty|^quantity|^pieces/.test(t)) c.qty = k;
          else if (/^emp|^worker|^person|^name/.test(t)) c.worker = k;
        }
        if (c.article != null && c.qty != null) blocks.push({ at: ci, process: hit[1], label: hit[2], c });
      });
      if (blocks.length === 0) {
        throw new Error("No Cutting, Over Lock, Flat Lock or Singer Lock block found in the first two rows.");
      }

      const out: Parsed[] = [];
      blocks.forEach((b) => {
        for (let r = 2; r < grid.length; r++) {
          const line = grid[r] ?? [];
          const article = String(line[b.c.article] ?? "").trim();
          if (!article) continue;
          out.push({
            row: r + 1,                                  // as the spreadsheet numbers it
            process: b.process, processLabel: b.label,
            worked_on: b.c.date != null ? asDay(line[b.c.date]) : null,
            article,
            rate: b.c.rate != null ? asNum(line[b.c.rate]) : null,
            quantity: asNum(line[b.c.qty]),
            worker_name: b.c.worker != null ? String(line[b.c.worker] ?? "").trim() : "",
          });
        }
      });
      if (out.length === 0) throw new Error("The blocks are there but every row under them is empty.");
      setParsed(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That file could not be read.");
    }
    setBusy(false);
  }

  /* Every row needs a name on it. The sheet usually has no Employee column,
     so one man is chosen per floor and the rows that already name somebody
     keep the name they have. */
  const missingWorker = floors.filter(
    (f) => !byFloor[f] && parsed.some((p) => p.process === f && !p.worker_name));

  async function send() {
    if (!supabase) return;
    setErr(""); setBusy(true);
    const payload = parsed.map((p) => ({
      row: p.row, process: p.process, worked_on: p.worked_on,
      article: p.article, rate: p.rate, quantity: p.quantity,
      worker_name: p.worker_name || undefined,
      worker_employee_id: p.worker_name ? undefined : (byFloor[p.process] || undefined),
    }));
    const { data, error } = await supabase.rpc("import_machine_process", { p_rows: payload });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    const d = data as { imported: number; skipped: number; needs_attention: number; rows: Result[] };
    setSummary({ imported: d.imported, skipped: d.skipped, needs_attention: d.needs_attention });
    setResult(d.rows ?? []);
    onDone();
  }

  const trouble = (result ?? []).filter((r) => r.status !== "imported" && r.status !== "skipped_duplicate");
  const skipped = (result ?? []).filter((r) => r.status === "skipped_duplicate");

  return (
    <Modal open={open} onClose={() => { if (!busy) { reset(); onClose(); } }} wide
      title="Import a day's sheet"
      subtitle="Cutting, Over Lock, Flat Lock and Singer Lock — read straight off the spreadsheet.">

      {!parsed.length && !result && (
        <>
          <button onClick={() => file.current?.click()} disabled={busy}
            className="flex w-full flex-col items-center gap-2 rounded-xl2 border-2 border-dashed border-line px-4 py-10 text-center transition hover:bg-panel/50">
            {busy ? <Loader2 size={22} className="animate-spin text-muted" /> : <FileSpreadsheet size={22} className="text-muted" />}
            <span className="text-[13.5px] font-semibold text-ink">Choose the .xlsx sheet</span>
            <span className="text-[12px] text-muted">
              Four blocks across the top — Date, Description, Rate, Qty under each.
              An Employee column beside Qty is used if it is there.
            </span>
          </button>
          <input ref={file} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
        </>
      )}

      {/* ------------------------------------------------ what was read */}
      {parsed.length > 0 && !result && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl2 bg-panel/60 px-3.5 py-2.5">
            <p className="text-[12.5px] text-ink/80">
              <b>{name}</b> — {parsed.length} row{parsed.length === 1 ? "" : "s"} across {floors.length} floor{floors.length === 1 ? "" : "s"}
            </p>
            <button onClick={reset} className="text-[12px] font-semibold text-ink/60 hover:text-ink">choose another</button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {floors.map((f) => {
              const rows = parsed.filter((p) => p.process === f);
              const named = rows.filter((p) => p.worker_name).length;
              return (
                <div key={f} className="rounded-xl2 border border-line p-3">
                  <p className="text-[13px] font-bold text-ink">{labelOf(f)}</p>
                  <p className="mt-0.5 text-[11.5px] text-muted">
                    {rows.length} rows · {rows.reduce((a, r) => a + (r.quantity ?? 0), 0).toLocaleString()} pieces
                    {named > 0 && ` · ${named} already name someone`}
                  </p>
                  {named < rows.length && (
                    <div className="mt-2">
                      <Field label="Who did this work">
                        <select value={byFloor[f] ?? ""} onChange={(e) => setByFloor((b) => ({ ...b, [f]: e.target.value }))}
                          className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30">
                          <option value="">Choose…</option>
                          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </Field>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Anything the sheet itself cannot supply, said before the button
              rather than after it. */}
          {(() => {
            const noRate = parsed.filter((p) => p.rate == null);
            const noDay = parsed.filter((p) => !p.worked_on);
            if (!noRate.length && !noDay.length) return null;
            return (
              <div className="mt-3 flex items-start gap-2 rounded-xl2 border border-amber-strong/40 bg-amber-soft/60 px-3.5 py-2.5 text-[12.5px] text-ink/85">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  {noRate.length > 0 && <>{noRate.length} row{noRate.length === 1 ? " has" : "s have"} no rate
                    {" "}(sheet row{noRate.length === 1 ? " " : "s "}{noRate.map((r) => r.row).join(", ")}). </>}
                  {noDay.length > 0 && <>{noDay.length} row{noDay.length === 1 ? " has" : "s have"} no date. </>}
                  They will be left out and listed, so you can fill them in and import again —
                  the rows that landed today will not be entered twice.
                </span>
              </div>
            );
          })()}

          {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}

          <div className="mt-5 flex items-center justify-end gap-2">
            {missingWorker.length > 0 && (
              <p className="mr-auto text-[12px] text-muted">
                Choose who worked on {missingWorker.map(labelOf).join(" and ")}.
              </p>
            )}
            <button onClick={() => { reset(); onClose(); }} disabled={busy}
              className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
            <button onClick={send} disabled={busy || missingWorker.length > 0}
              className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Import {parsed.length} rows
            </button>
          </div>
        </>
      )}

      {/* ------------------------------------------------ what happened */}
      {result && summary && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl2 bg-success-soft p-3 text-center">
              <p className="text-[22px] font-extrabold leading-none text-ink">{summary.imported}</p>
              <p className="mt-1 text-[11.5px] font-semibold text-ink/70">recorded</p>
            </div>
            <div className="rounded-xl2 bg-panel p-3 text-center">
              <p className="text-[22px] font-extrabold leading-none text-ink">{summary.skipped}</p>
              <p className="mt-1 text-[11.5px] font-semibold text-ink/70">already there</p>
            </div>
            <div className={`rounded-xl2 p-3 text-center ${summary.needs_attention ? "bg-amber-soft" : "bg-panel"}`}>
              <p className="text-[22px] font-extrabold leading-none text-ink">{summary.needs_attention}</p>
              <p className="mt-1 text-[11.5px] font-semibold text-ink/70">need a fix</p>
            </div>
          </div>

          {summary.skipped > 0 && (
            <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-muted">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {skipped.length} row{skipped.length === 1 ? " was" : "s were"} already recorded on that day at that
              rate and quantity, so {skipped.length === 1 ? "it was" : "they were"} left alone.
            </p>
          )}

          {trouble.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl2 border border-line">
              <p className="border-b border-line bg-panel px-3.5 py-2 text-[11.5px] font-bold uppercase tracking-wide text-hint">
                Fix these in the sheet and import it again
              </p>
              <div className="max-h-56 overflow-y-auto">
                {trouble.map((t, i) => (
                  <div key={`${t.row}-${i}`} className="flex items-start justify-between gap-3 border-b border-line/60 px-3.5 py-2 last:border-0">
                    <span className="min-w-0">
                      <span className="text-[12.5px] font-semibold text-ink">{t.article || "(no name)"}</span>
                      <span className="block text-[11.5px] text-muted">{t.reason}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink/70">
                      sheet row {t.row}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => reset()}
              className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Import another</button>
            <button onClick={() => { reset(); onClose(); }}
              className="rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white">Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
