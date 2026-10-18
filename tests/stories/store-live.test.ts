// Karan's live server: real Inkbox for the human (alert and reply), but Northwind Market, its agent, its return form
// and its carrier run in this process. Nothing for Northwind may go through Inkbox. The Inkbox client here only
// records (no key is real and nothing is sent).
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/db/index.js";
import { createSimulatedClock } from "../../src/orchestrator/clock.js";
import { DEFAULT_PARAMS } from "../../src/orchestrator/params.js";
import { createRuntime, DEMO_HUMAN_NUMBER } from "../../src/orchestrator/runtime.js";
import { createStandInInkbox } from "../../src/orchestrator/standin-inkbox.js";
import { createToolHandlers } from "../../src/tools/handlers.js";

const PHONE = "+15550000123";

describe("store story on a real-Inkbox server", () => {
  it("texts the human through Inkbox, while Northwind's agent, emails, form and carrier stay in-process", async () => {
    const clock = createSimulatedClock("2026-10-10T15:00:00.000Z");
    const inkbox = createStandInInkbox();
    const task_id = "task_store_live";
    const rt = createRuntime(clock, DEFAULT_PARAMS, DEFAULT_PARAMS.DEFAULT_PREFERENCES, {
      store: createMemoryStore(),
      inkbox,
      env: {
        INKBOX_API_KEY: "not_a_real_key",
        MERCHANT_ADDRESS_MODE: "real",
        HUMAN_PHONE: PHONE,
        PROXY_DEMO_ROUTES: "1",
        PROXY_DEMO_REDO_GAP_MS: "0",
        PROXY_ALERT_SETTLE_MS: "0",
        PROXY_CARRIER_SCAN_MS: "0",
        DEMO_PACE_MS: "0",
        INKBOX_DEMO_TASK_ID: task_id,
      },
    });
    const p = rt.proxy;
    p.deps.demo!.current = task_id;
    const tools = createToolHandlers(() => p);
    const logged = (await tools.log_intent({
      goal: "USB-C 65W charger for a MacBook, under $60",
      constraints: { categories: ["store"], budget_total: 6_000, must_haves: ["item:USB-C 65W charger"] },
      original_request: "Order a USB-C 65W charger for my MacBook, under $60.",
      idempotency_key: "live-store",
    })).structuredContent;
    if (!logged.ok) throw new Error("log_intent failed");
    // The receipt goes merchant -> capture in-process, even with real merchant addresses.
    await rt.merchants.book({ merchant_id: "northwind", task_id, task_email: logged.task_email, item: "USB-A 20W charger", amount: 4_500, booked_at: clock.now() });
    p.deps.sessions.end(task_id);
    await p.alertChains(task_id);
    const chain = (await rt.store.listChains(task_id))[0]!;
    expect(chain).toBeDefined();
    await rt.human.handleInbound({ from: PHONE, body: "UNDO ALL", via: "imessage" });
    const until = Date.now() + 10_000;
    while (Date.now() < until && (await rt.store.getChain(chain.chain_id))?.state !== "redone") await new Promise((r) => setTimeout(r, 10));
    expect((await rt.store.getChain(chain.chain_id))?.state).toBe("redone");

    const texts = inkbox.outbox.filter((o) => o.kind === "text") as Array<{ to: string; body: string }>;
    expect(texts.every((t) => t.to === PHONE && t.to !== DEMO_HUMAN_NUMBER)).toBe(true);
    expect(texts.map((t) => t.body)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Your agent ordered the wrong item/),
        "Your return label is ready. Drop it off by Oct 24.",
        expect.stringMatching(/^Proxy returned it through Northwind Market's return form\. Order refunded, \$45/),
      ]),
    );
    // Nothing for Northwind went through Inkbox: no protocol message, no email.
    expect(inkbox.outbox.filter((o) => o.kind === "protocol")).toEqual([]);
    expect(inkbox.outbox.filter((o) => o.kind === "email")).toEqual([]);
  });
});
