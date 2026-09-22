"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, Lock, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { type JobRole, type CatalogueItem } from "./teamShared";
import { roleSummary } from "./TeamPeople";

/* JOB ROLES — what each kind of Karkhana worker may do.
 *
 * The ticks are Karkhana permissions only (karkhana_permission_catalogue):
 * nothing of the Hub, FS Traders or Administration can be put into a Karkhana
 * role from here, and the database refuses it even if someone tries.
 *
 * Karkhana Admin always has everything — its ticks are fixed, so no careless
 * untick can leave the team without an admin. Warehouse Operator comes with
 * the system and cannot be removed, but what it can do is yours to change.
 */
export default function TeamRoles({ roles, catalogue, loading, onChanged }:
  { roles: JobRole[]; catalogue: CatalogueItem[]; loading: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState<JobRole | "new" | null>(null);
  const [err, setErr] = useState("");

  async function remove(r: JobRole) {
    if (!supabase) return;
    if (!(await confirm({ title: `Remove the job role “${r.name}”?`, body: "Nobody is in it, so nothing else changes.", confirmLabel: "Remove job role" }))) return;
    setErr("");
    const { error } = await supabase.rpc("karkhana_delete_role", { p_id: r.id });
    if (error) { setErr(error.message); return; }
    onChanged();
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="text-[12.5px] text-muted">A job role is a list of what someone may do. Give each person one.</p>
        <button onClick={() => setEditing("new")} className={`${btnPrimary} ml-auto`}><Plus size={16} /> New job role</button>
      </div>
      {err && <p className="mb-3 rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-2.5 text-[12.5px] font-medium text-ink">{err}</p>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted"><Loader2 size={18} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {roles.map((r) => {
            const can = roleSummary(r, catalogue);
            return (
              <div key={r.id} className="flex flex-col rounded-card border border-line bg-surface p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[15px] font-extrabold tracking-tight text-ink">
                      {r.name}
                      {r.locked && <Lock size={13} className="text-hint" aria-label="Comes with the system" />}
                    </p>
                    {r.description && <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{r.description}</p>}
                  </div>
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-panel px-2.5 py-1 text-[11.5px] font-semibold text-ink/70">
                    <Users size={12} /> {r.members}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {can.length === 0
                    ? <span className="text-[12px] text-hint">Can do nothing yet</span>
                    : can.map((c) => (
                        <span key={c} className="rounded-full bg-cream px-2.5 py-1 text-[11.5px] font-medium text-ink/80 dark:bg-white/[0.06]">{c}</span>
                      ))}
                </div>
                <div className="mt-4 flex gap-2 pt-1">
                  <button onClick={() => setEditing(r)}
                    className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/75 hover:bg-panel">
                    <Pencil size={13} /> {r.locked === "admin" ? "Rename" : "Edit"}
                  </button>
                  {!r.locked && (
                    <button onClick={() => remove(r)} disabled={r.members > 0}
                      title={r.members > 0 ? "Move the people in it to another job role first" : "Remove this job role"}
                      className="inline-flex items-center gap-1 rounded-full border border-danger/40 px-3 py-1.5 text-[12px] font-semibold text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40">
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <RoleEditor role={editing} catalogue={catalogue} onClose={() => setEditing(null)} onDone={onChanged} />
    </div>
  );
}

function RoleEditor({ role, catalogue, onClose, onDone }:
  { role: JobRole | "new" | null; catalogue: CatalogueItem[]; onClose: () => void; onDone: () => void }) {
  const isNew = role === "new";
  const r = role && role !== "new" ? role : null;
  const fixed = r?.locked === "admin";
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!role) return;
    setName(r?.name ?? ""); setDesc(r?.description ?? "");
    setTicks(new Set(r ? r.perms.filter((p) => catalogue.some((c) => c.code === p)) : ["khana.view"]));
    setErr("");
  }, [role, r, catalogue]);

  const groups = useMemo(() => {
    const m = new Map<string, CatalogueItem[]>();
    catalogue.forEach((c) => { m.set(c.grp, [...(m.get(c.grp) ?? []), c]); });
    return Array.from(m.entries());
  }, [catalogue]);

  const flip = (code: string) => setTicks((t) => { const n = new Set(t); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const flipGroup = (items: CatalogueItem[], on: boolean) =>
    setTicks((t) => { const n = new Set(t); items.forEach((c) => (on ? n.add(c.code) : n.delete(c.code))); return n; });

  async function save() {
    if (!supabase) return;
    setErr("");
    if (!name.trim()) { setErr("Give the job role a name."); return; }
    if (ticks.size === 0) { setErr("Tick at least one thing this job role can do."); return; }
    setBusy(true);
    const { error } = await supabase.rpc("karkhana_save_role", {
      p_id: isNew ? null : r!.id, p_name: name.trim(), p_description: desc.trim() || null,
      /* The admin role is sent back exactly as it is — its ticks are fixed. */
      p_perms: fixed ? r!.perms.filter((p) => catalogue.some((c) => c.code === p)) : Array.from(ticks),
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone(); onClose();
  }

  return (
    <Modal open={!!role} onClose={() => !busy && onClose()} wide
      title={isNew ? "New job role" : fixed ? "Rename the admin role" : `Edit “${r?.name}”`}
      subtitle={fixed ? "Karkhana Admin always has everything in Karkhana — only its name and description can change."
                      : "Tick what someone in this job role may do. People in it get a message, and see the change after a refresh."}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Packing supervisor" className={inputCls} autoFocus /></Field>
        <Field label="Description (optional)"><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What this person does" className={inputCls} /></Field>
      </div>

      <div className={`mt-4 space-y-3 ${fixed ? "pointer-events-none opacity-60" : ""}`}>
        {groups.map(([g, items]) => {
          const all = items.every((c) => ticks.has(c.code));
          return (
            <div key={g} className="rounded-xl2 border border-line p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11.5px] font-bold uppercase tracking-wide text-hint">{g}</p>
                <button type="button" onClick={() => flipGroup(items, !all)} className="text-[11.5px] font-semibold text-ink/60 hover:text-ink">
                  {all ? "Untick all" : "Tick all"}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {items.map((c) => (
                  <label key={c.code} className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-1.5 transition hover:bg-panel/60 ${ticks.has(c.code) ? "bg-cream/70 dark:bg-white/[0.04]" : ""}`}>
                    <input type="checkbox" checked={ticks.has(c.code)} onChange={() => flip(c.code)} disabled={fixed}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#141414]" />
                    <span className="text-[12.5px] leading-snug text-ink">{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {!fixed && ticks.has("khana.manage") && (
        <p className="mt-3 rounded-xl2 bg-amber-soft/60 px-3 py-2 text-[12px] text-ink/80">
          Full control lets this person edit, rename, void and delete warehouse records and correct stock by hand.
        </p>
      )}
      {!fixed && ticks.has("karkhana.admin") && (
        <p className="mt-2 rounded-xl2 bg-amber-soft/60 px-3 py-2 text-[12px] text-ink/80">
          Karkhana admin lets this person add and remove logins and change everyone&apos;s job role.
        </p>
      )}
      {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
        <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={15} className="animate-spin" />} {isNew ? "Create job role" : "Save"}</button>
      </div>
    </Modal>
  );
}
