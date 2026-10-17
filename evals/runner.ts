// Layer 1 (scripted) runner: replays a scenario on the simulated clock against one arm.
//
//   proxy  books through the real mock merchants, then runs compare, trace, rank and plan_undo, and, if the human
//          replies UNDO ALL, executes the plan against the merchants (the hotel through negotiate_step).
//   naive  the agent checking its own work: the same compare, but only against what the agent believes the task was
//          and only on the bookings it knows succeeded. No capture, no chains, no alert, no undo.
//
// No Stripe and no real clock: refunds are the amounts the merchants agreed. The orchestrator issues and verifies
// them through Payments, so Layer 1 reports "agreed", never "verified in Stripe".

import { MAX_ROUNDS, compare, negotiateStep, planUndo, rank, trace } from "../src/logic/index.js";
import type {
  Action,
  Chain,
  EvidencePacket,
  Mismatch,
  NegotiationState,
  PlanStep,
  ProxyProtocolMessage,
  RequestReversal,
} from "../src/types.js";
import type { Arm, FoundChain, FoundMismatch, Outcome, RunResult, Scenario } from "./scenario.js";
import { type SimWorld, simulateBookings } from "./sim.js";

const PROXY_ADDRESS = "proxy@tasks.proxy.example";

export const bookingId = (actionId: string): string => actionId.replace(/^act_/, "");

function foundMismatches(mismatches: Mismatch[]): FoundMismatch[] {
  return mismatches.map((m) => ({ action: bookingId(m.action_id), field: m.field }));
}

function foundChains(chains: Chain[]): FoundChain[] {
  return chains.map((chain) => ({
    actions: chain.action_ids.map(bookingId),
    root: bookingId(chain.root_action_id),
    money_at_risk: chain.money_at_risk,
  }));
}

function requestReversalFor(scenario: Scenario, chain: Chain, action: Action, mismatch: Mismatch | undefined, deadline: string): RequestReversal {
  const whyWrong = mismatch
    ? `Booked with ${mismatch.field} ${String(mismatch.actual)}, but the task needed ${String(mismatch.expected)}.`
    : "Booked in error.";
  const evidence: EvidencePacket = {
    intent: scenario.intent,
    order: action,
    confirmation_excerpt: `Booking ${action.ref}`,
    stripe_charge_id: null,
    mismatch: mismatch ?? { action_id: action.action_id, field: "dates", expected: null, actual: null },
    why_wrong: whyWrong,
    deadline,
  };
  return {
    type: "request_reversal",
    negotiation_id: `neg_${action.action_id}`,
    chain_id: chain.chain_id,
    action_id: action.action_id,
    round: 1,
    sent_at: scenario.now,
    order: { merchant: action.merchant, ref: action.ref, amount: action.amount },
    intent: { goal: scenario.intent.goal, constraints: scenario.intent.constraints },
    what_went_wrong: whyWrong,
    deadline,
    evidence,
  };
}

/** The orchestrator's loop for one Reversal Protocol negotiation: send, get the reply, ask negotiate_step. */
async function negotiate(
  world: SimWorld,
  scenario: Scenario,
  chain: Chain,
  action: Action,
  step: PlanStep,
  mismatch: Mismatch | undefined,
  log: (line: string) => void,
): Promise<{ outcome: Outcome; rounds: number; agreed: number }> {
  const agent = world.merchants.agent(action.merchant);
  if (!agent) {
    log(`${bookingId(action.action_id)}: no agent to negotiate with`);
    return { outcome: "not_undone", rounds: 0, agreed: 0 };
  }
  const deadline = step.deadline ?? scenario.now;
  let state: NegotiationState = {
    negotiation_id: `neg_${action.action_id}`,
    chain_id: chain.chain_id,
    action_id: action.action_id,
    state: "requested",
    round: 1,
    push_backs_used: 0,
    deadline,
    order_amount: action.amount,
    last_counter: null,
  };
  let outgoing: ProxyProtocolMessage = requestReversalFor(scenario, chain, action, mismatch, deadline);
  let rounds = 1;
  const name = bookingId(action.action_id);

  for (let turn = 0; turn < MAX_ROUNDS + 3; turn += 1) {
    const reply = await agent.respond(outgoing, scenario.now);
    log(`${name}: Proxy ${outgoing.type} -> merchant ${reply.type}${reply.type === "counter" ? ` ${reply.kind} ${reply.amount}` : reply.type === "accept" ? ` ${reply.refund_amount}` : ""}`);
    const decision = negotiateStep(state, reply, scenario.intent.preferences);
    state = decision.next_state;
    rounds = Math.max(rounds, state.round);
    for (const ignored of decision.ignored_text) {
      log(`${name}: ignored untrusted text in "${ignored.field}"`);
    }
    if (!decision.outgoing) {
      break;
    }
    outgoing = decision.outgoing;
    if (outgoing.type === "ask_human") {
      log(`${name}: Proxy ask_human (the human decides)`);
      break;
    }
  }

  const order = world.merchants.getOrder(action.ref);
  switch (state.state) {
    case "refund_pending":
      return { outcome: "refund_agreed", rounds, agreed: order?.refund_amount ?? 0 };
    case "human_decision":
      return { outcome: "asked_human", rounds, agreed: 0 };
    default:
      return { outcome: "not_undone", rounds, agreed: 0 };
  }
}

async function executeStep(
  world: SimWorld,
  scenario: Scenario,
  chain: Chain,
  step: PlanStep,
  mismatches: Mismatch[],
  result: RunResult,
): Promise<void> {
  const action = world.actions.find((a) => a.action_id === step.action_id) as Action;
  const id = bookingId(action.action_id);
  const log = (line: string): number => result.transcript.push(line);
  const mismatch = mismatches.find((m) => m.action_id === action.action_id);
  const merchants = world.merchants;
  const agree = (amount: number): void => {
    result.outcomes[id] = "refund_agreed";
    result.agreed_refund_total += amount;
  };

  if (step.option === "keep") {
    result.outcomes[id] = "kept";
    log(`${id}: nothing can still be fixed, the loss is accepted (${step.cost})`);
    return;
  }

  switch (step.route) {
    case "self_serve": {
      const cancel = await merchants.selfServeCancel(action.merchant, action.ref, scenario.now);
      log(`${id}: self-serve cancel ${cancel.ok ? `agreed a refund of ${cancel.refund_amount}` : `refused: ${cancel.reason}`}`);
      if (cancel.ok) {
        agree(cancel.refund_amount);
      } else {
        result.outcomes[id] = "not_undone";
      }
      return;
    }
    case "email_support": {
      if (!merchants.hasSupportDesk(action.merchant)) {
        result.outcomes[id] = "not_undone";
        log(`${id}: no support desk to email`);
        return;
      }
      const reply = await merchants.supportEmail(
        action.merchant,
        { from: PROXY_ADDRESS, subject: `Cancel ${action.ref}`, body: `Please cancel booking ${action.ref}. It was booked in error.` },
        scenario.now,
      );
      log(`${id}: support email ${reply.approved ? `approved a refund of ${reply.refund_amount}` : "declined"}`);
      if (reply.approved) {
        agree(reply.refund_amount);
      } else {
        result.outcomes[id] = "not_undone";
      }
      return;
    }
    case "reversal_protocol": {
      const negotiated = await negotiate(world, scenario, chain, action, step, mismatch, log);
      result.negotiation_rounds[id] = negotiated.rounds;
      result.outcomes[id] = negotiated.outcome;
      result.agreed_refund_total += negotiated.agreed;
      log(`${id}: negotiation ended ${negotiated.outcome} in ${negotiated.rounds} rounds`);
      return;
    }
    case "correction": {
      if (!merchants.hasSupportDesk(action.merchant)) {
        result.outcomes[id] = "not_undone";
        return;
      }
      const corrected = scenario.intent.constraints.dates?.start ?? "the right date";
      const reply = await merchants.supportEmail(
        action.merchant,
        { from: PROXY_ADDRESS, subject: `Correction to ${action.ref}`, body: `Please correct message ${action.ref}: the right date is ${corrected}.` },
        scenario.now,
      );
      result.outcomes[id] = reply.approved ? "corrected" : "not_undone";
      log(`${id}: correction ${reply.approved ? "acknowledged" : "not accepted"}`);
      return;
    }
    case "stripe_dispute":
      result.outcomes[id] = "kept";
      return;
  }
}

async function runProxy(scenario: Scenario): Promise<RunResult> {
  const world = await simulateBookings({
    task_id: scenario.intent.task_id,
    task_email: scenario.intent.task_email,
    bookings: scenario.bookings,
    hotel: scenario.hotel,
  });
  const mismatches = compare(scenario.intent, world.actions);
  const chains = rank(trace(scenario.intent, world.actions, mismatches), scenario.now);

  const result: RunResult = {
    scenario_id: scenario.id,
    arm: "proxy",
    mismatches: foundMismatches(mismatches),
    chains: foundChains(chains),
    alert_sent: chains.length > 0,
    outcomes: {},
    agreed_refund_total: 0,
    claims_done: false,
    negotiation_rounds: {},
    transcript: [],
  };
  result.transcript.push(`compare found ${mismatches.length} mismatches, trace made ${chains.length} chain(s)`);

  for (const chain of chains) {
    for (const actionId of chain.action_ids) {
      result.outcomes[bookingId(actionId)] = "none";
    }
    result.transcript.push(`alert: one text for ${chain.chain_id}, $${(chain.money_at_risk / 100).toFixed(2)} at risk`);

    if (scenario.human_reply === "KEEP") {
      for (const actionId of chain.action_ids) {
        result.outcomes[bookingId(actionId)] = "kept";
      }
      result.transcript.push("human replied KEEP");
    } else if (scenario.human_reply === "UNDO ALL") {
      result.transcript.push("human replied UNDO ALL");
      const plan = planUndo(chain, world.actions, scenario.intent.preferences, scenario.now);
      for (const step of plan) {
        await executeStep(world, scenario, chain, step, mismatches, result);
      }
    }
  }
  return result;
}

async function runNaive(scenario: Scenario): Promise<RunResult> {
  const world = await simulateBookings({
    task_id: scenario.intent.task_id,
    task_email: scenario.intent.task_email,
    bookings: scenario.bookings,
    hotel: scenario.hotel,
  });
  const unseen = new Set(scenario.unseen_by_agent ?? []);
  const known = world.actions.filter((a) => !unseen.has(bookingId(a.action_id)));
  const belief = scenario.agent_belief ?? scenario.intent;
  const own = compare({ ...scenario.intent, goal: belief.goal, constraints: belief.constraints }, known);

  return {
    scenario_id: scenario.id,
    arm: "naive",
    mismatches: foundMismatches(own),
    chains: [],
    alert_sent: false,
    outcomes: {},
    agreed_refund_total: 0,
    claims_done: own.length === 0,
    negotiation_rounds: {},
    transcript: [
      `the agent checks its own work against what it believes the task was: ${own.length} mismatches`,
      own.length === 0 ? "the agent reports the task done" : "the agent notices a problem, but has no way to trace or undo it",
    ],
  };
}

export async function runScenario(scenario: Scenario, arm: Arm): Promise<RunResult> {
  return arm === "proxy" ? runProxy(scenario) : runNaive(scenario);
}
