/** Live undo chain: one row per action, green only when Stripe verifies the refund. Shown by get_chain. */
import { useCallTool, useToolContext } from "mcp-use/react";
import { useEffect, useState } from "react";
import "./view.css";

const POLL_MS = 2000;
const DONE_STATES = new Set(["closed", "kept", "redone", "expired"]);

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
  verified: "Refund verified",
  failed: "Failed",
  kept: "Kept",
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 });

const utcTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";

export default function LiveChain() {
  const tool = useToolContext<"get_chain">();
  const getChain = useCallTool("get_chain");
  const [latest, setLatest] = useState(tool.status === "ready" ? tool.toolOutput : undefined);

  const initial = tool.status === "ready" ? tool.toolOutput : undefined;
  const chain = latest ?? initial;
  const chainId = chain?.chain_id;
  const done = chain ? DONE_STATES.has(chain.state) : false;

  // Poll get_chain so rows turn green as Stripe verifies each refund.
  useEffect(() => {
    if (!chainId || done) return;
    const timer = window.setInterval(() => {
      getChain
        .callTool({ chain_id: chainId })
        .then((r) => setLatest(r.structuredContent))
        .catch(() => {
          /* keep the last good state; the next poll retries */
        });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [chainId, done]); // eslint-disable-line react-hooks/exhaustive-deps

  if (tool.status === "pending") return <div className="lc lc-muted">Loading the chain…</div>;
  if (tool.status === "error" || !chain) return <div className="lc lc-muted">Couldn't load this chain.</div>;

  const verified = chain.actions.filter((a) => a.stripe_verified).length;

  return (
    <div className="lc">
      <header className="lc-head">
        <div>
          <div className="lc-title">Undo chain</div>
          <div className="lc-sub">
            {chain.actions.length} actions · {usd(chain.money_at_risk)} at risk
            {chain.window_ends_at ? ` · window closes ${utcTime(chain.window_ends_at)}` : ""}
          </div>
        </div>
        <div className="lc-progress" aria-label={`${verified} of ${chain.actions.length} verified`}>
          {verified}/{chain.actions.length}
        </div>
      </header>

      <ol className="lc-rows">
        {chain.actions.map((a) => (
          <li key={a.action_id} className={`lc-row ${a.stripe_verified ? "lc-ok" : a.state === "failed" ? "lc-bad" : ""}`}>
            <span className="lc-dot" aria-hidden="true" />
            <span className="lc-what">
              <span className="lc-summary">{a.summary}</span>
              <span className="lc-route">{a.route ? ROUTE_LABEL[a.route] ?? a.route : "Not planned"}</span>
            </span>
            <span className="lc-amount">{a.amount ? usd(a.amount) : "—"}</span>
            <span className="lc-state">{STATE_LABEL[a.state] ?? a.state}</span>
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
