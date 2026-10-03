"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, CornerUpLeft, CheckCircle2, Loader2, Flag, Rocket } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

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
const STAGE: Record<string, string> = {
  product: "Product & upload", qc: "Quality check", video: "Video",
  social: "Social media", ads: "Ads",
};
const rs = (v: number | null | undefined) => (v == null ? "—" : "Rs " + Math.round(Number(v)).toLocaleString("en-PK"));
const day = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" })
  : "";

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

/* "Sent back by Qaswar: make it two videos" / "Sent back by Qaswar (no note)"
   — the wording hub_task_checkpoint stores — read back as who + what. */
const SENT_BACK = /^Sent back by (.+?)(?:: ([\s\S]+)| \(no note\))$/;

export default function MyWork() {
  const [rows, setRows] = useState<Task[]>([]);
  const [facts, setFacts] = useState<Record<string, ArticleFacts>>({});
  const [cps, setCps] = useState<Record<string, Checkpoint>>({});
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  /* The one send-back form that is open (an ads task + a step), its note, and
     the ads card waiting for "Yes, go live". */
  const [sb, setSb] = useState<{ task: string; stage: string } | null>(null);
  const [sbNote, setSbNote] = useState("");
  const [confirmLive, setConfirmLive] = useState<string | null>(null);

  /* Only the newest reply is drawn: an older load that lands late must not
     paint yesterday's buttons over the fresh ones. */
  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const my = ++reqId.current;
    const [{ data, error }, arts, cp] = await Promise.all([
      supabase.rpc("hub_my_work"),
      supabase.rpc("hub_my_articles"),
      supabase.rpc("hub_my_checkpoints"),
    ]);
    if (my !== reqId.current) return;
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
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

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

  async function act(t: Task, what: "submit" | "send_back") {
    const text = (note[t.task_id] ?? "").trim();
    const ok = what === "submit"
      ? await run(t.task_id, "hub_task_submit", { p_task_id: t.task_id, p_note: text })
      : await run(t.task_id, "hub_task_send_back", { p_task_id: t.task_id, p_reason: text });
    if (ok) setNote((n) => ({ ...n, [t.task_id]: "" }));
  }

  async function sendBack(t: Task, stage: string) {
    const ok = await run(`${t.task_id}:${stage}`, "hub_task_checkpoint",
      { p_task_id: t.task_id, p_stage: stage, p_note: sbNote.trim() || null });
    if (ok) { setSb(null); setSbNote(""); }
  }

  async function goLive(t: Task) {
    const ok = await run(t.task_id, "hub_task_go_live",
      { p_task_id: t.task_id, p_note: (note[t.task_id] ?? "").trim() || null });
    setConfirmLive(null);
    if (ok) setNote((n) => ({ ...n, [t.task_id]: "" }));
  }

  const open = rows.filter((r) => r.status === "open");
  /* "To do" counts what he can act on now, not what he is waiting for. */
  const actionable = open.filter((r) => !r.waiting_for);
  const done = rows.filter((r) => r.status !== "open").slice(0, 6);

  if (loading) {
    return <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted dark:text-[#a89f93]">
      <Loader2 size={14} className="animate-spin" /> Loading your work…</div>;
  }
  /* It used to hide itself when there was nothing assigned. Now it lives
     behind its own tab, so an empty tab has to say it is empty — a blank
     panel reads as a page that failed to load. */

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card dark:border-white/10 dark:bg-[#201c17]">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-bold text-ink dark:border-white/10 dark:text-[#f4f1ea] sm:px-5">
        <ClipboardList size={15} /> Your work
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
      </h2>

      {err && <p className="border-b border-line bg-danger-soft px-4 py-2.5 text-[12.5px] font-medium text-danger dark:border-white/10 sm:px-5">{err}</p>}

      {open.length === 0 ? (
        <p className="px-4 py-5 text-[13px] text-muted dark:text-[#a89f93] sm:px-5">
          Nothing waiting on you right now.
        </p>
      ) : open.map((t) => {
        /* H286: an open ads card gets the checkpoints and the Live button.
           With no checkpoint data (the function missing) it still shows Live —
           the database enforces the rule either way. */
        const isAds = t.stage === "ads" && !!t.article_id;
        const cp = isAds ? cps[t.task_id] : undefined;
        const waitingFor = cp?.waiting_for ?? [];
        const ready = waitingFor.length === 0;
        const back = t.returned_note ? SENT_BACK.exec(t.returned_note) : null;
        return (
        <div key={t.task_id} className="border-b border-line px-4 py-4 last:border-0 dark:border-white/[0.06] sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span className="text-[14px] font-bold text-ink dark:text-[#f4f1ea]">{t.title}</span>
              {t.code && (
                <span className="ml-2 text-[12.5px] text-muted dark:text-[#a89f93]">
                  {t.code} · {t.article_name}
                </span>
              )}
            </div>
            {/* While he is waiting, no clock is shown — the days belong to the
                man making the product, not to him. */}
            {/* An ads card that cannot go Live yet is waiting on other people,
                not sitting with Qaswar — so it says who, like the QC card does. */}
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${t.waiting_for || (isAds && !ready)
                ? "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber"
                : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
              {t.waiting_for ? `waiting for ${t.waiting_for}`
                : isAds && !ready ? `waiting for ${waitingFor.map((w) => w.split(" (")[0].split(" ")[0]).join(", ")}`
                : `with you ${t.held}`}
            </span>
          </div>

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

          {isAds && cp && cp.steps.length > 0 && (
            /* CHECKPOINTS (H286). Every earlier step, who did it and when, and a
               Send back on each finished one. The note is optional. */
            <div className="mt-3 overflow-hidden rounded-xl2 border border-line dark:border-white/10">
              <div className="flex items-center gap-1.5 border-b border-line bg-panel/60 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-hint dark:border-white/10 dark:bg-white/[0.03] dark:text-[#8a8175]">
                <Flag size={12} className="shrink-0" /> Checkpoints · send a step back
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
                        <div className="text-[13px] font-bold text-ink sm:w-[104px] sm:shrink-0 dark:text-[#f4f1ea]">{s.name}</div>
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
              </span>
            </>) : (<>
              <button disabled={!!busy || !ready} onClick={() => { setConfirmLive(t.task_id); setSb(null); }}
                className="flex items-center gap-1.5 rounded-full bg-[#2f7a3d] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40 dark:bg-[#8fd39a] dark:text-[#141414]">
                <Rocket size={13} /> Live
              </button>
              <span className="text-[11.5px] text-hint dark:text-[#8a8175]">
                {ready
                  ? "Live closes the article for everyone. Until then you can send any step back."
                  : `Live opens when everyone is done — waiting for ${waitingFor.join(", ")}.`}
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

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button disabled={busy === t.task_id || !(note[t.task_id] ?? "").trim()}
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
              {t.stage === "qc"
                ? "Write what you checked, or what is wrong if you are sending it back."
                : "Write what you did — it goes to the administration with your name on it."}
            </span>
          </div>
          </>)}
        </div>
        );
      })}

      {done.length > 0 && (
        <div className="bg-panel/60 px-4 py-3 dark:bg-white/[0.03] sm:px-5">
          <div className="mb-2 text-[11.5px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Recently submitted</div>
          <ul className="space-y-1.5">
            {done.map((t) => (
              <li key={t.task_id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                <CheckCircle2 size={12} className="shrink-0 text-success" />
                <span className="font-semibold text-ink dark:text-[#e7e2d8]">{t.code ?? "Task"}</span>
                {/* An ads card is closed by Live; with no final comment there is
                    no note to show, so say what happened instead. */}
                <span className="min-w-0 flex-1 truncate text-muted dark:text-[#a89f93]">
                  {t.stage === "ads" ? `Live${t.submit_note ? ` · ${t.submit_note}` : ""}` : t.submit_note}
                </span>
                {/* A clock figure would be a lie on a record written by hand —
                    the system never held that work. Say who wrote it instead. */}
                {t.recorded_by ? (
                  <span className="shrink-0 font-semibold text-periwinkle-strong dark:text-periwinkle">
                    recorded by {t.recorded_by}
                    {t.submitted_at ? ` · ${new Date(t.submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                  </span>
                ) : (
                  <span className="shrink-0 text-hint dark:text-[#8a8175]">took {t.held}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
  const when = (iso: string | null) => iso
    ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" })
    : "";
  return (
    <div className="mt-2 rounded-xl2 border border-line px-3 py-2.5 dark:border-white/10">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">
        What the team wrote · {list.length}
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
                    · sent {STAGE[c.stage ?? ""] ?? c.title ?? "it"} back to {c.to ?? "them"}
                  </span>
                ) : (
                  <span className="text-muted dark:text-[#a89f93]">· {STAGE[c.stage ?? ""] ?? c.title ?? "Task"}</span>
                )}
                {c.kind === "sent_back" && <span className="font-semibold text-red-700 dark:text-salmon">· sent it back</span>}
                {c.kind === "live" && <span className="font-semibold text-[#2f7a3d] dark:text-[#8fd39a]">· went live</span>}
                <span className="text-[11.5px] text-hint dark:text-[#8a8175]">· {when(c.at)}</span>
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
  return (
    <div className="mt-2 space-y-2 rounded-xl2 bg-panel/70 px-3 py-2.5 text-[12.5px] dark:bg-white/[0.04]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
        <span className="w-[62px] shrink-0 text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Price</span>
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
          <span className="w-[62px] shrink-0 text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Budget</span>
          <span className="font-semibold tabular-nums text-ink dark:text-[#f4f1ea]">{rs(a.ads_budget)}</span>
          <span className="text-muted dark:text-[#a89f93]">{basis}</span>
        </div>
      )}
      {a.final_name && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-[62px] shrink-0 text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Name</span>
          <span className="font-semibold text-ink dark:text-[#f4f1ea]">{a.final_name}</span>
        </div>
      )}
      {live && (
        <div className="flex gap-x-2">
          <span className="w-[62px] shrink-0 pt-px text-[11px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Brief</span>
          <p className="min-w-0 flex-1 whitespace-pre-line leading-relaxed text-ink dark:text-[#e7e2d8]">{live}</p>
        </div>
      )}
      {video && (
        <div className="flex gap-x-2">
          <span className="w-[62px] shrink-0 pt-px text-[11px] font-bold uppercase tracking-wide text-[#2f7a3d] dark:text-[#8fd39a]">Video</span>
          <p className="min-w-0 flex-1 whitespace-pre-line font-semibold leading-relaxed text-ink dark:text-[#f4f1ea]">{video}</p>
        </div>
      )}
      {showSnap && (
        <div className="flex gap-x-2">
          <span className="w-[62px] shrink-0 pt-px text-[11px] font-bold uppercase leading-tight tracking-wide text-hint dark:text-[#8a8175]">
            Earlier brief
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
