import { describe, expect, it, vi } from "vitest";
import { DEMO_PREFERENCES, DEMO_START } from "./scripted.js";
import { assertStripeTestMode, resetDemo } from "./reset.js";

describe("demo reset", () => {
  it("refuses to run with a live Stripe key before making a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      resetDemo({ env: { STRIPE_SECRET_KEY: "sk_live_forbidden" }, fetch: fetchMock as typeof fetch }),
    ).rejects.toThrow(/test-mode key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an empty or test-mode Stripe key", () => {
    expect(() => assertStripeTestMode({})).not.toThrow();
    expect(() => assertStripeTestMode({ STRIPE_SECRET_KEY: "sk_test_example" })).not.toThrow();
  });

  it("clears the demo through the documented route and reseeds clock and preferences", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: new URL(String(input)), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await resetDemo({
      mcpUrl: "http://localhost:3000/mcp",
      env: { STRIPE_SECRET_KEY: "sk_test_example" },
      fetch: fetchMock as typeof fetch,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/demo/reset");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      clock: DEMO_START,
      preferences: DEMO_PREFERENCES,
    });
  });
});
