"use client";
/* FACTORY STAFF — who works here, at what rate, and what is owed.
 *
 * The rate lives on the person because most men have a standing one; the
 * entry form fills it in and it stays editable per job, since a harder cut
 * is paid more.
 *
 * Pending is shown here too — "who do I owe" is the question this list gets
 * opened for, and sending someone to another screen for it is how a second
 * sheet starts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, Plus, Loader2, Download, Printer } from "lucide-react";
import Topbar from "@/components/Topbar";
import Modal, { Field } from "@/components/Modal";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { exportCSV, exportExcel, exportPDF, printTable, type ExportTable } from "@/lib/export";

type Staff = { id: string; code: string; name: string; phone: string | null;
               is_active: boolean; rate: number | null; employment_type: string | null;
               join_date: string | null; dept_code: string; department: string;
               earned: number; pending: number; entry_count: number };

/* Departments come from the database now, not from a list typed in here —
   that list is what made a new floor a code change, and it is how three
   codes that never existed (OVL, FLT, SGL) sat here unnoticed.

   Only factory floors are read: rows of kind 'section'. The same table holds
   the businesses themselves — Karkhana, Hub, Inventory, FS Traders — and a
   man is not inducted into a business. Adding and removing goes through
   add_factory_department / remove_factory_department (K176), which enforce
   that same fence on their own side, whatever this screen sends. */
type Dept = { id: string; code: string; name: string; parent_id: string | null; sort_order: number | null };

/* Machine Process runs on exactly these four, so they cannot be removed.
   The database refuses them too; this only saves offering a button that
   would be refused. */
const FLOORS = ["CUT", "SINGLELOCK", "OVERLOCK", "FLATLOCK"];
const inp = "mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30";
/* Same look as inp, without its top margin and full width — for controls that
   sit side by side in one row. */
const inpRow = "rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30";
const n = (v: number) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const rs = (v: number) => "Rs " + Math.round(Number(v) || 0).toLocaleString();

export function InductionScreen({ side }: { side: "factory" | "warehouse" }) {
  const { can } = usePermissions();
  const canDo = can(["process.manage", "production.entry"]);
  const canDepts = can(["departments.manage"]);

  const [rows, setRows] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [show, setShow] = useState<"active" | "all">("active");

  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Staff | null>(null);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(new Date().toISOString().slice(0, 10));
  const [phone, setPhone] = useState("");
  const [cnic, setCnic] = useState("");
  const [dCode, setDCode] = useState("CUT");
  const [emp, setEmp] = useState("casual");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fErr, setFErr] = useState("");
  const [killing, setKilling] = useState(false);

  /* Department manager — opened from the Department field of the form. */
  const [depts, setDepts] = useState<Dept[]>([]);
  const [mOpen, setMOpen] = useState(false);
  const [newDept, setNewDept] = useState("");
  const [newParent, setNewParent] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dErr, setDErr] = useState("");
  const [dMsg, setDMsg] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const loadDepts = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("departments")
      .select("id,code,name,parent_id,sort_order")
      .eq("kind", "section").eq("is_active", true)
      .order("sort_order").order("name");
    if (error) { setErr(error.message); return; }
    setDepts((data as Dept[]) ?? []);
  }, []);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true);
    const [{ data, error }] = await Promise.all([
      supabase.from("v_factory_staff").select("*").order("code"),
      loadDepts(),
    ]);
    if (error) setErr(error.message);
    setRows((data as Staff[]) ?? []);
    setLoading(false);
  }, [loadDepts]);
  useEffect(() => { load(); }, [load]);

  /* Each floor followed by the floors under it, indented — so Cutting,
     Overlock, Flatlock and Singlelock read as part of the Stitching Unit, the
     way the factory is actually laid out. Sorting by number alone would put a
     floor added under Clipping somewhere after Stitching. */
  const tree = useMemo(() => {
    const ids = new Set(depts.map((d) => d.id));
    const out: (Dept & { depth: number })[] = [];
    const walk = (d: Dept, depth: number) => {
      out.push({ ...d, depth });
      if (depth < 4) depts.filter((c) => c.parent_id === d.id).forEach((c) => walk(c, depth + 1));
    };
    depts.filter((d) => !d.parent_id || !ids.has(d.parent_id)).forEach((d) => walk(d, 0));
    return out;
  }, [depts]);
  const label = (d: { name: string; depth: number }) => " ".repeat(d.depth) + (d.depth ? "· " : "") + d.name;

  /* Who is in each department right now — shown beside Remove, since a
     department with people in it cannot go. */
  const staffIn = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { if (r.is_active && r.dept_code) m[r.dept_code] = (m[r.dept_code] ?? 0) + 1; });
    return m;
  }, [rows]);

  async function addDept() {
    if (!supabase || !newDept.trim()) return;
    setDBusy(true); setDErr(""); setDMsg("");
    const { data, error } = await supabase.rpc("add_factory_department", {
      p_name: newDept.trim(), p_parent_code: newParent || null,
    });
    setDBusy(false);
    /* The database's own words, always — it knows why it refused. */
    if (error) { setDErr(error.message); return; }
    const made = data as { code: string; name: string; revived: boolean };
    await loadDepts();
    setDCode(made.code);
    setNewDept(""); setNewParent("");
    setDMsg(made.revived ? `${made.name} is back, and selected.` : `${made.name} added, and selected.`);
  }

  async function removeDept(d: Dept) {
    if (!supabase) return;
    setDBusy(true); setDErr(""); setDMsg("");
    const { error } = await supabase.rpc("remove_factory_department", { p_id: d.id });
    setDBusy(false); setConfirmId(null);
    if (error) { setDErr(error.message); return; }
    await loadDepts();
    if (dCode === d.code) setDCode("CUT");
    setDMsg(`${d.name} removed. Old records that mention it are untouched.`);
  }

  const view = useMemo(() => rows.filter((r) => {
    /* The screen decides the side, so a WR code can never be issued from the
       factory screen or the other way round. */
    const isWR = !!r.code?.startsWith("WR-");
    if (side === "warehouse" ? !isWR : isWR) return false;
    if (show === "active" && !r.is_active) return false;
    if (dept !== "all" && r.dept_code !== dept) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    return [r.name, r.code, r.phone, r.department].some((x) => String(x ?? "").toLowerCase().includes(t));
  }), [rows, q, dept, show, side]);

  const owed = view.reduce((a, r) => a + Number(r.pending || 0), 0);

  function openAdd() {
    setOpen(true); setEdit(null); setKilling(false); setName(""); setJoined(new Date().toISOString().slice(0, 10)); setPhone("");
    setCnic(""); setDCode("CUT"); setEmp("casual"); setActive(true); setFErr("");
    setMOpen(false); setDErr(""); setDMsg(""); setConfirmId(null); setNewDept(""); setNewParent("");
  }
  function openEdit(r: Staff) {
    setOpen(true); setEdit(r); setKilling(false); setName(r.name);
    setJoined(r.join_date ?? "");
    setPhone(r.phone ?? ""); setCnic(""); setDCode(r.dept_code);
    setEmp(r.employment_type ?? "casual"); setActive(r.is_active); setFErr("");
    setMOpen(false); setDErr(""); setDMsg(""); setConfirmId(null); setNewDept(""); setNewParent("");
  }

  async function remove() {
    if (!supabase || !edit) return;
    setBusy(true); setFErr("");
    const { error } = await supabase.rpc("delete_factory_employee", { p_id: edit.id });
    setBusy(false);
    if (error) { setFErr(error.message); setKilling(false); return; }
    setOpen(false); load();
  }

  async function save() {
    if (!supabase) return;
    setFErr("");
    if (!name.trim()) { setFErr("Give the name."); return; }
    setBusy(true);
    const { error } = edit
      ? await supabase.rpc("update_factory_employee", {
          p_id: edit.id, p_name: name.trim(), p_rate: null,
          p_phone: phone.trim() || null, p_active: active,
          p_department_code: dCode,
        })
      : await supabase.rpc("add_factory_employee", {
          p_name: name.trim(), p_department_code: dCode, p_rate: null,
          p_phone: phone.trim() || null, p_cnic: cnic.trim() || null,
          p_employment: "casual", p_join_date: joined || null, p_side: side,
        });
    setBusy(false);
    if (error) { setFErr(error.message); return; }
    setOpen(false); load();
  }

  const table = (): ExportTable => ({
    title: "Staff Induction",
    headers: ["Employee ID", "Name", "Department", "Joined", "Phone", "Earned", "Pending", "Status"],
    rows: view.map((r) => [r.code, r.name, r.department, r.join_date ?? "", r.phone ?? "",
      r.earned || "", r.pending || "", r.is_active ? "active" : "inactive"]),
  });

  return (
    <>
      <Topbar
        title={side === "warehouse" ? "Warehouse - New Staff Induction" : "Factory - New Staff Induction"}
        subtitle={`Employee IDs are issued as ${side === "warehouse" ? "WR" : "FT"}-00001`} />

      <div className="space-y-4 px-6 pb-12">
        {err && <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-ink">{err}</div>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-card bg-periwinkle-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">People</p>
            <p className="mt-1.5 text-[32px] font-extrabold leading-none tracking-tight text-ink">{view.length}</p>
          </div>
          <div className="rounded-card bg-amber-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Owed right now</p>
            <p className="mt-1.5 text-[32px] font-extrabold leading-none tracking-tight text-ink">{rs(owed)}</p>
          </div>
          <div className="rounded-card bg-success-soft p-5">
            <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">Warehouse side</p>
            <p className="mt-1.5 text-[32px] font-extrabold leading-none tracking-tight text-ink">
              {view.filter((r) => r.code?.startsWith("WR-")).length}
            </p>
            <p className="mt-1 text-[12px] text-ink/60">of {view.length}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, phone…"
            className="w-full max-w-xs rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-ink/30" />
          <select value={dept} onChange={(e) => setDept(e.target.value)}
            className="rounded-full border border-line bg-surface px-3 py-2 text-[12px] outline-none">
            <option value="all">All departments</option>
            {tree.map((d) => <option key={d.id} value={d.code}>{label(d)}</option>)}
          </select>
          <button onClick={() => setShow(show === "active" ? "all" : "active")}
            className={`rounded-full px-3 py-2 text-[12px] font-semibold transition ${show === "all" ? "bg-ink text-white" : "border border-line text-ink/65 hover:bg-panel"}`}>
            {show === "all" ? "Showing inactive" : "Active only"}
          </button>
          <button onClick={() => exportCSV(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Download size={13} /> CSV</button>
          <button onClick={() => exportExcel(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">Excel</button>
          <button onClick={() => exportPDF(table())} className="rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel">PDF</button>
          <button onClick={() => printTable(table())} className="flex items-center gap-1 rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Printer size={13} /> Print</button>
          {canDo && (
            <button onClick={openAdd} className="ml-auto flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white">
              <Plus size={15} /> Add employee
            </button>
          )}
        </div>

        {loading && <p className="text-[13px] text-hint">Loading…</p>}

        {!loading && view.length === 0 && (
          <div className="rounded-card border border-line bg-surface p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-panel text-ink"><Users size={24} /></span>
            <p className="mt-3 text-[15px] font-semibold text-ink">No staff yet</p>
            <p className="mt-1 text-[13px] text-muted">Add the men who cut, stitch and pack — their names then appear in every entry form.</p>
          </div>
        )}

        {!loading && view.length > 0 && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-hint">
                <th className="px-4 py-3 font-bold">Name</th>
                <th className="px-4 py-3 font-bold">Department</th>
                <th className="px-4 py-3 font-bold">Phone</th>
                <th className="px-4 py-3 text-right font-bold">Earned</th>
                <th className="px-4 py-3 text-right font-bold">Pending</th>
                <th className="px-4 py-3"></th>
              </tr></thead>
              <tbody>
                {view.map((r, ix) => (
                  <tr key={r.id} className={`border-b border-line/60 last:border-0 ${r.is_active ? "" : "opacity-50"} ${ix % 2 ? "bg-panel/25" : ""}`}>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-ink">{r.name}</span>
                      <span className="block text-[11px] text-hint">
                        {r.code}{r.employment_type ? ` · ${r.employment_type}` : ""}
                        {!r.is_active && " · inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink/80">{r.department}</td>
                    <td className="px-4 py-3 text-[12.5px] text-muted">{r.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-right tnum text-muted">{r.earned ? rs(r.earned) : "—"}</td>
                    <td className="px-4 py-3 text-right tnum text-[15px] font-extrabold text-ink">
                      {r.pending ? rs(r.pending) : <span className="text-[12px] font-semibold text-hint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canDo && (
                        <button onClick={() => openEdit(r)}
                          className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/75 hover:bg-panel">Edit</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={edit ? `Edit ${edit.name}` : "Add employee"}>
        <Field label="Name">
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Aslam" className={inp} />
        </Field>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {/* Not wrapped in Field: Field is a <label>, and the Add / remove
              button needs to sit beside the heading without being part of it. */}
          <div>
            {/* Fixed to the height of a plain label, so the pill beside it does
                not push this select below the Phone box next to it. */}
            <div className="flex h-[19px] items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">Department</span>
              {canDepts && (
                <button type="button" onClick={() => { setMOpen((v) => !v); setDErr(""); setDMsg(""); setConfirmId(null); }}
                  className="rounded-full border border-line px-2 py-[3px] text-[11px] font-semibold leading-none text-ink/65 hover:bg-panel">
                  {mOpen ? "Done" : "+ Add / remove"}
                </button>
              )}
            </div>
            <div className="mt-1.5">
              <select value={dCode} onChange={(e) => setDCode(e.target.value)} className={inp}>
                {tree.map((d) => <option key={d.id} value={d.code}>{label(d)}</option>)}
                {/* A man already in a department that has since been removed
                    keeps it until someone moves him — shown, not silently
                    swapped for the first option in the list. */}
                {tree.length > 0 && dCode && !tree.some((d) => d.code === dCode) && (
                  <option value={dCode}>{edit?.department ?? dCode} (removed)</option>
                )}
              </select>
            </div>
          </div>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inp} />
          </Field>
          <Field label="Date of joining">
            <input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} className={inp} />
          </Field>
          {!edit && (
            <Field label="CNIC (optional)">
              <input value={cnic} onChange={(e) => setCnic(e.target.value)} className={inp} />
            </Field>
          )}
        </div>

        {mOpen && canDepts && (
          <div className="mt-3 rounded-xl2 border border-line bg-panel/40 p-3">
            <p className="text-[12.5px] font-semibold text-ink">Factory departments</p>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input value={newDept} onChange={(e) => setNewDept(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDept(); } }}
                placeholder="New department, e.g. Button attach" className={`${inpRow} min-w-[180px] flex-1`} />
              <select value={newParent} onChange={(e) => setNewParent(e.target.value)} className={inpRow}
                title="Put it under another department, the way Cutting sits under the Stitching Unit">
                <option value="">On its own</option>
                {tree.filter((d) => d.depth === 0).map((d) => <option key={d.id} value={d.code}>Under {d.name}</option>)}
              </select>
              <button type="button" onClick={addDept} disabled={dBusy || !newDept.trim()}
                className="flex items-center gap-1 rounded-xl2 bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40">
                {dBusy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
              </button>
            </div>

            {dErr && <p className="mt-2 text-[12px] font-medium text-danger">{dErr}</p>}
            {dMsg && <p className="mt-2 text-[12px] font-medium text-[#166534]">{dMsg}</p>}

            {/* No height cap: a capped list scrolls inside a modal that already
                scrolls, and hides its own scrollbar while doing it — a department
                just added would land out of sight. The whole list shows; if the
                form gets taller than the screen, the form scrolls as one. */}
            <div className="mt-2.5 divide-y divide-line/60 rounded-xl2 border border-line bg-surface">
              {tree.map((d) => {
                const people = staffIn[d.code] ?? 0;
                const hasKids = tree.some((c) => c.parent_id === d.id);
                /* Say why a department cannot go, rather than showing a
                   button that will only be refused. */
                const why = FLOORS.includes(d.code) ? "Machine Process floor"
                  : people > 0 ? `${people} ${people === 1 ? "person" : "people"} in it`
                  : hasKids ? "has departments under it" : "";
                return (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="text-[12.5px] text-ink" style={{ paddingLeft: d.depth * 14 }}>
                      {d.depth ? "· " : ""}{d.name}
                      {people > 0 && <span className="ml-1.5 text-[11px] text-hint">{people} staff</span>}
                    </span>
                    {why ? (
                      <span className="shrink-0 text-[11px] text-hint">{why}</span>
                    ) : confirmId === d.id ? (
                      <span className="flex shrink-0 items-center gap-2">
                        <button type="button" onClick={() => removeDept(d)} disabled={dBusy}
                          className="rounded-full bg-danger px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Yes, remove</button>
                        <button type="button" onClick={() => setConfirmId(null)} className="text-[11px] text-ink/60">no</button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => { setConfirmId(d.id); setDErr(""); setDMsg(""); }}
                        className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-danger/80 hover:bg-danger-soft">Remove</button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-hint">
              Removing switches a department off — it leaves every form, but old work and payroll that mention it stay as they were.
            </p>
          </div>
        )}

        {edit && (
          <div className="mt-4 flex items-center justify-between rounded-xl2 border border-line p-3">
            <div>
              <p className="text-[13px] font-semibold text-ink">{active ? "Active" : "Inactive"}</p>
              <p className="mt-0.5 text-[12px] text-muted">
                {active ? "Appears in every entry form." : "Hidden from the forms. His past work stays."}
              </p>
            </div>
            <button onClick={() => setActive((v) => !v)}
              className={`rounded-full px-3.5 py-2 text-[12.5px] font-semibold transition ${active ? "border border-line text-ink/75 hover:bg-panel" : "bg-ink text-white"}`}>
              {active ? "Make inactive" : "Make active"}
            </button>
          </div>
        )}
        <p className="mt-3 text-[12px] text-hint">
          {/* No rate here on purpose: a piece rate changes with the job and the
              season, so one fixed at induction is wrong within a month. */}
          Only the name is needed. The rate is set on each work entry, not here — it changes with the job.
        </p>
        {fErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{fErr}</p>}

        <div className="mt-5 flex items-center gap-2">
          {edit && (killing ? (
            <span className="flex items-center gap-2">
              <button onClick={remove} disabled={busy}
                className="rounded-xl2 bg-danger px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50">
                Delete permanently
              </button>
              <button onClick={() => setKilling(false)} className="text-[12px] text-ink/60">cancel</button>
            </span>
          ) : (
            <button onClick={() => setKilling(true)}
              className="rounded-xl2 border border-line px-3.5 py-2 text-[12.5px] font-semibold text-danger/80 hover:bg-danger-soft">
              Delete
            </button>
          ))}
          {edit && edit.entry_count > 0 && !killing && (
            <span className="text-[11.5px] text-hint">{edit.entry_count} work entr{edit.entry_count === 1 ? "y" : "ies"}</span>
          )}
          <button onClick={() => setOpen(false)} className="ml-auto rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70">Cancel</button>
          <button onClick={save} disabled={busy}
            className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />} {edit ? "Save" : "Add employee"}
          </button>
        </div>
      </Modal>
    </>
  );
}
