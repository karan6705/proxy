import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../db/index.js";
import type { Action, HumanReply } from "../types.js";
import { createSimulatedClock } from "./clock.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";

const HUMAN = "+15550001111";
const clock = createSimulatedClock("2026-11-01T14:00:00.000Z");
let rt: Runtime;
let store: MemoryStore;
let inkbox: ReturnType<typeof createStandInInkbox>;
let replies: HumanReply[];

async function openChain(task_id: string): Promise<string> {
  await store.putIntent(
    {
      task_id,
      task_email: `${task_id}@tasks.proxy.example`,
      goal: "NYC trip",
      constraints: { dates: { start: "2026-11-13", end: "2026-11-16" } },
      preferences: DEFAULT_PARAMS.DEFAULT_PREFERENCES,
      created_at: clock.now(),
    },
    task_id,
  );
  const flight: Action = {
    action_id: `${task_id}_flight`,
    task_id,
    merchant: "airline",
    category: "flight",
    summary: "Flight, Nov 3",
    amount: 41_200,
    dates: { start: "2026-11-03" },
    ref: `${task_id}-AIR`,
    source: "email",
    received_at: clock.now(),
    state: "found",
  };
  await rt.proxy.onAction(flight);
  const chain = (await store.listChains(task_id))[0];
  if (!chain) throw new Error("Expected an open chain");
  return chain.chain_id;
}

beforeEach(() => {
  store = createMemoryStore();
  inkbox = createStandInInkbox();
  rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { HUMAN_PHONE: HUMAN }, store, inkbox });
  replies = [];
  const original = rt.proxy.onHumanReply;
  rt.proxy.onHumanReply = async (r) => {
    replies.push(r);
    await original(r);
  };
});

describe("texting the human and matching replies to chains", () => {
  it("keeps the existing chain id when a late booked action replaces the message root", async () => {
    const task_id = "task_root_change";
    await store.putIntent(
      {
        task_id,
        task_email: `${task_id}@tasks.proxy.example`,
        goal: "NYC trip",
        constraints: { dates: { start: "2026-11-13", end: "2026-11-16" } },
        preferences: DEFAULT_PARAMS.DEFAULT_PREFERENCES,
        created_at: clock.now(),
      },
      task_id,
    );
    await rt.proxy.onAction({
      action_id: "act_host",
      task_id,
      merchant: "host",
      category: "message",
      summary: "Arrival email, Nov 3",
      amount: 0,
      dates: { start: "2026-11-03" },
      ref: "MSG-1",
      source: "agent",
      received_at: clock.now(),
      state: "found",
    });
    const first = (await store.listChains(task_id))[0]!;
    expect(first.root_action_id).toBe("act_host");

    clock.advance(1_000);
    await rt.proxy.onAction({
      action_id: "act_flight",
      task_id,
      merchant: "airline",
      category: "flight",
      summary: "Flight, Nov 3",
      amount: 41_200,
      dates: { start: "2026-11-03" },
      ref: "AIR-1",
      source: "email",
      received_at: clock.now(),
      state: "found",
    });
    const chains = await store.listChains(task_id);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ chain_id: first.chain_id, root_action_id: "act_flight" });
  });

  it("textHuman sends the text and records the alert on the chain", async () => {
    const chain_id = await openChain("task_a");
    await rt.proxy.textHuman(chain_id, "chain_opened", "Your agent used the wrong date.");
    const chain = await store.getChain(chain_id);
    expect(chain?.state).toBe("alerted");
    expect(chain?.alerts).toHaveLength(1);
    expect(inkbox.outbox).toEqual([{ kind: "text", channel: "sms", to: HUMAN, body: "Your agent used the wrong date." }]);
  });

  it("a reply goes to the most recently alerted open chain", async () => {
    const a = await openChain("task_a");
    const b = await openChain("task_b");
    await rt.proxy.textHuman(a, "chain_opened", "chain a");
    clock.advance(60_000);
    await rt.proxy.textHuman(b, "chain_opened", "chain b");
    expect((await rt.proxy.mostRecentlyAlertedOpenChain())?.chain_id).toBe(b);

    const result = await rt.human.handleInbound({ from: HUMAN, body: "UNDO ALL" });
    expect(result).toMatchObject({ status: "forwarded", kind: "undo_all" });
    expect(replies.at(-1)).toMatchObject({ kind: "undo_all", chain_id: b });
  });

  it("the orchestrator re-attaches a reply whose chain is not open", async () => {
    const a = await openChain("task_a");
    await rt.proxy.textHuman(a, "chain_opened", "chain a");
    await rt.proxy.onHumanReply({ kind: "keep", chain_id: "chain_gone", received_at: clock.now() });
    const logged = store.events().filter((e) => e.kind === "sms_in").at(-1);
    expect(logged).toMatchObject({ chain_id: a, outcome: "keep" });
  });

  it("after a counteroffer question, the next YES is read as that decision", async () => {
    const a = await openChain("task_a");
    await rt.proxy.textHuman(a, "chain_opened", "chain a");
    await rt.proxy.askHumanAboutCounter(a, "neg_1", "The hotel offers 85% back. Reply YES to accept or NO to push back.");

    const result = await rt.human.handleInbound({ from: HUMAN, body: "YES" });

    expect(result).toMatchObject({ status: "forwarded", kind: "counter_decision" });
    expect(replies.at(-1)).toMatchObject({ kind: "counter_decision", chain_id: a, negotiation_id: "neg_1", accept: true });
    expect((await store.getChain(a))?.alerts.map((x) => x.kind)).toEqual(["chain_opened", "reminder"]);
  });

  it("refuses to text when no human number is registered", async () => {
    rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: {}, store, inkbox });
    const a = await openChain("task_a");
    await expect(rt.proxy.textHuman(a, "chain_opened", "x")).rejects.toThrow("HUMAN_PHONE");
    expect(inkbox.outbox).toHaveLength(0);
  });
});
