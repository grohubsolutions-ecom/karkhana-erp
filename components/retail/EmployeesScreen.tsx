"use client";
/* Employees — shop floor and head office.
 *
 * ONE COMPONENT, TWO SCREENS. The old app had a separate Employees page under
 * Head Office and another under the shops, and they drifted: one grew a pay
 * type and the other did not. They are the same table and the same job, so the
 * only thing that differs here is which branches are in scope.
 *
 * WHY "ADVANCE OWED" AND "NET TO PAY" ARE ON THIS TABLE
 *   This is the screen the shop manager has open on payday. The salary is one
 *   half of the answer and what the person already took is the other, and the
 *   original (renderStaff / renderShopAdvance / renderHOAdvance) has always
 *   shown both side by side with the subtraction done. Sending somebody to a
 *   second screen to find out what to actually hand over is how the wrong
 *   amount gets handed over.
 *
 *     advance owed = Σ (advance + purchase_credit − paid), all time, floored at 0
 *     net to pay   = salary − advance owed
 *
 *   Floored at zero because a person in credit — repaid more than they took —
 *   is money the business owes them, and letting a negative balance inflate
 *   their own net pay would quietly pay that credit twice. It is settled as its
 *   own entry on the Ledger screen, not by a bigger salary here.
 *
 *   The balance is never stored. A stored balance and a list of entries WILL
 *   disagree eventually, and when they do nobody can tell which is lying.
 *
 * SALARY IS NOT ONE FORMULA
 *   Monthly staff earn the full monthly_salary, flat — days present do not
 *   scale it. Hourly staff earn hourly_rate × the hours actually recorded this
 *   month, so an hourly person with no times in retail_attendance earns
 *   nothing, which is the honest answer rather than a guess with money on it.
 *
 * LEAVERS STAY LISTED
 *   This is the admin screen, so it reads `allEmployees` — the list that still
 *   includes people who have left. Everywhere else takes the active list: a
 *   leaver in a payroll total is a wrong number. Here, somebody who left last
 *   month may still owe an advance, and a person you cannot find is a person
 *   whose record gets typed in a second time.
 *
 * ON A PHONE (Oct 2026) — nothing below 768px reaches the computer screen.
 *   The table is nine columns and 1,080px wide, so on a phone each person is a
 *   card: the name as the title, net to pay as the one big figure, and the
 *   number turned into a Call and a WhatsApp button, because on a phone a
 *   number is not something you read — it is the next thing you do.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, UserPlus, Pencil, Wallet, Store, Scale, Phone, MessageCircle } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import Modal, { Field, inputCls, btnPrimary, btnGhost } from "@/components/Modal";
import {
  Shell, PageHeader, StatCards, DataTable, Pill, Select, PreviewNote, SourceNote,
  useIsPhone, useEmployees, isHeadOffice, isHourly, attHours, money, num, text,
  monthKey, monthBounds, monthLabel, fetchAll,
  type Employee, type Col, type Row,
} from "@/components/retail/kit";
import { useShopScope } from "@/lib/retailShop";
import { EmployeeStatement, balancesByEmployee } from "@/components/retail/LedgerScreen";

type Scope = "shops" | "ho";

const BLANK = {
  name: "", branch_id: "", designation: "Sales Person", phone: "",
  monthly_salary: "", pay_type: "monthly", hourly_rate: "", active: true,
};

/** Hours to "7h 30m", so a figure that pays money is readable at a glance. */
const hm = (h: number) => `${Math.floor(h)}h ${Math.round((h - Math.floor(h)) * 60)}m`;

/** THE NUMBER, THE WAY WHATSAPP INSISTS ON HAVING IT.
 *
 *  wa.me will not open a chat on a local number: it wants the country code, no
 *  plus and no leading zero. Staff numbers are typed into this screen the way
 *  they are said out loud — "0301-234 5678", "0321 4567890" — so the spaces,
 *  the dashes and that first 0 come off and 92 goes on. A number already stored
 *  internationally (+92…, 0092…) is left alone rather than given a second 92.
 *
 *  `tel:` deliberately does NOT use this. The dialler understands a local
 *  number, and the phone's own contacts match on the local form, so rewriting
 *  it there would lose the name the shop has saved for the person. */
function waNumber(raw: string) {
  const d = String(raw).replace(/\D/g, "").replace(/^00/, "");
  return d.startsWith("92") ? d : "92" + d.replace(/^0+/, "");
}

/** The buttons along the bottom of a phone card. 44px because they are the
 *  reason the card exists and two of them place a call. */
const cardBtn = "flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[13px] font-semibold text-ink transition active:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white";

export default function EmployeesScreen({ scope }: { scope: Scope }) {
  const phone = useIsPhone();
  const { allEmployees, branches, reloadEmployees } = useEmployees(scope);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ledger, setLedger] = useState<Row[]>([]);
  const [att, setAtt] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountFor, setAccountFor] = useState<Employee | null>(null);

  const month = monthKey();

  /* Head office staff live on the Head Office branch; shop staff on everything
     else. The picker only offers the branches this screen is responsible for,
     so nobody accidentally files a shop salesman under Head Office. */
  const pickable = useMemo(
    () => branches.filter((b) => (scope === "ho" ? isHeadOffice(b) : !isHeadOffice(b))),
    [branches, scope]
  );

  /* THE SHOP, from the left menu — Head Office excepted, which is not a shop.
     It narrows the LIST only. The form's branch dropdown keeps the full
     `pickable`, because moving somebody from Top Shop to FC DHA is a thing
     that happens and a form that could not express it would send people back
     to the database. */
  const shop = useShopScope(branches);
  const listed = useMemo(() => {
    if (scope === "ho" || !shop.ids) return null;
    return new Set(shop.ids);
  }, [scope, shop.ids]);
  const branchName = useCallback(
    (id: unknown) => branches.find((b) => b.id === Number(id))?.name ?? "—",
    [branches]
  );

  const ids = useMemo(() => allEmployees.map((e) => e.id), [allEmployees]);

  /* ── load ──────────────────────────────────────────────────────────────
   * The ledger is read ALL-TIME, because an advance given in March is still
   * owed in September; the attendance is read for the current month, because
   * that is the month being paid. Both are paged — PostgREST caps a plain
   * response at 1000 rows without saying so, and a truncated ledger would
   * report somebody as owing less than they do.
   */
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    if (ids.length === 0) { setLedger([]); setAtt([]); setLoading(false); return; }
    setLoading(true);
    const [from, to] = monthBounds(month);
    /* BOTH ARE ORDERED ON id, WHICH IS WHAT MAKES THE PAGING SOUND.
       fetchAll pages with .range() — LIMIT/OFFSET, one request per page — and a
       query with no total order lets Postgres return the rows in a different
       order each time, so a row can come back on two pages or on none. Every
       figure these two feed is a SUM: a duplicated advance makes somebody look
       like they owe money they do not, and a dropped one hides money they do.
       Neither read had an ORDER BY to preserve and neither feeds an on-screen
       order — both are reduced to per-person totals — so `id` alone is the whole
       order, and nothing about this screen looks different. */
    const [led, atn] = await Promise.all([
      fetchAll<Row>((a, b) =>
        supabase!.from("retail_employee_ledger")
          .select("employee_id,advance,purchase_credit,paid")
          .in("employee_id", ids).order("id", { ascending: true }).range(a, b)),
      fetchAll<Row>((a, b) =>
        supabase!.from("retail_attendance")
          .select("employee_id,att_date,time_in,time_out")
          .in("employee_id", ids).gte("att_date", from).lte("att_date", to)
          .order("id", { ascending: true }).range(a, b)),
    ]);
    if (led.error || atn.error) setErr(led.error || atn.error);
    setLedger(led.rows);
    setAtt(atn.rows);
    setLoading(false);
  }, [ids, month]);
  useEffect(() => { load(); }, [load]);

  /** Hours worked this month, per person. Either time missing means no hours:
   *  somebody clocked in and never out has an incomplete record, not an
   *  unknown number of hours, and guessing one would put money on it. */
  const hours = useMemo(() => {
    const m: Record<number, number> = {};
    att.forEach((a) => {
      const id = Number(a.employee_id);
      m[id] = (m[id] ?? 0) + attHours(a.time_in as string, a.time_out as string);
    });
    return m;
  }, [att]);

  /** What each person owes. Raw — negatives are kept here and floored where
   *  they are used, so the two meanings stay visible to the reader. */
  const balances = useMemo(() => balancesByEmployee(ledger), [ledger]);

  /** The month's earnings. Ported from empEarned. */
  const earned = useCallback(
    (e: Employee) => (isHourly(e) ? Math.round(num(e.hourly_rate) * (hours[e.id] ?? 0)) : num(e.monthly_salary)),
    [hours]
  );
  /* Floored at zero — see the note at the top of this file. */
  const owed = useCallback((e: Employee) => Math.max(0, balances[e.id] ?? 0), [balances]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allEmployees
      .filter((e) => !listed || listed.has(Number(e.branch_id)))
      .filter((e) => showInactive || e.active !== false)
      .filter((e) => !needle || e.name.toLowerCase().includes(needle) || (e.designation ?? "").toLowerCase().includes(needle));
  }, [allEmployees, q, showInactive, listed]);

  const totals = useMemo(() => {
    const sal = rows.reduce((t, e) => t + earned(e), 0);
    const ow = rows.reduce((t, e) => t + owed(e), 0);
    return { sal, ow, net: sal - ow };
  }, [rows, earned, owed]);

  const stats = useMemo(() => {
    const active = allEmployees.filter((e) => e.active !== false);
    const monthly = active.filter((e) => !isHourly(e));
    return [
      { label: "On the books", value: String(active.length), Icon: Users },
      { label: "Monthly paid", value: String(monthly.length), Icon: Wallet },
      { label: "Monthly wage bill", value: money(monthly.reduce((t, e) => t + num(e.monthly_salary), 0)), Icon: Store },
      { label: "Advances owed", value: money(active.reduce((t, e) => t + owed(e), 0)), Icon: Scale },
    ];
  }, [allEmployees, owed]);

  function startAdd() {
    setEditing(null);
    setForm({ ...BLANK, branch_id: pickable[0] ? String(pickable[0].id) : "" });
    setErr(""); setOpen(true);
  }
  function startEdit(e: Employee) {
    setEditing(e);
    setForm({
      name: e.name ?? "", branch_id: e.branch_id == null ? "" : String(e.branch_id),
      designation: e.designation ?? "", phone: e.phone ?? "",
      monthly_salary: e.monthly_salary == null ? "" : String(e.monthly_salary),
      pay_type: e.pay_type ?? "monthly",
      hourly_rate: e.hourly_rate == null ? "" : String(e.hourly_rate),
      active: e.active !== false,
    });
    setErr(""); setOpen(true);
  }

  async function save() {
    if (!form.name.trim()) { setErr("A name is required."); return; }
    if (!supabase) { setErr("Not connected."); return; }
    setSaving(true); setErr("");
    const payload = {
      name: form.name.trim(),
      branch_id: form.branch_id ? Number(form.branch_id) : null,
      designation: form.designation.trim() || null,
      phone: form.phone.trim() || null,
      monthly_salary: form.monthly_salary === "" ? 0 : Number(form.monthly_salary),
      pay_type: form.pay_type,
      /* Blank, not zero. An hourly rate of zero is a claim that the person
         works for nothing; a blank one says nobody has set it yet. */
      hourly_rate: form.hourly_rate === "" ? null : Number(form.hourly_rate),
      active: form.active,
    };
    const { error } = editing
      ? await supabase.from("retail_employees").update(payload).eq("id", editing.id)
      : await supabase.from("retail_employees").insert(payload);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setOpen(false); reloadEmployees();
  }

  const cols: Col<Employee>[] = [
    { head: "Name", cell: (e) => (
        <div>
          <span className="font-semibold">{e.name}</span>
          {e.active === false && <span className="ml-2"><Pill>Left</Pill></span>}
          {isHourly(e) && (
            <div className="text-[11px] text-muted dark:text-[#a89f93]">
              {hm(hours[e.id] ?? 0)} @ {money(e.hourly_rate)}/hr
            </div>
          )}
        </div>
      ) },
    { head: "Designation", muted: true, cell: (e) => text(e.designation) },
    { head: scope === "ho" ? "Office" : "Branch", cell: (e) => branchName(e.branch_id) },
    { head: "Phone", muted: true, cell: (e) => text(e.phone) },
    { head: "Pay", cell: (e) => isHourly(e) ? <Pill tone="warn">Hourly</Pill> : <Pill tone="info">Monthly</Pill> },
    { head: "Rate", right: true, cell: (e) => isHourly(e)
        ? (e.hourly_rate == null ? "—" : money(e.hourly_rate) + " /hr")
        : money(e.monthly_salary) },
    /* The two figures payday actually needs. */
    { head: "Advance owed", right: true, cell: (e) => {
        const o = owed(e);
        return o > 0.001 ? <span className="font-semibold text-danger">{money(o)}</span> : <span className="text-muted dark:text-[#a89f93]">—</span>;
      } },
    { head: "Net to pay", right: true, bold: true, cell: (e) => money(earned(e) - owed(e)) },
    { head: "", right: true, cell: (e) => (
        <div className="flex justify-end gap-1.5">
          <button onClick={() => setAccountFor(e)}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            Account
          </button>
          <button onClick={() => startEdit(e)} className="rounded-full p-1.5 text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label={`Edit ${e.name}`}>
            <Pencil size={15} />
          </button>
        </div>
      ) },
  ];

  /* ── THE PHONE CARD ──────────────────────────────────────────────────────
   * The automatic card would get the title and the lead figure right and then
   * have nowhere to put the two buttons or the phone number — a `tel:` link is
   * not a labelled pair — so this screen hands DataTable its own card.
   *
   * What a shop manager wants off this screen on a phone, in order: whose
   * record is this, what do I hand them, do they owe anything, and can I ring
   * them. So: name, net to pay as the one big figure, the pay type and any
   * advance as pills, and four full-size buttons.
   *
   * Hours are kept for hourly staff ("7h 30m this month") because that figure
   * IS their wage — the rate alone does not say what they earned.
   */
  const empCard = (e: Employee) => {
    const o = owed(e);
    const ph = (e.phone ?? "").trim();
    return (
      <div className="rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15.5px] font-extrabold text-ink dark:text-[#f4f1ea]">{e.name}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-muted dark:text-[#a89f93]">
              {text(e.designation)} · {branchName(e.branch_id)}
            </div>
          </div>
          <div className="flex-none text-right">
            <div className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Net to pay</div>
            <div className="text-[16px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{money(earned(e) - o)}</div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {e.active === false && <Pill>Left</Pill>}
          {isHourly(e)
            ? <Pill tone="warn">{e.hourly_rate == null ? "Hourly" : `${money(e.hourly_rate)}/hr`}</Pill>
            : <Pill tone="info">{money(e.monthly_salary)}/month</Pill>}
          {isHourly(e) && <span className="text-[12px] text-muted dark:text-[#a89f93]">{hm(hours[e.id] ?? 0)} this month</span>}
          {o > 0.001 && <Pill tone="bad">{money(o)} owed</Pill>}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 dark:border-white/[0.06]">
          {ph ? (
            <>
              {/* The raw number for the dialler, the 92… form for wa.me. The
                  Call button is labelled with the number itself, so the card
                  still SHOWS what the table's Phone column showed and the thing
                  you read is the thing you press. */}
              <a href={`tel:${ph}`} className={cardBtn}>
                <Phone size={14} className="flex-none" /> <span className="truncate">{ph}</span>
              </a>
              <a href={`https://wa.me/${waNumber(ph)}`} target="_blank" rel="noopener noreferrer" className={cardBtn}>
                <MessageCircle size={14} className="flex-none" /> WhatsApp
              </a>
            </>
          ) : (
            <p className="col-span-2 text-center text-[12px] text-hint dark:text-[#8a8175]">
              No phone number on file — add one with Edit and this becomes a call button.
            </p>
          )}
          <button onClick={() => setAccountFor(e)} className={cardBtn}>Account</button>
          <button onClick={() => startEdit(e)} className={cardBtn}><Pencil size={14} /> Edit</button>
        </div>
      </div>
    );
  };

  return (
    <Shell>
      <PageHeader
        title={scope === "ho" ? "Head Office Employees" : "Employees"}
        subtitle={scope === "ho" ? "The head office team, their pay type and what is left to pay them." : "Shop staff across the branches, their pay type and what is left to pay them."}
        onRefresh={load} loading={loading}
      >
        <button onClick={startAdd} className={btnPrimary}><UserPlus size={15} /> Add employee</button>
      </PageHeader>

      <StatCards stats={stats} loading={loading} />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or designation"
          className="min-w-[200px] flex-1 rounded-full border border-line bg-surface px-4 py-2 text-[13px] text-ink outline-none transition focus:border-ink/30 dark:border-white/10 dark:bg-white/[0.06] dark:text-white sm:max-w-xs" />
        {/* Full width once it has wrapped onto its own line, rather than a
            short pill floating at the left edge. */}
        <Select value={showInactive ? "all" : "active"} onChange={(v) => setShowInactive(v === "all")} className="max-md:w-full">
          <option value="active">Active only</option>
          <option value="all">Including left</option>
        </Select>
      </div>

      {err && <p className="mt-4 text-[12.5px] font-semibold text-danger">{err}</p>}

      <DataTable cols={cols} rows={rows} loading={loading} minWidth={1080}
        card={empCard}
        empty={`No ${scope === "ho" ? "head office" : "shop"} employees yet — add the first one above.`}
        footer={phone ? (
          /* The nine-column total row has four cells of its own; squeezed into
             390px it wraps into something nobody can read. Same three figures,
             stacked, with the one that gets handed over biggest. */
          <tr className="text-ink dark:text-[#f4f1ea]">
            <td className="px-3.5 py-3">
              <div className="text-[12.5px] font-bold">{rows.length} staff · salary {money(totals.sal)}</div>
              <div className="text-[11.5px] font-semibold text-danger">{money(totals.ow)} advance owed</div>
            </td>
            <td className="px-3.5 py-3 text-right">
              <div className="text-[11px] uppercase tracking-wide text-hint dark:text-[#8a8175]">Net to pay</div>
              <div className="text-[16px] font-extrabold tabular-nums">{money(totals.net)}</div>
            </td>
          </tr>
        ) : (
          <tr className="text-ink dark:text-[#f4f1ea]">
            {/* The salary total is written into the label rather than under
                "Rate": adding up hourly rates and monthly salaries in one
                column would be a total of two different units. */}
            <td className="px-4 py-3 font-bold" colSpan={6}>
              Total · {rows.length} staff · salary {money(totals.sal)}
            </td>
            <td className="px-4 py-3 text-right font-bold tabular-nums text-danger">{money(totals.ow)}</td>
            <td className="px-4 py-3 text-right font-bold tabular-nums">{money(totals.net)}</td>
            <td className="px-4 py-3" />
          </tr>
        )} />

      <SourceNote>
        Pay type decides how a month is valued. <strong>Monthly</strong> pays the full salary, flat — days
        present do not scale it, and an absence is handled as a deduction in the ledger where somebody has
        to decide it. <strong>Hourly</strong> is rate × real hours for {monthLabel(month)}, added up from the
        time in and time out on each attendance row, so an hourly person with no times recorded earns
        nothing. <strong>Advance owed</strong> is (advances + purchase credit) − repaid across the whole
        ledger, floored at zero, and <strong>net to pay</strong> is the salary less that. Tap
        {" "}<strong>Account</strong> for the entries behind the figure.
      </SourceNote>

      <Modal open={open} onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : "Add employee"}
        subtitle={editing ? "Changes apply from now on — months already paid are not recalculated." : undefined}>
        {/* ONE COLUMN ON A PHONE.
            Six fields in three pairs is right at 512px and wrong at 390px:
            "Designation" and "Monthly salary" both lose their labels to an
            ellipsis, and a half-width select is a 170px target. `md:` leaves
            every width above 767.98px exactly as it was.

            inputMode is the other half of it. These are the money fields, and
            on a phone the difference between the letter keyboard and the
            numeric keypad is the difference between four taps and twelve. */}
        <div className="space-y-3.5">
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} autoFocus /></Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={scope === "ho" ? "Office" : "Branch"}>
              <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {pickable.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Designation"><input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Phone">
              {/* The keypad with + and * on it, and the field the browser will
                  offer a saved number to. This number becomes the Call and
                  WhatsApp buttons on the card, so a typo here costs a call.
                  No placeholder: it would show on the computer too, and the rule
                  is that the computer screen does not change. */}
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                type="tel" inputMode="tel" autoComplete="tel" className={inputCls} />
            </Field>
            <Field label="Pay type">
              <select value={form.pay_type} onChange={(e) => setForm({ ...form, pay_type: e.target.value })} className={inputCls}>
                <option value="monthly">Monthly — full salary</option>
                <option value="hourly">Hourly — paid on real hours</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Monthly salary"><input type="number" inputMode="decimal" value={form.monthly_salary} onChange={(e) => setForm({ ...form, monthly_salary: e.target.value })} className={inputCls} /></Field>
            {/* decimal, not numeric: an hourly rate is routinely 187.5. */}
            <Field label="Hourly rate"><input type="number" inputMode="decimal" value={form.hourly_rate} onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} className={inputCls} placeholder="—" disabled={form.pay_type !== "hourly"} /></Field>
          </div>
          <label className="flex items-center gap-2.5 text-[13px] font-semibold text-ink dark:text-[#e7e2d8]">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="h-4 w-4 accent-[#141414] dark:accent-white" />
            Still working here
          </label>
          {err && <p className="text-[12.5px] font-semibold text-danger">{err}</p>}
          {/* Full width and stacked on a phone, with Save at the bottom where
              the thumb is. Cancel sitting beside it at half width is how a
              filled-in form gets thrown away by accident. */}
          <div className="flex justify-end gap-2 pt-1 max-md:flex-col">
            <button onClick={() => setOpen(false)} className={`${btnGhost} max-md:w-full`}>Cancel</button>
            <button onClick={save} disabled={saving} className={`${btnPrimary} max-md:w-full`}>{saving ? "Saving…" : editing ? "Save changes" : "Add employee"}</button>
          </div>
          {!isSupabaseConfigured && <p className="text-center text-[12px] text-hint">Preview build — nothing will be saved.</p>}
        </div>
      </Modal>

      {/* The same statement the Ledger screen opens — one implementation, so the
          two screens can never disagree about what somebody owes. */}
      {accountFor && (
        <EmployeeStatement
          employee={accountFor}
          branchName={branchName(accountFor.branch_id)}
          onClose={() => setAccountFor(null)}
          onSaved={load}
        />
      )}

      <PreviewNote />
    </Shell>
  );
}
