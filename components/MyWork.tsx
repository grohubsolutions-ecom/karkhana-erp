"use client";
import { useCallback, useEffect, useState } from "react";
import { ClipboardList, CornerUpLeft, CheckCircle2, Loader2 } from "lucide-react";
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
 * THE ONE EXTRA BUTTON belongs to the quality check alone. Abdul Rehman can
 * hand an article back to Hamza Mukhtar with a reason. Qaswar and Awais
 * deliberately cannot — that was asked for explicitly.
 */

/* WHAT HE NEEDS TO KNOW ABOUT THE ARTICLE (H279). The price the customer
   pays, every pack, the brief as it stands now, and — for the ads stage only —
   the budget. Never the cost: what we paid stays with the administration. */
type ArticleFacts = {
  article_id: string; code: string; name: string | null; final_name: string | null;
  retail_price: number | null; brief: string | null;
  packs: { label: string; units: number; price: number | null }[];
  ads_budget: number | null; ads_basis: string | null;
};
const rs = (v: number | null | undefined) => (v == null ? "—" : "Rs " + Math.round(Number(v)).toLocaleString("en-PK"));

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

export default function MyWork() {
  const [rows, setRows] = useState<Task[]>([]);
  const [facts, setFacts] = useState<Record<string, ArticleFacts>>({});
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) { setLoading(false); return; }
    const [{ data, error }, arts] = await Promise.all([
      supabase.rpc("hub_my_work"),
      supabase.rpc("hub_my_articles"),
    ]);
    if (error) setErr(error.message);
    setRows((data as Task[]) ?? []);
    /* A missing function (migration not run yet) must not take the work list
       down with it: the panel simply shows what it showed before. */
    if (!arts.error) {
      const map: Record<string, ArticleFacts> = {};
      for (const a of ((arts.data as ArticleFacts[]) ?? [])) map[a.article_id] = a;
      setFacts(map);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(t: Task, what: "submit" | "send_back") {
    if (!supabase) return;
    const text = (note[t.task_id] ?? "").trim();
    setBusy(t.task_id); setErr("");
    const { data, error } = what === "submit"
      ? await supabase.rpc("hub_task_submit", { p_task_id: t.task_id, p_note: text })
      : await supabase.rpc("hub_task_send_back", { p_task_id: t.task_id, p_reason: text });
    setBusy(null);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error) { setErr(error.message); return; }
    /* The database answers with a reason instead of throwing, so a refusal has
       to be read out of the reply and shown. Swallowing it looks like a button
       that does nothing. */
    if (res && res.ok === false) { setErr(res.error ?? "Refused."); return; }
    setNote((n) => ({ ...n, [t.task_id]: "" }));
    load();
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
      ) : open.map((t) => (
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
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${t.waiting_for
                ? "bg-amber-soft text-amber-strong dark:bg-white/[0.08] dark:text-amber"
                : "bg-panel text-muted dark:bg-white/[0.06] dark:text-[#a89f93]"}`}>
              {t.waiting_for ? `waiting for ${t.waiting_for}` : `with you ${t.held}`}
            </span>
          </div>

          {/* The reason is the instruction, so it is loud.
              "Back with you" rather than "Sent back", because this box now
              carries two different things: Rehman rejecting the work, and the
              administration undoing a submission that should not have been
              recorded. In the second case the man never sent anything, so
              "sent back" would be telling him something untrue about himself. */}
          {t.returned_note ? (
            <p className="mt-2 rounded-xl2 bg-salmon-soft px-3 py-2 text-[12.5px] text-red-900 dark:bg-white/[0.06] dark:text-salmon">
              <b>Back with you:</b> {t.returned_note}
            </p>
          ) : null}

          {t.article_id && facts[t.article_id] ? (
            /* A send-back writes "Sent back by <name>: <reason>" as the detail,
               and the reason is already in the red box above — so that detail is
               not passed on. Checked by its exact opening words, not by
               searching for the reason, which could appear in any brief. */
            <Facts a={facts[t.article_id]} detail={t.detail?.startsWith("Sent back by ") ? null : t.detail} />
          ) : !t.returned_note && t.detail ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted dark:text-[#a89f93]">{t.detail}</p>
          ) : null}

          {t.waiting_for ? (
            /* THE CHECK IS VISIBLE, NOT YET ACTIONABLE.
               The buttons would only be refused — there is no product to check
               until it is uploaded. He is told the moment it is. */
            <p className="mt-3 rounded-xl2 bg-panel px-3 py-2.5 text-[12.5px] leading-relaxed text-muted dark:bg-white/[0.04] dark:text-[#a89f93]">
              Coming to you. {t.waiting_for} is still uploading the product — you will get a
              notification the moment it is ready to check, and your time starts then.
            </p>
          ) : (<>
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
      ))}

      {done.length > 0 && (
        <div className="bg-panel/60 px-4 py-3 dark:bg-white/[0.03] sm:px-5">
          <div className="mb-2 text-[11.5px] font-bold uppercase tracking-wide text-hint dark:text-[#8a8175]">Recently submitted</div>
          <ul className="space-y-1.5">
            {done.map((t) => (
              <li key={t.task_id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                <CheckCircle2 size={12} className="shrink-0 text-success" />
                <span className="font-semibold text-ink dark:text-[#e7e2d8]">{t.code ?? "Task"}</span>
                <span className="min-w-0 flex-1 truncate text-muted dark:text-[#a89f93]">{t.submit_note}</span>
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
