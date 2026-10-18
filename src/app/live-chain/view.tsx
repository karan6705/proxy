/** Live undo chain: one row per action, green only when Stripe verifies the refund. Shown by get_chain. */
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
}

const ROUTE_LABEL: Record<string, string> = {
  self_serve: "Self-serve cancel",
  reversal_protocol: "Agent to agent",
  email_support: "Support email",
  correction: "Correction",
  stripe_dispute: "Stripe dispute",
};

const STATE_LABEL: Record<string, string> = {
  found: "Waiting",
  planned: "Planned",
  requested: "Requested",
  accepted: "Accepted",
  countered: "Countered",
  denied: "Denied",
  no_agent: "Emailing support",
  refund_pending: "Refund pending",
  verified: "Verified in Stripe",
  failed: "Failed",
  kept: "Kept",
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 });

function timeLeft(windowEnd: string | null | undefined, nowMs: number): string {
  if (!windowEnd) return "No deadline";
  const ms = Date.parse(windowEnd) - nowMs;
  if (ms <= 0) return "Window closed";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function asMeta(value: unknown): LiveMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<LiveMeta>;
  return typeof v.server_now === "string" && v.windows && v.recovered ? (v as LiveMeta) : undefined;
}

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

  // Poll get_chain so rows turn green as Stripe verifies each refund.
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
  const verified = chain.actions.filter((a) => a.stripe_verified).length;
  const recovered = chain.actions.reduce((sum, a) => sum + (a.stripe_verified ? (meta?.recovered[a.action_id] ?? 0) : 0), 0);

  return (
    <div className="lc">
      <header className="lc-head">
        <div>
          <div className="lc-title">Undo chain</div>
          <div className="lc-sub">
            {chain.actions.length} actions · {verified} verified in Stripe
          </div>
        </div>
        <div className="lc-totals">
          <div className="lc-total">
            <span className="lc-total-label">At risk</span>
            <span className="lc-total-value">{usd(chain.money_at_risk)}</span>
          </div>
          <div className="lc-total lc-total-ok">
            <span className="lc-total-label">Recovered</span>
            <span className="lc-total-value">{usd(recovered)}</span>
          </div>
        </div>
      </header>

      <ol className="lc-rows">
        {chain.actions.map((a) => (
          <li key={a.action_id} className={`lc-row ${isDone(a) ? "lc-ok" : a.state === "failed" ? "lc-bad" : ""}`}>
            <span className="lc-dot" aria-hidden="true" />
            <span className="lc-what">
              <span className="lc-summary">{a.summary}</span>
              <span className="lc-route">{a.route ? (ROUTE_LABEL[a.route] ?? a.route) : "Not planned"}</span>
            </span>
            <span className="lc-amount">{a.amount ? usd(a.amount) : "—"}</span>
            <span className="lc-time">{isDone(a) ? "Done" : timeLeft(meta?.windows[a.action_id], now)}</span>
            <span className="lc-state">{corrected.has(a.action_id) ? "Correction sent" : (STATE_LABEL[a.state] ?? a.state)}</span>
          </li>
        ))}
      </ol>

      <footer className="lc-foot">
        {chain.next_action === "wait_for_human" && "Waiting for the human's reply: UNDO ALL, PICK or KEEP."}
        {chain.next_action === "redo" && "Reversed. The agent is rebooking with the corrected intent."}
        {chain.next_action === "stop" && `Chain ${chain.state}.`}
        {chain.rounds > 0 && ` Negotiation rounds: ${chain.rounds}.`}
      </footer>
    </div>
  );
}
