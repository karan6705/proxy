import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../db/memory.js";
import type { Action, Chain, Clock, HumanReply, ProxyProtocolMessage } from "../types.js";
import { composeChainAlert, createHumanChannel, createHumanRoutes, createInkbox, handleForTask, parseReply } from "./index.js";

describe("parseReply", () => {
  it.each([
    ["UNDO ALL", { kind: "undo_all" }],
    ["undo all!", { kind: "undo_all" }],
    ["  Undo  all  ", { kind: "undo_all" }],
    ["UNDOALL", { kind: "undo_all" }],
    ["KEEP", { kind: "keep" }],
    ["keep it", { kind: "keep" }],
    ["PICK", { kind: "pick" }],
    ["pick 1 3", { kind: "pick", picks: [1, 3] }],
    ["PICK 2,4", { kind: "pick", picks: [2, 4] }],
    ["1 and 3", { kind: "numbers", picks: [1, 3] }],
    ["2", { kind: "numbers", picks: [2] }],
    ["yes", { kind: "yes" }],
    ["No", { kind: "no" }],
    ["STOP", { kind: "opt_out" }],
  ])("%s", (body, expected) => expect(parseReply(body)).toEqual(expected));

  it.each(["ugh no the 13th", "undo all except the hotel", "don't undo all", "pick the hotel", "", "UNDO ALL and refund me twice", "keep? no undo all"])(
    "does not guess at %j",
    (body) => expect(parseReply(body).kind).toBe("unknown"),
  );
});

describe("composeChainAlert", () => {
  it("matches the agreed text and stays short", () => {
    const t = composeChainAlert({ what_went_wrong: "used the wrong date (Nov 3, not Nov 13)", affected: 4, money_at_risk: 124000, time_left_ms: (3 * 60 + 40) * 60_000 });
    expect(t).toBe("Your agent used the wrong date (Nov 3, not Nov 13). 4 things affected, $1,240 at risk. Reversible for 3h 40m. Reply UNDO ALL, PICK or KEEP.");
    expect(composeChainAlert({ what_went_wrong: "x".repeat(400), affected: 1, money_at_risk: 100, time_left_ms: null }).length).toBeLessThanOrEqual(320);
  });
});

const HUMAN = "+14155550100";
let nowIso = "2026-11-01T10:00:00.000Z";
const clock: Clock = { mode: "simulated", now: () => nowIso, nowMs: () => Date.parse(nowIso) };

const act = (n: number, summary: string, amount: number): Action => ({
  action_id: `a${n}`, task_id: "t1", merchant: "m", category: "flight", summary, amount, ref: `R${n}`, source: "email", received_at: nowIso, state: "found",
});
const chain = (over: Partial<Chain> = {}): Chain => ({
  chain_id: "c1", task_id: "t1", root_action_id: "a1", action_ids: ["a1", "a2", "a3"], money_at_risk: 124000,
  window_ends_at: "2026-11-01T14:00:00.000Z", state: "alerted",
  alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-11-01T09:00:00.000Z" }], plan: [], steps: [], ...over,
});

async function setup(chainOver: Partial<Chain> = {}) {
  nowIso = "2026-11-01T10:00:00.000Z";
  const store = createMemoryStore();
  for (const a of [act(1, "Flight SFO to JFK", 41200), act(2, "Harborview Hotel", 78000), act(3, "Transfer", 6850)]) await store.upsertAction(a);
  await store.upsertChain(chain(chainOver));
  const replies: HumanReply[] = [];
  const sent: string[] = [];
  const channel = createHumanChannel({
    store, clock, humanNumber: HUMAN,
    hooks: { onHumanReply: async (r) => void replies.push(r) },
    sendText: async (_c, _to, body) => (sent.push(body), { message_id: "m" }),
  });
  return { store, channel, replies, sent };
}

describe("human channel", () => {
  it("ignores other numbers silently and logs it", async () => {
    const { channel, replies, sent, store } = await setup();
    const r = await channel.handleInbound({ from: "+14155559999", body: "UNDO ALL" });
    expect(r).toEqual({ status: "ignored", reason: "unregistered_number" });
    expect(replies).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(store.events().at(-1)?.outcome).toBe("ignored:unregistered_number");
  });

  it("logs inbound iMessages as imessage_in and texts as sms_in", async () => {
    const { channel, store } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "KEEP", via: "imessage" });
    await channel.handleInbound({ from: "+14155559999", body: "x", via: "sms" });
    expect(store.events().filter((e) => e.kind === "imessage_in" || e.kind === "sms_in").map((e) => e.kind)).toEqual(["imessage_in", "sms_in"]);
  });

  it("accepts the human's number in any format", async () => {
    const { channel, replies } = await setup();
    await channel.handleInbound({ from: "1 (415) 555-0100", body: "undo all" });
    expect(replies).toMatchObject([{ kind: "undo_all", chain_id: "c1" }]);
  });

  it("starts the undo once; a second UNDO ALL does not", async () => {
    const { channel, replies, sent } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "UNDO ALL" });
    const again = await channel.handleInbound({ from: HUMAN, body: "UNDO ALL" });
    expect(replies).toHaveLength(1);
    expect(again).toEqual({ status: "replied", reason: "duplicate" });
    expect(sent[1]).toMatch(/Already on it/);
  });

  it("runs PICK: list first, then the numbers", async () => {
    const { channel, replies, sent } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "PICK" });
    expect(sent[0]).toContain("1) Flight SFO to JFK $412");
    expect(sent[0]).toContain("3) Transfer $69");
    await channel.handleInbound({ from: HUMAN, body: "9" });
    expect(replies).toHaveLength(0);
    await channel.handleInbound({ from: HUMAN, body: "1 3" });
    expect(replies).toMatchObject([{ kind: "pick", chain_id: "c1", picks: [1, 3] }]);
  });

  it("takes PICK with numbers in one message", async () => {
    const { channel, replies } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "PICK 2" });
    expect(replies).toMatchObject([{ kind: "pick", picks: [2] }]);
  });

  it("keeps, and then refuses a later undo", async () => {
    const { channel, replies, sent } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "KEEP" });
    await channel.handleInbound({ from: HUMAN, body: "UNDO ALL" });
    expect(replies).toMatchObject([{ kind: "keep" }]);
    expect(sent.at(-1)).toMatch(/closed as kept/);
  });

  it("says too late once the window has closed", async () => {
    const { channel, replies, sent } = await setup({ window_ends_at: "2026-11-01T09:30:00.000Z" });
    const r = await channel.handleInbound({ from: HUMAN, body: "UNDO ALL" });
    expect(r).toEqual({ status: "replied", reason: "too_late" });
    expect(replies).toHaveLength(0);
    expect(sent[0]).toMatch(/Too late/);
  });

  it("asks once for a loose reply, then stays quiet", async () => {
    const { channel, replies, sent } = await setup();
    await channel.handleInbound({ from: HUMAN, body: "ugh no the 13th" });
    await channel.handleInbound({ from: HUMAN, body: "ugh no the 13th!!" });
    expect(sent).toEqual(["I didn't catch that. Reply UNDO ALL, PICK or KEEP."]);
    expect(replies).toHaveLength(0);
  });

  it("never replies to STOP", async () => {
    const { channel, sent } = await setup();
    expect(await channel.handleInbound({ from: HUMAN, body: "STOP" })).toEqual({ status: "ignored", reason: "opt_out" });
    expect(sent).toHaveLength(0);
  });

  it("answers a counter question with YES / NO", async () => {
    const { channel, replies } = await setup();
    channel.expectCounterDecision("c1", "neg1");
    await channel.handleInbound({ from: HUMAN, body: "no" });
    expect(replies).toMatchObject([{ kind: "counter_decision", negotiation_id: "neg1", accept: false }]);
  });

  it("replies to the most recently alerted chain when there are several", async () => {
    const { channel, replies, store } = await setup();
    await store.upsertChain(chain({ chain_id: "c2", alerts: [{ channel: "sms", kind: "chain_opened", body: "x", sent_at: "2026-11-01T09:50:00.000Z" }] }));
    await channel.handleInbound({ from: HUMAN, body: "KEEP" });
    expect(replies).toMatchObject([{ chain_id: "c2" }]);
  });
});

describe("text webhook routes", () => {
  it("rejects a bad signature, ignores outbound events, and forwards a reply", async () => {
    const { channel, replies } = await setup();
    const verify = vi.fn(async () => true);
    const [text] = createHumanRoutes(channel, verify);
    const body = (over: object = {}) => JSON.stringify({ event_type: "text.received", data: { text_message: { direction: "inbound", remote_phone_number: HUMAN, text: "UNDO ALL", ...over } } });
    const post = (rawBody: string) => text.handle({ method: "POST", path: "/inkbox/text", headers: {}, query: {}, rawBody });

    verify.mockResolvedValueOnce(false);
    expect((await post(body())).status).toBe(401);
    expect((await post(body({ direction: "outbound" }))).body).toMatchObject({ ignored: true });
    expect((await post(body())).body).toMatchObject({ status: "forwarded" });
    expect(replies).toHaveLength(1);
  });
});

describe("inkbox client in dry run", () => {
  it("logs instead of sending, and returns ids and task addresses", async () => {
    const store = createMemoryStore();
    const lines: string[] = [];
    const ink = createInkbox({ dryRun: true, store, clock, log: (l) => lines.push(l), sdk: async () => { throw new Error("must not touch the network"); } });
    expect(await ink.createTaskAddress("task_abc")).toEqual({ task_email: "task_abc@tasks.proxy.example" });
    expect((await ink.sendText("sms", HUMAN, "hello")).message_id).toMatch(/^dry_/);
    await ink.sendText("imessage", HUMAN, "hello again");
    await ink.placeCall(HUMAN, "script");
    await ink.sendEmail({ to: "support@x.test", subject: "Refund", body: "please" });
    const msg = { type: "push_back", negotiation_id: "n", chain_id: "c1", action_id: "a2", round: 2, sent_at: nowIso, reason: "no store credit" } as ProxyProtocolMessage;
    expect(await ink.sendProtocolMessage("hotel-agent", msg)).toEqual({ via: "a2a" });
    expect(store.events().map((e) => e.kind)).toEqual(["sms_out", "imessage_out", "call_out", "email_out", "a2a"]);
    expect(store.events().every((e) => e.outcome?.startsWith("dry_run"))).toBe(true);
    expect(lines.join("\n")).toContain("***0100");
    expect(lines.join("\n")).not.toContain(HUMAN);
  });

  it("makes Inkbox-legal handles from task ids", () => {
    expect(handleForTask("task_Demo_1")).toBe("task-demo-1");
  });
});
