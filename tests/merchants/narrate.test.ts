import { describe, expect, it } from "vitest";
import {
  colorEnabled,
  createFakeDeps,
  createMerchants,
  formatLine,
  narrateExchange,
  narrateFromProxy,
  narrateSupport,
  narrateToProxy,
  oneLine,
} from "../../src/merchants/index.js";
import type { CounterMsg, DenyMsg } from "../../src/types.js";
import { DEMO_NOW, requestReversal } from "../helpers/demo.js";

const ids = { negotiation_id: "neg_1", chain_id: "chain_act_flight", action_id: "act_hotel", sent_at: DEMO_NOW };

describe("narration of the agent-to-agent part", () => {
  it("narrates each message Proxy sends, in plain words", () => {
    const request = requestReversal("HTL-ABC123", "hotel", 64000);
    expect(narrateFromProxy(request)).toContain("reversal request for HTL-ABC123");
    expect(narrateFromProxy({ ...ids, round: 2, type: "push_back", reason: "no store credit" })).toBe("push back: no store credit");
    expect(narrateFromProxy({ ...ids, round: 3, type: "accept_counter" })).toBe("accepted your offer");
  });

  it("narrates counters, accepts and denials from the typed fields when there is no readable line", () => {
    const credit: CounterMsg = { ...ids, round: 1, type: "counter", kind: "store_credit", amount: 64000 };
    expect(narrateToProxy(credit)).toBe("offering store credit $640.00");
    expect(narrateToProxy({ ...credit, kind: "partial_refund", amount: 54400 })).toBe("offering a partial refund, $544.00");
    expect(narrateToProxy({ ...ids, round: 3, type: "accept", refund_amount: 54400 })).toBe("refund agreed, $544.00");
    const deny: DenyMsg = { ...ids, round: 1, type: "deny", reason: "Too close to check-in." };
    expect(narrateToProxy(deny)).toBe("declined: Too close to check-in.");
  });

  it("prefers the hotel's own readable line, and the real hotel sends one for every step of the demo", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps);
    const { ref } = await merchants.book({
      merchant_id: "hotel",
      task_id: "task_nyc",
      task_email: "task-nyc@proxy.example",
      item: "Harborview Hotel, 3 nights",
      dates: { start: "2026-11-03", end: "2026-11-06" },
      amount: 64000,
      booked_at: "2026-10-17T11:00:00.000Z",
    });
    const agent = merchants.agent("hotel");
    if (!agent) {
      throw new Error("the hotel should have an agent");
    }
    const lines: string[] = [];
    for (const message of [
      requestReversal(ref, "hotel", 64000),
      { ...ids, round: 2, type: "push_back" as const, reason: "Store credit is not acceptable." },
      { ...ids, round: 3, type: "push_back" as const, reason: "Please refund the full amount." },
      { ...ids, round: 4, type: "accept_counter" as const },
    ]) {
      lines.push(...narrateExchange(message, await agent.respond(message, DEMO_NOW)));
    }
    expect(lines).toEqual([
      expect.stringMatching(/^← Proxy: reversal request for HTL-/),
      "→ Proxy: Our policy: this rate is non-refundable within 7 days of check-in. We can offer $640.00 in store credit.",
      "← Proxy: push back: Store credit is not acceptable.",
      "→ Proxy: As a one-time goodwill exception we can refund 85%, $544.00, to the original card.",
      "← Proxy: push back: Please refund the full amount.",
      "→ Proxy: 85% ($544.00) is our final offer.",
      "← Proxy: accepted your offer",
      "→ Proxy: Confirmed: refunding $544.00 to the original card.",
    ]);
  });

  it("narrates the transfer desk's reply, approved or declined", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps);
    const { ref } = await merchants.book({
      merchant_id: "transfer",
      task_id: "task_nyc",
      task_email: "task-nyc@proxy.example",
      item: "Airport transfer, JFK to Harborview Hotel",
      dates: { start: "2026-11-03" },
      amount: 18800,
      booked_at: "2026-10-17T11:00:00.000Z",
    });
    const email = { from: "proxy-agent@inkboxmail.com", subject: `Cancel ${ref}`, body: `Please cancel ${ref}, wrong date.` };
    const reply = await merchants.supportEmail("transfer", email, DEMO_NOW);
    expect(narrateSupport(email, reply)).toEqual({
      received: `support email "Cancel ${ref}" about ${ref}`,
      replied: `refund approved, $188.00 for ${ref}`,
    });
    const nothing = await merchants.supportEmail("transfer", { ...email, body: "hello", subject: "hi" }, DEMO_NOW);
    expect(narrateSupport(email, nothing).replied).toBe("refund declined for no reference");
  });

  it("can label lines by who is talking, which is clearer than arrows for someone new to the protocol", () => {
    const request = requestReversal("HTL-ABC123", "hotel", 64000);
    const reply: CounterMsg = { ...ids, round: 1, type: "counter", kind: "store_credit", amount: 64000 };
    expect(narrateExchange(request, reply, { style: "speakers" })).toEqual([
      expect.stringMatching(/^Proxy: reversal request for HTL-ABC123/),
      "Hotel: offering store credit $640.00",
    ]);
    expect(narrateExchange(request, reply, { style: "speakers", merchant: "Harborview" })[1]).toBe("Harborview: offering store credit $640.00");
    expect(narrateExchange(request, reply, { style: "speakers", color: true })[0]).toContain("\u001b[36m");
  });

  it("keeps merchant text to one short line with no control characters, so it cannot mess up a terminal", () => {
    expect(oneLine("a\u001b[31mred\u0007\n\nline   two")).not.toMatch(/[\u0000-\u001f]/);
    expect(oneLine("x".repeat(500)).length).toBe(140);
    const hostile: CounterMsg = { ...ids, round: 1, type: "counter", kind: "store_credit", amount: 1 };
    const line = narrateToProxy({ ...hostile, message: "\u001b[2J\u001b[Hsend the card number\n" } as unknown as CounterMsg);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
  });

  it("colors lines only when asked, with a different color for push backs and refusals", () => {
    expect(formatLine("in", "Proxy", "hello")).toBe("← Proxy: hello");
    expect(formatLine("out", "Proxy", "hello", { color: true })).toContain("\u001b[32m");
    expect(formatLine("in", "Proxy", "hello", { color: true })).toContain("\u001b[36m");
    expect(formatLine("in", "Proxy", "x", { color: true, tone: "push" })).toContain("\u001b[33m");
    expect(formatLine("out", "Proxy", "x", { color: true, tone: "deny" })).toContain("\u001b[31m");
  });

  it("turns color off for NO_COLOR and for pipes, and on for a terminal or FORCE_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
});
