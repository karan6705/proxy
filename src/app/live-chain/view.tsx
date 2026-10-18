/** Live undo chain: one row per action, green with a check only when Stripe confirms the refund. Shown by get_chain. */
import { useCallTool, useToolContext } from "mcp-use/react";
import { useEffect, useState } from "react";
import "./view.css";

const POLL_MS = 2000;
const DONE_STATES = new Set(["closed", "kept", "redone", "expired"]);

/** View-only data get_chain sends in result _meta (see LiveChainMeta in src/tools/handlers.ts). */
interface LiveMeta {
  server_now: string;
  windows: Record<string, string | null>;
  recovered: Record<string, number>;
  /** Message actions whose correction was sent; done with no money. */
  corrected?: string[];
  /** Short row titles. */
  labels?: Record<string, string>;
  /** Last few agent-to-agent lines. */
  protocol?: Array<{ at: string; actor: string; text: string }>;
}

const ROUTE_LABEL: Record<string, string> = {
  self_serve: "Self-serve cancel",
  reversal_protocol: "Agent to agent",
  email_support: "Support email",
  correction: "Correction email",
  stripe_dispute: "Stripe dispute",
};

const STATE_LABEL: Record<string, string> = {
  found: "Waiting",
  planned: "Planned",
  requested: "Asked the merchant",
  accepted: "Agreed",
  countered: "Negotiating",
  denied: "Denied",
  no_agent: "Needs you",
  refund_pending: "Refund pending",
  verified: "Confirmed in Stripe",
  failed: "Failed",
  kept: "Kept",
};

const CHAIN_LABEL: Record<string, string> = {
  detected: "Mistake found",
  alerted: "Waiting for the human",
  undoing: "Undoing",
  partial: "Partly undone",
  reversed: "Reversed",
  redo_requested: "Reversed · agent rebooking",
  redone: "Reversed and rebooked",
  kept: "Kept",
  expired: "Expired",
  closed: "Closed",
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 });

function countdown(ms: number): string {
  if (ms <= 0) return "Window closed";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  return `${h > 0 ? `${h}h ` : ""}${String(m).padStart(h > 0 ? 2 : 1, "0")}m ${String(sec).padStart(2, "0")}s left`;
}

function asMeta(value: unknown): LiveMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<LiveMeta>;
  return typeof v.server_now === "string" && v.windows && v.recovered ? (v as LiveMeta) : undefined;
}

const WHO: Record<string, string> = { proxy: "Proxy", hotel_agent: "Hotel agent", stripe: "Stripe" };

export default function LiveChain() {
  const tool = useToolContext<"get_chain">();
  const getChain = useCallTool("get_chain");
  const initial = tool.status === "ready" ? tool.toolOutput : undefined;
  const [latest, setLatest] = useState(initial);
  const [meta, setMeta] = useState<LiveMeta | undefined>(tool.status === "ready" ? asMeta(tool.meta) : undefined);
  // Offset between the server's (simulated) clock and this browser, so the countdown ticks locally.
  const [offsetMs, setOffsetMs] = useState(0);
  const [tick, setTick] = useState(Date.now());

  const chain = latest ?? initial;
  const chainId = chain?.chain_id;
  const done = chain ? DONE_STATES.has(chain.state) : false;

  useEffect(() => {
    if (tool.status === "ready" && !meta) setMeta(asMeta(tool.meta));
  }, [tool.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (meta) setOffsetMs(Date.parse(meta.server_now) - Date.now());
  }, [meta?.server_now]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll get_chain so rows turn green as Stripe confirms each refund.
  useEffect(() => {
    if (!chainId || done) return;
    const timer = window.setInterval(() => {
      getChain
        .callTool({ chain_id: chainId })
        .then((r) => {
          setLatest(r.structuredContent);
          const m = asMeta((r as { _meta?: unknown })._meta);
          if (m) setMeta(m);
        })
        .catch(() => {
          /* keep the last good state; the next poll retries */
        });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [chainId, done]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  if (tool.status === "pending") return <div className="lc lc-muted">Loading the chain…</div>;
  if (tool.status === "error" || !chain) return <div className="lc lc-muted">Couldn't load this chain.</div>;

  const now = tick + offsetMs;
  const corrected = new Set(meta?.corrected ?? []);
  const isDone = (a: { action_id: string; stripe_verified: boolean }) => a.stripe_verified || corrected.has(a.action_id);
  const total = chain.actions.reduce((sum, a) => sum + a.amount, 0);
  const recovered = chain.actions.reduce((sum, a) => sum + (a.stripe_verified ? (meta?.recovered[a.action_id] ?? 0) : 0), 0);
  const pct = total > 0 ? Math.min(100, Math.round((recovered / total) * 100)) : 0;
  const openWindows = chain.actions
    .filter((a) => !isDone(a))
    .map((a) => meta?.windows[a.action_id])
    .filter((w): w is string => typeof w === "string")
    .map((w) => Date.parse(w))
    .sort((a, b) => a - b);
  const deadline = openWindows[0];
  const protocol = meta?.protocol ?? [];

  return (
    <div className="lc">
      <header className="lc-head">
        <div className="lc-eyebrow">Proxy · undo chain · {CHAIN_LABEL[chain.state] ?? chain.state}</div>
        <div className="lc-big">
          <span className="lc-big-label">Recovered</span>
          <span className="lc-big-value">{usd(recovered)}</span>
          <span className="lc-big-of">of {usd(total)}</span>
        </div>
        <div className="lc-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="lc-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="lc-sub">
          <span>
            {chain.actions.filter(isDone).length} of {chain.actions.length} done · confirmed in Stripe
          </span>
          {deadline !== undefined && !done && <span className="lc-countdown">{countdown(deadline - now)}</span>}
        </div>
      </header>

      <ol className="lc-rows">
        {chain.actions.map((a) => {
          const ok = isDone(a);
          const got = meta?.recovered[a.action_id];
          return (
            <li key={a.action_id} className={`lc-row ${ok ? "lc-ok" : a.state === "failed" || a.state === "denied" ? "lc-bad" : ""}`}>
              <span className="lc-mark" aria-hidden="true">{ok ? "✓" : ""}</span>
              <span className="lc-what">
                <span className="lc-summary" title={a.summary}>{meta?.labels?.[a.action_id] ?? a.summary}</span>
                <span className="lc-route">{a.route ? (ROUTE_LABEL[a.route] ?? a.route) : "Not planned"}</span>
              </span>
              <span className="lc-right">
                <span className="lc-amount">
                  {a.stripe_verified && got !== undefined && got !== a.amount ? `${usd(got)} of ${usd(a.amount)}` : a.amount ? usd(a.amount) : "—"}
                </span>
                <span className="lc-state">{corrected.has(a.action_id) ? "Correction sent" : (STATE_LABEL[a.state] ?? a.state)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {protocol.length > 0 && (
        <section className="lc-a2a" aria-label="Agent to agent">
          <div className="lc-a2a-title">Agent to agent</div>
          {protocol.map((p, i) => (
            <div key={`${p.at}-${i}`} className={`lc-bubble lc-from-${p.actor}`}>
              <span className="lc-who">{WHO[p.actor] ?? p.actor}</span>
              <span>{p.text.replace(/^[^:]+: /, "")}</span>
            </div>
          ))}
        </section>
      )}

      <footer className="lc-foot">
        {chain.next_action === "wait_for_human" && "Waiting for the human: UNDO ALL, PICK or KEEP."}
        {chain.next_action === "redo" && "Reversed. The agent is rebooking with the corrected intent."}
        {chain.next_action === "stop" &&
          (chain.state === "redone" ? "Reversed and rebooked for the right dates." : `Chain ${CHAIN_LABEL[chain.state] ?? chain.state}.`)}
      </footer>
    </div>
  );
}
