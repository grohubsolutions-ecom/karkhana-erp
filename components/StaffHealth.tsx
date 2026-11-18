"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Loader2, UserX, X } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { todayPk } from "@/lib/dateRange";

/* WHAT IS WRONG WITH THE STAFF LIST, SAID OUT LOUD (H289, 5 Oct 2026).
 *
 * THE OWNER, 5 OCT: "I added an employee from the Employees section and it is
 * not showing in the Summary", and "a man who joins on the 15th is being paid
 * for the Sundays before he joined."
 *
 * Both are the same kind of fault: something about a person is missing, and
 * nothing on any screen says so. The wage is still computed, and it is still
 * wrong, and the first anybody knows is on payday.
 *
 * So the four things that make a wage wrong are asked for by name, on the
 * screen where wages are read, and the one that is fixed in a second — the
 * joining date — is fixed from right here rather than on another page.
 *
 * It hides itself when there is nothing to say. A panel that is always there
 * saying "all fine" is a panel people stop reading.
 */

type Person = { id: string; name: string };
type Health = {
  missing_from_attendance?: Person[];
  no_join_date?: Person[];
  no_rate?: Person[];
  shared_login?: { login: string; names: string[] }[];
};

export default function StaffHealth({ onChanged }: { onChanged?: () => void }) {
  const [h, setH] = useState<Health | null>(null);
  const [open, setOpen] = useState<string | null>(null);   // emp_id being dated
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    const my = ++reqId.current;
    const { data, error } = await supabase.rpc("hub_staff_health");
    if (my !== reqId.current) return;
    /* A missing function (H289 not run yet) leaves the panel off rather than
       putting an error above the wages. */
    if (error) { setH(null); return; }
    setH((data as Health) ?? null);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(p: Person) {
    if (!supabase || !date) return;
    setBusy(p.id); setErr("");
    const { data, error } = await supabase.rpc("hub_set_join_date", { p_emp_id: p.id, p_join_date: date });
    const res = data as { ok?: boolean; error?: string } | null;
    setBusy("");
    if (error) { setErr(error.message); return; }
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setOpen(null); setDate("");
    setDone(`${p.name} joined ${date}. Sundays before that day are no longer paid.`);
    await load();
    /* The wages above have to be worked out again — the Sundays just moved. */
    onChanged?.();
  }

  const missing = h?.missing_from_attendance ?? [];
  const noDate = h?.no_join_date ?? [];
  const noRate = h?.no_rate ?? [];
  const shared = h?.shared_login ?? [];
  const nothing = missing.length + noDate.length + noRate.length + shared.length === 0;
  if (!h || (nothing && !done)) return null;

  return (
    <div className="mt-3 space-y-2">
      {done && (
        <div role="status" className="flex gap-2 rounded-card border border-emerald-300 bg-emerald-50 p-3 text-[13px] text-emerald-900">
          <Check size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{done}</span>
          <button onClick={() => setDone("")} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"><X size={15} /></button>
        </div>
      )}

      {!nothing && (
        <div className="overflow-hidden rounded-card border border-amber-300 bg-amber-50 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center gap-2 border-b border-amber-300/70 px-4 py-2.5 text-[13px] font-bold text-amber-900 dark:border-white/10 dark:text-amber">
            <AlertTriangle size={15} className="shrink-0" /> Check These Before You Pay
          </div>
          <div className="divide-y divide-amber-300/60 dark:divide-white/[0.08]">

            {/* The person the owner added who never reached the Summary. */}
            {missing.length > 0 && (
              <Section icon={<UserX size={14} />} title="On the Employees list, but not here"
                       note="Their days cannot be marked and no wage is worked out. Open Employees, press Edit on the person and Save — that builds the missing record.">
                {missing.map((p) => <Chip key={p.id} name={p.name} />)}
              </Section>
            )}

            {/* The joining date — fixed right here. */}
            {noDate.length > 0 && (
              <Section icon={<CalendarDays size={14} />} title="No joining date"
                       note="Every Sunday and holiday of their first month is being paid, including the ones before they started. Set the date and that stops — months already marked paid never move.">
                {noDate.map((p) => (
                  <div key={p.id} className="w-full">
                    {open === p.id ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-xl2 border border-amber-400 bg-white px-2.5 py-2 dark:border-white/15 dark:bg-white/[0.06]">
                        <span className="text-[12.5px] font-bold text-ink dark:text-[#f4f1ea]">{p.name}</span>
                        <label className="sr-only" htmlFor={`jd-${p.id}`}>Joined</label>
                        <input id={`jd-${p.id}`} type="date" autoFocus value={date} max={todayPk()}
                          onChange={(e) => setDate(e.target.value)}
                          /* 16px at every width: anything smaller and an iPhone or iPad zooms
                             the page in the moment the box is tapped. */
                          className="h-10 min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-2.5 text-[16px] text-ink outline-none sm:h-9 sm:flex-none dark:border-white/10 dark:bg-white/[0.05] dark:text-[#f4f1ea]" />
                        <button disabled={!date || busy === p.id} onClick={() => save(p)}
                          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40 sm:h-8 dark:bg-white dark:text-[#141414]">
                          {busy === p.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
                        </button>
                        <button onClick={() => { setOpen(null); setErr(""); }}
                          className="h-10 rounded-full border border-line px-3.5 text-[12.5px] font-semibold text-ink sm:h-8 dark:border-white/15 dark:text-white">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => { setOpen(p.id); setDate(""); setErr(""); }}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-amber-400 bg-white px-3 text-[12.5px] font-semibold text-ink hover:bg-amber-100 sm:min-h-0 sm:py-1 dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.10]">
                        <CalendarDays size={13} /> {p.name} — set date
                      </button>
                    )}
                  </div>
                ))}
              </Section>
            )}

            {noRate.length > 0 && (
              <Section icon={<AlertTriangle size={14} />} title="No monthly salary set"
                       note="Every day they work is worth nothing, so their wage reads Rs 0. Set the salary on the Employees page.">
                {noRate.map((p) => <Chip key={p.id} name={p.name} />)}
              </Section>
            )}

            {shared.length > 0 && (
              <Section icon={<UserX size={14} />} title="One login, two people"
                       note="Both can open the portal and read the other's wages. Give each of them their own login on the Employees page.">
                {shared.map((s, i) => <Chip key={i} name={`${s.login}: ${s.names.join(" + ")}`} />)}
              </Section>
            )}
          </div>

          {err && (
            <p className="border-t border-amber-300/70 bg-red-50 px-4 py-2 text-[12.5px] font-medium text-red-800 dark:border-white/10 dark:bg-white/[0.04]">{err}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, note, children }: {
  icon: React.ReactNode; title: string; note: string; children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-amber-900 dark:text-amber">
        <span className="shrink-0">{icon}</span>{title}
      </div>
      <p className="mt-0.5 max-w-[80ch] text-[12px] leading-snug text-amber-900/80 dark:text-[#a89f93]">{note}</p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

const Chip = ({ name }: { name: string }) => (
  <span className="inline-flex items-center rounded-full border border-amber-400 bg-white px-3 py-1 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:bg-white/[0.06] dark:text-white">
    {name}
  </span>
);
