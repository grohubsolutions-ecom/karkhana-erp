"use client";

/* ---------------------------------------------------------------------------
   RETURNS, MONTH BY MONTH — PostEx and OwnEx (H298, 22 Oct 2026).

   The owner: "a graph of the returns from PostEx and OwnEx by dates, so he can
   compare the returns of any month with any month — are returns being managed
   or not."

   COUNTED BY THE MONTH A PARCEL WAS SENT, so a month is always compared with a
   month on the same parcels (hub_returns_trend). The return rate is
   returned ÷ (delivered + returned): parcels still on their way are left out of
   it, and the current month says how many those are — its rate is not final
   until they land. "Returned" includes parcels already on their way back.

   One y-axis only. Rate and count are two views of the same months, switched,
   never drawn on two scales at once.
--------------------------------------------------------------------------- */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { tc } from "@/lib/titleCase";

type Courier = "PostEx" | "OwnEx";
type Row = {
  month: string; courier: Courier;
  sent: number; delivered: number; returned: number; moving: number;
  failed: number; saved: number; lost: number;
};
type Trend = { ok: boolean; error?: string; from: string; to: string; today: string; rows: Row[] };
type Metric = "rate" | "count";

const COURIERS: Courier[] = ["PostEx", "OwnEx"];
/* Categorical slots, validated together (light + dark): PostEx keeps the blue
   and OwnEx the green the rest of the Hub already uses for them. */
const STROKE: Record<Courier, string> = {
  PostEx: "stroke-[#2a78d6] dark:stroke-[#3987e5]",
  OwnEx: "stroke-[#1baf7a] dark:stroke-[#199e70]",
};
const FILL: Record<Courier, string> = {
  PostEx: "fill-[#2a78d6] dark:fill-[#3987e5]",
  OwnEx: "fill-[#1baf7a] dark:fill-[#199e70]",
};
const DOT: Record<Courier, string> = {
  PostEx: "bg-[#2a78d6] dark:bg-[#3987e5]",
  OwnEx: "bg-[#1baf7a] dark:bg-[#199e70]",
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string, long = false) => {
  const [y, m] = ym.split("-").map(Number);
  const n = MON[m - 1] ?? ym;
  return long ? `${n} ${y}` : n;
};
const num = (v: number) => Math.round(v).toLocaleString("en-PK");
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);

type Stat = { sent: number; delivered: number; returned: number; moving: number; failed: number; saved: number; lost: number };
const zero = (): Stat => ({ sent: 0, delivered: 0, returned: 0, moving: 0, failed: 0, saved: 0, lost: 0 });
const add = (a: Stat, r: Stat): Stat => ({
  sent: a.sent + r.sent, delivered: a.delivered + r.delivered, returned: a.returned + r.returned,
  moving: a.moving + r.moving, failed: a.failed + r.failed, saved: a.saved + r.saved, lost: a.lost + r.lost,
});
/* Of the parcels that have landed, how many came back. */
const rateOf = (s: Stat) => (s.delivered + s.returned > 0 ? (100 * s.returned) / (s.delivered + s.returned) : null);
/* Of the parcels that failed once, how many were delivered in the end. */
const savedOf = (s: Stat) => (s.saved + s.lost > 0 ? (100 * s.saved) / (s.saved + s.lost) : null);

export default function ReturnsTrend() {
  const [data, setData] = useState<Trend | null>(null);
  const [err, setErr] = useState("");
  const [metric, setMetric] = useState<Metric>("rate");
  const [show, setShow] = useState<"Both" | Courier>("Both");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    let live = true;
    (async () => {
      const { data: d, error } = await supabase!.rpc("hub_returns_trend", { p_months: 13 });
      if (!live) return;
      if (error) { setErr(error.message); return; }
      const t = d as Trend;
      if (!t?.ok) { setErr(t?.error ?? "Could not read the returns."); return; }
      setData(t);
      const months = [...new Set(t.rows.map((r) => r.month))];
      /* Last full month against this month, to begin with. */
      setA(months[months.length - 2] ?? months[0] ?? "");
      setB(months[months.length - 1] ?? "");
    })();
    return () => { live = false; };
  }, []);

  const months = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.month))], [data]);
  const at = useMemo(() => {
    const m = new Map<string, Stat>();
    for (const r of data?.rows ?? []) m.set(`${r.month}|${r.courier}`, r);
    return (month: string, c: "Both" | Courier): Stat =>
      c === "Both" ? add(m.get(`${month}|PostEx`) ?? zero(), m.get(`${month}|OwnEx`) ?? zero()) : (m.get(`${month}|${c}`) ?? zero());
  }, [data]);
  const series: Courier[] = show === "Both" ? COURIERS : [show];
  const valueOf = (s: Stat) => (metric === "rate" ? rateOf(s) : s.sent > 0 || s.returned > 0 ? s.returned : null);
  const current = months[months.length - 1];

  if (err) {
    return (
      <p className="mt-3 flex items-start gap-2 rounded-card border border-red-300 bg-red-50 p-3 text-[13px] text-red-800">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />{err}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-10 text-[13px] text-muted dark:text-[#a89f93]">
        <Loader2 size={16} className="animate-spin" /> Reading the returns…
      </p>
    );
  }

  const settling = at(current, show);

  return (
    <div className="mt-3 rounded-card border border-line bg-surface p-3.5 md:p-4 dark:border-white/[0.06] dark:bg-[#201c17]">
      {/* ---------------------------------------------------------- filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="What to show" className="inline-flex rounded-full bg-panel p-1 dark:bg-white/[0.05]">
          {([["rate", "Return rate"], ["count", "Returns"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={metric === k} onClick={() => setMetric(k)}
              className={`h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition ${metric === k
                ? "bg-ink text-white dark:bg-white dark:text-[#141414]" : "text-muted hover:text-ink dark:text-[#a89f93] dark:hover:text-white"}`}>
              {label}
            </button>
          ))}
        </div>
        <select value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Courier"
          className="h-10 rounded-full border border-line bg-surface px-3 text-[16px] font-semibold text-ink outline-none md:h-9 md:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white">
          <option value="Both">Both couriers</option>
          <option value="PostEx">PostEx</option>
          <option value="OwnEx">OwnEx</option>
        </select>
        {/* legend — identity never by colour alone: the line ends are labelled too */}
        <div className="ml-auto flex items-center gap-3 text-[12px] font-semibold text-muted dark:text-[#a89f93]">
          {series.map((c) => (
            <span key={c} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${DOT[c]}`} />{c}</span>
          ))}
        </div>
      </div>

      <Chart months={months} series={series} at={at} valueOf={valueOf} metric={metric}
        current={current} hover={hover} setHover={setHover} />

      <p className="mt-1 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">
        By the month the parcel was sent. {metric === "rate"
          ? "Return rate = returned ÷ (delivered + returned); “returned” includes parcels already on their way back."
          : "Returns = parcels returned or on their way back."}{" "}
        {settling.moving > 0 && <>{monthName(current, true)} is still settling — {num(settling.moving)} parcels are on their way, so its figure can still move.</>}
      </p>

      {/* ------------------------------------------------------ month vs month */}
      <Compare months={months} a={a} b={b} setA={setA} setB={setB} at={at} current={current} />
    </div>
  );
}

/* ------------------------------------------------------------------- chart */
function Chart({ months, series, at, valueOf, metric, current, hover, setHover }: {
  months: string[]; series: Courier[];
  at: (m: string, c: "Both" | Courier) => Stat;
  valueOf: (s: Stat) => number | null; metric: Metric; current: string;
  hover: number | null; setHover: (i: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const H = 230, L = 40, R = 92, T = 14, B = 28;
  const pw = w - L - R, ph = H - T - B;
  const vals = series.flatMap((c) => months.map((m) => valueOf(at(m, c)))).filter((v): v is number => v != null);
  const top = metric === "rate"
    ? Math.max(10, Math.ceil(Math.max(0, ...vals) / 10) * 10)
    : Math.max(10, niceCeil(Math.max(0, ...vals)));
  const ticks = [0, top / 2, top];
  const x = (i: number) => L + (months.length <= 1 ? pw / 2 : (i * pw) / (months.length - 1));
  const y = (v: number) => T + ph - (v / top) * ph;
  const fmt = (v: number) => (metric === "rate" ? `${Math.round(v)}%` : num(v));
  /* Line-end labels, pushed apart so two lines ending close never print over
     each other. */
  const ends = series.map((c) => {
    const pts = months.map((m, i) => ({ i, v: valueOf(at(m, c)) })).filter((p) => p.v != null);
    const e = pts[pts.length - 1];
    return e ? { c, x: x(e.i) + 9, y: y(e.v as number) + 4, text: `${c} ${fmt(e.v as number)}` } : null;
  }).filter((e): e is { c: Courier; x: number; y: number; text: string } => !!e).sort((p, q) => p.y - q.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;

  function pick(clientX: number) {
    const el = box.current;
    if (!el || months.length === 0) return;
    const rx = clientX - el.getBoundingClientRect().left;
    const i = Math.round(((rx - L) / Math.max(1, pw)) * (months.length - 1));
    setHover(Math.min(months.length - 1, Math.max(0, i)));
  }

  return (
    <div ref={box} className="relative mt-3 select-none" style={{ height: H }}
      onMouseMove={(e) => pick(e.clientX)} onMouseLeave={() => setHover(null)}
      onTouchStart={(e) => pick(e.touches[0].clientX)} onTouchMove={(e) => pick(e.touches[0].clientX)}>
      <svg width={w} height={H} role="img" aria-label={`${metric === "rate" ? "Return rate" : "Returns"} by month, ${series.join(" and ")}`}>
        {/* recessive grid and the one axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + pw} y1={y(t)} y2={y(t)} className="stroke-black/[0.08] dark:stroke-white/10" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="fill-current text-[10.5px] text-muted dark:text-[#a89f93]">{fmt(t)}</text>
          </g>
        ))}
        {months.map((m, i) => (months.length <= 8 || i % 2 === (months.length - 1) % 2) && (
          <text key={m} x={x(i)} y={H - 8} textAnchor="middle" className="fill-current text-[10.5px] text-muted dark:text-[#a89f93]">
            {monthName(m)}{m.endsWith("-01") || i === 0 ? ` ${m.slice(2, 4)}` : ""}
          </text>
        ))}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ph} className="stroke-black/25 dark:stroke-white/30" strokeWidth={1} />
        )}
        {series.map((c) => {
          const pts = months.map((m, i) => ({ i, m, v: valueOf(at(m, c)) }));
          const done = pts.filter((p) => p.v != null && p.m !== current);
          const last = pts.filter((p) => p.v != null);
          const path = (list: typeof pts) => list.map((p, k) => `${k ? "L" : "M"}${x(p.i)},${y(p.v as number)}`).join(" ");
          const cur = pts.find((p) => p.m === current && p.v != null);
          const prev = done[done.length - 1];
          const end = ends.find((e) => e.c === c);
          return (
            <g key={c}>
              <path d={path(done)} fill="none" className={STROKE[c]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* the month still settling: dashed, it is not final */}
              {cur && prev && (
                <path d={`M${x(prev.i)},${y(prev.v as number)} L${x(cur.i)},${y(cur.v as number)}`} fill="none"
                  className={STROKE[c]} strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" />
              )}
              {last.map((p) => (
                <circle key={p.m} cx={x(p.i)} cy={y(p.v as number)} r={hover === p.i ? 5 : 4}
                  className={`${FILL[c]} stroke-surface dark:stroke-[#201c17]`} strokeWidth={2} />
              ))}
              {end && (
                <text x={end.x} y={end.y} className="fill-current text-[11px] font-semibold text-ink dark:text-[#f4f1ea]">
                  {end.text}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && months[hover] && (
        <div className="pointer-events-none absolute top-1 z-10 w-[190px] rounded-xl2 border border-line bg-surface px-3 py-2 text-[12px] shadow-lg dark:border-white/10 dark:bg-[#2a251f]"
          style={{ left: Math.min(Math.max(0, x(hover) - 95), w - 190) }}>
          <div className="font-bold text-ink dark:text-[#f4f1ea]">
            {monthName(months[hover], true)}{months[hover] === current ? " · still settling" : ""}
          </div>
          {series.map((c) => {
            const s = at(months[hover], c);
            return (
              <div key={c} className="mt-1 flex items-start gap-1.5 text-ink dark:text-[#e7e2d8]">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[c]}`} />
                <span>
                  <b>{c}</b> {pct(rateOf(s))} · {num(s.returned)} back of {num(s.sent)} sent
                  {s.moving > 0 ? ` · ${num(s.moving)} on the way` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number) {
  if (v <= 10) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

/* ---------------------------------------------------------- month vs month */
function Compare({ months, a, b, setA, setB, at, current }: {
  months: string[]; a: string; b: string; setA: (m: string) => void; setB: (m: string) => void;
  at: (m: string, c: "Both" | Courier) => Stat; current: string;
}) {
  const opts = [...months].reverse();   // newest first
  const sel = "h-10 rounded-full border border-line bg-surface px-3 text-[16px] font-semibold text-ink outline-none md:h-9 md:text-[13px] dark:border-white/10 dark:bg-white/[0.06] dark:text-white";
  return (
    <section className="mt-4 border-t border-line pt-3 dark:border-white/[0.06]">
      <h3 className="text-[13.5px] font-bold text-ink dark:text-[#f4f1ea]">{tc("Compare two months")}</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-muted dark:text-[#a89f93]">
        <select value={a} onChange={(e) => setA(e.target.value)} aria-label="First month" className={sel}>
          {opts.map((m) => <option key={m} value={m}>{monthName(m, true)}</option>)}
        </select>
        <span>against</span>
        <select value={b} onChange={(e) => setB(e.target.value)} aria-label="Second month" className={sel}>
          {opts.map((m) => <option key={m} value={m}>{monthName(m, true)}{m === current ? " (so far)" : ""}</option>)}
        </select>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead className="text-left text-[11.5px] text-muted dark:text-[#a89f93]">
            <tr>
              <th className="py-1.5 pr-2 font-semibold">Courier</th>
              <th className="px-2 font-semibold">Return rate</th>
              <th className="px-2 font-semibold">Change</th>
              <th className="px-2 font-semibold">Came back</th>
              <th className="px-2 font-semibold">Sent</th>
              <th className="pl-2 font-semibold">Saved after a failed try</th>
            </tr>
          </thead>
          <tbody>
            {(["PostEx", "OwnEx", "Both"] as const).map((c) => {
              const sa = at(a, c), sb = at(b, c);
              const ra = rateOf(sa), rb = rateOf(sb);
              const d = ra != null && rb != null ? rb - ra : null;
              return (
                <tr key={c} className="border-t border-line align-top dark:border-white/[0.06]">
                  <td className="py-2 pr-2 font-bold text-ink dark:text-[#f4f1ea]">
                    <span className="flex items-center gap-1.5">
                      {c !== "Both" && <span className={`h-2.5 w-2.5 rounded-full ${DOT[c]}`} />}
                      {c === "Both" ? "Both" : c}
                    </span>
                  </td>
                  <Pair a={pct(ra)} b={pct(rb)} strong />
                  <td className="px-2 py-2"><Delta d={d} /></td>
                  <Pair a={num(sa.returned)} b={num(sb.returned)} />
                  <Pair a={num(sa.sent)} b={num(sb.sent)} />
                  <Pair a={`${pct(savedOf(sa))}${sa.failed ? ` of ${num(sa.failed)}` : ""}`} b={`${pct(savedOf(sb))}${sb.failed ? ` of ${num(sb.failed)}` : ""}`} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-muted dark:text-[#a89f93]">
        Each cell is {monthName(a, true)} → {monthName(b, true)}. Fewer coming back is better: a lower return rate is
        returns being managed. “Saved” is the parcels that failed once and were delivered in the end.
        {b === current || a === current ? ` ${monthName(current, true)} is not finished yet.` : ""}
      </p>
    </section>
  );
}

const Pair = ({ a, b, strong }: { a: string; b: string; strong?: boolean }) => (
  <td className="px-2 py-2 tabular-nums">
    <span className="text-muted dark:text-[#a89f93]">{a}</span>
    <span className="px-1 text-hint">→</span>
    <span className={strong ? "font-bold text-ink dark:text-[#f4f1ea]" : "font-semibold text-ink dark:text-[#e7e2d8]"}>{b}</span>
  </td>
);

/* Better or worse, with a word and an arrow — never colour alone. */
function Delta({ d }: { d: number | null }) {
  if (d == null) return <span className="text-hint">—</span>;
  if (Math.abs(d) < 0.5) {
    return <span className="inline-flex items-center gap-1 font-semibold text-muted dark:text-[#a89f93]"><Minus size={13} /> About the same</span>;
  }
  const better = d < 0;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-bold ${better
      ? "bg-success-soft text-[#2f7a3d]" : "bg-danger-soft text-[#8d3328]"}`}>
      {better ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}
      {better ? "Better" : "Worse"} {Math.abs(d).toFixed(1)} pts
    </span>
  );
}
