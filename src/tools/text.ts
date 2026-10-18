// Plain-text answers for every tool, sent as the first content block next to structuredContent (and the widget), so
// clients without structured output or MCP App support still get the answer and know what to do next.
import { humanDate, money } from "../orchestrator/copy.js";
import type { ChainSummary, GetChainOutput, LogIntentOutput, ReviewOutput, Reversibility, UndoOutput } from "../types.js";

const dateRange = (d: { start: string; end?: string } | undefined) => (d ? `${humanDate(d.start)}${d.end ? ` to ${humanDate(d.end)}` : ""}` : "no dates");

export function textLogIntent(r: LogIntentOutput): string {
  const lines = [`Task logged. task_id: ${r.task_id}. task_email: ${r.task_email}.`];
  const c = r.intent_check;
  if (c?.status === "disagrees") {
    lines.push(`Your intent differs from the human's words: you logged ${c.understood}, they said ${c.said}. The human is being asked which is right.`);
    lines.push("Next: wait, then call log_intent again with the same idempotency_key to get their answer. Don't book yet.");
    return lines.join("\n");
  }
  if (c?.status === "confirmed_human") lines.push(`The human confirmed their own words (${c.said}). Use the constraints in this result${r.constraints?.dates ? ` (${dateRange(r.constraints.dates)})` : ""}.`);
  if (c?.status === "confirmed_agent") lines.push(`The human confirmed your version (${c.understood}).`);
  if (c?.status === "agrees") lines.push("Your dates and budget match the human's words.");
  lines.push("Next: use task_email as the contact email for every booking and signup in this task, then call review(task_id) before you tell the human you are done.");
  return lines.join("\n");
}

export function textReversibility(r: Reversibility): string {
  const how = { cancel_refund: "can be cancelled for a refund", change: "can be changed", return: "can be returned", correct_message: "can be corrected with a follow-up", none: "can no longer be undone" }[r.kind];
  const window = r.window_ends_at ? `The window closes ${humanDate(r.window_ends_at)} (${r.window_ends_at}).` : "There is no deadline.";
  const cost = r.cost_to_reverse > 0 ? ` Reversing costs ${money(r.cost_to_reverse)}.` : " Reversing is free.";
  const refund = r.refundable ? "A full refund is available." : "A refund is not guaranteed.";
  const next = !r.refundable || r.kind === "none" ? "Next: check the details against the intent before you act." : "Next: go ahead if it matches the intent.";
  return `This action ${how}. ${refund}${cost} ${window} Rule: ${r.rule}\n${next}`;
}

export function textReview(r: ReviewOutput): string {
  if (r.status === "clean") return `Review: clean. Nothing that reached this task's email conflicts with the intent (${r.evidence_seen.emails} emails, ${r.evidence_seen.stripe_events} Stripe events, ${r.evidence_seen.actions} actions seen).\nNext: you can tell the human you are done.`;
  const lines = [`Review: ${r.mismatches.length} mismatch${r.mismatches.length === 1 ? "" : "es"} found.`];
  for (const m of r.mismatches) lines.push(`- ${m.action_id}: ${m.field} is ${String(m.actual)}, the intent says ${String(m.expected)}.`);
  lines.push(r.fixable_now.length ? `You can undo these yourself now: ${r.fixable_now.join(", ")}.` : "Nothing here is free for you to undo yourself; it goes to the human.");
  lines.push(`Chains: ${r.chain_ids.join(", ")}.`);
  lines.push(r.fixable_now.length ? "Next: call undo with the ids in fixable_now, then get_chain(chain_id). Don't tell the human you are done yet." : "Next: call get_chain(chain_id). Proxy texts the human; don't tell them everything is done.");
  return lines.join("\n");
}

export function textUndo(r: UndoOutput): string {
  const lines = [];
  lines.push(r.accepted.length ? `Undo started for: ${r.accepted.join(", ")}.` : "Nothing was undone by you.");
  if (r.requires_human.length) lines.push(`These need the human (a cost, a negotiation, or your session ended): ${r.requires_human.join(", ")}. Proxy texts them.`);
  lines.push(r.chain_id ? `Next: call get_chain("${r.chain_id}") to follow the refunds; they count only once Stripe shows them.` : "Next: call review(task_id) to see what is left.");
  return lines.join("\n");
}

export function textGetChain(r: GetChainOutput, recovered: Record<string, number> = {}, corrected: string[] = [], via = "Stripe"): string {
  const total = r.actions.reduce((t, a) => t + a.amount, 0);
  const back = r.actions.reduce((t, a) => t + (a.stripe_verified ? (recovered[a.action_id] ?? 0) : 0), 0);
  const lines = [`Chain ${r.chain_id}: ${r.state}. ${money(back)} of ${money(total)} recovered and confirmed in ${via}.`];
  for (const a of r.actions) {
    const mark = a.stripe_verified || corrected.includes(a.action_id) ? "[done]" : "[open]";
    const detail = a.stripe_verified ? `refunded ${money(recovered[a.action_id] ?? a.amount)}${(recovered[a.action_id] ?? a.amount) < a.amount ? ` of ${money(a.amount)}` : ""}, confirmed` : corrected.includes(a.action_id) ? "correction sent" : a.state;
    lines.push(`${mark} ${a.summary} (${a.amount ? money(a.amount) : "no charge"}): ${detail}`);
  }
  lines.push(r.window_ends_at ? `Window closes ${r.window_ends_at}.` : "No deadline.");
  if (r.rounds) lines.push(`Negotiation rounds used: ${r.rounds}.`);
  if (r.redo) lines.push(`Redo: ${r.redo.instruction}`);
  const next = { wait_for_human: "the human is deciding; check again later", redo: "book what the redo instruction says, using the task email", stop: "nothing more to do", retry: "retry shortly", fix_now: "fix the input and call again" }[r.next_action];
  lines.push(`Next: ${next}.`);
  return lines.join("\n");
}

export function textListChains(chains: ChainSummary[]): string {
  if (!chains.length) return "No open chains. Next: nothing to do. If you think a late confirmation should have opened one, call review(task_id).";
  const lines = [`${chains.length} chain${chains.length === 1 ? "" : "s"}, most urgent first:`];
  for (const c of chains) lines.push(`- ${c.chain_id} (${c.task_id}): ${c.state}, ${money(c.money_at_risk)} at risk, ${c.action_count} actions, starting with ${c.root_summary}${c.window_ends_at ? `, window closes ${c.window_ends_at}` : ""}`);
  lines.push(`Next: call get_chain("${chains[0]!.chain_id}").`);
  return lines.join("\n");
}
