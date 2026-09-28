"use client";
/* IMPORTING A DAY'S MACHINE-PROCESS SHEET (K187, K188).
 *
 * The floor keeps its day on one spreadsheet: four blocks side by side, one
 * per machine, each with Date · Description · Rate · Qty. This reads that
 * sheet as it is actually written rather than asking anyone to reshape it.
 *
 * WHAT COMES BACK IS A WORKING SHEET, NOT A PREVIEW. Every cell can be
 * changed before anything is written, rows can be added and rows can be
 * thrown away — because a paper sheet is never quite right: a rate is
 * missing, a name was left off, something was cut that nobody wrote down.
 * Fixing it here beats importing something known to be wrong and correcting
 * nine entries afterwards.
 *
 * WHAT IT STILL DOES NOT DO:
 *   It does not guess. An article is chosen from the list, never matched on
 *   a resemblance. A row that is not complete is marked and cannot be sent.
 *
 *   It does not double. The database skips a row already recorded — same
 *   floor, same day, same article, same rate, same quantity — so importing
 *   the same sheet twice changes nothing the second time.
 *
 * THE DATE IS READ FROM EACH ROW, not from the block heading. Kashif's sheet
 * is headed "Cutting (18-09-26)" and has two rows dated the 24th inside it.
 */
import { useMemo, useRef, useState } from "react";
import { Upload, Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, Plus, X, UserPlus } from "lucide-react";
import Modal, { Field } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

export type Staff = { id: string; name: string; dept_code: string | null };
export type Art = { id: string; name: string; system_barcode: string | null };

type Line = {
  key: number; row: number | null;          // null once it is one of ours, not the sheet's
  process: string; worked_on: string; articleId: string;
  rate: string; quantity: string; employeeId: string; workerName: string;
};
type Result = { row: number | null; status: string; article: string; reason?: string; entry?: string };

const FLOORS: [RegExp, string, string, string][] = [
  [/^cutting/, "cutting", "Cutting", "CUT"],
  [/^overlock/, "overlock", "Over Lock", "OVERLOCK"],
  [/^flatlock/, "flatlock", "Flat Lock", "FLATLOCK"],
  [/^singerlock|^singlelock/, "singerlock", "Singer Lock", "SINGLELOCK"],
];
const labelOf = (p: string) => FLOORS.find(([, k]) => k === p)?.[2] ?? p;
const deptOf = (p: string) => FLOORS.find(([, k]) => k === p)?.[3] ?? "CUT";
const squash = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const today = () => new Date().toLocaleDateString("en-CA");

/* Excel hands a date back as a serial number, a Date, or text, depending on
   how the cell was typed. All three have to end up as one day — THE DAY THE
   SHEET SAYS, not a day either side of it.

   This is read as a SERIAL NUMBER on purpose. Asking the reader for Date
   objects gives a moment in time, and a moment has a timezone: 18 Sept came
   back as 17 Sept once the browser applied its own offset, which would have
   dated every entry a day early. A serial is a count of days and cannot
   drift. The Date branch reads its parts in UTC for the same reason. */
function asDay(v: unknown): string {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);   // 18-09-26, day first
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
const asNum = (v: unknown) => {
  if (v == null || v === "") return "";
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? String(n) : "";
};

const cell = "w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-ink/40";

export default function MachineProcessImport({
  open, onClose, staff, arts, onDone, onReload,
}: {
  open: boolean; onClose: () => void;
  staff: Staff[]; arts: Art[];
  onDone: () => void; onReload: () => Promise<void> | void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [name, setName] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [result, setResult] = useState<Result[] | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; needs_attention: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  /* Adding someone without leaving the sheet. */
  const [addWho, setAddWho] = useState(false);
  const [nwName, setNwName] = useState("");
  const [nwFloor, setNwFloor] = useState("cutting");

  /* By name, so a sheet that DOES carry an Employee column still matches a
     person on the staff list rather than being stored as loose text. */
  const byName = useMemo(() => {
    const m = new Map<string, string>();
    staff.forEach((s) => m.set(squash(s.name), s.id));
    return m;
  }, [staff]);

  const artById = useMemo(() => new Map(arts.map((a) => [a.id, a])), [arts]);
  const artByName = useMemo(() => {
    const m = new Map<string, string>();
    arts.forEach((a) => m.set(squash(a.name), a.id));
    return m;
  }, [arts]);

  function reset() {
    setLines([]); setResult(null); setSummary(null); setErr(""); setName("");
    setAddWho(false); setNwName("");
    if (file.current) file.current.value = "";
  }

  const blank = (process = "cutting", worked_on = today()): Line => ({
    key: ++seq.current, row: null, process, worked_on,
    articleId: "", rate: "", quantity: "", employeeId: "", workerName: "",
  });

  async function pick(f: File) {
    reset(); setName(f.name); setBusy(true);
    try {
      /* Loaded only when a sheet is chosen — a large library nobody visiting
         this page should pay for until they import. */
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
      const blocks: { process: string; c: Record<string, number> }[] = [];
      heads.forEach((h, ci) => {
        const key = squash(h);
        if (!key) return;
        const hit = FLOORS.find(([re]) => re.test(key));
        if (!hit) return;
        const c: Record<string, number> = {};
        for (let k = ci; k < Math.min(ci + 8, cols.length); k++) {
          if (k > ci && heads[k]) break;                 // the next block starts here
          const t = squash(cols[k]);
          if (!t) continue;
          if (/^date/.test(t)) c.date = k;
          else if (/^desc|^item|^article|^product/.test(t)) c.article = k;
          else if (/^rate/.test(t)) c.rate = k;
          else if (/^qty|^quantity|^pieces/.test(t)) c.qty = k;
          else if (/^emp|^worker|^person|^name/.test(t)) c.worker = k;
        }
        if (c.article != null && c.qty != null) blocks.push({ process: hit[1], c });
      });
      if (blocks.length === 0) {
        throw new Error("No Cutting, Over Lock, Flat Lock or Singer Lock block found in the first two rows.");
      }

      const out: Line[] = [];
      blocks.forEach((b) => {
        for (let r = 2; r < grid.length; r++) {
          const line = grid[r] ?? [];
          const text = String(line[b.c.article] ?? "").trim();
          if (!text) continue;
          const who = b.c.worker != null ? String(line[b.c.worker] ?? "").trim() : "";
          out.push({
            key: ++seq.current,
            row: r + 1,                                  // as the spreadsheet numbers it
            process: b.process,
            worked_on: b.c.date != null ? asDay(line[b.c.date]) : "",
            /* Matched to an article by name, or left empty to be chosen.
               Never stored as loose text. */
            articleId: artByName.get(squash(text)) ?? "",
            rate: b.c.rate != null ? asNum(line[b.c.rate]) : "",
            quantity: asNum(line[b.c.qty]),
            employeeId: who ? (byName.get(squash(who)) ?? "") : "",
            workerName: who,
          });
        }
      });
      if (out.length === 0) throw new Error("The blocks are there but every row under them is empty.");
      setLines(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That file could not be read.");
    }
    setBusy(false);
  }

  const set = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const bad = (l: Line) =>
    !l.articleId || !l.worked_on || l.rate === "" || !(parseFloat(l.quantity) > 0)
    || (!l.employeeId && !l.workerName.trim());
  const incomplete = lines.filter(bad);

  /* Fills every row on a floor that has nobody on it yet. The fast way in,
     with each row still free to say someone else. */
  function fillFloor(process: string, id: string) {
    setLines((ls) => ls.map((l) =>
      l.process === process && !l.employeeId && !l.workerName.trim()
        ? { ...l, employeeId: id } : l));
  }

  async function addPerson() {
    if (!supabase || !nwName.trim()) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("add_factory_employee", {
      p_name: nwName.trim(), p_department_code: deptOf(nwFloor),
      p_rate: null, p_phone: null, p_cnic: null, p_employment: "casual",
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onReload();
    const made = data as Record<string, unknown>;
    /* Put him straight onto the rows of his floor that have nobody. */
    if (made?.id) fillFloor(nwFloor, String(made.id));
    setAddWho(false); setNwName("");
  }

  async function send() {
    if (!supabase) return;
    setErr(""); setBusy(true);
    const payload = lines.map((l) => ({
      row: l.row, process: l.process, worked_on: l.worked_on,
      article: artById.get(l.articleId)?.name ?? "",
      rate: l.rate === "" ? null : Number(l.rate),
      quantity: l.quantity === "" ? null : Number(l.quantity),
      worker_employee_id: l.employeeId || undefined,
      worker_name: l.employeeId ? undefined : (l.workerName.trim() || undefined),
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
  const floors = Array.from(new Set(lines.map((l) => l.process)));

  return (
    <Modal open={open} onClose={() => { if (!busy) { reset(); onClose(); } }} wide
      title={lines.length ? "Check the day before it goes in" : "Import a day's sheet"}
      subtitle={lines.length
        ? "Every cell can be changed, rows can be added, and anything wrong can be thrown out."
        : "Cutting, Over Lock, Flat Lock and Singer Lock — read straight off the spreadsheet."}>

      {/* ------------------------------------------------ choose a file */}
      {!lines.length && !result && (
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
          <div className="mt-3 flex justify-center">
            <button onClick={() => setLines([blank()])}
              className="text-[12.5px] font-semibold text-ink/60 underline decoration-line underline-offset-2 hover:text-ink">
              or start an empty day and type it in
            </button>
          </div>
          {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
        </>
      )}

      {/* ------------------------------------------------ the working sheet */}
      {lines.length > 0 && !result && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl2 bg-panel/60 px-3.5 py-2.5">
            <p className="text-[12.5px] text-ink/80">
              {name ? <><b>{name}</b> — </> : null}
              {lines.length} row{lines.length === 1 ? "" : "s"}
              {incomplete.length > 0 && (
                <span className="ml-1 font-semibold text-danger">· {incomplete.length} not ready</span>
              )}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setAddWho((v) => !v)}
                className="flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink">
                <UserPlus size={13} /> Add someone
              </button>
              <button onClick={reset} className="text-[12px] font-semibold text-ink/60 hover:text-ink">start over</button>
            </div>
          </div>

          {addWho && (
            <div className="mt-2 rounded-xl2 border border-line p-3">
              <p className="text-[11.5px] font-bold uppercase tracking-wide text-hint">New person</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px_auto]">
                <input value={nwName} onChange={(e) => setNwName(e.target.value)} autoFocus
                  placeholder="his name" className={cell} />
                <select value={nwFloor} onChange={(e) => setNwFloor(e.target.value)} className={cell}>
                  {FLOORS.map(([, k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button onClick={addPerson} disabled={busy || !nwName.trim()}
                  className="rounded-lg bg-ink px-3.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40">
                  {busy && <Loader2 size={12} className="mr-1 inline animate-spin" />} Add him
                </button>
              </div>
              <p className="mt-1.5 text-[11.5px] text-hint">
                He joins that floor&apos;s staff and goes onto its rows that have nobody yet.
              </p>
            </div>
          )}

          {/* One man for a whole floor, then change the odd row. */}
          {floors.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {floors.map((f) => (
                <div key={f} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1">
                  <span className="text-[11.5px] font-semibold text-ink/70">{labelOf(f)}</span>
                  <select defaultValue="" onChange={(e) => { fillFloor(f, e.target.value); e.currentTarget.value = ""; }}
                    className="rounded-md border-0 bg-transparent py-0 pl-1 pr-5 text-[11.5px] text-ink/60 outline-none">
                    <option value="">set everyone…</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 overflow-hidden rounded-xl2 border border-line">
            <div className="max-h-[46vh] overflow-auto">
              <table className="w-full min-w-[880px] text-left">
                <thead className="sticky top-0 z-10 bg-panel text-[10.5px] uppercase tracking-wide text-hint">
                  <tr>
                    <th className="px-2 py-2 font-bold">Floor</th>
                    <th className="px-2 py-2 font-bold">Date</th>
                    <th className="px-2 py-2 font-bold">Article</th>
                    <th className="w-[88px] px-2 py-2 font-bold">Rate</th>
                    <th className="w-[88px] px-2 py-2 font-bold">Qty</th>
                    <th className="px-2 py-2 font-bold">Who did it</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} className={`border-t border-line/60 ${bad(l) ? "bg-danger-soft/25" : ""}`}>
                      <td className="px-2 py-1.5">
                        <select value={l.process} onChange={(e) => set(l.key, { process: e.target.value })} className={cell}>
                          {FLOORS.map(([, k, lab]) => <option key={k} value={k}>{lab}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="date" value={l.worked_on} max={today()}
                          onChange={(e) => set(l.key, { worked_on: e.target.value })} className={cell} />
                      </td>
                      <td className="px-2 py-1.5">
                        <select value={l.articleId} onChange={(e) => set(l.key, { articleId: e.target.value })} className={cell}>
                          <option value="">Choose…</option>
                          {arts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input value={l.rate} inputMode="decimal" placeholder="—"
                          onChange={(e) => set(l.key, { rate: e.target.value })} className={`${cell} text-right`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input value={l.quantity} inputMode="decimal" placeholder="—"
                          onChange={(e) => set(l.key, { quantity: e.target.value })} className={`${cell} text-right`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <select value={l.employeeId} onChange={(e) => set(l.key, { employeeId: e.target.value, workerName: "" })} className={cell}>
                          <option value="">{l.workerName ? `${l.workerName} — not on the list` : "Choose…"}</option>
                          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                          title="Throw this row away"
                          className="rounded-full p-1 text-muted transition hover:bg-panel hover:text-danger">
                          <X size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={() => setLines((ls) => [...ls, blank(ls[ls.length - 1]?.process, ls[ls.length - 1]?.worked_on || today())])}
              className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-panel/40 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">
              <Plus size={13} /> Add a row
            </button>
          </div>

          {incomplete.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-ink/70">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
              {incomplete.length} row{incomplete.length === 1 ? "" : "s"} still need an article, a date, a rate,
              a quantity or a name. Fill them in, or throw them away with the ×.
            </p>
          )}
          {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button onClick={() => { reset(); onClose(); }} disabled={busy}
              className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
            <button onClick={send} disabled={busy || incomplete.length > 0 || lines.length === 0}
              className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Record {lines.length} rows
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
              <p className="mt-1 text-[11.5px] font-semibold text-ink/70">not taken</p>
            </div>
          </div>

          {summary.skipped > 0 && (
            <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-muted">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {summary.skipped} row{summary.skipped === 1 ? " was" : "s were"} already recorded on that day at that
              rate and quantity, so {summary.skipped === 1 ? "it was" : "they were"} left alone.
            </p>
          )}

          {trouble.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl2 border border-line">
              <p className="border-b border-line bg-panel px-3.5 py-2 text-[11.5px] font-bold uppercase tracking-wide text-hint">
                Not taken
              </p>
              <div className="max-h-56 overflow-y-auto">
                {trouble.map((t, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 border-b border-line/60 px-3.5 py-2 last:border-0">
                    <span className="min-w-0">
                      <span className="text-[12.5px] font-semibold text-ink">{t.article || "(no article)"}</span>
                      <span className="block text-[11.5px] text-muted">{t.reason}</span>
                    </span>
                    {t.row != null && (
                      <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink/70">
                        sheet row {t.row}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button onClick={reset}
              className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Import another</button>
            <button onClick={() => { reset(); onClose(); }}
              className="rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white">Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
