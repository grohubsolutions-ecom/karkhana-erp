"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, Search, Loader2, PackagePlus, UserPlus, CheckCircle2, ChevronDown, LayoutGrid, Rows3 } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { rs } from "@/lib/dateRange";

/* ARTICLES — the boss's list.
 *
 * WHAT THE ADMINISTRATION ACTUALLY ASKS THIS SCREEN
 *   "Where is my article?" Not how many there are. So the column that matters
 *   is WAITING ON — the name of the man holding it and how long he has held
 *   it — and it is the one thing that is never truncated.
 *
 * FOUR FIELDS TO CREATE ONE. Rough name, cost, price, ads budget, plus what he
 * wants made. Sizes, colours, pictures, Shopify details are somebody else's
 * job by design — that is the whole point of the workflow.
 *
 * The list comes whole from hub_articles_list() and the four cards are counted
 * over it here. That is safe only because articles are few — PostgREST caps a
 * response at 1,000 rows, so past roughly 900 articles these cards must move
 * into the database like every other Hub total.
 */

type Row = {
  id: string; code: string; name: string; status: string; created_at: string;
  exact_cost: number | null; retail_price: number | null; margin: number | null;
  /* The pack ladder, summarised. price_from/price_to are the cheapest and
     dearest of the article's prices — equal when it only sells one way — and
     pack_count includes the single, so 1 means no packs. */
  price_from: number | null; price_to: number | null; pack_count: number;
  ads_budget: number | null; ads_basis: string; ads_spent: number;
  ads_spent_period: number; ads_pending: number; period_label: string;
  stages_done: number; stages_total: number;
  waiting_on: string | null; waiting_days: number | null; age: string;
};

/* WHAT Rs 30,000 MEANS is a decision, not a default. A pot for the whole
   launch, a cap per day, or an allowance per month — the same number reads
   three different ways, and the screen cannot guess which one the boss had in
   mind. So it is asked on the form and stored with the article. */
const BASIS = [
  { key: "total",   label: "In total",  hint: "one pot for the whole launch" },
  { key: "daily",   label: "Per day",   hint: "a cap for each day" },
  { key: "monthly", label: "Per month", hint: "an allowance each month" },
];

/* A JOB THAT IS NOT AN ARTICLE.
   "Rehman, go and check which collections are empty" is work, it needs the
   same clock and the same submitted-with-a-note ending, and it has nothing to
   do with a product launch. It runs through the same machinery — it simply has
   no article attached — so there is one submit path and one notification path
   rather than two that drift apart. */
type Person = { id: string; name: string; designation: string | null; is_stage_owner: boolean };
type Assigned = {
  task_id: string; person: string; title: string; detail: string | null;
  status: string; opened_at: string; submitted_at: string | null;
  submit_note: string | null; held: string | null;
  /* True when it was the administration that wrote the ending, not the man. */
  on_behalf: boolean;
};

/* Two states, both derived from the work: in progress until the last man has
   submitted, completed after. There is no Approved and no Rejected — a word
   somebody sets by hand can disagree with the five stages underneath it, and
   then nobody can say which is right. */
const TABS = [
  { key: "all", label: "All" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
];

function statusChip(s: string) {
  if (s === "completed") return "bg-success-soft text-success dark:bg-white/[0.10]";
  return "bg-amber-soft text-amber-strong dark:bg-white/[0.10] dark:text-amber";
}

/* CARDS OR TABLE — the same rows, two ways to read them.
   Cards answer "where is each article" at a glance; the table lines the same
   facts up in columns for scanning many at once. The choice is remembered per
   browser, and never trusted to be there: private windows and blocked storage
   throw, and the page must still open. */
const VIEW_KEY = "hub.articles.view";
function readView(): "cards" | "table" {
  try { return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; }
}

export default function ArticlesPage() {
  const router = useRouter();
  /* EVERY ARTICLE, loaded once. The tab filters it here, and the four cards
     count it here — so "In progress" no longer reads 0 on the Completed tab,
     and a search no longer shrinks "Ads approved, all time". */
  const [all, setAll] = useState<Row[]>([]);
  /* ids matching the current search, or null when not searching. Search goes
     to the database because only it can look inside pack names. */
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<"cards" | "table">("cards");
  useEffect(() => { setView(readView()); }, []);
  function chooseView(v: "cards" | "table") {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* the choice just won't be remembered */ }
  }
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ rough_name: "", exact_cost: "", retail_price: "", ads_budget: "", brief: "", ads_basis: "total" });

  const [people, setPeople] = useState<Person[]>([]);
  const [assigned, setAssigned] = useState<Assigned[]>([]);
  const [showAssigned, setShowAssigned] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [task, setTask] = useState({ user_id: "", title: "", detail: "" });

  /* CLOSING A HANDED-OUT TASK ON THE MAN'S BEHALF.
     Most of these are arranged by talking and finished by talking. The same
     record has to exist either way, so the administration can write the ending
     with the date it really happened. The man is told it was written for him —
     nothing gets marked done behind his back. */
  const [markTask, setMarkTask] = useState<string | null>(null);
  const today = () => new Date().toISOString().slice(0, 10);
  const [markT, setMarkT] = useState({ note: "", done_on: today() });

  /* Which submitted task is being put back, and why. */
  const [undoTask, setUndoTask] = useState<string | null>(null);
  const [undoWhy, setUndoWhy] = useState("");

  /* Loads everything once — not on every tab click or keystroke. It used to
     send three requests per letter typed, and a slow early reply could land
     after a fast later one and show the wrong results. */
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    setLoading(true); setErr("");
    const [list, ppl, asg] = await Promise.all([
      supabase.rpc("hub_articles_list", { p_status: null, p_q: null }),
      supabase.rpc("hub_people"),
      supabase.rpc("hub_assigned_tasks", { p_include_done: true }),
    ]);
    const firstErr = list.error ?? ppl.error ?? asg.error;
    if (firstErr) setErr(firstErr.message);
    setAll((list.data as Row[]) ?? []);
    setPeople((ppl.data as Person[]) ?? []);
    setAssigned((asg.data as Assigned[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /* Search waits until typing pauses, and only the newest answer is used. */
  const searchId = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); setSearching(false); return; }
    const my = ++searchId.current;
    setSearching(true);
    const t = setTimeout(async () => {
      if (!supabase) return;
      const { data, error } = await supabase.rpc("hub_articles_list", { p_status: null, p_q: term });
      if (my !== searchId.current) return;
      if (error) setErr(error.message);
      setHits(new Set(((data as Row[]) ?? []).map((r) => r.id)));
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const rows = useMemo(
    () => all.filter((r) => (tab === "all" || r.status === tab) && (!hits || hits.has(r.id))),
    [all, tab, hits]);

  async function assign() {
    if (!supabase) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_task_assign", {
      p_user: task.user_id, p_title: task.title, p_detail: task.detail || null,
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) { setErr(error.message); return; }
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setAssigning(false);
    setTask({ user_id: "", title: "", detail: "" });
    setShowAssigned(true);
    load();
  }

  async function recordTask(taskId: string) {
    if (!supabase) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_task_submit", {
      p_task_id: taskId, p_note: markT.note,
      /* Midday, so the date reads the same whichever way the timezone leans.
         Nobody is recording an hour here, only a day. */
      p_done_on: new Date(`${markT.done_on}T12:00:00`).toISOString(),
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) { setErr(error.message); return; }
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setMarkTask(null);
    setMarkT({ note: "", done_on: today() });
    load();
  }

  async function reopenTask(taskId: string) {
    if (!supabase) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_task_reopen", {
      p_task_id: taskId, p_reason: undoWhy,
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) { setErr(error.message); return; }
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setUndoTask(null); setUndoWhy("");
    load();
  }

  async function create() {
    if (!supabase) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("hub_article_create", {
      p_rough_name: form.rough_name,
      p_exact_cost: form.exact_cost === "" ? null : Number(form.exact_cost),
      p_retail_price: form.retail_price === "" ? null : Number(form.retail_price),
      p_ads_budget: form.ads_budget === "" ? null : Number(form.ads_budget),
      p_brief: form.brief || null,
      p_ads_basis: form.ads_basis,
    });
    setBusy(false);
    const res = data as { ok?: boolean; error?: string; code?: string } | null;
    if (error) { setErr(error.message); return; }
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setAdding(false);
    setForm({ rough_name: "", exact_cost: "", retail_price: "", ads_budget: "", brief: "", ads_basis: "total" });
    load();
  }

  /* Counted over EVERY article, whatever tab or search is showing. */
  const totals = useMemo(() => ({
    live: all.filter((r) => r.status === "in_progress").length,
    waiting: all.filter((r) => r.waiting_on).length,
    spent: all.reduce((a, r) => a + Number(r.ads_spent || 0), 0),
    pending: all.reduce((a, r) => a + Number(r.ads_pending || 0), 0),
  }), [all]);

  const priceLine = (r: Row) =>
    r.price_from != null && r.price_to != null && r.price_from !== r.price_to
      ? `${rs(r.price_from)} – ${rs(r.price_to)}`
      : r.retail_price ? rs(r.retail_price) : "no price";

  return (
    <div className="px-4 py-6 sm:px-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-extrabold tracking-tight text-ink sm:text-[22px] dark:text-[#f4f1ea]">Articles</h1>
          <p className="mt-1 text-[13px] text-muted dark:text-[#a89f93]">
            Every product launch, who is holding it, and what the ads have cost.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white dark:bg-white dark:text-[#141414]">
            <Plus size={15} /> New article
          </button>
          <button onClick={() => setAssigning(true)}
            className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <UserPlus size={15} /> Assign a task
          </button>
          <button onClick={load}
            className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-panel dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* four numbers, and only four */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* No "total budget given" card. Adding a Rs 30,000 pot to a Rs 1,000
            daily cap produces a number that means nothing — the budgets are
            only comparable inside one article, so they are only shown there. */}
        {[
          ["In progress", String(totals.live), ""],
          ["Waiting on somebody", String(totals.waiting), ""],
          ["Ads approved, all time", rs(totals.spent), ""],
          ["Waiting for your approval", rs(totals.pending), totals.pending > 0 ? "ad spends to decide" : "nothing to decide"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
            <div className="text-[18px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{loading ? "—" : value}</div>
            <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{label}</div>
            {sub && <div className="mt-0.5 text-[11px] font-semibold text-amber-strong dark:text-amber">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex w-max gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.05]">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition sm:px-4 ${tab === t.key ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {/* Its own full-width line on a phone — squeezed beside the tabs it
            was a sliver too narrow to type into. */}
        <div className="order-last flex w-full min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 sm:order-none sm:w-auto sm:flex-none dark:border-white/10 dark:bg-white/[0.05]">
          {searching ? <Loader2 size={15} className="animate-spin text-hint" /> : <Search size={15} className="text-hint dark:text-[#8a8175]" />}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or pack"
            className="w-full min-w-0 bg-transparent text-[13px] outline-none placeholder:text-hint sm:w-56 dark:text-[#f4f1ea]" />
        </div>

        {/* the switch — same rows, cards or table */}
        <div role="group" aria-label="View" className="ml-auto flex gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.05]">
          {([["cards", "Cards", LayoutGrid], ["table", "Table", Rows3]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => chooseView(k)} aria-pressed={view === k} aria-label={label} title={label}
              className={`flex min-h-[32px] items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition sm:px-3.5 ${
                view === k ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
                           : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
              <Icon size={14} /> <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {err && <p className="mt-4 rounded-card border border-line bg-danger-soft px-4 py-3 text-[12.5px] font-medium text-danger">{err}</p>}

      {/* TASKS YOU HANDED OUT, kept folded. They are not articles and they are
          not the main job of this screen — but a task assigned and then never
          mentioned again is one the boss has to hold in his head, which is the
          thing he was trying to hand over. Open with the count visible. */}
      {assigned.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
          <button onClick={() => setShowAssigned((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left">
            <UserPlus size={15} className="text-muted dark:text-[#a89f93]" />
            <span className="text-[13px] font-bold text-ink dark:text-[#f4f1ea]">Tasks you assigned</span>
            <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-bold text-muted dark:bg-white/[0.06] dark:text-[#a89f93]">
              {assigned.filter((t) => t.status === "open").length} open
            </span>
            <ChevronDown size={15} className={`ml-auto text-hint transition ${showAssigned ? "rotate-180" : ""}`} />
          </button>
          {showAssigned && assigned.map((t) => (
            <div key={t.task_id} className="border-t border-line px-4 py-2.5 text-[12.5px] dark:border-white/[0.06]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-ink dark:text-[#f4f1ea]">{t.person}</span>
                <span className="min-w-0 flex-1 text-ink dark:text-[#e7e2d8]">{t.title}</span>
                {t.status === "open" ? (
                  <>
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber-strong dark:bg-white/[0.08] dark:text-amber">
                      with him {t.held}
                    </span>
                    {markTask !== t.task_id && (
                      <button onClick={() => { setMarkTask(t.task_id); setMarkT({ note: "", done_on: today() }); }}
                        className="min-h-[32px] rounded-full border border-line px-3 py-1.5 text-[11.5px] font-semibold text-ink transition hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/[0.06]">
                        Mark done
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1 text-muted dark:text-[#a89f93]">
                      <CheckCircle2 size={12} className="text-success" /> {t.submit_note} · took {t.held}
                    </span>
                    {/* Closed by mistake happens, and it happens most easily
                        from this side. The way back sits next to the record. */}
                    {undoTask !== t.task_id && (
                      <button onClick={() => { setUndoTask(t.task_id); setUndoWhy(""); }}
                        className="min-h-[32px] rounded-full border border-line px-3 py-1.5 text-[11.5px] font-semibold text-muted transition hover:border-danger/40 hover:text-danger dark:border-white/15 dark:text-[#a89f93]">
                        Undo
                      </button>
                    )}
                  </>
                )}
              </div>

              {undoTask === t.task_id && (
                <div className="mt-2 rounded-xl2 border border-salmon-soft bg-salmon-soft/40 p-3 dark:border-white/10 dark:bg-white/[0.04]">
                  <label className="block text-[12px] font-semibold text-red-800 dark:text-salmon">
                    Put this back with {t.person}. Why?
                  </label>
                  <input autoFocus value={undoWhy} onChange={(e) => setUndoWhy(e.target.value)}
                    placeholder="He had not actually done it"
                    className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button disabled={busy} onClick={() => reopenTask(t.task_id)}
                      className="rounded-full bg-danger px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40">
                      {busy ? "Undoing…" : `Put it back with ${t.person}`}
                    </button>
                    <button disabled={busy} onClick={() => setUndoTask(null)}
                      className="rounded-full border border-line px-4 py-1.5 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
                      Cancel
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11.5px] text-hint dark:text-[#8a8175]">
                    The submission is removed and it goes back to him with this reason. It stays in the history under your name.
                  </p>
                </div>
              )}

              {/* Said out loud, because a record written by the boss and one
                  written by the man are not the same fact. */}
              {t.status !== "open" && t.on_behalf && (
                <p className="mt-1 text-[11.5px] font-semibold text-periwinkle-strong dark:text-periwinkle">
                  recorded by you, not submitted by {t.person}
                </p>
              )}

              {markTask === t.task_id && (
                <div className="mt-2 rounded-xl2 border border-line bg-canvas p-3 dark:border-white/10 dark:bg-white/[0.03]">
                  <label className="block text-[12px] font-semibold text-muted dark:text-[#a89f93]">What did {t.person} do?</label>
                  <textarea autoFocus rows={2} value={markT.note}
                    onChange={(e) => setMarkT({ ...markT, note: e.target.value })}
                    placeholder="Went through every collection, 3 were empty and he filled them"
                    className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-[12px] font-semibold text-muted dark:text-[#a89f93]">Done on</label>
                    <input type="date" value={markT.done_on} max={today()}
                      onChange={(e) => setMarkT({ ...markT, done_on: e.target.value })}
                      className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-[13px] text-ink outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
                    <button disabled={busy || !markT.note.trim()} onClick={() => recordTask(t.task_id)}
                      className="rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
                      {busy ? "Saving…" : "Record it"}
                    </button>
                    <button disabled={busy} onClick={() => setMarkTask(null)}
                      className="rounded-full border border-line px-4 py-1.5 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-card bg-panel/70 dark:bg-white/[0.05]" />)
        ) : rows.length === 0 ? (
          <div className="rounded-card border border-line bg-surface px-4 py-16 text-center dark:border-white/[0.06] dark:bg-[#201c17]">
            <PackagePlus size={22} className="mx-auto mb-2 text-muted" />
            {/* "No articles yet" is only true when there are none at all. With
                articles hidden by a tab or a search, say so — otherwise it reads
                as if the articles were lost. */}
            {all.length === 0 ? (
              <>
                <p className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">No articles yet.</p>
                <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
                  Press New article. Hamza Mukhtar and Hamza Khan are told the moment you do.
                </p>
              </>
            ) : (
              <>
                <p className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">Nothing matches.</p>
                <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
                  {all.length} article{all.length === 1 ? "" : "s"} in total — try All, or clear the search.
                </p>
              </>
            )}
          </div>
        ) : view === "table" ? (
          /* THE TABLE. Scrolls sideways on a phone rather than squeezing the
             columns into unreadable slivers; the article column stays pinned so
             you always know which row you are reading. */
          <div className="overflow-x-auto rounded-card border border-line bg-surface dark:border-white/[0.06] dark:bg-[#201c17]">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted dark:border-white/[0.06] dark:text-[#a89f93]">
                  <th className="sticky left-0 z-10 bg-surface px-4 py-2.5 font-semibold dark:bg-[#201c17]">Article</th>
                  <th className="px-3 py-2.5 font-semibold">Price</th>
                  <th className="px-3 py-2.5 font-semibold">Stages</th>
                  <th className="px-3 py-2.5 font-semibold">Waiting on</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Ads</th>
                  <th className="px-3 py-2.5 font-semibold">Running</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-white/[0.06]">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/online/articles/${r.id}`)}
                    className="group cursor-pointer transition hover:bg-panel/60 dark:hover:bg-white/[0.04]">
                    <td className="sticky left-0 z-10 bg-surface px-4 py-3 transition group-hover:bg-panel/60 dark:bg-[#201c17] dark:group-hover:bg-[#262119]">
                      {/* A real link inside the row, so it can be opened in a new tab. */}
                      <Link href={`/online/articles/${r.id}`} onClick={(e) => e.stopPropagation()}
                        className="font-bold text-ink hover:underline dark:text-[#f4f1ea]">{r.name}</Link>
                      <div className="text-[11.5px] font-semibold text-muted dark:text-[#a89f93]">{r.code}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-ink dark:text-[#e7e2d8]">
                      <div className="whitespace-nowrap">{priceLine(r)}</div>
                      <div className="text-[11px] text-hint dark:text-[#8a8175]">
                        {r.pack_count > 1 ? `${r.pack_count} packs` : r.margin != null ? `${r.margin}% margin` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        {Array.from({ length: r.stages_total }).map((_, i) => (
                          <span key={i} className={`h-2 w-2 rounded-full ${i < r.stages_done ? "bg-success" : "bg-line dark:bg-white/20"}`} />
                        ))}
                        <span className="ml-1.5 text-[11.5px] font-semibold tabular-nums text-muted dark:text-[#a89f93]">{r.stages_done}/{r.stages_total}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[12.5px]">
                      {r.waiting_on ? (
                        <>
                          <b className="text-ink dark:text-[#e7e2d8]">{r.waiting_on}</b>
                          {r.waiting_days != null && r.waiting_days > 0 &&
                            <span className="text-muted dark:text-[#a89f93]"> · {r.waiting_days}d</span>}
                        </>
                      ) : <span className="text-muted dark:text-[#a89f93]">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <div className="font-semibold text-ink dark:text-[#f4f1ea]">{rs(Number(r.ads_spent_period))}</div>
                      <div className="text-[11px] text-hint dark:text-[#8a8175]">of {rs(Number(r.ads_budget || 0))} {r.period_label}</div>
                      {Number(r.ads_pending) > 0 && (
                        <div className="text-[11px] font-semibold text-amber-strong dark:text-amber">{rs(Number(r.ads_pending))} to approve</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-[12.5px] text-muted dark:text-[#a89f93]">{r.age}</td>
                    <td className="px-4 py-3">
                      <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${statusChip(r.status)}`}>
                        {r.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : rows.map((r) => (
          <Link key={r.id} href={`/online/articles/${r.id}`}
            className="block rounded-card border border-line bg-surface px-4 py-3.5 transition hover:border-ink/25 hover:shadow-soft dark:border-white/[0.06] dark:bg-[#201c17] dark:hover:border-white/20">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-[150px] flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{r.name}</span>
                  <span className="text-[11.5px] font-semibold text-muted dark:text-[#a89f93]">{r.code}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] text-hint dark:text-[#8a8175]">
                  {/* A range when the shirt sells more than one way. Printing
                      only the cheapest would read as "the price", which it
                      isn't, and printing the dearest would read as a markup. */}
                  {r.price_from != null && r.price_to != null && r.price_from !== r.price_to
                    ? `${rs(r.price_from)} – ${rs(r.price_to)}`
                    : r.retail_price ? `${rs(r.retail_price)} retail` : "no price"}
                  {r.pack_count > 1 && ` · ${r.pack_count} packs`}
                  {r.pack_count <= 1 && r.margin != null && ` · ${r.margin}% margin`} · running {r.age}
                </div>
              </div>

              {/* five dots, one per stage — the whole progress at a glance */}
              <div className="flex items-center gap-1">
                {Array.from({ length: r.stages_total }).map((_, i) => (
                  <span key={i} className={`h-2 w-2 rounded-full ${i < r.stages_done ? "bg-success" : "bg-line dark:bg-white/20"}`} />
                ))}
                <span className="ml-1.5 text-[11.5px] font-semibold tabular-nums text-muted dark:text-[#a89f93]">
                  {r.stages_done}/{r.stages_total}
                </span>
              </div>

              {/* the answer to "where is it" */}
              <div className="min-w-[170px] text-[12.5px]">
                {r.waiting_on ? (
                  <span className="text-ink dark:text-[#e7e2d8]">
                    waiting on <b>{r.waiting_on}</b>
                    {r.waiting_days != null && r.waiting_days > 0 &&
                      <span className="text-muted dark:text-[#a89f93]"> · {r.waiting_days}d</span>}
                  </span>
                ) : (
                  <span className="text-muted dark:text-[#a89f93]">nobody — nothing open</span>
                )}
              </div>

              {/* The cap and what has gone against it, in the period the boss
                  chose. The running total sits underneath, because "spent so
                  far" is wanted whatever the cap is measured against. */}
              <div className="text-right">
                <div className="text-[12.5px] font-semibold tabular-nums text-ink dark:text-[#f4f1ea]">
                  {rs(Number(r.ads_spent_period))}
                  <span className="font-normal text-hint dark:text-[#8a8175]">
                    {" "}of {rs(Number(r.ads_budget || 0))} {r.period_label}
                  </span>
                </div>
                {r.ads_basis !== "total" && (
                  <div className="text-[11px] text-hint dark:text-[#8a8175]">{rs(Number(r.ads_spent))} in total</div>
                )}
                {Number(r.ads_pending) > 0 && (
                  <div className="text-[11px] font-semibold text-amber-strong dark:text-amber">{rs(Number(r.ads_pending))} to approve</div>
                )}
              </div>

              <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${statusChip(r.status)}`}>
                {r.status.replace("_", " ")}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* ── assign a task to one person ──────────────────────────────────── */}
      {assigning && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={() => !busy && setAssigning(false)}>
          <div className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-card bg-surface p-5 shadow-card dark:bg-[#201c17] sm:rounded-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-[16px] font-extrabold text-ink dark:text-[#f4f1ea]">Assign a task</h2>
            <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
              Work for one person that has nothing to do with an article. It lands on his portal
              with the same Submit button, and you are told when he has done it.
            </p>

            <label className="mt-4 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">Who</label>
            <select value={task.user_id} onChange={(e) => setTask({ ...task, user_id: e.target.value })}
              className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]">
              <option value="">Choose a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.designation ? ` — ${p.designation}` : ""}
                </option>
              ))}
            </select>

            <label className="mt-3 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">What has to be done</label>
            <input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })}
              placeholder="Check which collections are empty on TopShop"
              className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />

            <label className="mt-3 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">Anything else he should know</label>
            <textarea value={task.detail} onChange={(e) => setTask({ ...task, detail: e.target.value })} rows={3}
              placeholder="Go through all 14 collections and list the empty ones with screenshots"
              className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />

            {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAssigning(false)} disabled={busy}
                className="rounded-full border border-line px-4 py-2 text-[13px] font-semibold text-ink dark:border-white/15 dark:text-white">Cancel</button>
              <button onClick={assign} disabled={busy || !task.user_id || !task.title.trim()}
                className="flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
                {busy && <Loader2 size={14} className="animate-spin" />} Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── new article ──────────────────────────────────────────────────── */}
      {adding && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={() => !busy && setAdding(false)}>
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-card bg-surface p-5 shadow-card dark:bg-[#201c17] sm:rounded-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-[16px] font-extrabold text-ink dark:text-[#f4f1ea]">New article</h2>
            <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
              Four numbers and what you want made. The names, sizes, pictures and Shopify details are Hamza Mukhtar&rsquo;s job.
            </p>

            <label className="mt-4 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">Rough name</label>
            <input autoFocus value={form.rough_name} onChange={(e) => setForm({ ...form, rough_name: e.target.value })}
              placeholder="Red winter coat"
              className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />

            <div className="mt-3 grid grid-cols-3 gap-2">
              {([["exact_cost", "Exact cost"], ["retail_price", "Retail price"], ["ads_budget", "Ads budget"]] as const).map(([k, label]) => (
                <div key={k}>
                  <label className="block text-[12px] font-semibold text-muted dark:text-[#a89f93]">{label}</label>
                  <input type="number" inputMode="numeric" value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                    className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[14px] tabular-nums text-ink outline-none dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
                </div>
              ))}
            </div>

            {/* Asked right under the budget box, because it changes what the
                number means and there is no sensible guess. */}
            <label className="mt-3 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">
              That ads budget is…
            </label>
            <div className="mt-1 flex w-full gap-1 rounded-full bg-panel p-1 dark:bg-white/[0.06]">
              {BASIS.map((b) => (
                <button key={b.key} type="button" onClick={() => setForm({ ...form, ads_basis: b.key })}
                  className={`flex-1 rounded-full px-3 py-2 text-[12.5px] font-semibold transition ${
                    form.ads_basis === b.key ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
                                             : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
                  {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11.5px] text-hint dark:text-[#8a8175]">
              {BASIS.find((b) => b.key === form.ads_basis)?.hint}
              {form.ads_budget && form.ads_basis !== "total" &&
                ` — ${rs(Number(form.ads_budget))} every ${form.ads_basis === "daily" ? "day" : "month"}, and the running total is still shown.`}
            </p>

            {/* Shown live, because a margin typed wrong is obvious the moment it
                is worked out and invisible until then. It needs BOTH figures: a
                blank cost read as zero reported a 100% margin, which is the
                worst kind of wrong number — it looks like an answer and it is
                good news. */}
            {Number(form.retail_price) > 0 && form.exact_cost !== "" && (
              <p className="mt-2 text-[12px] text-muted dark:text-[#a89f93]">
                Margin{" "}
                <b className="text-ink dark:text-[#f4f1ea]">
                  {Math.round(((Number(form.retail_price) - Number(form.exact_cost)) / Number(form.retail_price)) * 1000) / 10}%
                </b>{" "}
                · {rs(Number(form.retail_price) - Number(form.exact_cost))} a piece
              </p>
            )}

            {/* Packs are added on the article itself, not here. One shirt sold
                three ways is still one article, and this form is about creating
                the article. Said out loud because the alternative — making a
                second article called "Pack of 3" — is the obvious thing to do
                and it is the thing that breaks the workflow. */}
            <p className="mt-2 rounded-xl2 bg-periwinkle-soft px-3 py-2 text-[11.5px] leading-relaxed text-ink dark:bg-white/[0.05] dark:text-[#e7e2d8]">
              Selling this in packs too? Create it once here, then open it and add
              <b> Pack of 2</b>, <b>Pack of 3</b> and their prices. One workflow, one set of
              notifications — not a second article.
            </p>

            <label className="mt-3 block text-[12px] font-semibold text-muted dark:text-[#a89f93]">What do you want made?</label>
            <textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} rows={3}
              placeholder="Shoot 6 pictures and 3 reels, upload to Shopify, then run Meta ads on the cold audience"
              className="mt-1 w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
            <p className="mt-1 text-[11.5px] text-hint dark:text-[#8a8175]">
              This is what Hamza Mukhtar and Hamza Khan will read on their panel.
            </p>

            {err && <p className="mt-3 text-[12.5px] font-medium text-danger">{err}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAdding(false)} disabled={busy}
                className="rounded-full border border-line px-4 py-2 text-[13px] font-semibold text-ink dark:border-white/15 dark:text-white">Cancel</button>
              <button onClick={create} disabled={busy || !form.rough_name.trim()}
                className="flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
                {busy && <Loader2 size={14} className="animate-spin" />} Create &amp; assign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
