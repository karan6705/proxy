import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handler } from "./result.js";

describe("tool error boundary", () => {
  it("logs error details server-side but returns only the safe error contract", async () => {
    const logs: Array<{ tool: string; detail: string }> = [];
    const wrapped = handler(
      z.object({}),
      async () => { throw new Error("raw merchant failure: private detail"); },
      { toolName: "review", logError: (entry) => logs.push(entry) },
    );

    const result = await wrapped({});

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        code: "internal",
        message: "The tool could not complete the request. Don't retry in a loop: tell the human Proxy hit an error, and give them the task_id or chain_id.",
        retryable: false,
        next_action: "stop",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tool: "review" });
    expect(logs[0]!.detail).toContain("private detail");
  });

  it("maps transient Stripe failures to a safe retryable error", async () => {
    const wrapped = handler(
      z.object({}),
      async () => { throw Object.assign(new Error("socket details"), { code: "stripe_unavailable" }); },
      { toolName: "undo", logError: () => {} },
    );

    const result = await wrapped({});
    expect(result).toMatchObject({
      structuredContent: {
        ok: false,
        code: "upstream_unavailable",
        message: "The payment service is temporarily unavailable. Retry shortly.",
        retryable: true,
        next_action: "retry",
      },
    });
    expect(JSON.stringify(result)).not.toContain("socket details");
  });
});
