// The store story end to end on the real orchestrator (sandbox: simulated payments, nothing sent).
import { describe, expect, it } from "vitest";
import { createSandboxes } from "../../src/orchestrator/sandbox.js";
import { SHOW_HTML } from "../../src/web/show.js";

describe("store story: the wrong charger", () => {
  it("flags the item, negotiates, fills the return form, waits for the scan, verifies $45 and orders the right charger", async () => {
    const sandboxes = createSandboxes();
    const r = await sandboxes.run("show_store", "store");
    expect(r.finished).toBe(true);
    expect(r.summary).toContain("$45 of $45 is back, confirmed on simulated payments.");
    const feed = sandboxes.forTask("show_store")!.feed.list("show_store");
    const kinds = feed.map((e) => e.kind).filter((k) => k !== "wait");
    const at = (k: string) => kinds.indexOf(k as never);

    expect(feed.find((e) => e.kind === "mismatch")?.data).toMatchObject({ field: "item", expected: "USB-C 65W charger", actual: "USB-A 20W charger" });
    expect(feed.find((e) => e.kind === "text_out")?.text).toMatch(/^Your agent ordered the wrong item \(USB-A 20W charger, not USB-C 65W charger\)\./);
    // Support chat: store credit offered, Proxy pushes back under the human's rule, the store sends it to its form.
    expect(feed.filter((e) => e.kind.startsWith("protocol_")).map((e) => e.data.type)).toEqual(["request_reversal", "counter", "push_back", "deny"]);
    expect(feed.find((e) => e.kind === "protocol_in" && e.data.type === "counter")?.data.kind).toBe("store_credit");
    // The form, one field at a time, then the label.
    expect(feed.filter((e) => e.kind === "form_field").map((e) => [e.data.field, e.data.value ?? null])).toEqual([
      ["_open", null],
      ["order_number", feed.find((e) => e.kind === "booking")?.data.ref],
      ["item", "USB-A 20W charger"],
      ["reason", "Wrong item, ordered in error by an AI agent on my behalf"],
      ["resolution", "Refund to original payment"],
      ["method", "Drop-off"],
      ["_submit", null],
    ]);
    const label = feed.find((e) => e.kind === "return_label")!;
    expect(label.data).toMatchObject({ carrier: "ParcelPoint", drop_off_by: "2026-10-24" });
    expect(String(label.data.qr_path)).toMatch(/^M\d/);
    expect(feed.some((e) => e.kind === "text_out" && e.text === "Your return label is ready. Drop it off by Oct 24.")).toBe(true);
    // The refund only after the scan, and only once the payment shows it.
    expect(at("form_field")).toBeLessThan(at("return_label"));
    expect(at("return_label")).toBeLessThan(at("carrier_scan"));
    expect(at("carrier_scan")).toBeLessThan(at("stripe_refund"));
    expect(feed.find((e) => e.kind === "stripe_refund")?.data).toMatchObject({ merchant: "northwind", amount: 4_500, of: 4_500 });
    expect(feed.some((e) => e.kind === "text_out" && /^Proxy returned it through Northwind Market's return form\. Order refunded, \$45, confirmed/.test(e.text))).toBe(true);
    // Redo: the right charger, at Northwind's price, under the $60 budget.
    expect(feed.filter((e) => e.kind === "redo").map((e) => [e.data.item, e.data.amount])).toEqual([["USB-C 65W charger", 5_200]]);
    expect(feed.at(-1)?.text).toBe("Ordered the right one: USB-C 65W charger, $52. It matches what you asked for.");
  });

  it("is in /web/show's story picker with its scenes", () => {
    expect(SHOW_HTML).toContain('store:{title:"The wrong charger"');
    for (const scene of ["The support chat", "The return form", "The return label", "The drop-off scan"]) expect(SHOW_HTML).toContain(scene);
  });
});
