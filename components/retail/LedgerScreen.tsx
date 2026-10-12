"use client";
/* EMPLOYEE LEDGER — advances out, repayments in, one balance per person.
 *
 * WHAT THE THREE COLUMNS MEAN
 *   advance         cash handed over before payday
 *   purchase_credit goods taken from the shop and not paid for
 *   paid            money coming back, either handed in or cut from salary
 *
 * The balance is (advance + purchase_credit) − paid, per person, running from
 * the beginning. It is deliberately not stored anywhere: a stored balance and
 * a list of entries WILL disagree eventually, and when they do nobody can tell
 * which one is lying. Summing the entries every time is slower and correct.
 *
 * WHY THE DEFAULT VIEW IS ONE ROW PER PERSON  (ported from renderLedger)
 *   The question this screen exists to answer is "who owes me what". A flat
 *   list of entries newest-first answers "what happened lately", which is a
 *   different screen, and it cannot be totalled: the same person appears on it
 *   nine times and no row shows their balance. So the rollup is the screen and
 *   the entry list is a tab behind it.
 *
 * TOTAL OUTSTANDING COUNTS POSITIVE BALANCES ONLY
 *   The original:  if (bal > 0.001) { totOut += bal; nOwe++; }
 *   Summing every balance including the negative ones nets one person's credit
 *   against another person's debt, so the headline figure reads lower than the
 *   money actually out on the floor — and it reads lower quietly, with nothing
 *   on screen to say so. A person in credit is money the business owes, not a
 *   discount on what it is owed. See `rollup` below.
 *
 * THE `source` TAG IS THE ONE FIELD THAT CANNOT BE WRONG
 *   advance  → source 'advance'
 *   credit   → source 'advance'   (purchase_credit is still an advance of value)
 *   repay    → source 'repayment'
 *   "Collected this month" on the Repayments screen is defined as the sum of
 *   `paid` where source='repayment'. Write 'manual' instead and the debt is
 *   still right — the balance does not care — but the collection vanishes from
 *   that total and there is nothing left in the row to tell a collection apart
 *   from a salary deduction or an imported row that also carries a `paid`
 *   figure. That is unrecoverable without asking a human what each row was.
 *
 * ROWS THIS SCREEN DOES NOT OWN
 *   source='salary' is written by the month-end payroll run and is tied to a
 *   payslip through retail_salary_payments.ledger_entry_id; deleting it here
 *   would strand the payslip and silently un-deduct money that was already
 *   handed over. source='nimbus' came from the POS import and carries a
 *   dedupe_key, so the next import would overwrite any edit without telling
 *   anyone. Both are shown, labelled, and not editable here.
 *
 * EVERY READ IS PAGED
 *   PostgREST caps a response at 1000 rows and `.limit(1000)` does not raise
 *   that. Worse, the old query ordered by date DESCENDING with that cap, so
 *   past a thousand entries it dropped the OLDEST rows — and advances are
 *   always older than the repayments against them, so the balance came out too
 *   low and every outstanding figure on the screen understated the debt. It is
 *   read all-time through fetchAll instead.
 *
 * ON A PHONE  (Oct 2026 — nothing below 768px changes the computer screen)
 *   All three lists hand DataTable their own `card`, rather than letting the
 *   kit derive one. The derived card picks the LAST right-aligned column as the
 *   big figure, and on every table here that column is a button — "Statement"
 *   on the rollup, the delete bin on the register — so the one number the
 *   screen exists for ended up as a labelled pair halfway down the card while a
 *   button sat where the money should be. Written out by hand:
 *     who-owes-what → the BALANCE is the figure, and the card's left edge is
 *                     red when they owe and green when they are settled, so the
 *                     list can be read without reading it
 *     entries       → the AMOUNT of that entry, red out / green back
 *   The statement inside the modal becomes cards too: as a table it was a
 *   600px-wide scroller inside the modal's own scroller, which on a phone is
 *   two scrollbars fighting over one drag.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  NotebookPen, Plus, HandCoins, Users, Scale, Printer, Trash2, ArrowDownRight, ArrowUpRight, Phone,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import {
  Shell, PageHeader, StatCards, DataTable, Tabs, Pill, Select, BranchPicker, MonthPicker,
  PreviewNote, SourceNote, useEmployees, isHeadOffice, money, num, text, today,
  monthKey, monthBounds, monthLabel, fetchAll,
  RowCard, CardList, useIsPhone,
  type Row, type Col, type Employee,
} from "@/components/retail/kit";
import { useStaffScope } from "@/lib/retailShop";

type Scope = "shops" | "ho";

/** A balance is "settled" below a rupee. Floating point lands an exactly
 *  repaid advance on 0.0000001 often enough that `> 0` would keep people on
 *  the owing list forever, so the whole screen tests against this. */
export const OPEN = 0.001;

/** The columns this screen reads. `note` is deliberately not among them: the
 *  original writes the free-text note into `purchase_details`, which is the
 *  column every other retail screen reads, and asking PostgREST for a column
 *  that is not there fails the whole select rather than just that field. */
const LED_COLS = "id,employee_id,entry_date,advance,purchase_credit,paid,purchase_details,source";

/** What one row put ON the person: cash advanced plus goods taken on credit.
 *  Purchase credit is an advance of value, not a separate kind of debt, and
 *  every figure on this screen adds the two before doing anything else. */
export const advancedOn = (l: Row) => num(l.advance) + num(l.purchase_credit);

/** What a row was, when nobody typed a description. Ported from ledgerDetail:
 *  the tag decides, and a row with money coming back and nothing going out is
 *  a repayment even if it was written before the tag existed. */
const kindLabel = (l: Row, adv: number, rep: number) =>
  String(l.source) === "repayment" || (rep > 0 && adv === 0) ? "repayment" : "advance";

/** Rows this screen may show but must never edit or delete. See the header. */
export const isLockedRow = (l: Row) => {
  const s = String(l.source ?? "");
  return s === "salary" || s === "nimbus";
};

/** Per-person balance, all-time, raw — negative means the business owes them.
 *  Exported because the Employees screen needs exactly this number for its
 *  "Advance owed" column and two implementations of a balance is how a screen
 *  ends up disagreeing with the screen next to it. */
export function balancesByEmployee(rows: Row[]): Record<number, number> {
  const m: Record<number, number> = {};
  rows.forEach((l) => {
    const id = Number(l.employee_id);
    m[id] = (m[id] ?? 0) + advancedOn(l) - num(l.paid);
  });
  return m;
}

/** How a balance reads at a glance on a phone card's left edge: red when the
 *  person owes, amber when the business owes THEM (money pointing the other way
 *  is worth a second look, not a tick), green when it is settled. The same
 *  three cases the Outstanding column spells out in words. */
const balTone = (bal: number): "bad" | "warn" | "good" =>
  bal > OPEN ? "bad" : bal < -OPEN ? "warn" : "good";

function SourcePill({ source }: { source: unknown }) {
  const s = String(source ?? "manual");
  if (s === "advance") return <Pill tone="warn">Advance</Pill>;
  if (s === "repayment") return <Pill tone="good">Repayment</Pill>;
  if (s === "salary") return <Pill tone="info">Salary run</Pill>;
  if (s === "nimbus") return <Pill tone="info">Nimbus</Pill>;
  return <Pill>Manual</Pill>;
}

/* ── the per-employee statement ───────────────────────────────────────────
 * One implementation, used by this screen (tap a name) and by the Employees
 * screen (the Account button). It reads its own rows so it is correct
 * wherever it is opened from, and calls `onSaved` so the list behind it
 * refreshes after an advance or a repayment is recorded.
 */

/* The print copy is a sibling of <body>, so hiding every OTHER child of body
   leaves exactly the sheet on the page. It is rendered through a portal for
   that reason: inside the modal it would be a descendant of a fixed, scrolling,
   overflow-hidden overlay, and print would clip it to the visible box. */
const PRINT_CSS = `
.rt-stmt-print { display: none; }
@media print {
  body > *:not(.rt-stmt-print) { display: none !important; }
  .rt-stmt-print {
    display: block !important;
    background: #ffffff;
    color: #0f172a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @page { margin: 12mm; }
}
`;

type StmtRow = { l: Row; adv: number; rep: number; bal: number };

export function EmployeeStatement({ employee, branchName, onClose, onSaved }: {
  employee: Employee;
  branchName?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState<"adv" | "rep" | null>(null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const phone = useIsPhone();

  /* document.body does not exist while this renders on the server, so the
     print copy waits for the mount. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /* DATE ASCENDING, and paged. A running balance read newest-first is not a
     running balance of anything, and a truncated ledger would show a debt
     smaller than the real one. */
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const { rows: got, error } = await fetchAll<Row>((a, b) =>
      supabase!.from("retail_employee_ledger")
        .select(LED_COLS)
        .eq("employee_id", employee.id)
        .order("entry_date", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .range(a, b));
    if (error) setErr(error);
    setRows(got);
    setLoading(false);
  }, [employee.id]);
  useEffect(() => { load(); }, [load]);

  /** The statement, oldest first, each row carrying the balance after it. */
  const lines = useMemo<StmtRow[]>(() => {
    let bal = 0;
    return rows.map((l) => {
      const adv = advancedOn(l);
      const rep = num(l.paid);
      bal += adv - rep;
      return { l, adv, rep, bal };
    });
  }, [rows]);

  const advT = useMemo(() => lines.reduce((t, r) => t + r.adv, 0), [lines]);
  const repT = useMemo(() => lines.reduce((t, r) => t + r.rep, 0), [lines]);
  const bal = advT - repT;

  async function add(kind: "adv" | "rep") {
    if (!supabase) { setErr("Not connected."); return; }
    const amt = Number(amount);
    if (!amt || amt <= 0) { setErr("Enter an amount above zero."); return; }
    setSaving(kind); setErr("");
    const { error } = await supabase.from("retail_employee_ledger").insert({
      employee_id: employee.id,
      entry_date: date || today(),
      advance: kind === "adv" ? amt : 0,
      purchase_credit: 0,
      paid: kind === "rep" ? amt : 0,
      purchase_details: note.trim() || null,
      /* 'advance' / 'repayment', never 'manual'. This tag is the only thing
         that lets the Repayments screen count what was collected in a month,
         and a mistagged row cannot be worked out afterwards. */
      source: kind === "adv" ? "advance" : "repayment",
    });
    setSaving(null);
    if (error) { setErr(error.message); return; }
    setAmount(""); setNote("");
    load();
    onSaved?.();
  }

  const who = [branchName, employee.designation].filter(Boolean).join(" · ");

  /* ── the printable sheet ──────────────────────────────────────────────
   * Paper, not UI: fixed light colours and no `dark:` variants anywhere. The
   * dark class sits on <html>, so a themed sheet would print white text on a
   * background the printer does not draw.
   */
  const pth = "border border-[#d9dee7] bg-[#eef2f7] px-2.5 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-[#475569]";
  const ptd = "border border-[#d9dee7] px-2.5 py-1.5 text-[12px] text-[#0f172a]";
  const sheet = (
    <div className="bg-white p-0 font-sans text-[#0f172a]">
      <div className="rounded-t-[10px] bg-[#6d28d9] px-5 py-5 text-white">
        <div className="text-[11px] font-bold uppercase tracking-[0.09em] opacity-90">Advance ledger</div>
        <div className="mt-1 text-[21px] font-extrabold">{employee.name}</div>
        {who && <div className="mt-0.5 text-[12.5px] opacity-90">{who}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <div className="min-w-[110px] flex-1 rounded-[9px] bg-[#fef2f2] px-3.5 py-3">
          <div className="text-[10.5px] font-bold text-[#dc2626]">TOTAL ADVANCED</div>
          <div className="mt-0.5 text-[17px] font-extrabold tabular-nums">{money(advT)}</div>
        </div>
        <div className="min-w-[110px] flex-1 rounded-[9px] bg-[#ecfdf5] px-3.5 py-3">
          <div className="text-[10.5px] font-bold text-[#059669]">TOTAL REPAID</div>
          <div className="mt-0.5 text-[17px] font-extrabold tabular-nums">{money(repT)}</div>
        </div>
        <div className={`min-w-[110px] flex-1 rounded-[9px] px-3.5 py-3 ${bal > OPEN ? "bg-[#fff7ed]" : "bg-[#f1f5f9]"}`}>
          <div className="text-[10.5px] font-bold text-[#b45309]">OUTSTANDING</div>
          <div className={`mt-0.5 text-[19px] font-extrabold tabular-nums ${bal > OPEN ? "text-[#b45309]" : "text-[#059669]"}`}>{money(bal)}</div>
        </div>
      </div>
      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr>
            <th className={pth}>Date</th><th className={pth}>Details</th>
            <th className={`${pth} text-right`}>Advance (out)</th>
            <th className={`${pth} text-right`}>Repayment (in)</th>
            <th className={`${pth} text-right`}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ l, adv, rep, bal: b }, i) => (
            <tr key={i}>
              <td className={ptd}>{text(l.entry_date)}</td>
              <td className={`${ptd} text-[#64748b]`}>{text(l.purchase_details, kindLabel(l, adv, rep))}</td>
              <td className={`${ptd} text-right tabular-nums text-[#dc2626]`}>{adv ? money(adv) : "—"}</td>
              <td className={`${ptd} text-right tabular-nums text-[#059669]`}>{rep ? money(rep) : "—"}</td>
              <td className={`${ptd} text-right font-bold tabular-nums`}>{money(b)}</td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr><td className={`${ptd} text-center text-[#94a3b8]`} colSpan={5}>No entries yet.</td></tr>
          )}
        </tbody>
      </table>
      <div className="mt-3 text-[11px] text-[#94a3b8]">Generated {today()}</div>
    </div>
  );

  const boxLabel = "text-[10px] font-bold uppercase tracking-[0.06em]";

  return (
    <Modal open onClose={onClose} wide title={employee.name}
      subtitle={who || "Every advance and repayment, oldest first, with the balance after each one."}>
      <style>{PRINT_CSS}</style>

      {/* ── the three figures ───────────────────────────────────────────
          Three across at 390px leaves 110px a box, and "Rs 1,20,000" does not
          fit in 110px. On a phone Advanced and Repaid share the top line and
          Outstanding — the figure the statement was opened for — takes the
          whole width underneath. Three across from 768px up, as before. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-2.5">
        <div className="rounded-xl2 border border-line bg-danger-soft p-3 dark:border-white/[0.06] dark:bg-white/[0.04]">
          <div className={`${boxLabel} text-danger`}>Advanced</div>
          <div className="mt-1 text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : money(advT)}</div>
        </div>
        <div className="rounded-xl2 border border-line bg-success-soft p-3 dark:border-white/[0.06] dark:bg-white/[0.04]">
          <div className={`${boxLabel} text-success`}>Repaid</div>
          <div className="mt-1 text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : money(repT)}</div>
        </div>
        <div className="rounded-xl2 border border-line bg-amber-soft p-3 max-md:col-span-2 dark:border-white/[0.06] dark:bg-white/[0.04]">
          <div className={`${boxLabel} text-amber-strong`}>Outstanding</div>
          <div className={`mt-1 text-[18px] font-extrabold tabular-nums ${bal > OPEN ? "text-danger" : "text-success"}`}>{loading ? "—" : money(bal)}</div>
        </div>
      </div>

      {/* WHY A CALL BUTTON, AND ONLY HERE: the reason somebody opens a
          statement on a phone is nearly always to ring the person about what
          they owe, and the number is already loaded with the employee. A tel:
          link saves reading it off the screen and typing it into the dialler.
          Phone only — a desktop browser has nothing to hand the number to. */}
      {phone && employee.phone && (
        <a href={`tel:${String(employee.phone).replace(/\s+/g, "")}`}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <Phone size={15} /> Call {employee.phone}
        </a>
      )}

      {/* ── record something, without leaving the statement ────────────── */}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
        {/* decimal, not numeric: on iOS `numeric` is a digits-only pad with no
            decimal point, and a repayment of 1,500.50 cannot be typed on it. */}
        <Field label="Amount"><input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 2000" className={inputCls} /></Field>
      </div>
      <div className="mt-3"><Field label="Details"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="reason / what was taken" className={inputCls} /></Field></div>
      {/* STACKED ON A PHONE, NOT SIDE BY SIDE. These two buttons write money in
          opposite directions and neither asks for confirmation, so half a
          thumb's width between "Give advance" and "Record repayment" is a
          mis-tap that puts a debt on somebody who just paid it off. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => add("adv")} disabled={saving !== null}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-danger px-4 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50 max-md:w-full">
          <ArrowUpRight size={14} /> {saving === "adv" ? "Saving…" : "Give advance"}
        </button>
        <button onClick={() => add("rep")} disabled={saving !== null}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-success px-4 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50 max-md:w-full">
          <ArrowDownRight size={14} /> {saving === "rep" ? "Saving…" : "Record repayment"}
        </button>
      </div>
      {err && <p className="mt-2.5 text-[12.5px] font-semibold text-danger">{err}</p>}

      {/* ── the statement ───────────────────────────────────────────────
          CARDS ON A PHONE. As a table this is 600px wide inside a 44vh box
          inside the modal's own scroller: three nested scroll areas on a 390px
          screen, where a drag that was meant to move the list sideways moves
          the page instead and the row being read disappears. Oldest first
          either way, and each card carries the balance after it — that running
          figure is the whole point of the statement. */}
      {phone ? (
        <CardList rows={lines} loading={loading}
          empty="No entries yet — give an advance or record a repayment above."
          render={({ l, adv, rep, bal: b }, i) => (
            <RowCard key={i}
              title={text(l.purchase_details, kindLabel(l, adv, rep))}
              meta={text(l.entry_date)}
              /* The amount is the figure, and its direction is its colour:
                 red went out to them, green came back. */
              right={adv > 0
                ? <span className="text-danger">{money(adv)}</span>
                : rep > 0 ? <span className="text-success">{money(rep)}</span> : "—"}
              tone={adv > 0 ? "warn" : "good"}
              pills={<SourcePill source={l.source} />}
              /* An imported row can carry an advance AND a repayment at once,
                 and then the lead figure is only half the row. */
              pairs={[
                ...(adv > 0 && rep > 0 ? [{ k: "Repaid", v: money(rep) }] : []),
                { k: "Balance after", v: money(b) },
              ]}
            />
          )} />
      ) : (
      <div className="mt-4 max-h-[44vh] overflow-auto rounded-xl2 border border-line dark:border-white/[0.08]">
        <table className="w-full min-w-[600px] text-left text-[12.5px]">
          <thead className="sticky top-0 bg-panel dark:bg-[#2a251f]">
            <tr className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">
              <th className="px-3 py-2 font-semibold">Date</th>
              <th className="px-3 py-2 font-semibold">Details</th>
              <th className="px-3 py-2 font-semibold">Source</th>
              <th className="px-3 py-2 text-right font-semibold">Advance</th>
              <th className="px-3 py-2 text-right font-semibold">Repaid</th>
              <th className="px-3 py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-white/[0.05]">
            {lines.map(({ l, adv, rep, bal: b }, i) => (
              <tr key={i} className="text-ink dark:text-[#e7e2d8]">
                <td className="px-3 py-2 text-muted dark:text-[#a89f93]">{text(l.entry_date)}</td>
                <td className="px-3 py-2">{text(l.purchase_details, kindLabel(l, adv, rep))}</td>
                <td className="px-3 py-2"><SourcePill source={l.source} /></td>
                <td className="px-3 py-2 text-right tabular-nums text-danger">{adv ? money(adv) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-success">{rep ? money(rep) : "—"}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">{money(b)}</td>
              </tr>
            ))}
            {!loading && lines.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-muted dark:text-[#a89f93]">No entries yet — give an advance or record a repayment above.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-muted dark:text-[#a89f93]">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      <p className="mt-2.5 text-[11.5px] text-hint dark:text-[#8a8175]">
        Balance after each row is <strong>(advance + purchase credit) − repaid</strong>, running from the first
        entry. Rows written by the salary run or the Nimbus import are shown here but belong to those
        screens.
      </p>

      {/* The two buttons share the row at full width on a phone — a 70px
          "Close" pinned to the right edge of a 390px screen is a thumb reaching
          across the whole display for the commonest action on the dialog. */}
      <div className="mt-4 flex justify-end gap-2 max-md:[&>button]:flex-1">
        <button onClick={onClose} className={btnGhost}>Close</button>
        <button onClick={() => window.print()} className={btnPrimary}><Printer size={15} /> Print</button>
      </div>

      {/* Hidden on screen; the only thing on the page when printing. */}
      {mounted && createPortal(<div className="rt-stmt-print">{sheet}</div>, document.body)}
    </Modal>
  );
}

/* ── the screen ──────────────────────────────────────────────────────────── */

type Tab = "people" | "entries" | "advances";
const TABS: { key: Tab; label: string }[] = [
  { key: "people", label: "Who owes what" },
  { key: "entries", label: "All entries" },
  { key: "advances", label: "Advances register" },
];

type Roll = { e: Employee; adv: number; rep: number; bal: number };

const BLANK = { employee_id: "", entry_date: today(), kind: "advance", amount: "", details: "" };

/* THE `source` MAP. Three kinds on the form, two tags in the table, and the
 * middle one is what gets ported wrong: purchase credit is goods taken instead
 * of cash, which is still an advance of value, so it is tagged 'advance' and
 * not something of its own. Only money coming back is 'repayment'. Nothing a
 * person writes here is ever 'manual' — see the note at the top of this file
 * for what 'manual' costs, and why it cannot be repaired afterwards. */
const SOURCE_FOR: Record<string, string> = {
  advance: "advance",
  credit: "advance",
  repay: "repayment",
};

export default function LedgerScreen({ scope }: { scope: Scope }) {
  const { employees, branches } = useEmployees(scope);
  const phone = useIsPhone();
  const [tab, setTab] = useState<Tab>("people");
  const [employeeId, setEmployeeId] = useState("");
  const [month, setMonth] = useState(monthKey());
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [advForm, setAdvForm] = useState({ employee_id: "", entry_date: today(), amount: "", details: "" });
  const [advSaving, setAdvSaving] = useState(false);
  const [statementFor, setStatementFor] = useState<Employee | null>(null);
  const [delFor, setDelFor] = useState<Row | null>(null);

  /* Head office staff sit on the head office branch, shop staff on everything
     else. The picker only offers the branches this screen answers for. */
  const pool = useMemo(
    () => branches.filter((b) => (scope === "ho" ? isHeadOffice(b) : !isHeadOffice(b))),
    [branches, scope]
  );
  /* THE SHOP, from the left menu — except in the Head Office copy of this
     screen, which is not a shop and keeps its own picker. */
  const { branch, setBranch, pickable, inPool } = useStaffScope(branches, pool, scope !== "ho");
  const branchName = useCallback(
    (id: unknown) => branches.find((b) => b.id === Number(id))?.name ?? "—",
    [branches]
  );

  const ids = useMemo(() => employees.map((e) => e.id), [employees]);
  const empName = useCallback(
    (id: unknown) => employees.find((e) => e.id === Number(id))?.name ?? "—",
    [employees]
  );

  /* People the branch filter leaves on screen. The fetch below is deliberately
     NOT re-run when this changes: it reads everyone in scope once, all-time,
     and the filtering happens in memory, so switching branches is instant and
     cannot produce a half-loaded balance. */
  const people = useMemo(
    () => employees.filter((e) => (branch ? String(e.branch_id) === branch : inPool(e.branch_id))),
    [employees, branch, inPool]
  );
  const peopleIds = useMemo(() => new Set(people.map((p) => p.id)), [people]);

  /* ── load ──────────────────────────────────────────────────────────────
   * All-time and paged, oldest first. The old query was
   * `.order(entry_date, desc).limit(1000)`, which past a thousand entries
   * silently dropped the OLDEST rows — and since advances are older than the
   * repayments against them, the balance it produced was systematically too
   * small and every outstanding figure understated the debt.
   */
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    if (ids.length === 0) { setRows([]); setLoading(false); return; }
    setLoading(true); setErr("");
    const { rows: got, error } = await fetchAll<Row>((a, b) =>
      supabase!.from("retail_employee_ledger")
        .select(LED_COLS)
        .in("employee_id", ids)
        .order("entry_date", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .range(a, b));
    if (error) setErr(error);
    setRows(got);
    setLoading(false);
  }, [ids]);
  useEffect(() => { load(); }, [load]);

  const mine = useMemo(() => rows.filter((l) => peopleIds.has(Number(l.employee_id))), [rows, peopleIds]);

  /* ── the rollup ────────────────────────────────────────────────────────
   * One row per active person, and the headline figure.
   *
   * TOTAL OUTSTANDING ADDS POSITIVE BALANCES ONLY — `if (bal > 0.001)`, as the
   * original does. Somebody who has repaid more than they took has a NEGATIVE
   * balance: that is money the business owes them, and letting it cancel
   * another person's debt reports less money out on the floor than there is.
   * The mistake is invisible on screen — the total simply reads lower — which
   * is exactly why it has to be written down here.
   */
  const rollup = useMemo(() => {
    const bal = balancesByEmployee(mine);
    const advRep: Record<number, { adv: number; rep: number }> = {};
    mine.forEach((l) => {
      const id = Number(l.employee_id);
      const g = (advRep[id] ??= { adv: 0, rep: 0 });
      g.adv += advancedOn(l);
      g.rep += num(l.paid);
    });
    const list: Roll[] = people.map((e) => ({
      e,
      adv: advRep[e.id]?.adv ?? 0,
      rep: advRep[e.id]?.rep ?? 0,
      bal: bal[e.id] ?? 0,
    }));
    let totOut = 0, nOwe = 0;
    list.forEach((r) => { if (r.bal > OPEN) { totOut += r.bal; nOwe++; } });
    return {
      list,
      totOut,
      nOwe,
      totAdv: list.reduce((t, r) => t + r.adv, 0),
      totRep: list.reduce((t, r) => t + r.rep, 0),
    };
  }, [mine, people]);

  /** The toggle from the original: the list is people who owe, unless asked. */
  const rollRows = useMemo(
    () => rollup.list.filter((r) => showAll || r.bal > OPEN),
    [rollup.list, showAll]
  );

  /* The footer totals only the rows actually on screen, so a column and its
     total can never tell different stories. Outstanding is the same figure as
     the card above it either way: the rows the toggle hides are the settled
     ones, and a settled person adds nothing to a positive-only total. */
  const shownTotals = useMemo(() => {
    let adv = 0, rep = 0, out = 0;
    rollRows.forEach((r) => { adv += r.adv; rep += r.rep; if (r.bal > OPEN) out += r.bal; });
    return { adv, rep, out };
  }, [rollRows]);

  /* The entry list reads newest first — it is a "what happened lately" view,
     and the running balance that needs ascending order lives in the
     statement, not here. */
  const entries = useMemo(() => {
    const list = employeeId ? mine.filter((l) => String(l.employee_id) === employeeId) : mine;
    return [...list].reverse();
  }, [mine, employeeId]);

  /* ── the monthly advances register ─────────────────────────────────────
   * Month-scoped, rows that put money out (advance > 0). Derived from the
   * all-time set already in memory rather than re-queried: the balances above
   * need every row anyway, and a second query is a second thing that can
   * disagree with the first.
   */
  const advRows = useMemo(() => {
    const [from, to] = monthBounds(month);
    return mine
      .filter((l) => num(l.advance) > 0 && String(l.entry_date ?? "") >= from && String(l.entry_date ?? "") <= to)
      .reverse();
  }, [mine, month]);
  const advTotal = useMemo(() => advRows.reduce((t, l) => t + num(l.advance), 0), [advRows]);

  const stats = [
    { label: "Total outstanding", value: money(rollup.totOut), Icon: Scale },
    { label: "Employees owing", value: String(rollup.nOwe), Icon: Users },
    { label: "Advanced, all time", value: money(rollup.totAdv), Icon: HandCoins },
    { label: "Repaid, all time", value: money(rollup.totRep), Icon: NotebookPen },
  ];

  /* ── writing ─────────────────────────────────────────────────────────── */

  async function save() {
    if (!form.employee_id) { setErr("Pick an employee."); return; }
    const amt = Number(form.amount);
    if (!amt || amt <= 0) { setErr("Enter an amount above zero."); return; }
    if (!supabase) { setErr("Not connected."); return; }
    setSaving(true); setErr("");
    const { error } = await supabase.from("retail_employee_ledger").insert({
      employee_id: Number(form.employee_id),
      entry_date: form.entry_date,
      advance: form.kind === "advance" ? amt : 0,
      purchase_credit: form.kind === "credit" ? amt : 0,
      paid: form.kind === "repay" ? amt : 0,
      purchase_details: form.details.trim() || null,
      source: SOURCE_FOR[form.kind] ?? "advance",
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setOpen(false);
    setForm({ ...BLANK });
    load();
  }

  async function addAdvance() {
    if (!advForm.employee_id) { setErr("Pick an employee."); return; }
    const amt = Number(advForm.amount);
    if (!amt || amt <= 0) { setErr("Enter an amount above zero."); return; }
    if (!supabase) { setErr("Not connected."); return; }
    setAdvSaving(true); setErr("");
    const { error } = await supabase.from("retail_employee_ledger").insert({
      employee_id: Number(advForm.employee_id),
      entry_date: advForm.entry_date,
      advance: amt,
      purchase_credit: 0,
      paid: 0,
      purchase_details: advForm.details.trim() || null,
      source: "advance", // cash out before payday — see SOURCE_FOR above
    });
    setAdvSaving(false);
    if (error) { setErr(error.message); return; }
    setAdvForm({ employee_id: "", entry_date: today(), amount: "", details: "" });
    load();
  }

  async function removeAdvance() {
    if (!delFor || !supabase) return;
    /* Belt and braces: the register already hides the delete button on a
       salary or Nimbus row, and this stops a stale one from firing. */
    if (isLockedRow(delFor)) { setDelFor(null); return; }
    setSaving(true); setErr("");
    const { error } = await supabase.from("retail_employee_ledger").delete().eq("id", Number(delFor.id));
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setDelFor(null); load();
  }

  /* ── tables ────────────────────────────────────────────────────────────── */

  const showBranch = pickable.length > 1 && !branch;

  const rollCols: Col<Roll>[] = [
    { head: "Employee", cell: (r) => (
        <button onClick={() => setStatementFor(r.e)}
          className="text-left font-bold text-ink underline-offset-2 transition hover:underline dark:text-[#f4f1ea]">
          {r.e.name}
        </button>
      ) },
    ...(showBranch ? [{ head: "Branch", muted: true, cell: (r: Roll) => branchName(r.e.branch_id) }] : []),
    { head: "Advanced", right: true, cell: (r) => r.adv ? <span className="text-danger">{money(r.adv)}</span> : "—" },
    { head: "Repaid", right: true, cell: (r) => r.rep ? <span className="text-success">{money(r.rep)}</span> : "—" },
    { head: "Outstanding", right: true, cell: (r) => (
        r.bal > OPEN
          ? <span className="font-bold text-danger">{money(r.bal)}</span>
          : r.bal < -OPEN
            ? <span className="font-bold text-success" title="Repaid more than was taken — the business owes this back">{money(r.bal)}</span>
            : <Pill tone="good">Settled</Pill>
      ) },
    { head: "", right: true, cell: (r) => (
        <button onClick={() => setStatementFor(r.e)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
          Statement
        </button>
      ) },
  ];

  const entryCols: Col<Row>[] = [
    { head: "Date", muted: true, cell: (l) => text(l.entry_date) },
    { head: "Employee", bold: true, cell: (l) => empName(l.employee_id) },
    { head: "Advance", right: true, cell: (l) => (num(l.advance) ? money(l.advance) : "—") },
    { head: "Purchase credit", right: true, cell: (l) => (num(l.purchase_credit) ? money(l.purchase_credit) : "—") },
    { head: "Repaid", right: true, cell: (l) => (num(l.paid) ? money(l.paid) : "—") },
    { head: "Details", muted: true, cell: (l) => text(l.purchase_details) },
    { head: "Source", cell: (l) => <SourcePill source={l.source} /> },
  ];

  const advCols: Col<Row>[] = [
    { head: "Date", muted: true, cell: (l) => text(l.entry_date) },
    { head: "Employee", bold: true, cell: (l) => empName(l.employee_id) },
    { head: "Amount", right: true, cell: (l) => money(l.advance) },
    { head: "Details", muted: true, cell: (l) => text(l.purchase_details) },
    { head: "Source", cell: (l) => <SourcePill source={l.source} /> },
    { head: "", right: true, cell: (l) => (
        /* A salary-run or Nimbus row is shown but not deletable: the first is
           tied to a payslip, the second would come straight back on the next
           import. */
        isLockedRow(l) ? null : (
          <button onClick={() => { setErr(""); setDelFor(l); }} aria-label="Delete advance"
            className="rounded-full p-1.5 text-muted transition hover:bg-danger-soft hover:text-danger dark:text-[#a89f93] dark:hover:bg-white/[0.06]">
            <Trash2 size={15} />
          </button>
        )
      ) },
  ];

  /* ── the same three lists as phone cards ───────────────────────────────
   * Handed to DataTable as `card`, which replaces the kit's derived card below
   * 768px and changes nothing at all above it. Why they are written out rather
   * than hinted per column is at the top of this file: on every table here the
   * last right-aligned column is a button, and that is the slot the derived
   * card fills with the row's big figure.
   */

  /** WHO OWES WHAT. The balance is the figure, the left edge and the pill — the
   *  question is "who owes me what", and it should be answerable by scrolling
   *  past, not by reading. The whole card opens the statement: the 70px
   *  "Statement" pill from the table is a smaller target than the card it sits
   *  in, and tapping the name was already how the statement opened. */
  const rollCard = (r: Roll, i: number) => (
    <RowCard key={i}
      title={r.e.name}
      meta={showBranch ? branchName(r.e.branch_id) : r.e.designation}
      right={<span className={r.bal > OPEN ? "text-danger" : "text-success"}>{money(r.bal)}</span>}
      tone={balTone(r.bal)}
      pills={r.bal > OPEN
        ? <Pill tone="bad">Owes</Pill>
        : r.bal < -OPEN
          /* A Pill never wraps, so this says it in four words rather than
             overflowing the card: repaid more than taken, we owe it back. */
          ? <Pill tone="warn">In credit · we owe this</Pill>
          : <Pill tone="good">Settled</Pill>}
      pairs={[
        { k: "Advanced", v: r.adv ? money(r.adv) : "—" },
        { k: "Repaid", v: r.rep ? money(r.rep) : "—" },
      ]}
      onTap={() => setStatementFor(r.e)}
    />
  );

  /** ALL ENTRIES. The person is what identifies the row — a date identifies
   *  nothing when nine rows share it — and the figure is the amount of THIS
   *  entry, red for value going out and green for money coming back. */
  const entryCard = (l: Row, i: number) => {
    const adv = advancedOn(l);
    const rep = num(l.paid);
    return (
      <RowCard key={i}
        title={empName(l.employee_id)}
        meta={[text(l.entry_date, ""), text(l.purchase_details, "")].filter(Boolean).join(" · ")}
        right={adv > 0
          ? <span className="text-danger">{money(adv)}</span>
          : rep > 0 ? <span className="text-success">{money(rep)}</span> : "—"}
        tone={adv > 0 ? "warn" : "good"}
        pills={<SourcePill source={l.source} />}
        /* Only what the one figure above cannot say: how much of an advance was
           goods rather than cash, and the repayment on a row that carries both
           — which an imported row can. */
        pairs={[
          ...(num(l.purchase_credit) ? [{ k: "Of which credit", v: money(l.purchase_credit) }] : []),
          ...(adv > 0 && rep > 0 ? [{ k: "Repaid", v: money(l.paid) }] : []),
        ]}
      />
    );
  };

  /** ADVANCES REGISTER. Same shape, and the delete stays reachable because
   *  correcting a mistyped advance is exactly the thing somebody does from the
   *  shop floor with a phone in their hand. */
  const advCard = (l: Row, i: number) => (
    <RowCard key={i}
      title={empName(l.employee_id)}
      meta={[text(l.entry_date, ""), text(l.purchase_details, "")].filter(Boolean).join(" · ")}
      right={<span className="text-danger">{money(l.advance)}</span>}
      tone="warn"
      pills={
        <>
          <SourcePill source={l.source} />
          {/* Spelled out, not the 15px bin from the table: at a thumb's
              resolution a bare icon that deletes money is a coin flip. Same
              confirm dialog behind it, and a salary-run or Nimbus row still
              gets no button at all. */}
          {!isLockedRow(l) && (
            <button onClick={() => { setErr(""); setDelFor(l); }}
              className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger-soft px-3 py-2 text-[11.5px] font-semibold text-danger dark:border-danger/40 dark:bg-white/[0.06]">
              <Trash2 size={13} /> Delete
            </button>
          )}
        </>
      }
    />
  );

  return (
    <Shell>
      <PageHeader
        title={scope === "ho" ? "Head Office Ledger" : "Employee Ledger"}
        subtitle="Outstanding advances per employee. Tap a name for the full statement — advances, repayments and running balance."
        onRefresh={load} loading={loading}
      >
        {pickable.length > 1 && (
          /* Switching branch clears the employee filter: a person from the old
             branch left selected would empty the entry list with nothing on
             screen explaining why. */
          <BranchPicker branches={pickable} value={branch} onChange={(v) => { setBranch(v); setEmployeeId(""); }} />
        )}
        {tab === "entries" && (
          <Select value={employeeId} onChange={setEmployeeId}>
            <option value="">Everyone</option>
            {people.map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
          </Select>
        )}
        {tab === "advances" && <MonthPicker value={month} onChange={setMonth} />}
        {/* `today()` again on open, not the one frozen into BLANK when the
            module loaded. A phone keeps this tab alive for days, and an advance
            entered on Tuesday dated last Saturday lands in the wrong month's
            register with nothing on screen to say so. */}
        <button onClick={() => { setForm({ ...BLANK, entry_date: today(), employee_id: employeeId }); setErr(""); setOpen(true); }} className={btnPrimary}>
          <Plus size={15} /> New entry
        </button>
      </PageHeader>

      <StatCards stats={stats} loading={loading} />

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">{err}</p>}

      {tab === "people" && (
        <>
          <div className="mt-4">
            <button onClick={() => setShowAll((v) => !v)} className={btnGhost}>
              {showAll ? "Show only outstanding" : "Show all employees"}
            </button>
          </div>
          <DataTable cols={rollCols} rows={rollRows} loading={loading} minWidth={showBranch ? 880 : 760}
            empty={showAll ? "No employees on this branch yet." : "No outstanding advances — nobody owes anything."}
            card={rollCard}
            /* SIX CELLS DO NOT FIT ON A PHONE. The totals row is kept — it is
               the figure the shop's owner scrolls to the bottom for — but five
               money columns across 358px either wrap every figure in half or
               push the last one out of the card and under the clip. Two lines
               of two instead, outstanding first. */
            footer={phone ? (
              <>
                <tr className="text-ink dark:text-[#f4f1ea]">
                  <td className="px-3.5 pt-3 font-bold">Outstanding · {rollRows.length} shown</td>
                  <td className="px-3.5 pt-3 text-right font-bold tabular-nums text-danger">{money(shownTotals.out)}</td>
                </tr>
                <tr className="text-[12px] text-muted dark:text-[#a89f93]">
                  <td className="px-3.5 pb-3 pt-1">Advanced {money(shownTotals.adv)}</td>
                  <td className="px-3.5 pb-3 pt-1 text-right tabular-nums">Repaid {money(shownTotals.rep)}</td>
                </tr>
              </>
            ) : (
              <tr className="text-ink dark:text-[#f4f1ea]">
                <td className="px-4 py-3 font-bold" colSpan={showBranch ? 2 : 1}>
                  Total · {rollRows.length} shown
                </td>
                <td className="px-4 py-3 text-right font-bold tabular-nums">{money(shownTotals.adv)}</td>
                <td className="px-4 py-3 text-right font-bold tabular-nums">{money(shownTotals.rep)}</td>
                <td className="px-4 py-3 text-right font-bold tabular-nums text-danger">{money(shownTotals.out)}</td>
                <td className="px-4 py-3" />
              </tr>
            )} />
          <SourceNote>
            <strong>Total outstanding</strong> adds up the people who owe something and nobody else.
            A person who has repaid more than they took is money the business owes <em>them</em>; letting
            that cancel somebody else&apos;s debt would report less cash out on the floor than there
            really is, and nothing on the screen would say so.
          </SourceNote>
        </>
      )}

      {tab === "entries" && (
        <>
          <DataTable cols={entryCols} rows={entries} loading={loading} minWidth={920}
            card={entryCard}
            empty="No ledger entries — advances and purchase credit will appear here." />
          <SourceNote>
            Every row, newest first. <strong>Advance</strong> is cash out, <strong>purchase credit</strong> is
            goods taken and unpaid — both are tagged <strong>advance</strong>, because credit is an advance
            of value. Money coming back is tagged <strong>repayment</strong>, and that tag is what lets the
            Repayments screen count a month&apos;s collection. Rows from the <strong>salary run</strong> and
            from <strong>Nimbus</strong> are shown as such and belong to those screens.
          </SourceNote>
        </>
      )}

      {tab === "advances" && (
        <>
          <div className="mt-4 rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
            <h3 className="text-[14px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">Add advance</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Employee">
                <select value={advForm.employee_id} onChange={(e) => setAdvForm({ ...advForm, employee_id: e.target.value })} className={inputCls}>
                  <option value="">Pick someone</option>
                  {people.map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
                </select>
              </Field>
              {/* decimal, not numeric: iOS gives `numeric` a digits-only pad
                  with no decimal point on it. */}
              <Field label="Amount"><input type="number" inputMode="decimal" value={advForm.amount} onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })} placeholder="5000" className={inputCls} /></Field>
              <Field label="Date"><input type="date" value={advForm.entry_date} onChange={(e) => setAdvForm({ ...advForm, entry_date: e.target.value })} className={inputCls} /></Field>
              <Field label="Note"><input value={advForm.details} onChange={(e) => setAdvForm({ ...advForm, details: e.target.value })} placeholder="optional" className={inputCls} /></Field>
            </div>
            <div className="mt-3.5 flex justify-end max-md:[&>button]:w-full">
              <button onClick={addAdvance} disabled={advSaving} className={btnPrimary}>
                <Plus size={15} /> {advSaving ? "Saving…" : "Add advance"}
              </button>
            </div>
          </div>

          <DataTable cols={advCols} rows={advRows} loading={loading} minWidth={860}
            card={advCard}
            empty={`No advances in ${monthLabel(month)}.`}
            footer={phone ? (
              <tr className="text-ink dark:text-[#f4f1ea]">
                <td className="px-3.5 py-3 font-bold">Total · {advRows.length} advance{advRows.length === 1 ? "" : "s"}</td>
                <td className="px-3.5 py-3 text-right font-bold tabular-nums">{money(advTotal)}</td>
              </tr>
            ) : (
              <tr className="text-ink dark:text-[#f4f1ea]">
                <td className="px-4 py-3 font-bold" colSpan={2}>Total</td>
                <td className="px-4 py-3 text-right font-bold tabular-nums">{money(advTotal)}</td>
                <td className="px-4 py-3" colSpan={3} />
              </tr>
            )} />
          <SourceNote>
            Advances paid out in {monthLabel(month)} — deducted from that month&apos;s payable salary on the
            Salaries screen. Everything added here is tagged <strong>advance</strong>; a row written by the
            salary run or by an import is listed but cannot be deleted from this screen.
          </SourceNote>
        </>
      )}

      {/* ── new entry ───────────────────────────────────────────────────── */}
      <Modal open={open} onClose={() => setOpen(false)} title="New ledger entry"
        subtitle="One entry, one kind. Recording an advance and a repayment together hides which is which.">
        <div className="space-y-3.5">
          {/* ONE COLUMN ON A PHONE. Two half-width fields inside a dialog that
              is already only 390px wide leaves each one too narrow to show the
              name it is holding, and the 16px font the phone CSS forces on
              inputs (so iOS does not zoom) makes that worse, not better. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Employee">
              <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} className={inputCls}>
                <option value="">Pick someone</option>
                {people.map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
              </select>
            </Field>
            <Field label="Date"><input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={inputCls}>
              <option value="advance">Advance — cash given before payday</option>
              <option value="credit">Purchase credit — goods taken, unpaid</option>
              <option value="repay">Repayment — money coming back</option>
            </select>
          </Field>
          <Field label="Amount"><input type="number" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} autoFocus /></Field>
          <Field label={form.kind === "credit" ? "What was taken" : "Details"}>
            <input value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} className={inputCls}
              placeholder={form.kind === "credit" ? "e.g. 2 shirts, 1 trouser" : "Optional"} />
          </Field>
          {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}
          <div className="flex justify-end gap-2 pt-1 max-md:[&>button]:flex-1">
            <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
            <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Saving…" : "Add entry"}</button>
          </div>
          {!isSupabaseConfigured && <p className="text-center text-[12px] text-hint">Preview build — nothing will be saved.</p>}
        </div>
      </Modal>

      {/* ── delete an advance ───────────────────────────────────────────── */}
      <Modal open={!!delFor} onClose={() => setDelFor(null)} title="Delete this advance?"
        subtitle="The amount comes straight off what the person owes.">
        <div className="space-y-3.5">
          {delFor && (
            <p className="rounded-xl2 bg-panel/60 px-3.5 py-2.5 text-[12.5px] text-ink dark:bg-white/[0.04] dark:text-[#e7e2d8]">
              <strong>{empName(delFor.employee_id)}</strong> · {text(delFor.entry_date)} · <strong>{money(delFor.advance)}</strong>
            </p>
          )}
          {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}
          <div className="flex justify-end gap-2 max-md:[&>button]:flex-1">
            <button onClick={() => setDelFor(null)} className={btnGhost}>Keep it</button>
            <button onClick={removeAdvance} disabled={saving} className={btnPrimary}>{saving ? "Deleting…" : "Delete"}</button>
          </div>
        </div>
      </Modal>

      {statementFor && (
        <EmployeeStatement
          employee={statementFor}
          branchName={branchName(statementFor.branch_id)}
          onClose={() => setStatementFor(null)}
          onSaved={load}
        />
      )}

      <PreviewNote />
    </Shell>
  );
}
