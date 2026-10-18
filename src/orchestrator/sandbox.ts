// try_proxy_demo: the whole demo story in an isolated, simulated sandbox, for anyone connecting to the cloud judge copy.
// Each run gets its own runtime (own store, clock, payments, merchants, human channel and hotel agent) and its own
// task id (sandbox_<random>), so concurrent runs never touch each other, and none of it can reach a real service:
// the sandbox environment is PROXY_MODE=cloud whatever the server's own environment holds.
import { randomBytes } from "node:crypto";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import { DEMO_LATE_AT } from "../tools/stubs.js";
import type { Action, Chain, SimulatedClock } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { humanDate, money } from "./copy.js";
import { DEFAULT_PARAMS } from "./params.js";
import type { Proxy } from "./proxy.js";
import { createRuntime, DEMO_HUMAN_NUMBER } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";

/** The agent's day starts a week before the trip, so the flight is free to cancel under the 24-hour rule. */
const SANDBOX_START = "2026-10-25T14:00:00.000Z";
const slug = (ref: string) => ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface SandboxResult {
  task_id: string;
  chain_id: string;
  summary: string;
  finished: boolean;
}

export interface SandboxLookup {
  forChain(chain_id: string): Proxy | null;
  forTask(task_id: string): Proxy | null;
  /** Every sandbox chain, finished ones included, so list_chains has data after a run. */
  chains(): Promise<Chain[]>;
}

/** The stories a sandbox can run. trip is try_proxy_demo's story. */
export const SCENARIOS = ["trip"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Sandboxes extends SandboxLookup {
  /** Runs a story. `task_id` is for the boot example and /web/show; leave it out for a random sandbox_<random>. */
  run(task_id?: string, scenario?: Scenario): Promise<SandboxResult>;
  size(): number;
}

interface Entry {
  proxy: Proxy;
  store: { listChains(task_id: string): Promise<Chain[]> };
  task_id: string;
}

export function createSandboxes(opts: { max?: number; maxConcurrent?: number; timeoutMs?: number } = {}): Sandboxes {
  const max = opts.max ?? 40;
  const maxConcurrent = opts.maxConcurrent ?? 8;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const runs = new Map<string, Entry>();
  let inFlight = 0;

  /** The boot example and /web/show's recordings stay; random runs make room for new ones. */
  const kept = (task_id: string) => task_id === "sandbox_example" || task_id.startsWith("show_");
  const byChain = (chain_id: string) => [...runs.values()].find((e) => chain_id.includes(`_${e.task_id}_`) || chain_id.endsWith(`_${e.task_id}`));

  async function story(task_id: string, scenario: Scenario): Promise<SandboxResult> {
    void scenario;
    const clock: SimulatedClock = createSimulatedClock(SANDBOX_START);
    const runtime = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
      store: createMemoryStore(),
      inkbox: createStandInInkbox(),
      env: {
        PROXY_MODE: "cloud",
        PROXY_DEMO_ROUTES: "1",
        PROXY_DEMO_REDO: "1",
        PROXY_DEMO_REDO_GAP_MS: "0",
        PROXY_ALERT_SETTLE_MS: "0",
        INKBOX_DEMO_TASK_ID: task_id,
      },
    });
    runs.set(task_id, { proxy: runtime.proxy, store: runtime.store, task_id });
    while (runs.size > max) {
      const oldest = [...runs.keys()].find((k) => !kept(k) && k !== task_id);
      if (!oldest) break;
      runs.delete(oldest);
    }
    const p = runtime.proxy;
    if (!p.deps.demo) throw new Error("sandbox runtime has no demo task");
    p.deps.demo.current = task_id; // the task id is exactly sandbox_<random>
    const tools = createToolHandlers(() => p);

    const logged = (await tools.log_intent({
      goal: "NYC trip for the Nov 13 conference, under $1,500",
      constraints: { dates: { start: "2026-11-13", end: "2026-11-16" }, budget_total: 150_000 },
      original_request: "Book my NYC trip for the Nov 13 conference, under $1,500",
      idempotency_key: "sandbox",
    })).structuredContent;
    if (!logged.ok) throw new Error("sandbox log_intent failed");

    const book = async (merchant_id: "airline" | "hotel" | "transfer" | "host", item: string, amount: number, category: Action["category"], dates: Action["dates"]) => {
      const b = await runtime.merchants.book({ merchant_id, task_id, task_email: logged.task_email, item, dates, amount, booked_at: clock.now(), defer_confirmation: true });
      const action: Action = {
        action_id: `act_${task_id}_${slug(b.ref)}`,
        task_id,
        merchant: merchant_id,
        category,
        summary: item,
        amount,
        dates,
        ref: b.ref,
        source: merchant_id === "host" ? "agent" : "email",
        received_at: clock.now(),
        state: "found",
      };
      await p.onAction(action);
      clock.advance(1000);
      return action;
    };

    // The agent books Nov 3 instead of Nov 13 and tells the host.
    const flight = await book("airline", "Flight SFO to JFK, Nov 3", 41_200, "flight", { start: "2026-11-03" });
    await book("host", "Arrival email", 0, "message", { start: "2026-11-03" });
    // It reviews, finds the flight, undoes it itself (free under the 24-hour rule), says it is done, and leaves.
    await tools.review({ task_id });
    await tools.undo({ action_ids: [flight.action_id], reason: "booked Nov 3, the trip is Nov 13" });
    p.deps.sessions.end(task_id);
    // Late confirmations arrive close to the deadlines, so the alert reads "Reversible for 3h 40m".
    clock.set(DEMO_LATE_AT);
    await book("hotel", "Hotel, 3 nights", 64_000, "hotel", { start: "2026-11-03", end: "2026-11-06" });
    await book("transfer", "Airport transfer, Nov 3", 18_800, "transfer", { start: "2026-11-03" });
    // Proxy alerts the (simulated) human, who replies UNDO ALL.
    await p.alertChains(task_id);
    const chain = (await runtime.store.listChains(task_id)).sort((a, b) => b.action_ids.length - a.action_ids.length)[0];
    if (!chain) throw new Error("sandbox opened no chain");
    await runtime.human.handleInbound({ from: DEMO_HUMAN_NUMBER, body: "UNDO ALL", via: "imessage" });

    // The hotel negotiation, refunds, correction and redo run on their own; wait for the end (bounded).
    const until = Date.now() + timeoutMs;
    let state = chain.state;
    while (Date.now() < until) {
      state = (await runtime.store.getChain(chain.chain_id))?.state ?? state;
      if (state === "redone" || state === "partial") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const view = await tools.get_chain({ chain_id: chain.chain_id });
    const meta = ("_meta" in view ? view._meta : undefined) as { recovered: Record<string, number> } | undefined;
    const recovered = Object.values(meta?.recovered ?? {}).reduce((t, n) => t + n, 0);
    const actions = view.structuredContent.ok ? view.structuredContent.actions : [];
    const total = actions.reduce((t, a) => t + a.amount, 0);
    const d = (await runtime.store.getIntent(task_id))?.constraints.dates;
    const finished = state === "redone";
    const summary =
      "Simulated sandbox: no real money, messages or merchants. " +
      "The agent booked the flight, hotel and airport transfer for Nov 3 instead of Nov 13 and emailed the host the wrong date. " +
      `It undid the flight itself (${money(41_200)}), then left. Proxy found the rest when the late confirmations arrived and alerted the human: ` +
      `${money(total - 41_200)} at risk of ${money(total)}, reversible for 3h 40m. The (simulated) human replied UNDO ALL. ` +
      "Proxy negotiated with the hotel's agent (store credit refused, then 85% accepted), got the transfer refunded by email and the host corrected. " +
      `${money(recovered)} of ${money(total)} is back, confirmed on simulated payments. ` +
      (finished && d ? `The agent then rebooked for ${humanDate(d.start)} to ${humanDate(d.end ?? d.start)}.` : "The run did not finish in time; call get_chain to see where it stands.");
    return { task_id, chain_id: chain.chain_id, summary, finished };
  }

  return {
    async run(task_id = `sandbox_${randomBytes(4).toString("hex")}`, scenario: Scenario = "trip") {
      if (inFlight >= maxConcurrent) throw new Error("The sandbox is busy. Try again in a few seconds.");
      inFlight += 1;
      try {
        return await story(task_id, scenario);
      } finally {
        inFlight -= 1;
      }
    },
    forChain: (chain_id) => byChain(chain_id)?.proxy ?? null,
    forTask: (task_id) => runs.get(task_id)?.proxy ?? null,
    async chains() {
      const all: Chain[] = [];
      // /web/show's recordings are page material, not chains an agent should be told about.
      for (const e of runs.values()) if (!e.task_id.startsWith("show_")) all.push(...(await e.store.listChains(e.task_id)));
      return all;
    },
    size: () => runs.size,
  };
}
