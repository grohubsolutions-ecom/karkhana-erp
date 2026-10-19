"use client";
/* PAID, WITH THE ADVANCE CUT (H284, 1 Oct 2026).
 *
 * The owner: "when we press Paid there should be a message — this employee has
 * this much advance, how much do you want to cut. A custom amount, and by
 * default the whole advance. If the advance was 10k and I cut 5k, the other
 * 5k moves to next month with the comment 'advance carried forward'."
 *
 * Until now that was arithmetic done by hand: Hamza Khan's September advances
 * came to Rs 166,810 against one month's pay, and Rs 106,143 was typed into
 * October as "last month advance". This dialog does the same sum, shows it,
 * and lets the amount be changed before anything is saved.
 *
 * THE LIMITS, SAID BEFORE THEY ARE HIT
 *   - no more than the advance can be cut;
 *   - no more than was earned this month can be cut — the pay cannot go
 *     below zero, so the default stops there and the rest carries forward.
 * The database checks both again (hub_salary_mark_paid); this only says so
 * early, in words.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const rs = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");

export type PayTarget = {
  emp_id: string; name: string;
  /* the month's advances, all of them (carried-in ones too) */
  advances: number;
  /* what was earned this month, whole rupees: payable + advances while unpaid */
  earned: number;
};
type Adv = { id: string; date: string; amount: number; note: string | null; carried_from: string | null };

export default function PaySalaryDialog({ target, year, month, onClose, onDone }: {
  target: PayTarget | null; year: number; month: number;
  onClose: () => void; onDone: (report: string) => void;
}) {
  const due = Math.max(0, Math.round(target?.advances ?? 0));
  const earned = Math.max(0, Math.round(target?.earned ?? 0));
  const best = Math.min(due, earned);
  const [cut, setCut] = useState("");
  const [advs, setAdvs] = useState<Adv[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const monthName = MONTHS[month];
  const nextName = MONTHS[next.m];

  useEffect(() => {
    if (!target) return;
    setCut(String(best)); setErr(""); setAdvs([]);
    if (!supabase) return;
    const db = supabase;
    let live = true;
    (async () => {
      const { data } = await db.from("online_att_advances").select("id,date,amount,note,carried_from")
        .eq("emp_id", target.emp_id).eq("deduct_year", year).eq("deduct_month", month).order("date");
      if (live) setAdvs((data as Adv[]) ?? []);
    })();
    return () => { live = false; };
    // `best` follows target; listing it would reset a typed amount on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, year, month]);

  const n = useMemo(() => {
    const t = cut.trim();
    if (t === "") return NaN;
    const v = Number(t.replace(/,/g, ""));
    return Number.isFinite(v) ? v : NaN;
  }, [cut]);
  const problem =
    Number.isNaN(n) ? "Write how much to cut — 0 if nothing."
    : !Number.isInteger(n) ? "Whole rupees only."
    : n < 0 ? "The amount cannot be below zero."
    : n > due ? `Only ${rs(due)} of advance is due — that is the most that can be cut.`
    : n > earned ? `Only ${rs(earned)} was earned in ${monthName} — that is the most that can be cut.`
    : "";
  const cutN = problem ? 0 : n;
  const carry = due - cutN;
  const net = earned - cutN;

  async function save() {
    if (!supabase || !target || problem) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_salary_mark_paid", {
      p_emp: target.emp_id, p_year: year, p_month: month, p_cut: cutN,
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string; report?: string } | null;
    if (error) { setErr(error.message); return; }
    if (!res?.ok) { setErr(res?.error ?? "It was not saved and no reason was given."); return; }
    onDone(res.report ?? `${target.name} marked paid.`);
  }

  return (
    <Modal open={!!target} onClose={() => { if (!busy) onClose(); }}
      title={target ? `Mark ${monthName} paid — ${target.name}` : ""}
      subtitle={`${monthName} ${year} salary`}>
      {target && (<>
        <div className="rounded-xl2 border border-amber-300/70 bg-amber-soft px-3.5 py-3 dark:border-amber/30 dark:bg-white/[0.05]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold text-amber-900 dark:text-amber">
              {target.name} has an advance of
            </span>
            <span className="text-[19px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(due)}</span>
          </div>
          {advs.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-amber-300/50 pt-2 text-[12.5px] dark:border-white/10">
              {advs.map((a) => {
                /* H296: a minus row is money given back — it already came off the advance above. */
                const back = Number(a.amount) < 0;
                return (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-muted dark:text-[#a89f93]">
                      <span className="tabular-nums">{a.date}</span>
                      {back && <span className="font-semibold text-emerald-700 dark:text-success"> · Given back</span>}
                      {a.note && !(back && a.note === "Advance returned")
                        ? <span className={a.carried_from ? " font-semibold text-ink dark:text-[#e7e2d8]" : ""}> · {a.note}</span> : null}
                    </span>
                    <span className={`shrink-0 font-semibold tabular-nums ${back ? "text-emerald-700 dark:text-success" : "text-ink dark:text-[#e7e2d8]"}`}>
                      {back ? `− ${rs(-Number(a.amount))}` : rs(a.amount)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-4">
          <Field label={`How much to cut from ${monthName}'s salary?`}>
            <input value={cut} onChange={(e) => setCut(e.target.value)} inputMode="numeric" autoFocus
              aria-label="Amount to cut" aria-invalid={!!problem}
              className={`${inputCls} max-sm:text-[16px] tabular-nums ${problem ? "border-danger" : ""}`} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setCut(String(best))}
              className={`rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition ${cutN === best && !problem
                ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
                : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10"}`}>
              {best === due ? `Whole advance ${rs(due)}` : `All that was earned ${rs(best)}`}
            </button>
            <button type="button" onClick={() => setCut("0")}
              className={`rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition ${cutN === 0 && !problem
                ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-[#141414]"
                : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/10"}`}>
              Nothing — move it all to {nextName}
            </button>
          </div>
          {problem ? (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] font-semibold text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />{problem}
            </p>
          ) : due > earned ? (
            <p className="mt-2 text-[12px] leading-snug text-muted dark:text-[#a89f93]">
              {rs(earned)} was earned in {monthName}, so no more than that can be cut — the pay cannot go below zero.
            </p>
          ) : null}
        </div>

        <dl className="mt-4 overflow-hidden rounded-xl2 border border-line text-[13px] dark:border-white/10">
          <div className="flex justify-between gap-3 px-3.5 py-2">
            <dt className="text-muted dark:text-[#a89f93]">Earned in {monthName}</dt>
            <dd className="font-semibold tabular-nums">{rs(earned)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-line px-3.5 py-2 dark:border-white/10">
            <dt className="text-muted dark:text-[#a89f93]">Advance cut</dt>
            <dd className="font-semibold tabular-nums text-amber-700 dark:text-amber">− {rs(cutN)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-line bg-panel px-3.5 py-2.5 dark:border-white/10 dark:bg-white/[0.04]">
            <dt className="font-bold text-ink dark:text-[#f4f1ea]">Net to pay now</dt>
            <dd className="text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(net)}</dd>
          </div>
          {carry > 0 && (
            <div className="border-t border-line px-3.5 py-2.5 dark:border-white/10">
              <div className="flex justify-between gap-3">
                <dt className="flex items-center gap-1.5 font-semibold text-ink dark:text-[#f4f1ea]">
                  <ArrowRight size={13} /> Moves to {nextName} {next.y}
                </dt>
                <dd className="font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(carry)}</dd>
              </div>
              <p className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">
                as an advance in {nextName}&rsquo;s pay, with the comment &ldquo;Advance carried forward from {monthName} {year}&rdquo;
              </p>
            </div>
          )}
        </dl>

        {err && (
          <p className="mt-3 flex items-start gap-1.5 rounded-xl2 bg-danger-soft px-3 py-2 text-[12.5px] font-semibold text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />{err}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={save} disabled={busy || !!problem} className={btnPrimary}>
            {busy && <Loader2 size={14} className="animate-spin" />} Mark paid
          </button>
          <button onClick={onClose} disabled={busy} className={btnGhost}>Cancel</button>
        </div>
      </>)}
    </Modal>
  );
}
