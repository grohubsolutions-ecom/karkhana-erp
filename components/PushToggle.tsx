"use client";
/* "Ring my phone" toggle (H290). One control on the portal: turn the phone's
   push alerts on or off. It says plainly when the phone cannot do it, when the
   browser has blocked it, or when push is not set up on the server yet — so it
   never looks broken. */
import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import { currentState, enablePush, disablePush, type PushState } from "@/lib/push";

export default function PushToggle({ dark }: { dark?: boolean }) {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { currentState().then(setState); }, []);

  /* It is hidden entirely where it can do nothing — an unsupported browser —
     so the header is not cluttered with a dead control. Everything else
     (off / on / blocked / not-configured) is shown, because each is actionable
     or worth telling the person. */
  if (state === "loading" || state === "unsupported") return null;

  async function toggle() {
    setBusy(true); setErr("");
    if (state === "on") { setState(await disablePush()); setBusy(false); return; }
    const r = await enablePush();
    setState(r.state);
    if (r.error) setErr(r.error);
    setBusy(false);
  }

  const label =
    state === "on" ? "Phone alerts on"
    : state === "blocked" ? "Alerts blocked"
    : state === "not-configured" ? "Alerts coming soon"
    : "Ring my phone";
  const disabled = busy || state === "blocked" || state === "not-configured";
  const Icon = state === "on" ? BellRing : state === "blocked" ? BellOff : Bell;

  const base = dark
    ? "border-white/20 text-white/80 hover:bg-white/10"
    : "border-line text-ink hover:bg-panel dark:border-white/15 dark:text-white";
  const onCls = dark
    ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
    : "border-[#2f7a3d]/30 bg-success-soft text-[#2f7a3d] dark:border-[#8fd39a]/30 dark:bg-white/[0.08] dark:text-[#8fd39a]";

  return (
    <div className="relative">
      <button onClick={toggle} disabled={disabled}
        title={state === "blocked" ? "Turn notifications back on for this site in your browser settings"
             : state === "not-configured" ? "Phone alerts are not switched on by the office yet"
             : state === "on" ? "Tap to stop alerts on this phone" : "Tap to get the bell on this phone"}
        className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition disabled:opacity-60 ${
          state === "on" ? onCls : base}`}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
        <span className="whitespace-nowrap">{label}</span>
      </button>
      {err && (
        <p className="absolute right-0 top-full z-10 mt-1 w-56 rounded-xl2 border border-line bg-surface p-2 text-[11.5px] text-danger shadow-card dark:border-white/10 dark:bg-[#201c17]">
          {err}
        </p>
      )}
    </div>
  );
}
