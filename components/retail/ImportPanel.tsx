"use client";
/* Import — one drop zone, six Nimbus file types.
 *
 * The old app had a single Import screen that worked out what you had dropped
 * on it from the header row, and that is right: the person exporting from
 * Nimbus is not thinking about which of six importers they need, they are
 * thinking "here is today's file". Every rule below is ported from that app;
 * the reasoning lives in lib/nimbus.ts next to the code it justifies.
 *
 * The three things worth knowing before changing anything here:
 *
 *   1. The sales file cannot tell card from JazzCash. Both arrive as "Other
 *      Payment". They are resolved afterwards by the Non-cash payments file,
 *      matched on store + date + exact time — so that file has to be dropped
 *      AFTER the sales it refers to, or there is nothing to tag.
 *
 *   2. The bill-wise sale report has no item codes. It is refused here in
 *      words, and refused again by a trigger in the database.
 *
 *   3. line_hash is a plain joined string, not a digest, and its shape is
 *      load-bearing for compatibility with rows already in the old database.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, X, Info } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { btnPrimary, btnGhost } from "@/components/Modal";
import {
  DataTable, Pill, Select, PreviewNote, SourceNote,
  money, unitForBranch, useIsPhone, useBranches, type Col,
} from "@/components/retail/kit";
import { readGrid, findHeaderRow, dropRepeatedHeaders } from "@/lib/readGrid";
import {
  detectKind, KIND_LABEL, normStore, withLineHashes, looksLikeMopCell,
  parseSalesRows, parseExpenseRows, parsePaymentRows, parseCommRows,
  type NimbusKind, type SaleRow, type ExpenseRow, type PaymentRow, type CommRow,
} from "@/lib/nimbus";

type Branch = { id: number; name: string; chain: string | null; nimbus_name: string | null };

/** WHAT ONE LANDED FILE DID, for the phone result log.
 *
 *  `tone` is how the run READS, not whether it errored, and `quiet` is how a
 *  figure is printed. A file whose lines were all already in is the line_hash
 *  guard doing exactly its job — the best possible outcome of a second drop —
 *  so that count is printed in the same ink as the rows that landed and never
 *  in red. Somebody who reads "skipped" as "failed" re-exports the file and
 *  starts hunting for a problem that does not exist. */
type ImportResult = {
  file: string;
  kind: NimbusKind;
  tone: "good" | "warn";
  figures: { l: string; v: string; quiet?: boolean }[];
  note: string;
};

/** The uploader itself — drop zone, preview, checks and the write.
 *
 *  It lives in a component rather than on a page of its own because there IS no
 *  Import page any more. The owner's point, and he is right: a file is uploaded
 *  while you are looking at the screen whose figures are short. Sales, Non-cash
 *  and Expenses each open this; sending somebody to a separate screen to do it
 *  was a step that existed for the code's convenience and nobody else's.
 *
 *  One component, three callers — not three copies. The parse rules, the
 *  bill-wise guard, the PDF column check and the duplicate protection are the
 *  same wherever it is opened from, which is the only way they stay the same.
 *
 *  `onDone` lets the screen that opened it reload once something has landed. */
export function ImportPanel({ onDone }: { onDone?: () => void } = {}) {
  const phone = useIsPhone();
  const fileRef = useRef<HTMLInputElement>(null);
  /* The shared branch cache, which now carries nimbus_name for this screen —
     rather than this screen fetching the same nine rows again on every mount. */
  const { branches } = useBranches();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [kind, setKind] = useState<NimbusKind>("unknown");
  const [needBranch, setNeedBranch] = useState(false);
  const [pickBranch, setPickBranch] = useState("");
  const [fatal, setFatal] = useState("");
  const [warn, setWarn] = useState<string[]>([]);
  /* Whether the grid was READ from the file or INFERRED from a page layout.
     Its own state, not an entry in `warn`: that array is rebuilt from scratch
     by the parse-warning effect below every time the parsed rows change, which
     silently swallowed this notice the moment the file finished parsing — the
     one moment it most needs to be on screen. */
  const [inferred, setInferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  /* THE RESULT LOG — one card per file that has actually landed.
     A day's import is not one file, it is four or five dropped in sequence:
     sales, then the account transactions, then the non-cash payments that tag
     the sales just loaded, then the commission master. This screen kept a
     single line of prose and threw it away the moment the next file was
     chosen, so halfway through there was nothing on screen saying which files
     were already in — and the only safe thing to do when you cannot remember
     is drop them all again. The log is what makes that unnecessary, so it
     deliberately survives Clear: only Clear log empties it. */
  const [results, setResults] = useState<ImportResult[]>([]);

  /* Chunk-by-chunk progress. A sales file goes up 400 lines at a time, and on
     a phone on mobile data that is a minute during which the only feedback was
     a button reading "Working…" — indistinguishable from a page that has died,
     and the natural response to a dead page is to tap Import again, which
     writes a second import batch. `total` of 0 means "counting, length not
     known yet" and draws an indeterminate bar. */
  const [prog, setProg] = useState<{ done: number; total: number; what: string } | null>(null);

  function addResult(r: Omit<ImportResult, "file" | "kind">) {
    setResults((prev) => [{ file: fileName, kind, ...r }, ...prev]);
    /* The screen that opened this reloads — the figures it is showing are the
       ones the file just changed. */
    onDone?.();
  }

  const resolveBranch = useCallback((ns: string): number | null => {
    const b = branches.find((x) => x.nimbus_name && normStore(x.nimbus_name) === ns);
    return b ? b.id : null;
  }, [branches]);

  const forceBid = needBranch && pickBranch ? Number(pickBranch) : null;

  /* ── parse, per kind ─────────────────────────────────────────────────── */
  const sales = useMemo(() => {
    if (!rows.length || (kind !== "sales_multi" && kind !== "sales_single")) return null;
    if (kind === "sales_single" && forceBid == null) return null;
    return parseSalesRows(rows, kind === "sales_single" ? forceBid : null, resolveBranch);
  }, [rows, kind, forceBid, resolveBranch]);

  const expenses = useMemo(() => {
    if (!rows.length || (kind !== "expense_multi" && kind !== "expense_single")) return null;
    if (kind === "expense_single" && forceBid == null) return null;
    return parseExpenseRows(rows, kind === "expense_single" ? forceBid : null, resolveBranch);
  }, [rows, kind, forceBid, resolveBranch]);

  const payments = useMemo(() => {
    if (!rows.length || kind !== "payments") return null;
    return parsePaymentRows(rows);
  }, [rows, kind]);

  const comm = useMemo(() => {
    if (!rows.length || kind !== "comm_master") return null;
    return parseCommRows(rows);
  }, [rows, kind]);

  async function onFile(f: File) {
    setFatal(""); setWarn([]); setDone(null); setRows([]); setNeedBranch(false); setPickBranch("");
    setInferred(false);
    setFileName(f.name);

    /* CSV, Excel or PDF — see lib/readGrid.ts. Everything below this line is
       unchanged: the parsers have always worked on a grid of strings and do not
       care which of the three it came out of. */
    let grid;
    try {
      /* The predicate is what lets a PDF keep its empty columns: its headings
         ARE its columns. See lib/readGrid.ts. */
      grid = await readGrid(f, (cells) => detectKind(cells.map((c) => c.trim())) !== "unknown");
    } catch (e) {
      setFatal(`Could not open that file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const all = grid.rows.filter((r) => r.some((c) => c !== ""));
    if (!all.length) { setFatal("Could not read any rows from that file."); return; }

    /* WHERE THE TABLE STARTS. A Nimbus CSV begins with its header row; an Excel
       export usually has a title above it and a PDF always has a report
       heading. Rather than guess which row looks like headers, ask detectKind:
       the first row it recognises IS the header row. */
    const hi = findHeaderRow(all, (h) => detectKind(h) !== "unknown");
    if (hi < 0) {
      setFatal(grid.format === "pdf"
        ? "No Nimbus column headings were found in that PDF. The table may not have come through — try the CSV or Excel export of the same report."
        : "This does not look like a Nimbus export — no Store, Account, Payment Mode or Item Code column was found.");
      setKind("unknown");
      return;
    }

    /* Everything above the header row is the report's own title block. A
       multi-page PDF reprints its headings, and those would arrive as a sale
       with the item code "Item Code" if they were left in. */
    const hdr = all[hi].map((h) => h.trim());
    const parsed = dropRepeatedHeaders(all.slice(hi), hdr).filter((r) => r.length > 1);
    const k = detectKind(hdr);
    setKind(k);

    /* A PDF has no table in it — only text at coordinates — so the rows and
       columns below were worked out from where the words sit on the page. For a
       machine-generated report that is reliable, and it is still inference, so
       it is said out loud rather than hidden. The summary underneath shows the
       line count and the totals; those are what to check it against. */
    setInferred(!grid.exact);

    /* THE PDF COLUMN GUARD, for sales files only.
       parseSalesRows finds the payment-mode cell and then reads the money
       columns by OFFSET from it — retail price is twelve to its left. For CSV
       and Excel the grid IS the file, so the offsets are whatever the report
       says. For a PDF the columns were inferred, and one column too many or too
       few would not fail: it would read quantity where the discount should be
       and import a plausible wrong number for every line.

       Every sale row carries a payment mode, so a row without one means the
       split is wrong. Refused outright — there is a CSV of the same report. */
    if (!grid.exact && (k === "sales_multi" || k === "sales_single")) {
      const data = parsed.slice(1).filter((r) => r.join("").trim());
      const bad = data.filter((r) => !r.some(looksLikeMopCell)).length;
      if (bad) {
        setFatal(`The columns in this PDF could not be read reliably — ${bad.toLocaleString()} of ${data.length.toLocaleString()} rows have no payment mode where one is expected. A sales file's figures are read by column position, so importing this could file the wrong amount against every line. Use the CSV or Excel export of the same report.`);
        setRows([]);
        return;
      }
    }

    /* The bill-wise guard. A bill-wise sale report has one row per receipt and
       therefore no item code. Commissions are per item and cannot be rebuilt
       from it, and uploading it on top of an item-wise day doubles that day's
       sales. Refused here in words, and again by a trigger in Postgres. */
    if (k === "sales_multi" || k === "sales_single") {
      const ci = hdr.indexOf("Item Code");
      const anyCode = ci >= 0 && parsed.slice(1).some((r) => (r[ci] ?? "").trim() !== "" && !/^total/i.test((r[ci] ?? "").trim()));
      if (!anyCode) {
        setFatal("This is the BILL-WISE sale report — it has no item codes. Commissions are calculated per item and cannot be built from it, and uploading it on top of an item-wise day doubles that day's sales. In Nimbus, choose the item-wise (line-item) sale export instead.");
        return;
      }
    }

    setRows(parsed);
    if (k === "sales_single" || k === "expense_single") setNeedBranch(true);
  }

  /* Whichever kind is loaded, these drive the summary strip. */
  const summary = useMemo(() => {
    if (sales) {
      const ok = sales.parsed.filter((p) => p.branch_id);
      return [
        { l: "Line items", v: sales.parsed.length.toLocaleString() },
        { l: "Matched to a shop", v: ok.length.toLocaleString() },
        { l: "Shop-days", v: String(new Set(ok.map((p) => p.branch_id + "|" + p.sale_date)).size) },
        { l: "Total sales", v: money(ok.reduce((t, p) => t + p.sales_amount, 0)) },
      ];
    }
    if (expenses) {
      const exp = expenses.parsed.filter((p) => p.txn_type === "expense").reduce((t, p) => t + p.amount, 0);
      const inc = expenses.parsed.filter((p) => p.txn_type === "income").reduce((t, p) => t + p.amount, 0);
      return [
        { l: "Transactions", v: expenses.parsed.length.toLocaleString() },
        { l: "Total expense", v: money(exp) },
        { l: "Misc income", v: money(inc) },
        { l: "Date range", v: `${expenses.minD ?? "—"} → ${expenses.maxD ?? "—"}` },
      ];
    }
    if (payments) {
      const modes = new Map<string, number>();
      payments.forEach((p) => modes.set(p.modeRaw, (modes.get(p.modeRaw) ?? 0) + 1));
      return [
        { l: "Payments in file", v: payments.length.toLocaleString() },
        { l: "Card", v: String(payments.filter((p) => p.pm === "meezan_card").length) },
        { l: "JazzCash", v: String(payments.filter((p) => p.pm === "jazzcash").length) },
        { l: "Modes seen", v: [...modes.keys()].slice(0, 2).join(", ") || "—" },
      ];
    }
    if (comm) return [
      { l: "Items", v: comm.length.toLocaleString() },
      { l: "With a rate", v: String(comm.filter((c) => c.percentage > 0 || c.commission > 0).length) },
      { l: "—", v: "" }, { l: "—", v: "" },
    ];
    return null;
  }, [sales, expenses, payments, comm]);

  /* Unknown store names, surfaced before anything is written. */
  useEffect(() => {
    const w: string[] = [];
    if (sales?.unknownStores.size) w.push(`${sales.unknownStores.size} store name(s) not recognised: ${[...sales.unknownStores].slice(0, 4).join(", ")}. Those lines will be skipped — set the shop's Nimbus name on the Branches screen first.`);
    if (expenses?.unknown.size) w.push(`${expenses.unknown.size} store name(s) not recognised: ${[...expenses.unknown].slice(0, 4).join(", ")}. Those rows will be skipped.`);
    if (payments && branches.length) {
      const un = [...new Set(payments.map((p) => p.store))].filter((s) => !resolveBranch(normStore(s)));
      if (un.length) w.push(`Store name(s) not recognised: ${un.slice(0, 4).join(", ")}.`);
    }
    setWarn(w);
  }, [sales, expenses, payments, branches, resolveBranch]);

  /* THE UPLOAD LOG IS HOW THE DASHBOARD KNOWS WHAT IS MISSING.
     It records that a given shop-day HAS been uploaded, for a given KIND of
     file. Absence is the signal — the reminder lists every shop-day with no
     stamp and names the file still owed.

     So the kind written here has to match the kind the reminder looks for, for
     all three: sales, expenses, noncash. Stamping only "sales" (which is what
     this screen used to do) leaves the other two permanently unstamped, and a
     reminder that reports every day as missing forever is a reminder people
     switch off. `unit` is the branch id as text, which is what the dashboard
     keys on too. */
  async function stampUploads(pairs: { branch_id: number | null; date: string | null }[], kind: string) {
    if (!supabase || !pairs.length) return;
    /* The unit is unitForBranch(), not the branch id. Top Shop exports as one
       combined all-stores file, so its six branches share the unit "topshop";
       each Fashion Collection shop is "b<id>". This is the old app's key, kept
       so the migrated three years of rows still line up with what is written
       from today. Stamping the bare branch id orphans all of them and makes
       the dashboard report one missing Top Shop file as six missing days. */
    const stamps = [...new Set(
      pairs.filter((p) => p.date).map((p) => {
        const b = branches.find((x) => x.id === Number(p.branch_id));
        const u = unitForBranch(b as never);
        return u ? `${u}|${p.date}` : "";
      }).filter(Boolean)
    )].map((k) => {
      const i = k.indexOf("|");
      return { unit: k.slice(0, i), log_date: k.slice(i + 1), kind };
    });
    if (stamps.length) {
      await supabase.from("retail_upload_log")
        .upsert(stamps, { onConflict: "unit,log_date,kind", ignoreDuplicates: true });
    }
  }

  /* ── run ─────────────────────────────────────────────────────────────── */
  async function run() {
    if (!supabase) return;
    setBusy(true); setFatal(""); setDone(null);
    try {
      if (sales) {
        const ok = sales.parsed.filter((p) => p.branch_id);
        if (!ok.length) { setFatal("No line matched a branch — nothing to import."); setBusy(false); return; }
        const total = ok.reduce((t, p) => t + p.sales_amount, 0);
        const { data: batch, error: be } = await supabase.from("retail_import_batches")
          .insert({ filename: fileName, row_count: sales.parsed.length, total_sales: total })
          .select("id").single();
        if (be) throw be;
        const batchId = (batch as { id: number }).id;

        const hashed = withLineHashes(ok);
        let inserted = 0;
        setProg({ done: 0, total: hashed.length, what: "Uploading lines" });
        for (let i = 0; i < hashed.length; i += 400) {
          const chunk = hashed.slice(i, i + 400).map(({ _store, _ns, ...rest }: SaleRow & { line_hash: string }) => {
            void _store; void _ns;
            return { ...rest, import_batch_id: batchId };
          });
          const { data, error } = await supabase.from("retail_sale_lines")
            .upsert(chunk, { onConflict: "line_hash", ignoreDuplicates: true }).select("id");
          if (error) throw error;
          inserted += (data as unknown[] | null)?.length ?? 0;
          /* Lines SENT, not lines inserted — the bar is how far through the file
             we are, and the duplicate guard means those two are different
             numbers on any re-import. */
          setProg({ done: Math.min(i + 400, hashed.length), total: hashed.length, what: "Uploading lines" });
        }
        const skipped = hashed.length - inserted;
        await supabase.from("retail_import_batches").update({ inserted_count: inserted, skipped_count: skipped }).eq("id", batchId);

        setProg({ done: hashed.length, total: hashed.length, what: "Stamping the upload log" });
        await stampUploads(ok.map((p) => ({ branch_id: p.branch_id, date: p.sale_date })), "sales");

        setDone(`${inserted.toLocaleString()} new line${inserted === 1 ? "" : "s"} added.` +
          (skipped ? ` ${skipped.toLocaleString()} were already in — that is the duplicate guard working, not an error.` : ""));
        addResult({
          tone: "good",
          figures: [
            { l: "New lines added", v: inserted.toLocaleString() },
            { l: "Already in — duplicate guard", v: skipped.toLocaleString(), quiet: true },
          ],
          note: skipped
            ? "Those lines were already in, matched on line_hash. Dropping the same file twice changes nothing, which is what that number means."
            : "Every line in the file was new.",
        });
      }

      else if (expenses) {
        const ok = expenses.parsed.filter((p) => p.branch_id);
        if (!ok.length) { setFatal("No row matched a branch — nothing to import."); setBusy(false); return; }
        /* The RPC, not a client-side delete-then-insert. It scopes its own
           delete from the payload and lands on a unique dedupe_key, which is
           what makes re-importing an overlapping range safe. */
        const { data, error } = await supabase.rpc("retail_import_nimbus_expenses", {
          p_branch_ids: [...new Set(ok.map((p) => p.branch_id))],
          p_min_date: expenses.minD,
          p_max_date: expenses.maxD,
          p_rows: ok.map(({ _store, _ns, ...rest }: ExpenseRow) => { void _store; void _ns; return rest; }),
          p_adv_rows: [],
        });
        if (error) throw error;
        setProg({ done: ok.length, total: ok.length, what: "Stamping the upload log" });
        await stampUploads(ok.map((p) => ({ branch_id: p.branch_id, date: p.expense_date })), "expenses");
        const res = data as { inserted?: number; expenses_replaced?: number } | null;
        setDone(`${(res?.inserted ?? 0).toLocaleString()} expense rows imported. ${(res?.expenses_replaced ?? 0).toLocaleString()} previously-imported rows in the same range were replaced, so an overlapping re-import cannot double anything.`);
        addResult({
          tone: "good",
          figures: [
            { l: "Rows imported", v: (res?.inserted ?? 0).toLocaleString() },
            { l: "Replaced in this range", v: (res?.expenses_replaced ?? 0).toLocaleString(), quiet: true },
          ],
          note: "Importing replaces previously-imported Nimbus expenses inside the file's own date range, so an overlapping re-import cannot double anything.",
        });
      }

      else if (payments) {
        const mapped = payments.map((p) => ({ ...p, bid: forceBid ?? resolveBranch(p.ns) })).filter((p) => p.bid);
        if (!mapped.length) { setFatal("No payment matched a branch."); setBusy(false); return; }
        const minD = mapped.reduce((a, p) => (a < p.date ? a : p.date), mapped[0].date);
        const maxD = mapped.reduce((a, p) => (a > p.date ? a : p.date), mapped[0].date);

        const key = new Map<string, string>();
        mapped.forEach((p) => key.set(`${p.bid}|${p.date}|${p.time}`, p.pm));

        const lines: { id: number; branch_id: number; sale_date: string; sale_time: string | null }[] = [];
        setProg({ done: 0, total: 0, what: "Reading the sales already imported" });
        /* THIS PAGER HAD NO `order by` AT ALL, AND IT IS DECIDING WHAT GETS
           TAGGED. Without a total order, LIMIT/OFFSET gives Postgres no
           obligation to return rows in the same sequence between two requests —
           so a line could be read twice, or skipped and then never tagged as
           card or JazzCash, leaving revenue sitting as "unclassified" with
           nothing to show it was missed. Every sibling read in this department
           carries that warning; this one was written without it.
           A keyset cursor on `id` fixes the correctness and the speed at once:
           it is a total order by construction, and it does not read and discard
           the rows it skips (measured 8 ms a page against 307 ms by offset). */
        let afterId = 0;
        for (;;) {
          const { data, error } = await supabase.from("retail_sale_lines")
            .select("id,branch_id,sale_date,sale_time").gte("sale_date", minD).lte("sale_date", maxD)
            .gt("id", afterId).order("id", { ascending: true }).limit(1000);
          if (error) throw error;
          const got = (data as typeof lines) ?? [];
          lines.push(...got);
          /* Total unknown while paging — there is no count query here and adding
             one would be a second round trip for a progress bar. */
          setProg({ done: lines.length, total: 0, what: "Reading the sales already imported" });
          if (got.length < 1000) break;
          afterId = Number(got[got.length - 1].id);
        }

        const byMode: Record<string, number[]> = {};
        lines.forEach((l) => {
          const m = key.get(`${l.branch_id}|${l.sale_date}|${l.sale_time ?? ""}`);
          if (m) (byMode[m] = byMode[m] ?? []).push(l.id);
        });
        const toTag = Object.values(byMode).reduce((t, a) => t + a.length, 0);
        setProg({ done: 0, total: toTag, what: "Tagging sale lines" });
        let updated = 0;
        for (const mode of Object.keys(byMode)) {
          const ids = byMode[mode];
          for (let i = 0; i < ids.length; i += 300) {
            const { error } = await supabase.from("retail_sale_lines")
              .update({ payment_method: mode }).in("id", ids.slice(i, i + 300));
            if (error) throw error;
            updated += Math.min(300, ids.length - i);
            setProg({ done: updated, total: toTag, what: "Tagging sale lines" });
          }
        }
        setProg({ done: toTag, total: toTag, what: "Stamping the upload log" });
        await stampUploads(mapped.map((p) => ({ branch_id: p.bid as number, date: p.date })), "noncash");
        setDone(updated === 0
          ? "No sale line matched. This file tags sales that are already imported, matched on shop + date + exact time — import that shop's sales first, then drop this again."
          : `${updated.toLocaleString()} sale lines tagged as card or JazzCash.`);
        addResult({
          /* Nothing matched is not an error and not a success — it is almost
             always the files dropped in the wrong order, so it reads amber and
             says which file to drop first. */
          tone: updated === 0 ? "warn" : "good",
          figures: [
            { l: "Sale lines tagged", v: updated.toLocaleString() },
            { l: "Payments in file", v: mapped.length.toLocaleString(), quiet: true },
          ],
          note: updated === 0
            ? "Nothing matched. This file only tags sales that are already in, on shop + date + exact time — import that shop's sales first, then drop this again."
            : "Matched on shop + date + exact time, which is the only way card and JazzCash can be told apart.",
        });
      }

      else if (comm) {
        let n = 0;
        setProg({ done: 0, total: comm.length, what: "Updating rates" });
        for (let i = 0; i < comm.length; i += 500) {
          const { error } = await supabase.from("retail_commission_master")
            .upsert(comm.slice(i, i + 500) as CommRow[], { onConflict: "item_code" });
          if (error) throw error;
          n += Math.min(500, comm.length - i);
          setProg({ done: n, total: comm.length, what: "Updating rates" });
        }
        setDone(`${n.toLocaleString()} commission rates updated.`);
        addResult({
          tone: "good",
          figures: [{ l: "Rates updated", v: n.toLocaleString() }],
          note: "Matched on item code, so re-uploading the master corrects rates rather than adding them again.",
        });
      }
    } catch (e) {
      setFatal((e as { message?: string })?.message ?? String(e));
    }
    setProg(null);
    setBusy(false);
    /* On a phone the result log and the error banner both sit up by the drop
       zone, while the Import button is halfway down the page. Without this the
       run ends with the progress bar simply vanishing from under the thumb and
       nothing on screen saying whether it worked — so go back to the top, where
       the answer is, with the box for the next file beside it. */
    if (phone) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* Clear takes the FILE away, not the log. Somebody clearing to drop the next
     file still needs to see which ones have already landed. */
  function reset() {
    setRows([]); setFileName(""); setFatal(""); setWarn([]); setDone(null); setNeedBranch(false); setPickBranch(""); setInferred(false);
    setProg(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  /* THE PHONE CARD FOR A SALES PREVIEW answers one question: did this line find
     its shop? So the shop is the title — it is the cell carrying the red
     "unmatched" pill — the item is the grey line under it, and the amount is the
     figure on the right. The receipt number is hidden on a phone: it is a raw
     POS reference nobody checks before pressing Import, and on a 390px card it
     costs a whole labelled pair that Date, Qty and MOP can use. It is still
     there on the computer, where the column is free. */
  const saleCols: Col<SaleRow>[] = [
    { head: "Date", muted: true, cell: (p) => p.sale_date },
    { head: "Shop", bold: true, phone: "title", cell: (p) => p.branch_id ? (branches.find((b) => b.id === p.branch_id)?.name ?? p._store) : <Pill tone="bad">{p._store || "unmatched"}</Pill> },
    { head: "Receipt", muted: true, phone: "hide", cell: (p) => p.receipt_txn || "—" },
    { head: "Item", phone: "meta", cell: (p) => p.item_name || p.item_code || "—" },
    { head: "Qty", right: true, cell: (p) => p.quantity },
    { head: "Amount", right: true, bold: true, cell: (p) => money(p.sales_amount) },
    { head: "MOP", cell: (p) =>
        p.payment_method === "credit" ? <Pill tone="bad">Credit (udhaar)</Pill>
        : p.payment_method === "cash" ? <Pill tone="good">Cash</Pill>
        : p.payment_method === "online" ? <Pill tone="info">Online</Pill>
        : <Pill tone="warn">{p.mop_raw || "unclassified"}</Pill> },
  ];
  /* Same reasoning: the shop is what you are checking matched, the category is
     what the money was, and the amount is the figure. */
  const expCols: Col<ExpenseRow>[] = [
    { head: "Date", muted: true, cell: (p) => p.expense_date },
    { head: "Shop", bold: true, phone: "title", cell: (p) => p.branch_id ? (branches.find((b) => b.id === p.branch_id)?.name ?? p._store) : <Pill tone="bad">{p._store}</Pill> },
    { head: "Type", cell: (p) => p.txn_type === "income" ? <Pill tone="good">Income</Pill> : <Pill tone="warn">Expense</Pill> },
    { head: "Category", phone: "meta", cell: (p) => p.category },
    { head: "Description", muted: true, cell: (p) => p.description ?? "—" },
    { head: "Paid via", muted: true, cell: (p) => p.paid_via },
    { head: "Amount", right: true, bold: true, cell: (p) => money(p.amount) },
  ];
  /* This table has no right-aligned column, so the automatic card would have
     found no figure for the right-hand slot and buried the store in a pair.
     "Becomes" is the answer the file exists to give — card or JazzCash — so it
     is the lead; Time stays a pair because the match is on the exact second and
     a wrong time is the usual reason nothing tags. */
  const payCols: Col<PaymentRow>[] = [
    { head: "Date", muted: true, phone: "meta", cell: (p) => p.date },
    { head: "Time", muted: true, cell: (p) => p.time },
    { head: "Store", bold: true, phone: "title", cell: (p) => p.store },
    { head: "Mode in file", cell: (p) => p.modeRaw || "—" },
    { head: "Becomes", phone: "lead", cell: (p) => p.pm === "jazzcash" ? <Pill tone="warn">JazzCash</Pill> : <Pill tone="info">Card</Pill> },
  ];
  /* No hints: the automatic card is already right here — item code identifies
     the row, the name is the grey line, and the percentage is the figure
     somebody opened the commission master to check. */
  const commCols: Col<CommRow>[] = [
    { head: "Item code", bold: true, cell: (c) => c.item_code },
    { head: "Item name", muted: true, cell: (c) => c.item_name ?? "—" },
    { head: "Retail", right: true, cell: (c) => money(c.retail_price) },
    { head: "Commission", right: true, cell: (c) => money(c.commission) },
    { head: "%", right: true, bold: true, cell: (c) => c.percentage },
  ];

  const readyCount = sales ? sales.parsed.filter((p) => p.branch_id).length
    : expenses ? expenses.parsed.filter((p) => p.branch_id).length
    : payments ? payments.length : comm ? comm.length : 0;

  const fcBranches = branches.filter((b) => (b.chain ?? "") !== "Topshop");

  /* ON A PHONE THERE IS NO DRAG, so the dashed box becomes the button itself.
     A drop target that is only a label is a dead end on the device the shop
     actually has in its hand. Above 767.98px this is the same <div> it always
     was, so the computer site is untouched. */
  const Zone = phone ? "button" : "div";

  /* THE ZONE SAID "DROP A NIMBUS EXPORT HERE" AND NOTHING HANDLED A DROP.
     Dragging a file onto it did what dragging a file onto any page does: the
     browser navigated away from the app and opened the file. An instruction the
     screen does not honour is worse than no instruction, so it is honoured now.
     `dragDepth` rather than a boolean: dragover/dragleave fire for every child
     element the pointer crosses, so a single flag flickers off the moment the
     cursor passes over the icon inside the zone. */
  const [dragDepth, setDragDepth] = useState(0);
  const dragProps = phone ? {} : {
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setDragDepth((d) => d + 1); },
    onDragOver:  (e: React.DragEvent) => { e.preventDefault(); },
    onDragLeave: (e: React.DragEvent) => { e.preventDefault(); setDragDepth((d) => Math.max(0, d - 1)); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragDepth(0);
      const f = e.dataTransfer?.files?.[0];
      /* One file at a time on purpose. A day's import is sales, then the
         account transactions, then the non-cash payments that tag the sales
         just loaded — the ORDER matters, and a handful dropped together would
         be imported in whatever order the browser hands them over. */
      if (f) onFile(f);
    },
  };

  return (
    <div>
      {rows.length > 0 && (
        <div className="mb-3 flex justify-end">
          <button onClick={reset} className={btnGhost}><X size={15} /> Clear</button>
        </div>
      )}

      {/* The picker sits OUTSIDE the zone. Inside it, a programmatic .click()
          would bubble back up to the zone's own handler and re-open the picker
          for ever — it is hidden either way, so where it lives changes nothing
          on screen. */}
      <input ref={fileRef} type="file"
        accept=".csv,.xlsx,.xls,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />

      <Zone
        {...(phone ? { type: "button" as const, onClick: () => fileRef.current?.click() } : {})}
        {...dragProps}
        className={`mt-5 w-full rounded-card border border-dashed p-6 text-center transition ${
          dragDepth > 0
            ? "border-ink bg-salmon-soft dark:border-white/40 dark:bg-white/[0.08]"
            : "border-line bg-surface dark:border-white/[0.12] dark:bg-[#201c17]"}`}>
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-panel text-ink dark:bg-white/[0.08] dark:text-white"><Upload size={22} /></span>
        <p className="mt-3 text-[14px] font-semibold text-ink dark:text-[#f4f1ea]">
          {phone ? "Tap to choose a Nimbus export" : dragDepth > 0 ? "Let go to read it" : "Drop a Nimbus export here"}
        </p>
        <p className="mt-1 text-[12.5px] text-muted dark:text-[#a89f93]">
          Sales, account transactions, non-cash payments or the commission master.
        </p>
        {/* The formats, said plainly. People were converting Excel files by hand
            because nothing on this screen said they did not have to. */}
        <p className="mt-1 text-[12px] text-hint dark:text-[#8a8175]">
          CSV, Excel (.xlsx / .xls) or PDF — the file says which report it is.
        </p>
        {phone
          /* A <button> inside a <button> is not valid HTML — the parser lifts it
             out of the card and the layout comes apart. The whole card is the
             control here, so this only has to look like the thing you tap. */
          ? <span className={`${btnPrimary} mx-auto mt-4`}>Choose file</span>
          : <button onClick={() => fileRef.current?.click()} className={`${btnPrimary} mx-auto mt-4`}>Choose file</button>}
        {fileName && (
          <p className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">
            <FileCheck2 size={14} /> {fileName}
            {kind !== "unknown" && <Pill tone="info">{KIND_LABEL[kind]}</Pill>}
          </p>
        )}
      </Zone>

      {fatal && (
        <div className="mt-4 flex gap-3 rounded-card border border-danger/30 bg-danger-soft p-4 dark:border-danger/30 dark:bg-danger/10">
          <AlertTriangle size={18} className="mt-0.5 flex-none text-danger" />
          <p className="text-[13px] font-medium leading-relaxed text-danger">{fatal}</p>
        </div>
      )}

      {needBranch && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-line bg-periwinkle-soft p-4 dark:border-white/[0.06] dark:bg-white/[0.04]">
          <Info size={18} className="flex-none text-ink dark:text-white" />
          <p className="flex-1 text-[12.5px] font-medium text-ink dark:text-[#e7e2d8]">
            This is a <strong>single-store</strong> file — it has no Store column, which is how a
            Fashion Collection shop exports. Which branch is it? (Top Shop comes as the combined
            all-stores export.)
          </p>
          <Select value={pickBranch} onChange={setPickBranch} className="max-md:w-full">
            <option value="">Pick a branch…</option>
            {fcBranches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
          </Select>
        </div>
      )}

      {/* A PDF HAS NO TABLE IN IT — only text at coordinates — so the rows and
          columns were worked out from where the words sit on the page. For a
          machine-generated report that is reliable, and it is still inference,
          so it is said out loud rather than hidden. The summary underneath is
          what to check it against. */}
      {inferred && rows.length > 0 && (
        <div className="mt-4 flex gap-3 rounded-card border border-line bg-periwinkle-soft p-4 dark:border-white/[0.06] dark:bg-white/[0.04]">
          <Info size={18} className="mt-0.5 flex-none text-ink dark:text-white" />
          <p className="text-[12.5px] font-medium leading-relaxed text-ink dark:text-[#e7e2d8]">
            This is a <strong>PDF</strong>, so the columns were worked out from the layout of the page
            rather than read from the file. Check the line count and the total below against the report
            before importing — the CSV or Excel export of the same report is exact and needs no checking.
          </p>
        </div>
      )}

      {warn.map((w, i) => (
        <div key={i} className="mt-3 flex gap-3 rounded-card border border-line bg-amber-soft p-4 dark:border-white/[0.06] dark:bg-amber/10">
          <AlertTriangle size={18} className="mt-0.5 flex-none text-amber-strong dark:text-amber" />
          <p className="text-[12.5px] font-medium leading-relaxed text-ink dark:text-[#e7e2d8]">{w}</p>
        </div>
      ))}

      {/* The computer keeps the one banner it had, word for word. The phone gets
          the log below instead, whose newest card says the same thing. */}
      {done && !phone && (
        <div className="mt-4 flex gap-3 rounded-card border border-success/30 bg-success-soft p-4 dark:border-success/30 dark:bg-success/10">
          <CheckCircle2 size={18} className="mt-0.5 flex-none text-success" />
          <p className="text-[13px] font-medium leading-relaxed text-ink dark:text-[#e7e2d8]">{done}</p>
        </div>
      )}

      {/* THE RESULT LOG, PHONE ONLY. One card per file that landed, newest
          first: what the file was taken to be, how many rows went in, and how
          many were already there. Cards rather than a table because the numbers
          are two or three per file and a table of three columns on a 390px
          screen is a table you scroll sideways for nothing. */}
      {phone && results.length > 0 && (
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-bold text-ink dark:text-[#f4f1ea]">Landed in this sitting</h3>
            <button onClick={() => setResults([])}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-muted dark:border-white/10 dark:bg-white/[0.06] dark:text-[#a89f93]">
              Clear log
            </button>
          </div>
          {results.map((r, i) => (
            <div key={i} className={`rounded-card border p-3.5 ${r.tone === "warn"
              ? "border-amber-strong/40 bg-amber-soft dark:border-white/[0.08] dark:bg-amber/10"
              : "border-success/30 bg-success-soft dark:border-success/30 dark:bg-success/10"}`}>
              <div className="flex items-start gap-2.5">
                {r.tone === "warn"
                  ? <AlertTriangle size={16} className="mt-0.5 flex-none text-amber-strong dark:text-amber" />
                  : <CheckCircle2 size={16} className="mt-0.5 flex-none text-success" />}
                <div className="min-w-0 flex-1">
                  <div className="break-all text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{r.file}</div>
                  <div className="mt-0.5 text-[12px] text-muted dark:text-[#a89f93]">{KIND_LABEL[r.kind]}</div>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-3 dark:border-white/[0.08]">
                {r.figures.map((f, j) => (
                  <div key={j} className="min-w-0">
                    {/* `quiet` is grey, never red. A duplicate skip is the
                        line_hash guard working — the best outcome a second drop
                        of the same file can have — and a red number there sends
                        somebody hunting for a problem that does not exist. */}
                    <dd className={`text-[18px] font-extrabold tabular-nums ${f.quiet ? "text-muted dark:text-[#a89f93]" : "text-ink dark:text-[#f4f1ea]"}`}>{f.v}</dd>
                    <dt className="text-[11px] uppercase leading-tight tracking-wide text-hint dark:text-[#8a8175]">{f.l}</dt>
                  </div>
                ))}
              </dl>
              <p className="mt-2.5 text-[12px] leading-relaxed text-muted dark:text-[#a89f93]">{r.note}</p>
            </div>
          ))}
        </div>
      )}

      {kind === "payments" && rows.length > 0 && (
        <SourceNote>
          A Nimbus sales export cannot tell card from JazzCash — both come through as &ldquo;Other
          Payment&rdquo;. This file is what resolves them, matched on <strong>shop + date + exact
          time</strong>. So the sales for these days have to be imported first; if nothing matches,
          that is the reason.
        </SourceNote>
      )}

      {summary && !fatal && (
        <>
          {/* The commission master only has two figures worth printing, so the
              other two are invisible spacers that keep the computer's 4-across
              row square. On a phone an invisible card is just 70px of blank
              scroll, so there it is dropped rather than hidden. */}
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(phone ? summary.filter((s) => s.l !== "—") : summary).map(({ l, v }, i) => (
              <div key={i} className={`rounded-card border border-line bg-surface p-4 dark:border-white/[0.06] dark:bg-[#201c17] ${l === "—" ? "opacity-0" : ""}`}>
                <div className="text-[19px] font-extrabold tabular-nums text-ink dark:text-[#f4f1ea]">{v}</div>
                <div className="text-[12px] font-medium text-muted dark:text-[#a89f93]">{l}</div>
              </div>
            ))}
          </div>

          {/* Reversed on a phone so Import is the first thing under the warnings
              rather than sitting below a caption about the preview, and full
              width because it is the one button on the screen that writes. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 max-md:flex-col-reverse max-md:items-stretch">
            <p className="text-[12.5px] text-muted dark:text-[#a89f93]">Showing the first 50 rows for checking.</p>
            <button onClick={run} disabled={busy || readyCount === 0} className={`${btnPrimary} max-md:w-full`}>
              {busy ? "Working…"
                : kind === "payments" ? `Classify ${readyCount.toLocaleString()} payments`
                : kind === "comm_master" ? `Update ${readyCount.toLocaleString()} rates`
                : `Import ${readyCount.toLocaleString()} rows`}
            </button>
          </div>

          {/* PROGRESS, PHONE ONLY — `phone &&`, not a media query, so nothing new
              can render at 1024px. See the note on `prog`: the old feedback was
              a button reading "Working…", which on mobile data is the same thing
              as a page that has died. */}
          {phone && busy && prog && (
            <div className="mt-3 rounded-card border border-line bg-surface p-3.5 dark:border-white/[0.06] dark:bg-[#201c17]">
              <div className="flex items-center justify-between gap-3 text-[12.5px] font-semibold text-ink dark:text-[#e7e2d8]">
                <span>{prog.what}…</span>
                <span className="tabular-nums text-muted dark:text-[#a89f93]">
                  {prog.total ? `${prog.done.toLocaleString()} / ${prog.total.toLocaleString()}` : prog.done.toLocaleString()}
                </span>
              </div>
              <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-panel dark:bg-white/[0.08]">
                <span className={`block h-full rounded-full bg-ink dark:bg-white ${prog.total ? "transition-[width]" : "animate-pulse"}`}
                  style={{ width: prog.total ? `${Math.min(100, Math.round((prog.done / prog.total) * 100))}%` : "35%" }} />
              </span>
              <p className="mt-2 text-[11.5px] text-hint dark:text-[#8a8175]">Keep this screen open until it finishes.</p>
            </div>
          )}

          {sales && <DataTable cols={saleCols} rows={sales.parsed.slice(0, 50)} minWidth={900} empty="Nothing to show." />}
          {expenses && <DataTable cols={expCols} rows={expenses.parsed.slice(0, 50)} minWidth={900} empty="Nothing to show." />}
          {payments && <DataTable cols={payCols} rows={payments.slice(0, 50)} minWidth={720} empty="Nothing to show." />}
          {comm && <DataTable cols={commCols} rows={comm.slice(0, 50)} minWidth={720} empty="Nothing to show." />}
        </>
      )}

      {(kind === "sales_multi" || kind === "sales_single") && rows.length > 0 && (
        <SourceNote>
          Every line carries a <strong>line_hash</strong> — shop, day, receipt, item, quantity,
          amount and time, joined. The column is unique, so dropping the same file in twice changes
          nothing; the second run reports the lines as skipped. Two identical items on one receipt
          are two real sales and get <code>|#2</code> appended rather than being collapsed.
        </SourceNote>
      )}
      {(kind === "expense_multi" || kind === "expense_single") && rows.length > 0 && (
        <SourceNote>
          Importing <strong>replaces</strong> previously-imported Nimbus expenses for these branches
          within the file&apos;s own date range, so an overlapping re-import is safe. The sign in the
          Amount column decides direction: negative is an expense, positive is misc income.
        </SourceNote>
      )}

      <PreviewNote />
    </div>
  );
}
