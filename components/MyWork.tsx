"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardList, ClipboardCheck, CornerUpLeft, CheckCircle2, CheckSquare, ChevronDown, Clock3, Loader2, Flag, Rocket, X, Plus, Send, CalendarDays,
} from "lucide-react";
import { todayPk } from "@/lib/dateRange";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { tc } from "@/lib/titleCase";

/* WHAT THIS PERSON HAS TO DO — on their own portal, beside their own wages.
 *
 * ONE BUTTON. There is no Start, no Accept, no Reject. The work arrives, the
 * person does it, they write what they did and press Submit. Everything else —
 * who gets it next, what the boss is told, how long it sat here — happens in
 * the database at that moment.
 *
 * THE CLOCK IS NOT SHOWN AS A DEADLINE. It says how long this has been with
 * you, because that is a fact. There is no target and nothing turns red: a
 * limit nobody agreed to only teaches people to ignore the colour.
 *
 * TWO SEND-BACKS. The quality check can hand an article back to Hamza Mukhtar
 * with a reason, as before. And since H286 (the owner, 2 Oct) the ads stage —
 * Qaswar, the last man in the chain — has a CHECKPOINT for every earlier
 * step: Product, Video, QC, Social, each with Send back and an optional note.
 * His Submit is now LIVE, with an optional final comment: it opens only when
 * the other four are done, and it closes the article for everyone. Awais still
 * has no send-back.
 *
 * H288 (the owner, 5 Oct):
 *   - every article card ends with ARTICLE PROGRESS: the five steps ticked off
 *     as they finish, what happens after this person, and the next card in
 *     their list. After Submit (or Live) a box takes the finished card's place:
 *     finished from your side, who has the article now, and the next one.
 *   - Awais ticks INSTAGRAM, FACEBOOK and TIKTOK on his social card as each
 *     post goes up — his signature, nothing more. Qaswar sees the ticks on the
 *     Social row of his checkpoints.
 *   - headings are Title Case: every word starts with a capital.
 */

/* WHAT HE NEEDS TO KNOW ABOUT THE ARTICLE (H279). The price the customer
   pays, every pack, the brief as it stands now, and — for the ads stage only —
   the budget. Never the cost: what we paid stays with the administration. */
type ArticleFacts = {
  article_id: string; code: string; name: string | null; final_name: string | null;
  retail_price: number | null; brief: string | null;
  packs: { label: string; units: number; price: number | null }[];
  ads_budget: number | null; ads_basis: string | null;
  /* H284: what everybody on this article wrote when they pressed Submit. */
  comments?: Comment[];
};
/* The owner, 1 Oct: "in article management everyone should see each other's
   comments — where they write done". One line per submitted note on the
   article, by anyone, oldest first; a quality-check send-back is one too.
   H286 adds two kinds: "checkpoint" (sent back from the ads card — `by` sent
   it, `to` got it) and "live" (the ads stage's Live, comment optional). */
type Comment = {
  task_id: string; stage: string | null; title: string | null; by: string;
  mine: boolean; at: string | null; kind: "done" | "sent_back" | "checkpoint" | "live"; note: string;
  recorded_by: string | null; to?: string | null;
};
/* Role names, Title Case (H288). STAGE is the longer form used in the team's
   notes; STEP is the short form on the progress chips and checkpoints. */
const STAGE: Record<string, string> = {
  product: "Product & Upload", qc: "Quality Check", video: "Video",
  social: "Social Media", ads: "Ads",
};
const STEP: Record<string, string> = {
  product: "Product", video: "Video", qc: "Quality Check", social: "Social Media", ads: "Ads",
};
const rs = (v: number | null | undefined) => (v == null ? "—" : "Rs " + Math.round(Number(v)).toLocaleString("en-PK"));
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" })
  : "";
const stamp = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" })
  : "";
const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "nobody";
/* The database writes "Awais (Social media)"; the role in brackets is a role
   heading, so it is shown Title Case like everywhere else on the portal. */
const roleTc = (w: string) => w.replace(/\(([^)]*)\)/, (_m, r: string) => `(${tc(r)})`);

type Task = {
  task_id: string; article_id: string | null; code: string | null;
  article_name: string | null; stage: string | null; title: string;
  detail: string | null; status: string; opened_at: string;
  submitted_at: string | null; submit_note: string | null;
  held: string | null; returned_note: string | null;
  /* Set when somebody else wrote this ending — the administration recording
     work that was arranged and finished by talking. The man sees it on his own
     panel, so nothing is closed in his name without him knowing. */
  recorded_by: string | null;
  /* Set on a quality check whose product is not in yet — the name of the man
     it is waiting for. The check is visible from the day the article is
     created, but there is nothing to check until the product is uploaded. */
  waiting_for: string | null;
};

/* H286: one row per earlier step on Qaswar's open ads card
   (hub_my_checkpoints), and who Live is still waiting for. */
type Step = {
  stage: string; name: string; person: string | null; status: string | null;
  attempt: number | null; opened_at: string | null; submitted_at: string | null;
  sent_back_by: string | null; sent_back_note: string | null; can_send_back: boolean;
};
type Checkpoint = { article_id: string; task_id: string; waiting_for: string[]; steps: Step[] };

/* H290: the Custom task form in Qaswar's work — the people he can send to, and
   what he fills in. */
type Person = { id: string; name: string; designation: string | null };
type CustomForm = { assignee: string; article: string; inventory: string; name: string; details: string; deadline: string };
const EMPTY_FORM: CustomForm = { assignee: "", article: "", inventory: "", name: "", details: "", deadline: "" };

/* H288: where each of my articles stands (hub_my_progress), and the ticks. */
type Platform = "instagram" | "facebook" | "tiktok";
const PLATFORMS: { key: Platform; name: string }[] = [
  { key: "instagram", name: "Instagram" }, { key: "facebook", name: "Facebook" }, { key: "tiktok", name: "TikTok" },
];
type Posts = Partial<Record<Platform, { at: string | null; by: string | null }>>;
type PStep = {
  stage: string; person: string | null; status: string | null; attempt: number | null;
  opened_at: string | null; submitted_at: string | null; sent_back_by: string | null; mine: boolean;
};
type Progress = {
  article_id: string; code: string; status: string; completed_at: string | null;
  live: { at: string | null; by: string | null; note: string | null } | null;
  steps: PStep[]; posts: Posts;
  /* H291: the "Campaign setup" ticks, beside the "Posted on" ticks. */
  setup: Posts;
};
/* H291: the two kinds of per-account tick — campaign set up, and posted. */
type TickKind = "setup" | "posted";
/* The box that takes a finished card's place: what was finished, and the
   card that was next after it. */
type Flash = {
  kind: "done" | "live" | "sent_back"; task_id: string; code: string | null;
  article_id: string | null; pos: number;
};

/* WHAT HAPPENS WHEN THIS STEP IS DONE — the chain as hub_task_submit runs it:
   the product goes to the quality check (or, when the check finished first,
   straight to social and ads); the video and the check go to social and ads;
   social goes to ads; ads is the Live. */
const AFTER: Record<string, string[]> = {
  product: ["qc"], video: ["social", "ads"], qc: ["social", "ads"], social: ["ads"], ads: [],
};
function afterYou(stage: string | null, p: Progress | undefined, fixFor: string | null): string {
  if (!stage || stage === "ads" || !AFTER[stage]) return "";
  /* D1 (2 Oct): a fix sent back from the ads card goes straight back to the
     man who sent it — no second quality check. */
  if (fixFor) return `straight back to ${fixFor} for Live — no second quality check.`;
  const who = (st: string) => p?.steps.find((s) => s.stage === st)?.person;
  if (stage === "social") return `${STEP.ads}${who("ads") ? ` (${firstName(who("ads"))})` : ""} — then Live, and the article is finished.`;
  const next = stage === "product" && p?.steps.find((s) => s.stage === "qc")?.status === "submitted"
    ? ["social", "ads"] : AFTER[stage];
  return next.map((st) => `${STEP[st]}${who(st) ? ` (${firstName(who(st))})` : ""}`).join(" and ") + ".";
}

/* "Sent back by Qaswar: make it two videos" / "Sent back by Qaswar (no note)"
   — the wording hub_task_checkpoint stores — read back as who + what. */
const SENT_BACK = /^Sent back by (.+?)(?:: ([\s\S]+)| \(no note\))$/;

export default function MyWork() {
  const [rows, setRows] = useState<Task[]>([]);
  const [facts, setFacts] = useState<Record<string, ArticleFacts>>({});
  const [cps, setCps] = useState<Record<string, Checkpoint>>({});
  const [prog, setProg] = useState<Record<string, Progress>>({});
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  /* The one send-back form that is open (an ads task + a step), its note, and
     the ads card waiting for "Yes, go live". */
  const [sb, setSb] = useState<{ task: string; stage: string } | null>(null);
  const [sbNote, setSbNote] = useState("");
  const [confirmLive, setConfirmLive] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [glow, setGlow] = useState<string | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);
  /* H290: the custom-task people (empty unless the caller may send tasks —
     Qaswar or an admin), the open form, and what it says after a send. */
  const [people, setPeople] = useState<Person[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [form, setForm] = useState<CustomForm>(EMPTY_FORM);
  const [sentMsg, setSentMsg] = useState("");
  /* H292: each article card can be minimized to just its header, so a long
     list is easy to scroll. Kept per card in memory. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /* H293: the product owner (Hamza Mukhtar) or an admin can start an article
     from here. The button shows only for them. */
  const [canArticle, setCanArticle] = useState(false);
  const [articleOpen, setArticleOpen] = useState(false);
  const [artName, setArtName] = useState("");
  const [artBrief, setArtBrief] = useState("");

  /* Only the newest reply is drawn: an older load that lands late must not
     paint yesterday's buttons over the fresh ones. */
  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    const [{ data, error }, arts, cp, pr, ppl, mk] = await Promise.all([
      supabase.rpc("hub_my_work"),
      supabase.rpc("hub_my_articles"),
      supabase.rpc("hub_my_checkpoints"),
      supabase.rpc("hub_my_progress"),
      supabase.rpc("hub_custom_task_people"),
      supabase.rpc("hub_can_make_article"),
    ]);
    if (my !== reqId.current) return;
    /* H293: show the "New article" button only to whoever may start one. */
    if (!mk.error) setCanArticle(mk.data === true);
    /* H290: the dropdown for the Custom task button. Empty unless the caller
       may send tasks (Qaswar or an admin), so the button only appears for them.
       A missing function (migration not run) just leaves the button off. */
    if (!ppl.error) setPeople((ppl.data as Person[]) ?? []);
    if (error) setErr(error.message);
    setRows((data as Task[]) ?? []);
    /* A missing function (migration not run yet) must not take the work list
       down with it: the panel simply shows what it showed before. */
    if (!arts.error) {
      const map: Record<string, ArticleFacts> = {};
      for (const a of ((arts.data as ArticleFacts[]) ?? [])) map[a.article_id] = a;
      setFacts(map);
    }
    if (!cp.error) {
      const map: Record<string, Checkpoint> = {};
      for (const c of ((cp.data as Checkpoint[]) ?? [])) map[c.task_id] = c;
      setCps(map);
    }
    if (!pr.error) {
      const map: Record<string, Progress> = {};
      for (const p of ((pr.data as Progress[]) ?? [])) map[p.article_id] = { ...p, posts: p.posts ?? {}, setup: p.setup ?? {} };
      setProg(map);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /* The finished box is read where the finished card was. */
  useEffect(() => {
    if (flash) flashRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [flash]);

  /* Every action answers { ok, error } instead of throwing, so a refusal has
     to be read out of the reply and shown. Swallowing it looks like a button
     that does nothing. */
  async function run(key: string, fn: string, args: Record<string, unknown>): Promise<boolean> {
    if (!supabase) return false;
    setBusy(key); setErr("");
    const { data, error } = await supabase.rpc(fn, args);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) { setBusy(null); setErr(error.message); return false; }
    if (res && res.ok === false) { setBusy(null); setErr(res.error ?? "Refused."); return false; }
    /* The buttons stay busy until the fresh screen is drawn — otherwise for a
       moment the old one offers the same press again, and it is refused. */
    await load();
    setBusy(null);
    return true;
  }

  const open = rows.filter((r) => r.status === "open");
  /* "To do" counts what he can act on now, not what he is waiting for. */
  const actionable = open.filter((r) => !r.waiting_for);
  const done = rows.filter((r) => r.status !== "open").slice(0, 6);

  /* Where the card sits in his list, taken before the list changes: the
     finished box goes into the same place. */
  const posOf = (t: Task) => Math.max(0, open.findIndex((o) => o.task_id === t.task_id));

  async function act(t: Task, what: "submit" | "send_back") {
    const text = (note[t.task_id] ?? "").trim();
    const pos = posOf(t);
    setFlash(null);
    const ok = what === "submit"
      ? await run(t.task_id, "hub_task_submit", { p_task_id: t.task_id, p_note: text })
      : await run(t.task_id, "hub_task_send_back", { p_task_id: t.task_id, p_reason: text });
    if (ok) {
      setNote((n) => ({ ...n, [t.task_id]: "" }));
      setFlash({ kind: what === "submit" ? "done" : "sent_back", task_id: t.task_id, code: t.code, article_id: t.article_id, pos });
    }
  }

  async function sendBack(t: Task, stage: string) {
    setFlash(null);
    const ok = await run(`${t.task_id}:${stage}`, "hub_task_checkpoint",
      { p_task_id: t.task_id, p_stage: stage, p_note: sbNote.trim() || null });
    if (ok) { setSb(null); setSbNote(""); }
  }

  /* H293: start a new article (product owner / admin). Name required; cost,
     price and budget are left for the administration. */
  async function createArticle() {
    if (!supabase) return;
    setBusy("article"); setErr(""); setSentMsg("");
    const { data, error } = await supabase.rpc("hub_article_create_own",
      { p_rough_name: artName.trim() || null, p_brief: artBrief.trim() || null });
    const res = data as { ok?: boolean; error?: string; code?: string } | null;
    if (error) { setBusy(null); setErr(error.message); return; }
    if (res && res.ok === false) { setBusy(null); setErr(res.error ?? "Refused."); return; }
    setArticleOpen(false); setArtName(""); setArtBrief("");
    setSentMsg(`${res?.code ?? "Article"} created — it is now in your work.`);
    await load();
    setBusy(null);
  }

  /* H290: send a custom task. On success the form closes and a line names who
     got it; a refusal (no details, past deadline, …) is read back by run(). */
  async function sendCustom() {
    if (!supabase) return;
    setBusy("custom"); setErr(""); setSentMsg("");
    const { data, error } = await supabase.rpc("hub_create_custom_task", {
      p_assignee: form.assignee || null,
      p_article_name: form.article.trim() || null,
      p_inventory_code: form.inventory.trim() || null,
      p_name: form.name.trim() || null,
      p_details: form.details.trim() || null,
      p_deadline: form.deadline || null,
    });
    const res = data as { ok?: boolean; error?: string; person?: string } | null;
    if (error) { setBusy(null); setErr(error.message); return; }
    if (res && res.ok === false) { setBusy(null); setErr(res.error ?? "Refused."); return; }
    setBusy(null); setCustomOpen(false); setForm(EMPTY_FORM);
    setSentMsg(`Task sent to ${res?.person ?? "them"}.`);
  }

  async function goLive(t: Task) {
    const pos = posOf(t);
    setFlash(null);
    const ok = await run(t.task_id, "hub_task_go_live",
      { p_task_id: t.task_id, p_note: (note[t.task_id] ?? "").trim() || null });
    setConfirmLive(null);
    if (ok) {
      setNote((n) => ({ ...n, [t.task_id]: "" }));
      setFlash({ kind: "live", task_id: t.task_id, code: t.code, article_id: t.article_id, pos });
    }
  }

  /* A tick saves on its own and answers with the article's ticks, so only
     those are redrawn — no reload of the whole list for one tick. H291: the
     same path drives both kinds — "posted" (hub_article_post_set) and the
     campaign "setup" (hub_article_setup_set). */
  async function tick(t: Task, platform: Platform, on: boolean, kind: TickKind = "posted") {
    if (!supabase || !t.article_id) return;
    const art = t.article_id;
    setBusy(`${t.task_id}:${kind}:${platform}`); setErr("");
    const fn = kind === "setup" ? "hub_article_setup_set" : "hub_article_post_set";
    const { data, error } = await supabase.rpc(fn, { p_task_id: t.task_id, p_platform: platform, p_posted: on });
    const res = data as { ok?: boolean; error?: string; posts?: Posts; setup?: Posts } | null;
    if (error) setErr(error.message);
    else if (res && res.ok === false) setErr(res.error ?? "Refused.");
    else {
      const next = kind === "setup" ? res?.setup : res?.posts;
      if (next) setProg((m) => (m[art] ? { ...m, [art]: { ...m[art], [kind === "setup" ? "setup" : "posts"]: next } } : m));
    }
    setBusy(null);
  }

  /* "Mark all" — tick (or untick) all three accounts of one kind at once. */
  async function tickAll(t: Task, kind: TickKind, on: boolean) {
    if (!supabase || !t.article_id) return;
    const art = t.article_id;
    setBusy(`${t.task_id}:${kind}:all`); setErr("");
    const fn = kind === "setup" ? "hub_article_setup_set" : "hub_article_post_set";
    type PostRes = { ok?: boolean; error?: string; posts?: Posts; setup?: Posts };
    let last: PostRes | null = null;
    for (const pl of PLATFORMS) {
      const { data, error } = await supabase.rpc(fn, { p_task_id: t.task_id, p_platform: pl.key, p_posted: on });
      if (error) { setErr(error.message); setBusy(null); return; }
      last = data as PostRes | null;
      if (last && last.ok === false) { setErr(last.error ?? "Refused."); setBusy(null); return; }
    }
    const next = kind === "setup" ? last?.setup : last?.posts;
    if (next) setProg((m) => (m[art] ? { ...m, [art]: { ...m[art], [kind === "setup" ? "setup" : "posts"]: next } } : m));
    setBusy(null);
  }

  function jump(taskId: string) {
    setCollapsed((m) => (m[taskId] ? { ...m, [taskId]: false } : m));   // H292: open it if minimized
    const el = document.getElementById(`task-${taskId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
    setGlow(taskId);
    window.setTimeout(() => setGlow((g) => (g === taskId ? null : g)), 1600);
  }

  if (loading) {
    return <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted dark:text-[#a89f93]">
      <Loader2 size={14} className="animate-spin" /> Loading your work…</div>;
  }
  /* It used to hide itself when there was nothing assigned. Now it lives
     behind its own tab, so an empty tab has to say it is empty — a blank
     panel reads as a page that failed to load. */

  /* The finished box goes where the finished card was — above the card that
     came after it, or at the end when it was the last one. Its "next" is that
     card, or the first in the list. */
  const flashAt = flash ? Math.min(flash.pos, open.length) : -1;
  const flashNext = flash ? open[flashAt] ?? open[0] ?? null : null;
  const banner = flash ? (
    <DoneBanner key="flash" f={flash} p={flash.article_id ? prog[flash.article_id] : undefined}
      next={flashNext} onJump={jump} onClose={() => setFlash(null)} boxRef={flashRef} />
  ) : null;
  const bannerAbove = flash && flashAt < open.length ? open[flashAt].task_id : null;
  const trailingBanner = !!flash && !bannerAbove;

  /* A social row in Recently Submitted keeps its ticks until the article is
     Live — the newest one per article, and only while no open card for that
     article carries them already. */
  const ticksOnDone = new Set<string>();
  {
    const seen = new Set<string>();
    for (const t of done) {
      if (!t.article_id || seen.has(t.article_id)) continue;
      seen.add(t.article_id);
      const p = prog[t.article_id];
      if (t.stage === "social" && p && p.status !== "completed" && !open.some((o) => o.article_id === t.article_id)) ticksOnDone.add(t.task_id);
    }
  }

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
      <h2 className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea] sm:px-5">
        <ClipboardList size={15} /> Your Work
        {actionable.length > 0 && (
          <span className="rounded-full bg-periwinkle-soft px-2 py-0.5 text-[11px] font-bold text-periwinkle-strong dark:bg-white/[0.10] dark:text-periwinkle">
            {actionable.length} to do
          </span>
        )}
        {open.length > actionable.length && (
          <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-bold text-muted dark:bg-white/[0.06] dark:text-[#a89f93]">
            {open.length - actionable.length} coming
          </span>
        )}
        {/* H293: New article — the product owner (Hamza Mukhtar) or an admin.
            H290: Custom task — Qaswar or an admin. The first button present
            takes the ml-auto so the group sits at the right. */}
        {canArticle && (
          <button onClick={() => { setArticleOpen((v) => !v); setCustomOpen(false); setErr(""); setSentMsg(""); }}
            className={`ml-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${articleOpen
              ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
              : "border border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/[0.06]"}`}>
            <Plus size={13} /> New article
          </button>
        )}
        {people.length > 0 && (
          <button onClick={() => { setCustomOpen((v) => !v); setArticleOpen(false); setErr(""); setSentMsg(""); }}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${canArticle ? "" : "ml-auto"} ${customOpen
              ? "bg-ink text-white dark:bg-white dark:text-[#141414]"
              : "border border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/[0.06]"}`}>
            <Plus size={13} /> Custom task
          </button>
        )}
      </h2>

      {err && <p className="border-b border-line bg-danger-soft px-4 py-2.5 text-[12.5px] font-medium text-danger dark:border-white/10 sm:px-5">{err}</p>}
      {sentMsg && (
        <p className="flex items-center gap-2 border-b border-line bg-success-soft/60 px-4 py-2.5 text-[12.5px] font-medium text-[#2f7a3d] dark:border-white/10 dark:bg-white/[0.04] dark:text-[#8fd39a] sm:px-5">
          <CheckCircle2 size={14} className="shrink-0" /> {sentMsg}
          <button onClick={() => setSentMsg("")} aria-label="Dismiss" className="ml-auto shrink-0 opacity-60 hover:opacity-100"><X size={14} /></button>
        </p>
      )}
      {customOpen && people.length > 0 && (
        <CustomTaskForm people={people} form={form} setForm={setForm} busy={busy === "custom"}
          onSend={sendCustom} onClose={() => { setCustomOpen(false); setForm(EMPTY_FORM); }} />
      )}
      {articleOpen && canArticle && (
        <NewArticleForm name={artName} brief={artBrief} setName={setArtName} setBrief={setArtBrief}
          busy={busy === "article"} onCreate={createArticle}
          onClose={() => { setArticleOpen(false); setArtName(""); setArtBrief(""); }} />
      )}

      {/* H290/H291: the articles sit in a tray with a clear gap between them,
          each its own card led by WHICH campaign it is. */}
      <div className="space-y-4 bg-panel/40 p-3 dark:bg-white/[0.02] sm:p-4">
      {open.length === 0 ? (<>
        {banner}
        {!flash && (
          <p className="px-1 py-4 text-center text-[13px] text-muted dark:text-[#a89f93]">
            Nothing waiting on you right now.
          </p>
        )}
      </>) : open.map((t, idx) => {
        /* H286: an open ads card gets the checkpoints and the Live button.
           With no checkpoint data (the function missing) it still shows Live —
           the database enforces the rule either way. */
        const isAds = t.stage === "ads" && !!t.article_id;
        const isSocial = t.stage === "social" && !!t.article_id;
        /* H290: product, video and social get the checkpoint panel too, not
           only ads — each sends back the other finished steps. */
        const cp = cps[t.task_id];
        const p = t.article_id ? prog[t.article_id] : undefined;
        const waitingFor = cp?.waiting_for ?? [];
        const ready = waitingFor.length === 0;
        const back = t.returned_note ? SENT_BACK.exec(t.returned_note) : null;
        /* who this fix goes back to: the checkpoint's sender (H286) */
        const fixFor = p?.steps.find((s) => s.mine && s.stage === t.stage)?.sent_back_by ?? (back ? back[1] : null);
        const socialWho = firstName(cp?.steps.find((s) => s.stage === "social")?.person ?? "Awais");
        const notTicked = p ? PLATFORMS.filter((pl) => !p.posts[pl.key]).map((pl) => pl.name) : [];
        const last = idx === open.length - 1;
        const isMin = !!collapsed[t.task_id];   // H292: card minimized to its header
        return (<div key={t.task_id} className="space-y-3">
        {bannerAbove === t.task_id && banner}
        <div id={`task-${t.task_id}`} data-code={t.code ?? undefined} tabIndex={-1}
          className={`rounded-2xl border bg-surface px-4 py-4 shadow-sm outline-none transition-colors dark:bg-[#211d17] sm:px-5 ${
            glow === t.task_id ? "border-periwinkle-strong ring-2 ring-inset ring-periwinkle-strong bg-periwinkle-soft/30 dark:bg-white/[0.05]" : "border-line dark:border-white/[0.07]"}`}>
          {/* H291: lead with WHICH campaign this is — the code and the article
              name, big — so two cards never look like one. The role (what this
              person does on it) is the quieter line under it. */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {t.code && <span className="text-[15px] font-extrabold tracking-tight text-ink dark:text-[#f4f1ea]">{t.code}</span>}
                <span className="text-[15px] font-extrabold tracking-tight text-ink [overflow-wrap:anywhere] dark:text-[#f4f1ea]">
                  {t.code ? tc(t.article_name ?? "—") : tc(t.title)}
                </span>
              </div>
              <div className="mt-0.5 text-[12px] font-semibold text-muted dark:text-[#a89f93]">{tc(t.title)}</div>
            </div>
            {/* The status chip, and the minimize arrow (H292). While he is
                waiting, no clock is shown — the days belong to the man making
                the product. An ads card that cannot go Live yet is waiting on
                other people, so it says who. */}
            <div className="flex shrink-0 items-center gap-1.5">
              <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${t.waiting_for || (isAds && !ready)
                  ? "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber"
                  : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
                {t.waiting_for ? `waiting for ${t.waiting_for}`
                  : isAds && !ready ? `waiting for ${waitingFor.map((w) => w.split(" (")[0].split(" ")[0]).join(", ")}`
                  : `with you ${t.held}`}
              </span>
              <button type="button" aria-expanded={!isMin}
                aria-label={isMin ? `Open ${t.code ?? "task"}` : `Minimize ${t.code ?? "task"}`}
                onClick={() => setCollapsed((m) => ({ ...m, [t.task_id]: !isMin }))}
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-panel hover:text-ink dark:text-[#a89f93] dark:hover:bg-white/[0.06] dark:hover:text-white">
                <ChevronDown size={18} className={`transition-transform ${isMin ? "-rotate-90" : ""}`} />
              </button>
            </div>
          </div>

          {/* H292: everything below the header hides when the card is minimized. */}
          {!isMin && (<>
          {/* The reason is the instruction, so it is loud.
              "Back with you" rather than "Sent back", because this box now
              carries two different things: Rehman rejecting the work, and the
              administration undoing a submission that should not have been
              recorded. In the second case the man never sent anything, so
              "sent back" would be telling him something untrue about himself.
              A checkpoint from the ads card says who sent it and what to fix. */}
          {t.returned_note ? (
            <p className="mt-2 whitespace-pre-line rounded-xl2 bg-salmon-soft px-3 py-2 text-[12.5px] text-red-900 [overflow-wrap:anywhere] dark:bg-white/[0.06] dark:text-salmon">
              {back
                ? <><b>Sent back by {back[1]}{back[2] ? ":" : ""}</b> {back[2] ?? "no note — ask what needs changing."}</>
                : <><b>Back with you:</b> {t.returned_note}</>}
            </p>
          ) : null}

          {t.article_id && facts[t.article_id] ? (
            /* A send-back writes "Sent back by <name>: <reason>" as the detail,
               and the reason is already in the red box above — so that detail is
               not passed on. Checked by its exact opening words, not by
               searching for the reason, which could appear in any brief. */
            <Facts a={facts[t.article_id]} detail={t.detail?.startsWith("Sent back by ")
              /* …but keep any "Video ready" note added after it (a social card
                 sent back from the ads stage still needs the new video). */
              ? t.detail.replace(/^[\s\S]*?(?=\n\nVideo ready: |$)/, "")
              : t.detail} />
          ) : !t.returned_note && t.detail ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted dark:text-[#a89f93]">{t.detail}</p>
          ) : null}

          {/* Right above the box where he writes his own — so he sees what the
              others on this article already said before he says his. */}
          {t.article_id && (facts[t.article_id]?.comments?.length ?? 0) > 0 && (
            <Comments list={facts[t.article_id].comments!} />
          )}

          {cp && cp.steps.length > 0 && (
            /* CHECKPOINTS (H286 ads; H290 product/video/social too). Every other
               step, who did it and when, and a Send back on each finished one.
               The note is optional. */
            <div className="mt-3 overflow-hidden rounded-xl2 border border-line dark:border-white/10">
              <div className="flex items-center gap-1.5 border-b border-line bg-panel/60 px-3 py-2 text-[12px] font-bold text-muted dark:border-white/10 dark:bg-white/[0.03] dark:text-[#a89f93]">
                <Flag size={12} className="shrink-0" /> Checkpoints · Send A Step Back
              </div>
              {cp.steps.map((s) => {
                const formOpen = sb?.task === t.task_id && sb.stage === s.stage;
                const who = s.person ?? "nobody";
                const state = s.status === "submitted" ? `done ${day(s.submitted_at)}`
                  : s.status === "open" ? (s.sent_back_by ? `sent back ${day(s.opened_at)} · fixing it` : "working on it")
                  : s.status === "returned" ? "handed it back to Product"
                  : "not started";
                return (
                  <div key={s.stage} className="border-b border-line/70 px-3 py-2.5 last:border-0 dark:border-white/[0.06]">
                    {/* Name over details on a phone, one line from sm up; the
                        button always keeps the right edge. */}
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                        <div className="text-[13px] font-bold text-ink sm:w-[104px] sm:shrink-0 dark:text-[#f4f1ea]">{STEP[s.stage] ?? tc(s.name)}</div>
                        <div className="min-w-0 text-[12px] text-muted dark:text-[#a89f93]">
                          {who} · {state}
                          {(s.attempt ?? 1) > 1 && (
                            <span className="ml-1.5 whitespace-nowrap rounded-full bg-salmon-soft px-1.5 py-px text-[10.5px] font-bold text-red-800 dark:bg-white/[0.08] dark:text-salmon">
                              attempt {s.attempt}
                            </span>
                          )}
                        </div>
                      </div>
                      {s.can_send_back ? (
                        <button disabled={!!busy}
                          onClick={() => { setSb(formOpen ? null : { task: t.task_id, stage: s.stage }); setSbNote(""); setConfirmLive(null); }}
                          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40 ${formOpen
                            ? "border-periwinkle-strong bg-periwinkle-soft text-ink dark:border-periwinkle dark:bg-white/[0.10] dark:text-white"
                            : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white dark:hover:bg-white/[0.06]"}`}>
                          <CornerUpLeft size={12} /> Send back
                        </button>
                      ) : s.status === "open" ? (
                        <span className="shrink-0 rounded-full bg-amber-soft px-2.5 py-1 text-[11px] font-semibold text-amber-strong dark:bg-white/[0.08] dark:text-amber">
                          with {who.split(" ")[0]}
                        </span>
                      ) : null}
                    </div>
                    {/* H288/H291: what Awais ticked — campaign setup and posted. */}
                    {s.stage === "social" && p && <PostsLine posts={p.posts} setup={p.setup} />}
                    {s.status === "open" && s.sent_back_by && s.sent_back_note && (
                      <p className="mt-1 text-[11.5px] text-red-800 [overflow-wrap:anywhere] dark:text-salmon">“{s.sent_back_note}”</p>
                    )}
                    {formOpen && (
                      <div className="mt-2 rounded-xl2 border border-periwinkle-soft bg-canvas p-3 dark:border-white/10 dark:bg-white/[0.04]">
                        <label className="block text-[12px] font-semibold text-muted dark:text-[#a89f93]">
                          Note for {who} <span className="font-normal text-hint dark:text-[#8a8175]">(optional)</span>
                        </label>
                        <textarea autoFocus rows={2} value={sbNote} onChange={(e) => setSbNote(e.target.value)}
                          placeholder="e.g. make it a combination of two videos"
                          className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]" />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button disabled={!!busy} onClick={() => sendBack(t, s.stage)}
                            className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
                            <CornerUpLeft size={13} /> {busy === `${t.task_id}:${s.stage}` ? "Sending…" : `Send back to ${who}`}
                          </button>
                          <button disabled={!!busy} onClick={() => { setSb(null); setSbNote(""); }}
                            className="rounded-full border border-line px-4 py-1.5 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
                            Cancel
                          </button>
                        </div>
                        <p className="mt-1.5 text-[11.5px] leading-relaxed text-hint dark:text-[#8a8175]">
                          It goes back to {who} as attempt {(s.attempt ?? 1) + 1}. When the fix is submitted it comes straight back to you, and Live waits until then.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* H288/H291: Awais's two tick blocks — Campaign setup, then Posted on.
              Each has a Mark all. Posting is compulsory before he can submit. */}
          {isSocial && p && (<>
            <SocialTicks kind="setup" title="Campaign Setup"
              hint="Tick each account once the campaign is set up on it." posts={p.setup} busy={busy}
              taskId={t.task_id} locked={p.status === "completed"}
              onToggle={(pl, on) => tick(t, pl, on, "setup")} onAll={(on) => tickAll(t, "setup", on)} />
            <SocialTicks kind="posted" title="Posted On"
              hint="Tick each one when the post is up — Qaswar sees these. All three are needed before you submit."
              posts={p.posts} busy={busy} taskId={t.task_id} locked={p.status === "completed"}
              onToggle={(pl, on) => tick(t, pl, on, "posted")} onAll={(on) => tickAll(t, "posted", on)} />
          </>)}

          {t.waiting_for ? (
            /* THE CHECK IS VISIBLE, NOT YET ACTIONABLE.
               The buttons would only be refused — there is no product to check
               until it is uploaded. He is told the moment it is. */
            <p className="mt-3 rounded-xl2 bg-panel px-3 py-2.5 text-[12.5px] leading-relaxed text-muted dark:bg-white/[0.04] dark:text-[#a89f93]">
              Coming to you. {t.waiting_for} is still uploading the product — you will get a
              notification the moment it is ready to check, and your time starts then.
            </p>
          ) : isAds ? (<>
          {/* LIVE (H286). The final comment is optional. The button opens only
              when the four steps above are all done, and asks once more before
              it closes the article for everyone. */}
          <textarea
            value={note[t.task_id] ?? ""}
            onChange={(e) => setNote((n) => ({ ...n, [t.task_id]: e.target.value }))}
            rows={2}
            placeholder="Final comment (optional) — e.g. campaign live on Meta"
            className="mt-3 min-h-[72px] w-full rounded-xl2 sm:min-h-0 border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {confirmLive === t.task_id ? (<>
              <button disabled={!!busy} onClick={() => goLive(t)}
                className="flex items-center gap-1.5 rounded-full bg-[#2f7a3d] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-[#8fd39a] dark:text-[#141414]">
                <Rocket size={13} /> {busy === t.task_id ? "Going live…" : "Yes, go live"}
              </button>
              <button disabled={!!busy} onClick={() => setConfirmLive(null)}
                className="rounded-full border border-line px-4 py-2 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
                Cancel
              </button>
              <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
                This closes {t.code} for everyone. Only the administration can undo it.
                {notTicked.length > 0 && <b className="font-semibold text-[#7a4f12] dark:text-amber"> {socialWho} has not ticked {notTicked.join(", ")} yet.</b>}
              </span>
            </>) : (<>
              <button disabled={!!busy || !ready} onClick={() => { setConfirmLive(t.task_id); setSb(null); }}
                className="flex items-center gap-1.5 rounded-full bg-[#2f7a3d] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-[#8fd39a] dark:text-[#141414]">
                <Rocket size={13} /> Live
              </button>
              <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
                {ready
                  ? "Live closes the article for everyone. Until then you can send any step back."
                  : `Live opens when everyone is done — waiting for ${waitingFor.map(roleTc).join(", ")}.`}
              </span>
            </>)}
          </div>
          </>) : (<>
          <textarea
            value={note[t.task_id] ?? ""}
            onChange={(e) => setNote((n) => ({ ...n, [t.task_id]: e.target.value }))}
            rows={3}
            placeholder="What did you do? e.g. 6 pictures, 4 sizes, size chart added, live on Shopify"
            className="mt-3 min-h-[92px] w-full rounded-xl2 sm:min-h-0 border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]"
          />

          {(() => {
            /* H291: Awais must tick all three "Posted on" accounts before he can
               submit. The button stays dead and says which are still missing. */
            const need = isSocial && p ? PLATFORMS.filter((pl) => !p.posts[pl.key]).map((pl) => pl.name) : [];
            const blocked = need.length > 0;
            return (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button disabled={busy === t.task_id || !(note[t.task_id] ?? "").trim() || blocked}
              onClick={() => act(t, "submit")}
              className="rounded-full bg-ink px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
              {busy === t.task_id ? "Saving…" : "Submit"}
            </button>

            {t.stage === "qc" && (
              <button disabled={busy === t.task_id || !(note[t.task_id] ?? "").trim()}
                onClick={() => act(t, "send_back")}
                className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-40 dark:border-white/15 dark:text-white">
                <CornerUpLeft size={13} /> Send back
              </button>
            )}

            <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
              {blocked
                ? <b className="font-semibold text-[#7a4f12] dark:text-amber">Tick {need.join(", ")} under &ldquo;Posted on&rdquo; before you submit.</b>
                : t.stage === "qc"
                ? "Write what you checked, or what is wrong if you are sending it back."
                : "Write what you did — it goes to the administration with your name on it."}
            </span>
          </div>
            );
          })()}
          </>)}

          {/* ARTICLE PROGRESS (H288) — the space at the bottom of every card:
              which steps are finished, what happens after you, and the next
              card in your list. */}
          <ProgressPanel p={p} t={t} fixFor={fixFor} next={open[idx + 1] ?? null} onJump={jump} />
          </>)}
        </div>
        </div>);
      })}
      {open.length > 0 && trailingBanner && banner}
      </div>

      {done.length > 0 && (
        <div className="border-t border-line bg-panel/60 px-4 py-3 dark:border-white/[0.06] dark:bg-white/[0.03] sm:px-5">
          <div className="mb-2 text-[12px] font-bold text-muted dark:text-[#a89f93]">Recently Submitted</div>
          <ul className="space-y-2">
            {done.map((t) => {
              const p = t.article_id ? prog[t.article_id] : undefined;
              const now = p && p.status !== "completed"
                ? p.steps.filter((s) => s.status === "open" && !s.mine).map((s) => firstName(s.person)) : [];
              return (
              <li key={t.task_id} className="text-[12.5px]">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <CheckCircle2 size={12} className="shrink-0 self-center text-success" />
                  {/* H290: the article NAME next to the code, not just "A-1010".
                      A custom task has no code, so its own name is the label. */}
                  <span className="font-semibold text-ink dark:text-[#e7e2d8]">{t.code ?? tc(t.title) ?? "Task"}</span>
                  {t.code && t.article_name && (
                    <span className="min-w-0 max-w-full truncate font-medium text-ink/75 dark:text-[#cfc8bd]">{tc(t.article_name)}</span>
                  )}
                  {/* An ads card is closed by Live; with no final comment there is
                      no note to show, so say what happened instead. */}
                  <span className="min-w-0 flex-1 truncate text-muted dark:text-[#a89f93]">
                    {t.stage === "ads" ? `Live${t.submit_note ? ` · ${t.submit_note}` : ""}` : t.submit_note}
                  </span>
                  {/* H288: where the article is now — finished, or with whom. */}
                  {p && (p.status === "completed" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-bold text-[#2f7a3d] dark:text-[#8fd39a] dark:bg-white/[0.10]">
                      <Rocket size={11} /> finished · Live {day(p.live?.at ?? p.completed_at)}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-[#7a4f12] dark:bg-white/[0.08] dark:text-amber">
                      {now.length ? `now with ${now.join(", ")}` : "in progress"}
                    </span>
                  ))}
                  {/* A clock figure would be a lie on a record written by hand —
                      the system never held that work. Say who wrote it instead. */}
                  {t.recorded_by ? (
                    <span className="shrink-0 font-semibold text-periwinkle-strong dark:text-periwinkle">
                      recorded by {t.recorded_by}
                      {t.submitted_at ? ` · ${day(t.submitted_at)}` : ""}
                    </span>
                  ) : (
                    <span className="shrink-0 text-hint dark:text-[#8a8175]">took {t.held}</span>
                  )}
                </div>
                {ticksOnDone.has(t.task_id) && p && (
                  <SocialTicks compact kind="posted" posts={p.posts} busy={busy} taskId={t.task_id} locked={false}
                    onToggle={(pl, on) => tick(t, pl, on, "posted")} />
                )}
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/* NEW ARTICLE (H293) — the product owner starts an article with just a name
   and an optional brief. The cost, price and ad budget stay for the office. */
function NewArticleForm({ name, brief, setName, setBrief, busy, onCreate, onClose }: {
  name: string; brief: string; setName: (v: string) => void; setBrief: (v: string) => void;
  busy: boolean; onCreate: () => void; onClose: () => void;
}) {
  const box = "w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[16px] sm:text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]";
  const cap = "block text-[12px] font-semibold text-ink dark:text-[#e7e2d8]";
  return (
    <div className="border-b border-line bg-panel/50 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03] sm:px-5">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-ink dark:text-[#f4f1ea]">
        <Plus size={14} className="shrink-0" /> Start A New Article
      </div>
      <div className="space-y-3">
        <label className="block">
          <span className={cap}>Article name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Boys Denim Jacket"
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) onCreate(); }} className={`mt-1 ${box}`} />
        </label>
        <label className="block">
          <span className={cap}>Brief <span className="font-normal text-hint dark:text-[#8a8175]">(optional)</span></span>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2}
            placeholder="Anything to note for the shoot / upload." className={`mt-1 min-h-[64px] ${box}`} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={busy || !name.trim()} onClick={onCreate}
          className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#141414]">
          <Plus size={13} /> {busy ? "Creating…" : "Create article"}
        </button>
        <button disabled={busy} onClick={onClose}
          className="rounded-full border border-line px-4 py-2 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
          Cancel
        </button>
        <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
          It opens with you on Product, plus Video and the quality check. The office sets the price and budget.
        </span>
      </div>
    </div>
  );
}

/* THE CUSTOM TASK FORM (H290) — Qaswar picks a person and sends them a job
   that is not one of the five article steps: an article name, an inventory
   code, a short name, the details, and a deadline. It lands in that person's
   "Your work" like any other task. */
function CustomTaskForm({ people, form, setForm, busy, onSend, onClose }: {
  people: Person[]; form: CustomForm; setForm: (f: CustomForm) => void;
  busy: boolean; onSend: () => void; onClose: () => void;
}) {
  const set = (k: keyof CustomForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const box = "w-full rounded-xl2 border border-line bg-canvas px-3 py-2 text-[16px] sm:text-[13px] text-ink outline-none placeholder:text-hint dark:border-white/10 dark:bg-white/[0.04] dark:text-[#f4f1ea]";
  const cap = "block text-[12px] font-semibold text-ink dark:text-[#e7e2d8]";
  const ready = !!form.assignee && !!form.details.trim();
  return (
    <div className="border-b border-line bg-panel/50 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03] sm:px-5">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-ink dark:text-[#f4f1ea]">
        <Send size={14} className="shrink-0" /> Send A Custom Task
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className={cap}>Who is it for?</span>
          <select value={form.assignee} onChange={set("assignee")} className={`mt-1 ${box}`}>
            <option value="">Pick an employee…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.designation ? ` — ${p.designation}` : ""}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={cap}>Article name</span>
          <input value={form.article} onChange={set("article")} placeholder="e.g. Winter Hoodie" className={`mt-1 ${box}`} />
        </label>
        <label>
          <span className={cap}>Inventory code</span>
          <input value={form.inventory} onChange={set("inventory")} placeholder="e.g. INV-5567" className={`mt-1 ${box}`} />
        </label>
        <label className="sm:col-span-2">
          <span className={cap}>Name</span>
          <input value={form.name} onChange={set("name")} placeholder="A short name for the task" className={`mt-1 ${box}`} />
        </label>
        <label className="sm:col-span-2">
          <span className={cap}>Required data <span className="font-normal text-hint dark:text-[#8a8175]">— what has to be done</span></span>
          <textarea value={form.details} onChange={set("details")} rows={3}
            placeholder="Describe the scenario and exactly what you need back."
            className={`mt-1 min-h-[88px] ${box}`} />
        </label>
        <label>
          <span className={cap}>Deadline <span className="font-normal text-hint dark:text-[#8a8175]">(optional)</span></span>
          <div className="relative mt-1">
            <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
            <input type="date" value={form.deadline} min={todayPk()} onChange={set("deadline")} className={`${box} pl-9`} />
          </div>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={busy || !ready} onClick={onSend}
          className="flex items-center gap-1.5 rounded-full bg-[#2f7a3d] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-[#8fd39a] dark:text-[#141414]">
          <Send size={13} /> {busy ? "Sending…" : "Send task"}
        </button>
        <button disabled={busy} onClick={onClose}
          className="rounded-full border border-line px-4 py-2 text-[12.5px] font-semibold text-ink dark:border-white/15 dark:text-white">
          Cancel
        </button>
        <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
          It goes straight to that person&rsquo;s work, with your name on it.
        </span>
      </div>
    </div>
  );
}

/* ARTICLE PROGRESS — the space at the bottom of every card (H288).
   The five steps as chips, ticked as they finish; what happens after this
   person presses Submit; and the next card in his list, one tap away.
   Qaswar's ads card already lists every step in its checkpoints, so there it
   only points to the next card. */
function ProgressPanel({ p, t, fixFor, next, onJump }: {
  p: Progress | undefined; t: Task; fixFor: string | null; next: Task | null; onJump: (taskId: string) => void;
}) {
  const steps = p && t.stage !== "ads" ? p.steps : null;
  const doneN = steps ? steps.filter((s) => s.status === "submitted").length : 0;
  const after = t.article_id ? afterYou(t.stage, p, fixFor) : "";
  return (
    <div className="mt-3 rounded-xl2 border border-line bg-panel/50 px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.03]">
      {steps && (<>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12px] font-bold text-ink dark:text-[#f4f1ea]">
            <ClipboardCheck size={13} className="shrink-0" /> Article Progress
          </span>
          <span className="text-[11.5px] font-semibold tabular-nums text-muted dark:text-[#a89f93]">
            {doneN} of {steps.length} done
          </span>
        </div>
        <ol className="mt-2 flex flex-wrap gap-1.5" aria-label="Steps of this article">
          {steps.map((s) => <StepChip key={s.stage} s={s} />)}
        </ol>
      </>)}
      {after && (
        <p className={`${steps ? "mt-2" : ""} text-[12px] leading-snug text-muted dark:text-[#a89f93]`}>
          <b className="font-semibold text-ink dark:text-[#e7e2d8]">After You:</b> {after}
        </p>
      )}
      <p className={`${steps || after ? "mt-1.5" : ""} flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-muted dark:text-[#a89f93]`}>
        <b className="font-semibold text-ink dark:text-[#e7e2d8]">Next In Your List:</b>
        {next ? (
          <button onClick={() => onJump(next.task_id)}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full py-0.5 text-left font-semibold text-[#3d5c99] underline-offset-2 hover:underline dark:text-periwinkle">
            <span className="shrink-0">{next.code ?? "Task"} ·</span>
            <span className="min-w-0 truncate">{tc(next.article_name ?? next.title)}</span>
            <ChevronDown size={13} className="shrink-0" />
          </button>
        ) : <span>this is the last one.</span>}
      </p>
    </div>
  );
}

function StepChip({ s }: { s: PStep }) {
  const done = s.status === "submitted";
  const fixing = s.status === "open" && !!s.sent_back_by;
  const open = s.status === "open";
  const back = s.status === "returned";
  const name = STEP[s.stage] ?? tc(s.stage);
  const state = done ? (s.stage === "ads" ? "live" : "done")
    : fixing ? "being fixed" : open ? (s.mine ? "with you now" : "in progress")
    : back ? "sent back" : "not started";
  const tone = done ? "border-transparent bg-success-soft text-[#2f7a3d] dark:text-[#8fd39a] dark:bg-white/[0.10]"
    : fixing || back ? "border-transparent bg-salmon-soft text-red-800 dark:bg-white/[0.08] dark:text-salmon"
    : open ? (s.mine
      ? "border-ink/50 bg-surface text-ink dark:border-white/40 dark:bg-white/[0.06] dark:text-white"
      : "border-transparent bg-amber-soft text-[#7a4f12] dark:bg-white/[0.08] dark:text-amber")
    : "border-dashed border-[#d6cfc4] text-muted dark:border-white/15 dark:text-[#8a8175]";
  const title = `${name} — ${s.person ?? "nobody"} · ${state}${done && s.submitted_at ? ` ${day(s.submitted_at)}` : ""}${(s.attempt ?? 1) > 1 ? ` · attempt ${s.attempt}` : ""}`;
  return (
    <li title={title} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${tone}`}>
      {done ? (s.stage === "ads" ? <Rocket size={12} className="shrink-0" /> : <CheckCircle2 size={12} className="shrink-0" />)
        : fixing || back ? <CornerUpLeft size={12} className="shrink-0" />
        : open ? <Clock3 size={12} className="shrink-0" />
        : <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border border-current" />}
      <span>{name}</span>
      <span className="truncate font-normal opacity-80">· {s.mine ? "You" : firstName(s.person)}</span>
      <span className="sr-only">— {state}</span>
    </li>
  );
}

/* AWAIS'S TICKS (H288 posted; H291 campaign setup). Each is his signature that
   the account is set up / the post is up, saved the moment he taps it. A
   "Mark all" ticks or unticks all three at once. Closed once the article is
   Live. The compact form (recently submitted) has no header or Mark all. */
function SocialTicks({ kind, title, hint, posts, busy, taskId, locked, compact, onToggle, onAll }: {
  kind: TickKind; title?: string; hint?: string;
  posts: Posts; busy: string | null; taskId: string; locked: boolean; compact?: boolean;
  onToggle: (platform: Platform, on: boolean) => void; onAll?: (on: boolean) => void;
}) {
  const allOn = PLATFORMS.every((pl) => !!posts[pl.key]);
  const allBusy = busy === `${taskId}:${kind}:all`;
  const buttons = (
    <div className="flex flex-wrap gap-2" role="group" aria-label={title ?? "Posted on"}>
      {PLATFORMS.map((pl) => {
        const on = !!posts[pl.key];
        const mine = busy === `${taskId}:${kind}:${pl.key}`;
        return (
          <button key={pl.key} type="button" role="checkbox" aria-checked={on} disabled={!!busy || locked}
            onClick={() => onToggle(pl.key, !on)}
            title={on ? `Ticked by ${posts[pl.key]?.by ?? "someone"} · ${stamp(posts[pl.key]?.at)}` : `Tick ${pl.name}`}
            className={`inline-flex items-center gap-1.5 rounded-full border font-semibold transition disabled:opacity-50 ${compact
              ? "min-h-[36px] px-2.5 text-[11.5px] sm:min-h-0 sm:py-1" : "min-h-[40px] px-3 text-[12.5px] sm:min-h-0 sm:py-1.5"} ${on
              ? "border-[#2f7a3d]/40 bg-success-soft text-[#2f7a3d] dark:text-[#8fd39a] dark:border-[#8fd39a]/40 dark:bg-white/[0.10]"
              : "border-line bg-surface text-ink hover:bg-panel dark:border-white/15 dark:bg-white/[0.03] dark:text-white dark:hover:bg-white/[0.06]"}`}>
            {mine ? <Loader2 size={13} className="shrink-0 animate-spin" />
              : on ? <CheckSquare size={14} className="shrink-0" />
              : <span aria-hidden className="h-[13px] w-[13px] shrink-0 rounded-[3px] border-2 border-current opacity-60" />}
            {pl.name}
            {on && !compact && <span className="font-normal opacity-80">· {day(posts[pl.key]?.at)}</span>}
          </button>
        );
      })}
      {/* Mark all — ticks all three, or clears them if they are all on. */}
      {onAll && !compact && (
        <button type="button" disabled={!!busy || locked} onClick={() => onAll(!allOn)}
          className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-dashed px-3 text-[12.5px] font-semibold transition disabled:opacity-50 sm:min-h-0 sm:py-1.5 ${
            allOn ? "border-line text-muted hover:bg-panel dark:border-white/15 dark:text-[#a89f93]"
                  : "border-ink/40 text-ink hover:bg-panel dark:border-white/30 dark:text-white dark:hover:bg-white/[0.06]"}`}>
          {allBusy ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <CheckSquare size={13} className="shrink-0" />}
          {allOn ? "Clear all" : "Mark all"}
        </button>
      )}
    </div>
  );
  if (compact) return <div className="mt-1.5 pl-5">{buttons}</div>;
  return (
    <div className="mt-3 rounded-xl2 border border-line px-3 py-2.5 dark:border-white/10">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12px] font-bold text-ink dark:text-[#f4f1ea]">{title ?? "Posted On"}</span>
        <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
          {locked ? "The article is live — the ticks are closed." : hint}
        </span>
      </div>
      {buttons}
    </div>
  );
}

/* What Awais ticked, read-only — on the Social row of Qaswar's checkpoints:
   campaign setup and posted, each account. */
function PostsLine({ posts, setup }: { posts: Posts; setup?: Posts }) {
  const line = (label: string, map: Posts) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10.5px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">{label}</span>
      {PLATFORMS.map((pl) => {
        const p = map[pl.key];
        return (
          <span key={pl.key} title={p ? `Ticked by ${p.by ?? "someone"} · ${stamp(p.at)}` : "Not ticked yet"}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${p
              ? "bg-success-soft text-[#2f7a3d] dark:text-[#8fd39a] dark:bg-white/[0.10]"
              : "bg-panel text-muted dark:bg-white/[0.05] dark:text-[#8a8175]"}`}>
            {p ? <CheckSquare size={11} className="shrink-0" />
              : <span aria-hidden className="h-[10px] w-[10px] shrink-0 rounded-[2px] border-[1.5px] border-current" />}
            {pl.name}
          </span>
        );
      })}
    </div>
  );
  return (
    <div className="mt-1.5 space-y-1">
      {setup && line("Setup", setup)}
      {line("Posted", posts)}
    </div>
  );
}

/* THE FINISHED BOX (H288) — in the place of the card that was just
   submitted: it is finished from your side, who has the article now, and the
   next card, with a button that takes you to it. */
function DoneBanner({ f, p, next, onJump, onClose, boxRef }: {
  f: Flash; p: Progress | undefined; next: Task | null;
  onJump: (taskId: string) => void; onClose: () => void;
  boxRef: { current: HTMLDivElement | null };
}) {
  const finished = f.kind === "live" || p?.status === "completed";
  const withNow = p && !finished
    ? p.steps.filter((s) => s.status === "open" && !s.mine).map((s) => `${s.person ?? "nobody"} (${STEP[s.stage] ?? tc(s.stage)})`) : [];
  const head = f.kind === "live" ? `${f.code ?? "The Article"} Is Live — Finished For Everyone`
    : f.kind === "sent_back" ? `${f.code ?? "It"} Sent Back To Product`
    : finished ? `${f.code ?? "The Article"} Is Finished`
    : `${f.code ?? "This Task"} Is Finished From Your Side`;
  const line = finished ? "Nothing more can change on it — only the administration can undo a Live."
    : f.kind === "sent_back" ? "Hamza Mukhtar has it back with your reason; it comes back to you when he fixes it."
    : !f.article_id ? "Your note went to the administration with your name on it."
    : withNow.length ? `It is with ${withNow.join(" and ")} now.`
    : "The next step opens by itself — you will be told if it comes back to you.";
  return (
    <div ref={boxRef} role="status"
      className="rounded-2xl border border-[#2f7a3d]/30 bg-success-soft/70 px-4 py-3 shadow-sm dark:border-[#8fd39a]/25 dark:bg-white/[0.05] sm:px-5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[#2f7a3d] dark:text-[#8fd39a]">
          {f.kind === "live" ? <Rocket size={16} /> : f.kind === "sent_back" ? <CornerUpLeft size={16} /> : <CheckCircle2 size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{head}</div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted dark:text-[#a89f93]">{line}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]">
            {next ? (<>
              <span className="min-w-0 font-semibold text-ink dark:text-[#e7e2d8]">
                Next: {next.code ?? "Task"} · {tc(next.article_name ?? next.title)}
              </span>
              <button onClick={() => onJump(next.task_id)}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-ink px-3.5 text-[12px] font-semibold text-white sm:min-h-0 sm:py-1 dark:bg-white dark:text-[#141414]">
                Go To It <ChevronDown size={13} />
              </button>
            </>) : (
              <span className="font-semibold text-ink dark:text-[#e7e2d8]">Nothing else is waiting on you right now.</span>
            )}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-black/[0.05] dark:text-[#a89f93] dark:hover:bg-white/[0.08]">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

/* WHAT THE TEAM WROTE ON THIS ARTICLE. Links (a Shopify product page is the
   usual note) open in a new tab; everything else is plain text. */
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return <>{parts.map((p, i) => (i % 2 === 1
    ? <a key={i} href={p} target="_blank" rel="noopener noreferrer"
         className="font-semibold text-periwinkle-strong underline underline-offset-2 [overflow-wrap:anywhere] dark:text-periwinkle">{p}</a>
    : <span key={i}>{p}</span>))}</>;
}

function Comments({ list }: { list: Comment[] }) {
  return (
    <div className="mt-2 rounded-xl2 border border-line px-3 py-2.5 dark:border-white/10">
      <div className="mb-1.5 text-[12px] font-bold text-muted dark:text-[#a89f93]">
        What The Team Wrote · {list.length}
      </div>
      <ul className="space-y-2">
        {list.map((c) => {
          const red = c.kind === "sent_back" || c.kind === "checkpoint";
          return (
            <li key={`${c.task_id}-${c.kind}`} className="text-[12.5px] leading-relaxed">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-bold text-ink dark:text-[#f4f1ea]">{c.mine ? "You" : c.by}</span>
                {c.kind === "checkpoint" ? (
                  /* by = who sent it back, to = who has it now */
                  <span className="font-semibold text-red-700 dark:text-salmon">
                    · sent {STAGE[c.stage ?? ""] ?? (c.title ? tc(c.title) : "it")} back to {c.to ?? "them"}
                  </span>
                ) : (
                  <span className="text-muted dark:text-[#a89f93]">· {STAGE[c.stage ?? ""] ?? (c.title ? tc(c.title) : "Task")}</span>
                )}
                {c.kind === "sent_back" && <span className="font-semibold text-red-700 dark:text-salmon">· sent it back</span>}
                {c.kind === "live" && <span className="font-semibold text-[#2f7a3d] dark:text-[#8fd39a]">· went live</span>}
                <span className="text-[11.5px] text-hint dark:text-[#8a8175]">· {stamp(c.at)}</span>
                {c.recorded_by && <span className="text-[11.5px] text-periwinkle-strong dark:text-periwinkle">· recorded by {c.recorded_by}</span>}
              </div>
              {c.note ? (
                <p className={`whitespace-pre-line [overflow-wrap:anywhere] ${red ? "text-red-900 dark:text-salmon" : "text-ink dark:text-[#e7e2d8]"}`}>
                  <Linked text={c.note} />
                </p>
              ) : c.kind === "checkpoint" ? (
                <p className="text-[12px] italic text-muted dark:text-[#a89f93]">no note</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* THE ARTICLE, AS THE MAN DOING THE WORK NEEDS IT.
   Prices first, because putting the wrong one on Shopify is the costliest
   mistake on this panel. Then the budget if he runs the ads, then the brief. */
function Facts({ a, detail }: { a: ArticleFacts; detail: string | null }) {
  const priced = a.packs.filter((p) => p.price != null);
  /* The video stage appends "Video ready: <note>" to the ads and social tasks.
     That is news, not brief — split it out and show it as its own line,
     instead of letting it hide at the end of an old copy of the brief. */
  const [rawSnap, ...videoParts] = (detail ?? "").split(/\n\nVideo ready: /);
  const video = videoParts.join("\n").trim();
  /* The task carries the brief as it was when the work reached him. If the
     administration has changed or removed it since, the old copy is shown
     labelled as the earlier brief, so nobody works from it without knowing. */
  const snap = (rawSnap ?? "").trim();
  const live = (a.brief ?? "").trim();
  const showSnap = snap !== "" && snap !== live;
  const basis = a.ads_basis === "daily" ? "a day" : a.ads_basis === "monthly" ? "a month" : "in total";
  const label = "w-[62px] shrink-0 text-[11.5px] font-bold text-hint dark:text-[#8a8175]";
  return (
    <div className="mt-2 space-y-2 rounded-xl2 bg-panel/70 px-3 py-2.5 text-[12.5px] dark:bg-white/[0.04]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
        <span className={label}>Price</span>
        {priced.length === 0 ? (
          <span className="text-muted dark:text-[#a89f93]">No price set yet — ask the administration before it goes live.</span>
        ) : priced.map((p, i) => (
          <span key={`${p.units}-${p.label}-${i}`} className="inline-flex items-baseline gap-1 rounded-full bg-surface px-2.5 py-1 font-semibold text-ink dark:bg-white/[0.07] dark:text-[#f4f1ea]">
            {p.label} <span className="tabular-nums">{rs(p.price)}</span>
            {p.units > 1 && p.price != null && (
              <span className="font-normal text-muted dark:text-[#a89f93]">· {rs(p.price / p.units)} each</span>
            )}
          </span>
        ))}
      </div>
      {a.ads_budget != null && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={label}>Budget</span>
          <span className="font-semibold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(a.ads_budget)}</span>
          <span className="text-muted dark:text-[#a89f93]">{basis}</span>
        </div>
      )}
      {a.final_name && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={label}>Name</span>
          <span className="font-semibold text-ink dark:text-[#f4f1ea]">{a.final_name}</span>
        </div>
      )}
      {live && (
        <div className="flex gap-x-2">
          <span className={`${label} pt-px`}>Brief</span>
          <p className="min-w-0 flex-1 whitespace-pre-line leading-relaxed text-ink dark:text-[#e7e2d8]">{live}</p>
        </div>
      )}
      {video && (
        <div className="flex gap-x-2">
          <span className="w-[62px] shrink-0 pt-px text-[11.5px] font-bold text-[#2f7a3d] dark:text-[#8fd39a]">Video</span>
          <p className="min-w-0 flex-1 whitespace-pre-line font-semibold leading-relaxed text-ink dark:text-[#f4f1ea]">{video}</p>
        </div>
      )}
      {showSnap && (
        <div className="flex gap-x-2">
          <span className={`${label} pt-px leading-tight`}>
            Earlier Brief
          </span>
          <p className="min-w-0 flex-1 whitespace-pre-line leading-relaxed text-muted dark:text-[#a89f93]">
            {snap}
            {!live && <span className="mt-0.5 block text-[11.5px] text-hint dark:text-[#8a8175]">The administration has since removed the brief.</span>}
          </p>
        </div>
      )}
    </div>
  );
}
