import { describe, expect, it } from "vitest";
import { createFakeDeps, createMerchants, merchantRoutes } from "../../src/merchants/index.js";
import type { HttpMethod, RouteHandler, RouteResponse } from "../../src/types.js";
import { DEMO_NOW, FLIGHT_BOOKED_AT, fakeClock, requestReversal } from "../helpers/demo.js";

function setup() {
  const fake = createFakeDeps();
  const merchants = createMerchants(fake.deps);
  const clock = fakeClock(DEMO_NOW);
  const routes = merchantRoutes(merchants, fake.deps, clock);
  return { fake, merchants, clock, routes };
}

async function call(routes: RouteHandler[], method: HttpMethod, path: string, body?: unknown, raw?: string): Promise<RouteResponse> {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`No route for ${method} ${path}`);
  }
  return route.handle({ method, path, headers: {}, query: {}, rawBody: raw ?? (body === undefined ? "" : JSON.stringify(body)) });
}

const flightBody = {
  task_id: "task_nyc",
  task_email: "task_nyc@tasks.proxy.example",
  item: "SFO-JFK",
  dates: { start: "2026-11-03" },
  amount: 41200,
  booked_at: FLIGHT_BOOKED_AT,
};

describe("merchant routes: shape", () => {
  it("mounts every route under /merchants/ and never repeats a method and path", () => {
    const { routes } = setup();
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.path.startsWith("/merchants")).toBe(true);
    }
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives agents only to merchants that have one, and support desks only to the merchants that take email (transfer, host, saas, store)", () => {
    const { routes } = setup();
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/merchants/hotel/agent");
    expect(paths).not.toContain("/merchants/airline/agent");
    expect(paths).not.toContain("/merchants/transfer/agent");
    expect(paths).toContain("/merchants/transfer/support");
    expect(paths).toContain("/merchants/host/support");
    expect(paths).not.toContain("/merchants/host/agent");
    expect(paths).toContain("/merchants/saas/support");
    expect(paths).toContain("/merchants/store/support");
    expect(paths).not.toContain("/merchants/saas/agent");
    expect(paths).not.toContain("/merchants/store/agent");
    expect(paths).not.toContain("/merchants/airline/support");
    expect(paths).not.toContain("/merchants/hotel/support");
  });

  it("lists the six merchants", async () => {
    const { routes } = setup();
    const response = await call(routes, "GET", "/merchants");
    expect(response.status).toBe(200);
    expect((response.body as { merchants: { merchant_id: string }[] }).merchants.map((m) => m.merchant_id)).toEqual(["airline", "hotel", "transfer", "host", "saas", "store"]);
  });
});

describe("merchant routes: airline", () => {
  it("books, emails the confirmation, then cancels under the 24-hour rule on the simulated clock", async () => {
    const { routes, fake } = setup();

    const booked = await call(routes, "POST", "/merchants/airline/book", flightBody);
    expect(booked.status).toBe(200);
    const { ref } = booked.body as { ref: string };
    expect(fake.emails).toHaveLength(1);

    const cancelled = await call(routes, "POST", "/merchants/airline/cancel", { ref });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ ok: true, refund_amount: 41200 });
    expect(cancelled.body).toMatchObject({ stripe_refund_id: null });
  });

  it("refuses the cancel once the simulated clock passes the 24-hour window", async () => {
    const { routes, clock } = setup();
    const { ref } = (await call(routes, "POST", "/merchants/airline/book", flightBody)).body as { ref: string };

    clock.set("2026-10-18T09:00:00.001Z");
    const refused = await call(routes, "POST", "/merchants/airline/cancel", { ref });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ ok: false, refund_amount: 0 });
  });

  it("defaults booked_at to the clock", async () => {
    const { routes, merchants, clock } = setup();
    const { booked_at: _ignored, ...withoutBookedAt } = flightBody;
    const { ref } = (await call(routes, "POST", "/merchants/airline/book", withoutBookedAt)).body as { ref: string };
    expect(merchants.getOrder(ref)?.booked_at).toBe(clock.now());
  });

  it("holds back a deferred confirmation until /confirm", async () => {
    const { routes, fake } = setup();
    const { ref } = (await call(routes, "POST", "/merchants/airline/book", { ...flightBody, defer_confirmation: true })).body as { ref: string };
    expect(fake.emails).toHaveLength(0);

    const confirmed = await call(routes, "POST", "/merchants/airline/confirm", { ref });
    expect(confirmed).toMatchObject({ status: 200, body: { sent: true } });
    expect(fake.emails).toHaveLength(1);
    expect((await call(routes, "POST", "/merchants/airline/confirm", { ref })).body).toEqual({ sent: false });
  });
});

describe("merchant routes: hotel agent", () => {
  it("answers a Reversal Protocol request with a typed counter", async () => {
    const { routes } = setup();
    const { ref } = (
      await call(routes, "POST", "/merchants/hotel/book", {
        ...flightBody,
        item: "Harborview Hotel, 3 nights",
        dates: { start: "2026-11-03", end: "2026-11-06" },
        amount: 64000,
        booked_at: "2026-10-17T11:00:00.000Z",
      })
    ).body as { ref: string };

    const response = await call(routes, "POST", "/merchants/hotel/agent", requestReversal(ref, "hotel", 64000));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ type: "counter", kind: "store_credit", amount: 64000, round: 1 });
  });

  it("rejects a body that is not a Proxy protocol message", async () => {
    const { routes } = setup();
    for (const body of [{}, { type: "accept", negotiation_id: "n", round: 1 }, { type: "push_back", round: 1 }, { type: "push_back", negotiation_id: "n" }]) {
      const response = await call(routes, "POST", "/merchants/hotel/agent", body);
      expect(response.status).toBe(400);
    }
  });
});

describe("merchant routes: transfer support desk", () => {
  it("approves and delivers the reply email, leaving the refund to the orchestrator", async () => {
    const { routes, fake } = setup();
    const { ref } = (
      await call(routes, "POST", "/merchants/transfer/book", {
        ...flightBody,
        item: "Airport transfer, JFK to Harborview Hotel",
        amount: 18800,
        booked_at: "2026-10-17T09:15:00.000Z",
      })
    ).body as { ref: string };

    const response = await call(routes, "POST", "/merchants/transfer/support", {
      from: "proxy@tasks.proxy.example",
      subject: `Cancel ${ref}`,
      body: `Please cancel booking ${ref}.`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ approved: true, ref, refund_amount: 18800 });
    expect(response.body).not.toHaveProperty("stripe_refund_id");
    const reply = fake.emails.at(-1);
    expect(reply?.to).toBe("proxy@tasks.proxy.example");
    expect(reply?.body).toContain("REFUND APPROVED");
  });

  it("rejects a sender that is not an email address", async () => {
    const { routes } = setup();
    const response = await call(routes, "POST", "/merchants/transfer/support", { from: "nobody", subject: "x", body: "y" });
    expect(response.status).toBe(400);
  });
});

describe("merchant routes: errors", () => {
  it("answers 400 for invalid JSON and for a body that is not an object", async () => {
    const { routes } = setup();
    expect((await call(routes, "POST", "/merchants/airline/book", undefined, "{not json")).status).toBe(400);
    expect((await call(routes, "POST", "/merchants/airline/book", undefined, "[1,2]")).status).toBe(400);
  });

  it("answers 400 for invalid booking input and does not charge", async () => {
    const { routes, fake } = setup();
    const response = await call(routes, "POST", "/merchants/airline/book", { ...flightBody, amount: 0 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_input" });
    expect(fake.charges).toHaveLength(0);
  });

  it("answers 400 when the amount is not a number", async () => {
    const { routes } = setup();
    expect((await call(routes, "POST", "/merchants/airline/book", { ...flightBody, amount: "41200" })).status).toBe(400);
  });

  it("answers 404 when confirming an unknown booking", async () => {
    const { routes } = setup();
    const response = await call(routes, "POST", "/merchants/airline/confirm", { ref: "AIR-NOPE00" });
    expect(response.status).toBe(404);
  });

  it("answers 502 when Stripe is down", async () => {
    const { routes, fake } = setup();
    fake.failures.charge = true;
    const response = await call(routes, "POST", "/merchants/airline/book", flightBody);
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ error: "upstream_unavailable" });
  });

  it("answers 400 for a request_reversal with no order reference", async () => {
    const { routes } = setup();
    const response = await call(routes, "POST", "/merchants/hotel/agent", { type: "request_reversal", negotiation_id: "n", round: 1 });
    expect(response.status).toBe(400);
  });

  it("answers 500 with a generic message, and does not leak internals, on an unexpected error", async () => {
    const { merchants, fake, clock } = setup();
    const broken = {
      ...merchants,
      agent: () => ({
        merchant_id: "hotel",
        respond: async () => {
          throw new TypeError("secret internal detail");
        },
      }),
    };
    const routes = merchantRoutes(broken, fake.deps, clock);
    const response = await call(routes, "POST", "/merchants/hotel/agent", requestReversal("HTL-ABC123", "hotel", 64000));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(response.body).toMatchObject({ error: "internal" });
  });
});

describe("merchant routes: host correction", () => {
  it("books the agent's message for $0, then takes the correction over the support route", async () => {
    const { routes, fake, merchants } = setup();
    const booked = await call(routes, "POST", "/merchants/host/book", {
      task_id: "task_nyc",
      task_email: "task_nyc@tasks.proxy.example",
      item: "Arrival email to the host: arriving 2026-11-03",
      dates: { start: "2026-11-03" },
      amount: 0,
    });
    expect(booked.status).toBe(200);
    const { ref } = booked.body as { ref: string };
    expect(fake.charges).toHaveLength(0);

    const corrected = await call(routes, "POST", "/merchants/host/support", {
      from: "proxy@tasks.proxy.example",
      subject: `Correction to ${ref}`,
      body: `Please correct ${ref}: I arrive 2026-11-13.`,
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body).toMatchObject({ approved: true, ref, refund_amount: 0 });
    expect(fake.emails.at(-1)?.to).toBe("proxy@tasks.proxy.example");
    expect(merchants.getOrder(ref)?.status).toBe("corrected");
  });

  it("answers 400 for a message with a negative amount", async () => {
    const { routes } = setup();
    const response = await call(routes, "POST", "/merchants/host/book", {
      task_id: "task_nyc",
      task_email: "task_nyc@tasks.proxy.example",
      item: "x",
      dates: { start: "2026-11-03" },
      amount: -5,
    });
    expect(response.status).toBe(400);
  });
});
