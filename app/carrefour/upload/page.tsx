"use client";
/* CARREFOUR — UPLOAD A STOCK REPORT (K192)
 *
 * Carrefour's file is one row per article with a stock column per shop —
 * GUJ_S, WTC_S, EMP_S … — plus TOTAL_S. Read as it is: nobody reshapes it.
 *
 *   1. pick the DATE the report is for (the file does not carry one)
 *   2. pick the file — every shop column is read, and its total shown
 *   3. any shop code not matched yet is matched here, once, and remembered
 *   4. a shop that already has a report for that date is said out loud;
 *      it goes in only if "replace" is ticked
 *   5. Upload
 *
 * A shop column that is empty in every row is a Carrefour shop that carries
 * none of our goods. It is skipped rather than asked about each time.
 *
 * A file laid out the other way — one row per shop and article, with a shop
 * column and a quantity column — is read too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { FileSpreadsheet, Loader2, Upload, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react";
import Topbar from "@/components/Topbar";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";

type Shop = { branch_id: string; name: string; last_report: string | null; reports: number };
type Line = { shop: string; barcode: string; name: string; qty: number; price: number | null };
type Col = { code: string; pieces: number; articles: number; branchId: string };
type Upload = { report_id: string; report_date: string; file_name: string | null; uploaded_at: string;
                uploaded_by: string; shops: number; lines: number; pieces: number; unmatched: number };

const today = () => new Date().toLocaleDateString("en-CA");
const n = (v: number) => Number(v || 0).toLocaleString();
const day = (v: string) => new Date(v + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const norm = (v: unknown) => String(v ?? "").trim();
const numv = (v: unknown) => { const x = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };

/* Read the sheet into lines, whichever way round it is laid out. */
function readFile(grid: unknown[][]): { lines: Line[]; skipped: string[]; error?: string } {
  const hi = grid.findIndex((r) => r.some((c) => /barc/i.test(norm(c))));
  if (hi < 0) return { lines: [], skipped: [], error: "No barcode column found in the file." };
  const h = grid[hi].map((c) => norm(c));
  const find = (re: RegExp) => h.findIndex((c) => re.test(c));
  const bi = find(/barc/i);
  const ni = find(/^itmdsc$|desc|article|item\s*name|^name$/i);
  const pi = find(/^pp$|price|retail/i);
  const body = grid.slice(hi + 1).filter((r) => norm(r[bi]) !== "");

  /* Wide: a column per shop, headed CODE_S. */
  const shopCols = h.map((c, i) => ({ c, i })).filter(({ c }) => /_S$/i.test(c) && !/^TOTAL_S$/i.test(c));
  if (shopCols.length) {
    const lines: Line[] = []; const skipped: string[] = [];
    shopCols.forEach(({ c, i }) => {
      const code = c.replace(/_S$/i, "");
      if (!body.some((r) => numv(r[i]) !== 0)) { skipped.push(code); return; }
      body.forEach((r) => lines.push({ shop: code, barcode: norm(r[bi]), name: ni >= 0 ? norm(r[ni]) : "",
        qty: numv(r[i]), price: pi >= 0 ? numv(r[pi]) || null : null }));
    });
    return { lines, skipped };
  }
  /* Long: a shop column and a quantity column. */
  const si = find(/shop|store|branch|location|outlet/i);
  const qi = find(/qty|quantity|stock|soh|on\s*hand/i);
  if (si < 0 || qi < 0) return { lines: [], skipped: [], error: "Could not find the shop columns (like GUJ_S, WTC_S) or a shop + quantity column." };
  return { skipped: [], lines: body.map((r) => ({ shop: norm(r[si]), barcode: norm(r[bi]), name: ni >= 0 ? norm(r[ni]) : "",
    qty: numv(r[qi]), price: pi >= 0 ? numv(r[pi]) || null : null })) };
}

export default function CarrefourUploadPage() {
  const { can } = usePermissions();
  const canUpload = can(["carrefour.upload"]);
  const file = useRef<HTMLInputElement>(null);

  const [shops, setShops] = useState<Shop[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [date, setDate] = useState(today());
  const [fileName, setFileName] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [cols, setCols] = useState<Col[]>([]);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<null | { shops: number; lines: number; unmatched: number; replaced: boolean }>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    const [s, u] = await Promise.all([supabase.rpc("carrefour_shops"), supabase.rpc("carrefour_uploads")]);
    if (!s.error) setShops((s.data ?? []) as Shop[]);
    if (!u.error) setUploads(((u.data ?? []) as Upload[]).map((x) => ({ ...x, pieces: Number(x.pieces) })));
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  /* Which shops already have a report on the chosen date. */
  useEffect(() => {
    if (!supabase || !date) return;
    supabase.rpc("carrefour_shops_on", { p_date: date }).then(({ data }) =>
      setTaken(new Set(((data ?? []) as { branch_id: string }[]).map((x) => x.branch_id))));
  }, [date, done]);

  async function pick(f: File) {
    if (!supabase) return;
    setErr(""); setDone(null); setBusy(true); setFileName(f.name);
    try {
      const wb = XLSX.read(await f.arrayBuffer());
      const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
      const r = readFile(grid);
      if (r.error) { setErr(r.error); setLines([]); setCols([]); setBusy(false); return; }
      setLines(r.lines); setSkipped(r.skipped);
      /* One entry per shop code, with what the database already knows of it. */
      const codes = [...new Set(r.lines.map((l) => l.shop))];
      const matched = await Promise.all(codes.map((c) => supabase!.rpc("carrefour_match_shop", { p_name: c })));
      setCols(codes.map((c, i) => {
        const of = r.lines.filter((l) => l.shop === c);
        return { code: c, pieces: of.reduce((a, l) => a + l.qty, 0), articles: of.length, branchId: (matched[i].data as string | null) ?? "" };
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That file could not be read.");
    }
    setBusy(false);
  }

  async function matchShop(code: string, branchId: string) {
    if (!supabase || !branchId) return;
    const { error } = await supabase.rpc("set_carrefour_shop_alias", { p_alias: code, p_branch: branchId });
    if (error) { setErr(error.message); return; }
    setCols((cs) => cs.map((c) => c.code === code ? { ...c, branchId } : c));
  }

  const unmatched = cols.filter((c) => !c.branchId);
  const clashes = cols.filter((c) => c.branchId && taken.has(c.branchId));
  const total = useMemo(() => cols.reduce((a, c) => a + c.pieces, 0), [cols]);
  const ready = lines.length > 0 && unmatched.length === 0 && !!date && (clashes.length === 0 || replace);

  async function send() {
    if (!supabase || !ready) return;
    setBusy(true); setErr("");
    const byCode = new Map(cols.map((c) => [c.code, c.branchId]));
    const payload = lines.map((l) => ({ shop: l.shop, branch_id: byCode.get(l.shop) || null, barcode: l.barcode,
      name: l.name, qty: l.qty, price: l.price }));
    const { data, error } = await supabase.rpc("import_carrefour_report",
      { p_date: date, p_file: fileName, p_rows: payload, p_replace: replace });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    const d = data as { ok: boolean; message?: string; shops?: number; lines?: number; unmatched_barcodes?: number; replaced?: boolean; already_uploaded?: string[]; unknown_shops?: string[] };
    if (!d.ok) {
      setErr([d.message, d.already_uploaded?.join(", "), d.unknown_shops?.join(", ")].filter(Boolean).join(" "));
      return;
    }
    setDone({ shops: d.shops ?? 0, lines: d.lines ?? 0, unmatched: d.unmatched_barcodes ?? 0, replaced: !!d.replaced });
    setLines([]); setCols([]); setSkipped([]); setReplace(false); setFileName("");
    if (file.current) file.current.value = "";
    loadAll();
  }

  async function removeUpload(id: string) {
    if (!supabase) return;
    const { error } = await supabase.rpc("delete_carrefour_upload", { p_report: id });
    setConfirmDel(null);
    if (error) { setErr(error.message); return; }
    setDone(null); loadAll();
  }

  const shopName = (id: string) => shops.find((s) => s.branch_id === id)?.name ?? "";

  return (
    <>
      <Topbar title="Carrefour — upload report" subtitle="Carrefour's stock file, filed under the date it is for" />
      <div className="space-y-4 px-6 pb-12">
        {!canUpload && (
          <div className="rounded-xl2 border border-line bg-panel px-4 py-3 text-[13px] text-ink/75">
            You can see Carrefour reports but not upload them. Ask for the <b>Upload Carrefour stock reports</b> permission.
          </div>
        )}
        {err && <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>}
        {done && (
          <div className="flex items-start gap-2 rounded-xl2 border border-success/40 bg-success-soft px-4 py-3 text-[13px] text-ink">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <span>
              <b>Uploaded{done.replaced ? " (replacing the earlier one)" : ""}:</b> {done.shops} shops, {n(done.lines)} lines for {day(date)}.
              {done.unmatched > 0 && <> {done.unmatched} barcode{done.unmatched === 1 ? " is" : "s are"} not in our products and {done.unmatched === 1 ? "is" : "are"} kept as written.</>}
              {" "}<Link href="/carrefour" className="font-semibold underline">See stock &amp; sales →</Link>
            </span>
          </div>
        )}

        {canUpload && (
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[12px] font-semibold text-ink/70">
                Report date
                <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)}
                  className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
              </label>
              <button onClick={() => file.current?.click()} disabled={busy}
                className="flex items-center gap-2 rounded-xl2 border border-line px-4 py-2 text-[13px] font-semibold text-ink/80 hover:bg-panel">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <FileSpreadsheet size={15} />}
                {fileName || "Choose the Carrefour file (.xlsx)"}
              </button>
              <input ref={file} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
            </div>

            {cols.length > 0 && (
              <>
                <div className="mt-4 overflow-hidden rounded-xl2 border border-line">
                  <table className="w-full text-left text-[13px]">
                    <thead><tr className="border-b border-line bg-panel/50 text-[11px] uppercase tracking-wide text-hint">
                      <th className="px-3 py-2 font-bold">In the file</th>
                      <th className="px-3 py-2 font-bold">Our shop</th>
                      <th className="px-3 py-2 text-right font-bold">Articles</th>
                      <th className="px-3 py-2 text-right font-bold">Pieces</th>
                      <th className="px-3 py-2 font-bold" />
                    </tr></thead>
                    <tbody>
                      {cols.map((c) => (
                        <tr key={c.code} className="border-b border-line/60 last:border-0">
                          <td className="px-3 py-2 font-mono text-[12px] font-semibold text-ink">{c.code}</td>
                          <td className="px-3 py-2">
                            <select value={c.branchId} onChange={(e) => matchShop(c.code, e.target.value)}
                              className={`rounded-lg border px-2 py-1 text-[12.5px] outline-none ${c.branchId ? "border-line" : "border-amber-strong bg-amber-soft/50"}`}>
                              <option value="">Which shop is this?</option>
                              {shops.map((s) => <option key={s.branch_id} value={s.branch_id}>{s.name}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right tnum">{c.articles}</td>
                          <td className="px-3 py-2 text-right tnum font-semibold">{n(c.pieces)}</td>
                          <td className="px-3 py-2 text-[12px]">
                            {c.branchId && taken.has(c.branchId) && <span className="font-semibold text-danger">already has a report on {day(date)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr className="border-t border-line bg-panel/40 font-bold text-ink">
                      <td className="px-3 py-2" colSpan={3}>{cols.length} shops</td>
                      <td className="px-3 py-2 text-right tnum">{n(total)}</td><td />
                    </tr></tfoot>
                  </table>
                </div>
                {skipped.length > 0 && (
                  <p className="mt-2 text-[12px] text-muted">Skipped — no stock in any row: {skipped.join(", ")}.</p>
                )}
                {unmatched.length > 0 && (
                  <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink">
                    <AlertTriangle size={14} className="text-amber-strong" />
                    Pick our shop for {unmatched.map((c) => c.code).join(", ")}. It is remembered for every file after this.
                  </p>
                )}
                {clashes.length > 0 && (
                  <label className="mt-2 flex items-center gap-2 text-[12.5px] text-ink">
                    <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                    Replace the report already on {day(date)} for {clashes.map((c) => shopName(c.branchId)).join(", ")}
                  </label>
                )}
                <div className="mt-4 flex justify-end">
                  <button onClick={send} disabled={!ready || busy}
                    className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40">
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                    Upload {n(total)} pieces for {day(date)}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <p className="border-b border-line bg-panel/50 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-hint">Uploaded reports</p>
          {uploads.length === 0 ? (
            <p className="p-6 text-center text-[13px] text-muted">Nothing uploaded yet.</p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className="px-4 py-2.5 font-bold">Report date</th><th className="px-4 py-2.5 font-bold">File</th>
                <th className="px-4 py-2.5 text-right font-bold">Shops</th><th className="px-4 py-2.5 text-right font-bold">Pieces</th>
                <th className="px-4 py-2.5 font-bold">Uploaded</th><th className="px-4 py-2.5" />
              </tr></thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.report_id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5 font-semibold text-ink">{day(u.report_date)}</td>
                    <td className="px-4 py-2.5 text-ink/75">{u.file_name ?? "—"}
                      {u.unmatched > 0 && <span className="ml-1.5 rounded-full bg-amber-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink/70">{u.unmatched} unknown barcodes</span>}</td>
                    <td className="px-4 py-2.5 text-right tnum">{u.shops}</td>
                    <td className="px-4 py-2.5 text-right tnum font-semibold">{n(u.pieces)}</td>
                    <td className="px-4 py-2.5 text-[12px] text-muted">{new Date(u.uploaded_at).toLocaleString()}{u.uploaded_by ? ` · ${u.uploaded_by}` : ""}</td>
                    <td className="px-4 py-2.5 text-right">
                      {canUpload && (confirmDel === u.report_id ? (
                        <span className="flex items-center justify-end gap-2">
                          <button onClick={() => removeUpload(u.report_id)} className="rounded-full bg-danger px-2.5 py-1 text-[11px] font-semibold text-white">remove it</button>
                          <button onClick={() => setConfirmDel(null)} className="text-[11px] text-ink/50">keep</button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDel(u.report_id)} title="Remove this upload"
                          className="rounded-full p-1.5 text-muted hover:bg-panel hover:text-danger"><Trash2 size={14} /></button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}
