"use client";
/* CUTTING — fabric in, cut pieces out (K185).
 *
 * The first stage on the floor, and the first one running on its own numbers.
 * Nothing here is new machinery: a cutting job is a production order assigned
 * to the Cutting department, and cut pieces are a process receipt against it —
 * the same two rows every other stage writes. That is deliberate. The wage, the
 * pending count and the payable figure are summed from those receipts rather
 * than stored anywhere, so correcting a wrong entry corrects the money with it.
 *
 * What this screen adds is a floor's-eye view: only Cutting, only its jobs,
 * only its people, and a start button that does the order and the assignment
 * in one go rather than making someone visit two screens to begin a day's work.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Scissors, Plus, Tag, Loader2, AlertTriangle } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

type Job = {
  id: string; assignment_no: string; order_id: string; order_number: string;
  article_code: string; article: string; department_id: string; supervisor: string | null;
  assigned: number; received: number; rejected: number; pending: number;
  wage_earned: number; wage_unpaid: number; status: string; age_days: number;
  assigned_at: string;
};
type Pay = { employee_id: string; employee: string; department_id: string;
             pieces: number; earned: number; payable: number; pieces_unpaid: number };
type Art = { id: string; code: string | null; name: string; system_barcode: string | null };
type Emp = { id: string; name: string };

const TABS = ["Work", "Wages"] as const;
type Tab = (typeof TABS)[number];

const inp = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-ink/30";
const rs = (v: number) => "Rs " + Math.round(Number(v) || 0).toLocaleString();
const num = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

export default function CuttingPage() {
  const [deptId, setDeptId] = useState<string | null>(null);
  const [deptLive, setDeptLive] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pay, setPay] = useState<Pay[]>([]);
  const [arts, setArts] = useState<Art[]>([]);
  const [staff, setStaff] = useState<Emp[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("Work");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  /* Start a cutting job */
  const [startOpen, setStartOpen] = useState(false);
  const [sArt, setSArt] = useState(""); const [sQty, setSQty] = useState("");
  const [sDate, setSDate] = useState(""); const [sNote, setSNote] = useState("");

  /* Record cut pieces */
  const [recv, setRecv] = useState<Job | null>(null);
  const [rGood, setRGood] = useState(""); const [rRej, setRRej] = useState("");
  const [rEmp, setREmp] = useState(""); const [rRate, setRRate] = useState("");
  const [rOn, setROn] = useState("");

  /* Rs per piece */
  const [rateOpen, setRateOpen] = useState(false);
  const [newRate, setNewRate] = useState("");

  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");

    /* The department is found by name rather than a pasted id, so this screen
       still works on a database where the row was recreated. */
    const { data: d } = await supabase.from("departments")
      .select("id,name,in_process").eq("name", "Cutting").eq("kind", "section").maybeSingle();
    const id = (d as { id?: string } | null)?.id ?? null;
    setDeptId(id);
    setDeptLive(!!(d as { in_process?: boolean } | null)?.in_process);
    if (!id) { setLoading(false); return; }

    const [w, p, a, e, r] = await Promise.all([
      supabase.from("v_process_pending").select("*").eq("department_id", id).order("assigned_at", { ascending: true }),
      supabase.from("v_process_payable").select("*").eq("department_id", id).order("payable", { ascending: false }),
      supabase.from("articles").select("id,code,name,system_barcode").eq("is_active", true).order("name"),
      supabase.from("v_factory_employees").select("id,name").order("name"),
      supabase.from("piece_rates").select("rate,effective_from")
        .eq("department_id", id).is("article_id", null)
        .order("effective_from", { ascending: false }).limit(1),
    ]);
    if (w.error) setErr(w.error.message);
    setJobs((w.data as Job[]) ?? []);
    setPay((p.data as Pay[]) ?? []);
    setArts((a.data as Art[]) ?? []);
    setStaff((e.data as Emp[]) ?? []);
    const rr = (r.data as { rate: number }[] | null)?.[0]?.rate;
    setRate(rr == null ? null : Number(rr));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = useMemo(() => jobs.filter((j) => Number(j.pending) > 0), [jobs]);
  const pending = jobs.reduce((t, j) => t + Number(j.pending || 0), 0);
  const cut = jobs.reduce((t, j) => t + Number(j.received || 0), 0);
  const rejected = jobs.reduce((t, j) => t + Number(j.rejected || 0), 0);
  const payable = pay.reduce((t, p) => t + Number(p.payable || 0), 0);

  /* One button, two rows: the order and the assignment. Cutting a hundred
     trousers is one act on the floor, and it should be one act here. */
  async function startJob() {
    if (!supabase || !deptId) return;
    setFormErr("");
    const q = parseInt(sQty, 10);
    if (!sArt) { setFormErr("Which article is being cut?"); return; }
    if (!(q > 0)) { setFormErr("How many pieces?"); return; }
    setBusy(true);
    const { data: orderId, error: e1 } = await supabase.rpc("create_production_order", {
      p_article_id: sArt, p_quantity: q, p_target_date: sDate || null,
      p_notes: sNote.trim() || null,
    });
    if (e1) { setBusy(false); setFormErr(e1.message); return; }
    const { error: e2 } = await supabase.rpc("assign_to_process", {
      p_order_id: orderId, p_department_id: deptId, p_quantity: q,
      p_supervisor_employee_id: null, p_note: sNote.trim() || null,
    });
    setBusy(false);
    /* The order exists either way. Saying so beats a bare refusal that leaves
       someone wondering whether to press the button again. */
    if (e2) { setFormErr(`The order was created but could not be given to Cutting: ${e2.message}`); load(); return; }
    setStartOpen(false); setSArt(""); setSQty(""); setSDate(""); setSNote("");
    load();
  }

  async function recordCut() {
    if (!supabase || !recv) return;
    setFormErr("");
    const good = parseFloat(rGood) || 0;
    const rej = parseFloat(rRej) || 0;
    if (!(good > 0) && !(rej > 0)) { setFormErr("How many pieces came back?"); return; }
    if (!rEmp) { setFormErr("Who did the cutting?"); return; }
    if (good + rej > Number(recv.pending)) {
      setFormErr(`Only ${num(recv.pending)} are still out on this job.`); return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("receive_from_process", {
      p_assignment_id: recv.id, p_quantity: good, p_employee_id: rEmp,
      p_rejected: rej, p_rate: rRate === "" ? null : parseFloat(rRate),
      p_received_at: rOn ? new Date(`${rOn}T${new Date().toTimeString().slice(0, 5)}`).toISOString() : null,
      p_note: null,
    });
    setBusy(false);
    if (error) { setFormErr(error.message); return; }
    setRecv(null); setRGood(""); setRRej(""); setREmp(""); setRRate(""); setROn("");
    load();
  }

  async function saveRate() {
    if (!supabase || !deptId) return;
    setFormErr("");
    const v = parseFloat(newRate);
    if (!(v > 0)) { setFormErr("What is the rate per piece?"); return; }
    setBusy(true);
    const { error } = await supabase.rpc("set_piece_rate", {
      p_department_id: deptId, p_rate: v, p_article_id: null,
      p_effective_from: today(), p_note: null,
    });
    setBusy(false);
    if (error) { setFormErr(error.message); return; }
    setRateOpen(false); setNewRate(""); load();
  }

  return (
    <>
      <Topbar title="Cutting" subtitle="Fabric in, cut pieces out — by the piece, by the person" />

      <div className="space-y-5 px-6 pb-10">
        {!isSupabaseConfigured ? (
          <div className="rounded-card bg-surface p-8 text-center text-[14px] text-muted shadow-card">
            Connect Supabase to see cutting work.
          </div>
        ) : deptId === null && !loading ? (
          <div className="rounded-card bg-surface p-8 text-center text-[14px] text-muted shadow-card">
            There is no Cutting section on this database yet.
          </div>
        ) : (
          <>
            {/* K185 is what opens this. Saying so beats an empty screen that
                looks broken. */}
            {!deptLive && !loading && (
              <div className="flex items-start gap-2.5 rounded-xl2 border border-amber-strong/40 bg-amber-soft/60 px-4 py-3 text-[13px] text-ink">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>Cutting is not switched on yet, so no work can be given to it. Run <b>K185</b> and refresh.</span>
              </div>
            )}

            <div className="rounded-card bg-surface p-5 shadow-card">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl2 bg-panel text-ink"><Scissors size={18} /></span>
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-ink/60">Still to cut</p>
                    <p className="mt-0.5 text-[30px] font-extrabold leading-none text-ink">{num(pending)}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-ink/60">Cut so far</p>
                  <p className="mt-0.5 text-[22px] font-extrabold leading-none text-ink">{num(cut)}</p>
                  {rejected > 0 && <p className="mt-0.5 text-[11.5px] text-danger">{num(rejected)} rejected</p>}
                </div>
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-ink/60">Wages payable</p>
                  <p className="mt-0.5 text-[22px] font-extrabold leading-none text-ink">{rs(payable)}</p>
                  <p className="mt-0.5 text-[11.5px] text-hint">{open.length} job{open.length === 1 ? "" : "s"} open</p>
                </div>
                <div className="text-right">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-ink/60">Rate</p>
                  {rate == null ? (
                    <p className="mt-0.5 text-[13px] font-semibold text-danger">not set</p>
                  ) : (
                    <p className="mt-0.5 text-[22px] font-extrabold leading-none text-ink">{rs(rate)}<span className="text-[12px] font-semibold text-hint"> /pc</span></p>
                  )}
                </div>
              </div>
              {rate == null && (
                <p className="mt-3 rounded-xl2 bg-amber-soft/60 px-3 py-2 text-[12px] text-ink/80">
                  No rate per piece is set for Cutting, so every wage below reads zero. Set it before recording work.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {TABS.map((t) => (
                  <button key={t} onClick={() => { setTab(t); setFormErr(""); }}
                    className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${tab === t ? "bg-ink text-white" : "bg-surface text-muted hover:bg-panel"}`}>{t}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => { setRateOpen(true); setNewRate(rate == null ? "" : String(rate)); setFormErr(""); }}
                  className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-[13px] font-semibold text-ink/75 hover:bg-panel">
                  <Tag size={15} /> {rate == null ? "Set the rate" : "Change the rate"}
                </button>
                <button onClick={() => { setStartOpen(true); setFormErr(""); }} disabled={!deptLive}
                  className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
                  <Plus size={15} /> Start a cutting job
                </button>
              </div>
            </div>

            {err && <div className="rounded-xl2 bg-danger-soft px-4 py-2.5 text-[13px] text-danger">{err}</div>}

            {tab === "Work" && (
              <div className="rounded-card bg-surface shadow-card">
                {loading ? <p className="p-5 text-[13px] text-muted">Loading…</p>
                : jobs.length === 0 ? (
                  <p className="p-5 text-[13px] text-muted">
                    Nothing at cutting yet. Start a cutting job to begin.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] text-[13px]">
                      <thead className="border-b border-line bg-panel text-[11.5px] uppercase tracking-wide text-muted">
                        <tr>
                          <th className="px-5 py-2.5 text-left">Job</th>
                          <th className="px-3 py-2.5 text-left">Article</th>
                          <th className="px-3 py-2.5 text-right">Given</th>
                          <th className="px-3 py-2.5 text-right">Cut</th>
                          <th className="px-3 py-2.5 text-right">Rejected</th>
                          <th className="px-3 py-2.5 text-right">Still out</th>
                          <th className="px-3 py-2.5 text-right">Wage</th>
                          <th className="px-5 py-2.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((j) => (
                          <tr key={j.id} className="border-b border-line/60 last:border-0">
                            <td className="px-5 py-3">
                              <span className="font-semibold text-ink">{j.order_number}</span>
                              <span className="mt-0.5 block text-[11.5px] text-muted">{j.assignment_no} · {j.age_days}d old</span>
                            </td>
                            <td className="px-3 py-3 text-ink/80">
                              {j.article}
                              <span className="block text-[11.5px] text-muted">{j.article_code}</span>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums">{num(j.assigned)}</td>
                            <td className="px-3 py-3 text-right tabular-nums text-ink/70">{num(j.received)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">
                              {Number(j.rejected) > 0
                                ? <span className="font-semibold text-danger">{num(j.rejected)}</span>
                                : <span className="text-hint">—</span>}
                            </td>
                            <td className="px-3 py-3 text-right font-bold tabular-nums text-ink">{num(j.pending)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">
                              {rs(j.wage_earned)}
                              {Number(j.wage_unpaid) > 0 && <span className="block text-[11.5px] text-danger">{rs(j.wage_unpaid)} unpaid</span>}
                            </td>
                            <td className="px-5 py-3 text-right">
                              {Number(j.pending) > 0 ? (
                                <button onClick={() => { setRecv(j); setRGood(""); setRRej(""); setREmp(""); setRRate(""); setROn(today()); setFormErr(""); }}
                                  className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-semibold text-ink/75 hover:bg-panel">
                                  Record cut pieces
                                </button>
                              ) : (
                                <span className="rounded-full bg-panel px-2.5 py-1 text-[11.5px] font-semibold text-muted">done</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {tab === "Wages" && (
              <div className="rounded-card bg-surface shadow-card">
                {pay.length === 0 ? (
                  <p className="p-5 text-[13px] text-muted">Nobody has cut anything yet.</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead className="border-b border-line bg-panel text-[11.5px] uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-5 py-2.5 text-left">Person</th>
                        <th className="px-3 py-2.5 text-right">Pieces cut</th>
                        <th className="px-3 py-2.5 text-right">Earned</th>
                        <th className="px-5 py-2.5 text-right">Payable now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pay.map((p) => (
                        <tr key={p.employee_id} className="border-b border-line/60 last:border-0">
                          <td className="px-5 py-3 font-semibold text-ink">{p.employee}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{num(p.pieces)}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted">{rs(p.earned)}</td>
                          <td className="px-5 py-3 text-right font-bold tabular-nums text-ink">{rs(p.payable)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="px-5 py-3 text-[12px] text-hint">
                  Earned is everything they have ever cut. Payable is what has not been paid yet — both summed
                  from the pieces recorded, never stored, so a corrected entry corrects the money.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      <Modal open={startOpen} onClose={() => !busy && setStartOpen(false)}
        title="Start a cutting job"
        subtitle="Makes the production order and gives the pieces to Cutting in one step.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Article">
              <select value={sArt} onChange={(e) => setSArt(e.target.value)} className={inp} autoFocus>
                <option value="">Choose…</option>
                {arts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.system_barcode ? ` · ${a.system_barcode}` : a.code ? ` · ${a.code}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Pieces to cut">
            <input value={sQty} onChange={(e) => setSQty(e.target.value)} inputMode="numeric" className={inp} />
          </Field>
          <Field label="Wanted by (optional)">
            <input type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} className={inp} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Note (optional)">
              <input value={sNote} onChange={(e) => setSNote(e.target.value)} className={inp} />
            </Field>
          </div>
        </div>
        {formErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{formErr}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setStartOpen(false)} disabled={busy}
            className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
          <button onClick={startJob} disabled={busy}
            className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />} Start cutting
          </button>
        </div>
      </Modal>

      <Modal open={!!recv} onClose={() => !busy && setRecv(null)}
        title="Record cut pieces"
        subtitle={recv ? `${recv.order_number} · ${recv.article} · ${num(recv.pending)} still out` : undefined}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pieces good">
            <input value={rGood} onChange={(e) => setRGood(e.target.value)} inputMode="decimal" className={inp} autoFocus />
          </Field>
          <Field label="Rejected">
            <input value={rRej} onChange={(e) => setRRej(e.target.value)} inputMode="decimal" className={inp} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Who did the cutting">
              <select value={rEmp} onChange={(e) => setREmp(e.target.value)} className={inp}>
                <option value="">Choose…</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Day it was cut">
            <input type="date" value={rOn} max={today()} onChange={(e) => setROn(e.target.value)} className={inp} />
          </Field>
          <Field label={`Rate override${rate == null ? "" : ` (normally ${rs(rate)})`}`}>
            <input value={rRate} onChange={(e) => setRRate(e.target.value)} inputMode="decimal"
              placeholder={rate == null ? "no rate set" : String(rate)} className={inp} />
          </Field>
        </div>
        {formErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{formErr}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setRecv(null)} disabled={busy}
            className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
          <button onClick={recordCut} disabled={busy}
            className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />} Record
          </button>
        </div>
      </Modal>

      <Modal open={rateOpen} onClose={() => !busy && setRateOpen(false)}
        title="Rate per piece — Cutting"
        subtitle="Applies from today. Work already recorded keeps the rate it was recorded at.">
        <Field label="Rs per piece">
          <input value={newRate} onChange={(e) => setNewRate(e.target.value)} inputMode="decimal" className={inp} autoFocus />
        </Field>
        {formErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{formErr}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setRateOpen(false)} disabled={busy}
            className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
          <button onClick={saveRate} disabled={busy}
            className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />} Save rate
          </button>
        </div>
      </Modal>
    </>
  );
}
