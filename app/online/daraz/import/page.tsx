"use client";
import { useCallback, useEffect, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { readGrid } from "@/lib/readGrid";
import { parseDaraz, type ParsedFile } from "@/lib/daraz";
import { usePermissions } from "@/lib/usePermissions";

type Imp = { id: number; kind: string; file_name: string | null; row_count: number; inserted: number; updated: number; imported_at: string };

const CHUNK = 800;

/* UPLOAD DARAZ FILES.
   Either export can be dropped here; the page works out which one it is from
   the header row, shows what it read, and only then writes. Re-uploading is
   safe: order items are updated to their newest status, statement lines that
   are already in are not added twice (unpaid → paid is updated in place). */
export default function DarazImportPage() {
  const { can } = usePermissions();
  const mayUpload = can(["hub.daraz.manage"]);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<Imp[]>([]);

  const loadHistory = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const { data } = await supabase.from("daraz_imports")
      .select("id,kind,file_name,row_count,inserted,updated,imported_at")
      .order("imported_at", { ascending: false }).limit(25);
    setHistory((data as Imp[]) ?? []);
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function pick(f: File | null) {
    setFile(f); setParsed(null); setMsg(null);
    if (!f) return;
    setReading(true);
    try {
      const grid = await readGrid(f);
      const p = await parseDaraz(grid.rows);
      if (!p) setMsg({ ok: false, text: "This doesn't look like a Daraz Orders export or Account Statement export. Check the header row has columns like Order Number / Status, or Fee Name / Amount." });
      else if (!p.rows.length) setMsg({ ok: false, text: "The header was found but there are no data rows under it." });
      setParsed(p);
    } catch (e) {
      setMsg({ ok: false, text: "Couldn't read the file: " + (e as Error).message });
    }
    setReading(false);
  }

  async function save() {
    if (!parsed || !supabase || !file) return;
    setSaving(true); setMsg(null);
    const fn = parsed.kind === "orders" ? "daraz_import_orders" : "daraz_import_statement";
    let ins = 0, upd = 0, skip = 0;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const part = parsed.rows.slice(i, i + CHUNK);
      const { data, error } = await supabase.rpc(fn, { p_file: file.name, p_rows: part });
      if (error) {
        setMsg({ ok: false, text: `Stopped at row ${i + 1}: ${error.message}. Rows before this are saved; uploading the same file again is safe.` });
        setSaving(false); loadHistory(); return;
      }
      const r = data as { inserted: number; updated: number; skipped: number };
      ins += r.inserted; upd += r.updated; skip += r.skipped;
    }
    setMsg({ ok: true, text: `${parsed.kind === "orders" ? "Order items" : "Statement lines"}: ${ins.toLocaleString()} new, ${upd.toLocaleString()} updated${skip ? `, ${skip} skipped (no ID)` : ""}.` });
    setSaving(false); setParsed(null); setFile(null); loadHistory();
  }

  const box = "rounded-card border border-line bg-surface p-5 dark:border-white/[0.06] dark:bg-[#201c17]";
  return (
    <div className="px-4 py-4 sm:px-6 md:px-10 md:py-8">
      <div className="hidden md:block">
        <h1 className="text-[22px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Daraz · Upload files</h1>
        <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">Orders export and Account Statement export from Daraz Seller Center. The file type is detected automatically.</p>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className={box}>
          {!mayUpload ? (
            <p className="text-[13px] text-muted">You can view Daraz figures but not upload files. Ask an admin for <b>hub.daraz.manage</b>.</p>
          ) : (<>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl2 border-2 border-dashed border-line px-4 py-10 text-center transition hover:bg-panel dark:border-white/10 dark:hover:bg-white/[0.04]">
              {reading ? <Loader2 className="animate-spin text-muted" /> : <Upload className="text-muted" />}
              <span className="text-[14px] font-semibold text-ink dark:text-[#f4f1ea]">{file ? file.name : "Choose a Daraz .xlsx / .csv file"}</span>
              <span className="text-[12px] text-muted dark:text-[#a89f93]">Orders export or Account Statement export</span>
              <input type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </label>

            {parsed && parsed.rows.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center gap-2 text-[14px] font-bold text-ink dark:text-[#f4f1ea]">
                  <FileSpreadsheet size={16} /> {parsed.kind === "orders" ? "Daraz Orders export" : "Daraz Account Statement"}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {parsed.preview.map((p) => (
                    <div key={p.label} className="rounded-xl2 bg-panel px-3 py-2 dark:bg-white/[0.05]">
                      <div className="text-[11.5px] text-muted dark:text-[#a89f93]">{p.label}</div>
                      <div className="text-[14px] font-bold tabular-nums text-ink dark:text-[#f4f1ea]">{p.value}</div>
                    </div>
                  ))}
                </div>
                {parsed.missing.length > 0 && (
                  <p className="mt-3 flex items-start gap-2 rounded-xl2 bg-amber-soft px-3 py-2 text-[12.5px] text-amber-900">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    Columns not found: {parsed.missing.join(", ")}. The rest will import; these fields stay blank.
                  </p>
                )}
                <button onClick={save} disabled={saving}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-[#141414]">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Import {parsed.rows.length.toLocaleString()} rows
                </button>
              </div>
            )}
          </>)}
          {msg && <p className={`mt-4 rounded-xl2 px-3 py-2 text-[13px] ${msg.ok ? "bg-success-soft text-emerald-800" : "bg-danger-soft text-danger"}`}>{msg.text}</p>}
        </div>

        <div className={box + " text-[13px] leading-relaxed text-ink dark:text-[#e7e2d8]"}>
          <div className="text-[14px] font-bold">Which files to download from Daraz</div>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li><b>Orders</b> — Seller Center → <i>Orders</i> → <i>Manage Orders</i> → tab <i>All</i> → pick the date range → <i>Export</i> → All fields. Upload daily (or every few days) so statuses stay current.</li>
            <li><b>Finance</b> — Seller Center → <i>Finance</i> → <i>Account Statements</i> → <i>Transaction Overview</i> → pick the period → <i>Export</i>. Upload every statement, and again after Daraz marks it paid.</li>
          </ol>
          <div className="mt-3 text-[14px] font-bold">Rules</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted dark:text-[#a89f93]">
            <li>Upload the file as Daraz gives it — don&apos;t delete or rename columns.</li>
            <li>Overlapping date ranges are fine; nothing is counted twice.</li>
            <li>An older orders file never moves an item back to an earlier status.</li>
          </ul>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-ink dark:text-[#f4f1ea]">Recent uploads</h2>
        <button onClick={loadHistory} className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink"><RefreshCw size={13} /> Refresh</button>
      </div>
      <div className="mt-2 overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-hint dark:border-white/[0.06]">
            <th className="px-4 py-3">When</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">File</th>
            <th className="px-4 py-3 text-right">Rows</th><th className="px-4 py-3 text-right">New</th><th className="px-4 py-3 text-right">Updated</th>
          </tr></thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {history.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">No uploads yet.</td></tr>
              : history.map((h) => (
                <tr key={h.id} className="text-ink dark:text-[#e7e2d8]">
                  <td className="px-4 py-2.5 text-muted">{new Date(h.imported_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" })}</td>
                  <td className="px-4 py-2.5">{h.kind === "orders" ? "Orders" : "Statement"}</td>
                  <td className="max-w-[260px] truncate px-4 py-2.5">{h.file_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{h.row_count.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{h.inserted.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{h.updated.toLocaleString()}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
