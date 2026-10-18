import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../db/index.js";
import { createToolHandlers } from "../tools/handlers.js";
import { createSimulatedClock } from "./clock.js";
import { DEFAULT_PARAMS } from "./params.js";
import { createSandboxes } from "./sandbox.js";
import { createRuntime } from "./runtime.js";
import { createStandInInkbox } from "./standin-inkbox.js";

describe("try_proxy_demo sandbox", () => {
  it("two concurrent runs are isolated and each finishes at $1,144 of $1,240", async () => {
    const sandboxes = createSandboxes();
    const [a, b] = await Promise.all([sandboxes.run(), sandboxes.run()]);
    expect(a.task_id).toMatch(/^sandbox_[0-9a-f]{8}$/);
    expect(b.task_id).toMatch(/^sandbox_[0-9a-f]{8}$/);
    expect(a.task_id).not.toBe(b.task_id);
    expect(a.chain_id).not.toBe(b.chain_id);
    for (const r of [a, b]) {
      expect(r.finished).toBe(true);
      expect(r.summary).toContain("Simulated sandbox: no real money, messages or merchants.");
      expect(r.summary).toContain("$1,144 of $1,240 is back, confirmed on simulated payments.");
      expect(r.summary).toContain("rebooked for Nov 13 to Nov 16");
    }

    // The main server's tools find each sandbox's chain, with that sandbox's own numbers.
    const main = createRuntime(createSimulatedClock("2026-11-01T14:00:00.000Z"), DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, { env: { PROXY_MODE: "cloud" }, store: createMemoryStore(), inkbox: createStandInInkbox() });
    const tools = createToolHandlers(() => main.proxy, sandboxes);
    for (const r of [a, b]) {
      const view = await tools.get_chain({ chain_id: r.chain_id });
      expect(view.structuredContent).toMatchObject({ ok: true, state: "redone", next_action: "stop" });
      const recovered = Object.values(("_meta" in view ? view._meta.recovered : {}) as Record<string, number>).reduce((t, n) => t + n, 0);
      expect(recovered).toBe(114_400);
      expect(view.content[0]?.text).toContain("$1,144 of $1,240 recovered and confirmed in Stripe (simulated).");
    }
    const listed = (await tools.list_chains({})).structuredContent;
    expect(listed.ok && listed.chains.map((c) => c.task_id).sort()).toEqual([a.task_id, b.task_id].sort());
    // The refunded flight stays the root; the arrival email never takes over.
    expect(listed.ok && listed.chains.map((c) => c.root_summary)).toEqual(["Flight SFO to JFK, Nov 3", "Flight SFO to JFK, Nov 3"]);
  });

  it("a run never touches another run's state, texts or refunds", async () => {
    const sandboxes = createSandboxes();
    const [a, b] = await Promise.all([sandboxes.run("sandbox_aaaaaaaa"), sandboxes.run("sandbox_bbbbbbbb")]);
    const pa = sandboxes.forTask(a.task_id)!;
    const pb = sandboxes.forTask(b.task_id)!;
    expect(pa).not.toBe(pb);
    expect((await pa.deps.store.listActions(b.task_id)).length).toBe(0);
    expect((await pb.deps.store.listActions(a.task_id)).length).toBe(0);
    expect(pa.feed.list(b.task_id)).toEqual([]);
  });

  it("sends nothing real: no phone number, simulated payments, even when the server has keys", async () => {
    const before = { ...process.env };
    process.env.INKBOX_API_KEY = "not-a-real-key";
    process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
    process.env.HUMAN_PHONE = "+15555550199";
    try {
      const sandboxes = createSandboxes();
      const r = await sandboxes.run();
      expect(r.finished).toBe(true);
      const p = sandboxes.forTask(r.task_id)!;
      expect(p.deps.paymentsName).toBe("Stripe (simulated)");
      expect(p.deps.canTextHuman).toBe(false);
      expect(JSON.stringify(p.feed.list(r.task_id))).not.toContain("5555550199");
    } finally {
      process.env.INKBOX_API_KEY = before.INKBOX_API_KEY;
      process.env.STRIPE_SECRET_KEY = before.STRIPE_SECRET_KEY;
      process.env.HUMAN_PHONE = before.HUMAN_PHONE;
      for (const k of ["INKBOX_API_KEY", "STRIPE_SECRET_KEY", "HUMAN_PHONE"]) if (before[k] === undefined) delete process.env[k];
    }
  });
});
