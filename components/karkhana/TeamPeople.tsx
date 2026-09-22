"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus, Search, KeyRound, Pencil, Trash2, Copy, Check, Wand2, Eye, EyeOff, UsersRound } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import { useConfirm } from "@/components/ConfirmDialog";
import { type JobRole, type CatalogueItem, type Member, callTeam, makePassword, lastSeen, SYNTH } from "./teamShared";

/* PEOPLE — who can log in to Karkhana, and as what.
 *
 * The list comes from karkhana_team(), which only ever returns Karkhana
 * people: everyone whose every role is a Karkhana job role. Hub and FS Traders
 * logins, and super admins, are not in it and cannot be reached from here —
 * the login function applies the same rule on its side.
 */

export function roleSummary(role: JobRole | undefined, catalogue: CatalogueItem[]): string[] {
  if (!role) return [];
  if (role.locked === "admin") return ["Everything in Karkhana, and runs this team"];
  return catalogue.filter((c) => role.perms.includes(c.code)).map((c) => c.label);
}

export default function TeamPeople({ roles, catalogue, onChanged }:
  { roles: JobRole[]; catalogue: CatalogueItem[]; onChanged: () => void }) {
  const confirm = useConfirm();
  const [people, setPeople] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase.rpc("karkhana_team");
    if (error) setErr(error.message);
    else { setErr(""); setPeople((data as Member[]) ?? []); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return people;
    return people.filter((p) => [p.full_name, p.email, p.phone, p.role_name]
      .some((x) => String(x ?? "").toLowerCase().includes(t)));
  }, [people, q]);

  async function changeRole(p: Member, roleId: string) {
    const role = roles.find((r) => r.id === roleId);
    if (!role || !supabase) return;
    const can = roleSummary(role, catalogue);
    if (!(await confirm({
      title: `Make ${p.full_name || "this person"} a ${role.name}?`,
      body: `From their next refresh they will be able to: ${can.join(" · ") || "nothing yet"}. They get a message saying their access changed.`,
      confirmLabel: "Change job role", tone: "normal",
    }))) return;
    setBusy(p.user_id); setErr("");
    const { error } = await supabase.rpc("karkhana_set_member_role", { p_user: p.user_id, p_role: roleId });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    load(); onChanged();
  }

  async function remove(p: Member) {
    if (!(await confirm({
      title: `Remove ${p.full_name || p.email}'s login?`,
      body: "They will not be able to sign in any more. Everything they recorded stays, with their name on it in the history.",
      confirmLabel: "Remove login",
    }))) return;
    setBusy(p.user_id); setErr("");
    const e = await callTeam({ action: "delete", user_id: p.user_id });
    setBusy(null);
    if (e) { setErr(e); return; }
    load(); onChanged();
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person or job role"
            className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-hint focus:border-ink/30" />
        </div>
        <span className="text-[12.5px] text-muted">{people.length} {people.length === 1 ? "person" : "people"}</span>
        <button onClick={() => setAdding(true)} className={`${btnPrimary} ml-auto`}>
          <UserPlus size={16} /> Add person
        </button>
      </div>

      {err && <p className="mb-3 rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-2.5 text-[12.5px] font-medium text-ink">{err}</p>}

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted"><Loader2 size={18} className="animate-spin" /> Loading…</div>
        ) : people.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-panel text-ink"><UsersRound size={22} /></span>
            <p className="text-[14px] font-semibold text-ink">No one on the Karkhana team yet</p>
            <p className="max-w-sm text-[12.5px] text-muted">Add a person, give them a job role, and share the login. They see only what their job role allows.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-6 py-10 text-center text-[13px] text-muted">Nobody matches “{q.trim()}”.</p>
        ) : (
          shown.map((p) => {
            const synth = (p.email ?? "").endsWith(SYNTH);
            const role = roles.find((r) => r.id === p.role_id);
            return (
              <div key={p.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-4 py-3.5 last:border-0 sm:px-5">
                <div className="flex min-w-0 flex-1 basis-[220px] items-center gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                    role?.locked === "admin" ? "bg-ink text-white" : "bg-salmon-soft text-ink"}`}>
                    {(p.full_name || p.email || "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-ink">
                      {p.full_name || "—"}
                      {p.is_self && <span className="rounded-full bg-panel px-2 py-px text-[10.5px] font-bold text-muted">you</span>}
                    </p>
                    <p className="truncate text-[12px] text-muted">{synth ? (p.phone || "—") : p.email}</p>
                    <p className="text-[11px] text-hint">{lastSeen(p.last_sign_in_at)}</p>
                  </div>
                </div>

                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <select value={p.role_id ?? ""} disabled={p.is_self || busy === p.user_id}
                    onChange={(e) => changeRole(p, e.target.value)}
                    title={p.is_self ? "Another admin has to change your own job role" : "Job role"}
                    className="min-w-0 flex-1 rounded-xl2 border border-line bg-canvas px-3 py-2 text-[13px] font-semibold text-ink outline-none focus:border-ink/30 disabled:opacity-60 sm:w-[210px] sm:flex-none">
                    {!role && <option value="">{p.role_name || "No job role"}</option>}
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  {busy === p.user_id && <Loader2 size={15} className="animate-spin text-muted" />}
                </div>

                <div className="flex items-center gap-1.5">
                  <button onClick={() => setEditing(p)} title="Change name or email"
                    className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/75 hover:bg-panel">
                    <Pencil size={13} /> Edit
                  </button>
                  <button onClick={() => setResetting(p)} title="Set a new password"
                    className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-ink/75 hover:bg-panel">
                    <KeyRound size={13} /> Password
                  </button>
                  {!p.is_self && (
                    <button onClick={() => remove(p)} disabled={busy === p.user_id} title="Remove login"
                      className="inline-flex items-center gap-1 rounded-full border border-danger/40 px-3 py-1.5 text-[12px] font-semibold text-danger hover:bg-danger-soft disabled:opacity-50">
                      <Trash2 size={13} /> <span className="hidden sm:inline">Remove</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <AddPerson open={adding} roles={roles} catalogue={catalogue}
        onClose={() => setAdding(false)} onDone={() => { load(); onChanged(); }} />
      <EditPerson person={editing} onClose={() => setEditing(null)} onDone={load} />
      <ResetPassword person={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

/* ---------------------------------------------------------------- add */
function AddPerson({ open, roles, catalogue, onClose, onDone }:
  { open: boolean; roles: JobRole[]; catalogue: CatalogueItem[]; onClose: () => void; onDone: () => void }) {
  const firstOperator = roles.find((r) => r.locked === "preset")?.id ?? roles[0]?.id ?? "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [see, setSee] = useState(true);
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ name: string; email: string; pw: string; role: string } | null>(null);

  useEffect(() => {
    if (open) { setName(""); setEmail(""); setPw(makePassword()); setSee(true); setRoleId(firstOperator); setErr(""); setMade(null); }
  }, [open, firstOperator]);

  const role = roles.find((r) => r.id === roleId);

  async function save() {
    setErr("");
    if (!name.trim()) { setErr("Enter the person's name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr("Enter a valid email address — it is what they sign in with."); return; }
    if (pw.length < 6) { setErr("The password must be at least 6 characters."); return; }
    if (!roleId) { setErr("Choose a job role."); return; }
    setBusy(true);
    const e = await callTeam({ action: "create", full_name: name.trim(), email: email.trim(), password: pw, role_id: roleId });
    setBusy(false);
    if (e) { setErr(e); return; }
    setMade({ name: name.trim(), email: email.trim().toLowerCase(), pw, role: role?.name ?? "" });
    onDone();
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={made ? "Login ready" : "Add a person"}
      subtitle={made ? "Share these with them — they choose their own password the first time they sign in." : "They sign in with this email and password, and see only what their job role allows."}>
      {made ? (
        <>
          <Credentials rows={[["Name", made.name], ["Job role", made.role], ["Email", made.email], ["Password", made.pw]]} />
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => { setMade(null); setName(""); setEmail(""); setPw(makePassword()); }} className={btnGhost}>Add another</button>
            <button onClick={onClose} className={btnPrimary}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-3">
            <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bilal Khan" className={inputCls} autoFocus /></Field>
            <Field label="Email — they sign in with this">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Temporary password">
              <PasswordBox value={pw} onChange={setPw} see={see} setSee={setSee} />
            </Field>
            <Field label="Job role">
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputCls}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            {role && <CanList items={roleSummary(role, catalogue)} />}
          </div>
          {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
            <button onClick={save} disabled={busy} className={btnPrimary}>
              {busy && <Loader2 size={15} className="animate-spin" />} Create login
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- edit */
function EditPerson({ person, onClose, onDone }: { person: Member | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (person) {
      setName(person.full_name ?? "");
      setEmail((person.email ?? "").endsWith(SYNTH) ? "" : (person.email ?? ""));
      setErr("");
    }
  }, [person]);

  async function save() {
    if (!person) return;
    setErr("");
    const n = name.trim(), m = email.trim().toLowerCase();
    if (!n) { setErr("Enter the person's name."); return; }
    if (m && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) { setErr("Enter a valid email address."); return; }
    setBusy(true);
    let e: string | null = null;
    if (n !== (person.full_name ?? "")) e = await callTeam({ action: "update_name", user_id: person.user_id, full_name: n });
    if (!e && m && m !== (person.email ?? "").toLowerCase()) e = await callTeam({ action: "update_email", user_id: person.user_id, email: m });
    setBusy(false);
    if (e) { setErr(e); return; }
    onDone(); onClose();
  }

  return (
    <Modal open={!!person} onClose={() => !busy && onClose()} title="Change name or email"
      subtitle="A new email becomes their sign-in straight away. Their password stays the same.">
      <div className="space-y-3">
        <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="off" /></Field>
      </div>
      {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
        <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={15} className="animate-spin" />} Save</button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- password */
function ResetPassword({ person, onClose }: { person: Member | null; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [see, setSee] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { if (person) { setPw(makePassword()); setSee(true); setErr(""); setDone(false); } }, [person]);

  async function save() {
    if (!person) return;
    if (pw.length < 6) { setErr("The password must be at least 6 characters."); return; }
    setBusy(true); setErr("");
    const e = await callTeam({ action: "reset_password", user_id: person.user_id, new_password: pw });
    setBusy(false);
    if (e) { setErr(e); return; }
    setDone(true);
  }

  const who = person?.full_name || person?.email || "";
  return (
    <Modal open={!!person} onClose={() => !busy && onClose()} title={done ? "Password changed" : `New password for ${who}`}
      subtitle={done
        ? (person?.is_self ? "Use it the next time you sign in." : "Share it with them — they choose their own the next time they sign in.")
        : "The old password stops working as soon as you save."}>
      {done ? (
        <>
          <Credentials rows={[["Name", who], ["Email", person?.email ?? ""], ["Password", pw]]} />
          <div className="mt-5 flex justify-end"><button onClick={onClose} className={btnPrimary}>Done</button></div>
        </>
      ) : (
        <>
          <PasswordBox value={pw} onChange={setPw} see={see} setSee={setSee} />
          {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
            <button onClick={save} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={15} className="animate-spin" />} Set password</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- bits */
function PasswordBox({ value, onChange, see, setSee }:
  { value: string; onChange: (v: string) => void; see: boolean; setSee: (v: boolean) => void }) {
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input type={see ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="at least 6 characters" className={`${inputCls} pr-9 font-mono`} autoComplete="new-password" />
        <button type="button" onClick={() => setSee(!see)} aria-label={see ? "Hide password" : "Show password"}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:text-ink">
          {see ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <button type="button" onClick={() => onChange(makePassword())} title="Make a new one"
        className="flex shrink-0 items-center gap-1 rounded-xl2 border border-line px-3 text-[12.5px] font-semibold text-ink/75 hover:bg-panel">
        <Wand2 size={14} /> New
      </button>
    </div>
  );
}

function CanList({ items }: { items: string[] }) {
  return (
    <div className="rounded-xl2 bg-panel/60 px-3.5 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-hint">This job role can</p>
      {items.length === 0
        ? <p className="mt-1 text-[12.5px] text-muted">Nothing yet — tick what it can do under Job roles.</p>
        : <ul className="mt-1 space-y-0.5">{items.map((x) => <li key={x} className="text-[12.5px] text-ink/80">· {x}</li>)}</ul>}
    </div>
  );
}

function Credentials({ rows }: { rows: [string, string][] }) {
  const [copied, setCopied] = useState(false);
  const text = ["Karkhana login", ...rows.map(([k, v]) => `${k}: ${v}`),
    typeof window !== "undefined" ? `Open: ${window.location.origin}/login` : ""].filter(Boolean).join("\n");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { /* the details are on screen to copy by hand */ }
  }
  return (
    <div className="rounded-xl2 border border-success/40 bg-success-soft/60 p-4">
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 text-[13px]">
            <dt className="w-20 shrink-0 text-muted">{k}</dt>
            <dd className={`min-w-0 break-all font-semibold text-ink ${k === "Password" || k === "Email" ? "font-mono" : ""}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <button onClick={copy} className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel">
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />} {copied ? "Copied" : "Copy login details"}
      </button>
    </div>
  );
}
