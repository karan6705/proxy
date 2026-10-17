import { describe, expect, it } from "vitest";
import {
  type InkboxLike,
  createFakeDeps,
  createInkboxDeliver,
  createMerchants,
  merchantRoutes,
} from "../../src/merchants/index.js";
import type { MerchantEmail } from "../../src/merchants/deps.js";
import type { BookingRequest } from "../../src/types.js";
import { FLIGHT_BOOKED_AT, fakeClock } from "../helpers/demo.js";

// Synthetic values only. These are not real keys.
const AIRLINE = "fake-airline-key-0001";
const HOTEL = "fake-hotel-key-0002";
const TRANSFER = "fake-transfer-key-0003";
const PROXY = "fake-proxy-key-0004";
const ADMIN = "fake-admin-key-0005";
const ALL_KEYS = [AIRLINE, HOTEL, TRANSFER, PROXY, ADMIN];

const FULL_ENV = {
  INKBOX_AIRLINE_API_KEY: AIRLINE,
  INKBOX_HOTEL_AGENT_API_KEY: HOTEL,
  INKBOX_TRANSFER_SUPPORT_API_KEY: TRANSFER,
  INKBOX_PROXY_API_KEY: PROXY,
  INKBOX_API_KEY: ADMIN,
};

interface Sent {
  apiKey: string;
  handle: string;
  message: { to: string[]; subject: string; bodyText: string; bodyHtml: string };
}

function setup(env: NodeJS.ProcessEnv, failWith?: (apiKey: string) => Error) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const deliver = createInkboxDeliver({
    env,
    log: (line) => logs.push(line),
    clientFor: async (apiKey): Promise<InkboxLike> => {
      if (failWith) {
        throw failWith(apiKey);
      }
      return {
        getIdentity: async (handle) => ({
          sendEmail: async (message) => {
            sent.push({ apiKey, handle, message });
          },
        }),
      };
    },
  });
  return { deliver, sent, logs };
}

const email = (identity?: MerchantEmail["identity"]): MerchantEmail => ({
  from: { name: "Sender", address: "sender@example.com" },
  to: "task_nyc@tasks.proxy.example",
  subject: "Your booking is confirmed",
  body: "plain text body",
  html: "<html><body>html body</body></html>",
  identity,
});

describe("inkbox deliver: sends as the merchant's own identity with its own key", () => {
  it("sends the airline's email as airline with the airline key", async () => {
    const { deliver, sent } = setup(FULL_ENV);
    await deliver(email("airline"));
    expect(sent).toEqual([
      {
        apiKey: AIRLINE,
        handle: "airline",
        message: { to: ["task_nyc@tasks.proxy.example"], subject: "Your booking is confirmed", bodyText: "plain text body", bodyHtml: "<html><body>html body</body></html>" },
      },
    ]);
  });

  it("uses a different key for each identity", async () => {
    const { deliver, sent } = setup(FULL_ENV);
    await deliver(email("airline"));
    await deliver(email("hotel"));
    await deliver(email("transfer"));
    expect(sent.map((s) => [s.handle, s.apiKey])).toEqual([
      ["airline", AIRLINE],
      ["hotel-agent", HOTEL],
      ["transfer-support", TRANSFER],
    ]);
  });

  it("falls back to INKBOX_API_KEY when the identity's own key is not set", async () => {
    const { deliver, sent } = setup({ INKBOX_API_KEY: ADMIN });
    await deliver(email("hotel"));
    expect(sent[0]).toMatchObject({ handle: "hotel-agent", apiKey: ADMIN });
  });

  it("fails with the variable names, and no values, when there is no key at all", async () => {
    const { deliver, sent } = setup({});
    const error = await deliver(email("hotel")).catch((e: Error) => e);
    expect(error).toMatchObject({ name: "MerchantError", kind: "upstream_unavailable" });
    expect((error as Error).message).toContain("INKBOX_HOTEL_AGENT_API_KEY");
    expect((error as Error).message).toContain("hotel-agent");
    expect(sent).toEqual([]);
  });

  it("sends an email with no merchant identity (the host's copy) as Proxy's own identity", async () => {
    const { deliver, sent } = setup(FULL_ENV);
    await deliver(email("host"));
    await deliver(email(undefined));
    expect(sent.map((s) => [s.handle, s.apiKey])).toEqual([
      ["proxy-agent", PROXY],
      ["proxy-agent", PROXY],
    ]);
  });

  it("uses INKBOX_PROXY_HANDLE for Proxy's identity, and the admin key if Proxy has none", async () => {
    const { deliver, sent } = setup({ INKBOX_PROXY_HANDLE: "proxy-demo", INKBOX_API_KEY: ADMIN });
    await deliver(email(undefined));
    expect(sent[0]).toMatchObject({ handle: "proxy-demo", apiKey: ADMIN });
  });
});

describe("inkbox deliver: dry run and secrecy", () => {
  it("logs what it would send and sends nothing when INKBOX_DRY_RUN=1", async () => {
    const { deliver, sent, logs } = setup({ ...FULL_ENV, INKBOX_DRY_RUN: "1" });
    await deliver(email("transfer"));
    expect(sent).toEqual([]);
    expect(logs).toEqual(["dry run: would send from transfer-support to task_nyc@tasks.proxy.example: Your booking is confirmed"]);
  });

  it("needs no key at all in a dry run", async () => {
    const { deliver, logs } = setup({ INKBOX_DRY_RUN: "1" });
    await expect(deliver(email("airline"))).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
  });

  it("never logs a key or the email body", async () => {
    const { deliver, logs } = setup({ ...FULL_ENV, INKBOX_DRY_RUN: "1" });
    await deliver(email("airline"));
    const shown = logs.join("\n");
    for (const key of ALL_KEYS) {
      expect(shown).not.toContain(key);
    }
    expect(shown).not.toContain("plain text body");
  });

  it("removes keys from a failure message, whichever key the SDK echoes", async () => {
    const { deliver } = setup(FULL_ENV, (apiKey) => new Error(`401 Unauthorized for ${apiKey}; also saw ${ADMIN} and ${TRANSFER}`));
    const error = (await deliver(email("airline")).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("Inkbox could not send as airline");
    for (const key of ALL_KEYS) {
      expect(error.message).not.toContain(key);
    }
    expect(error.message).toContain("[redacted]");
  });

  it("reports a send failure as an upstream error", async () => {
    const { deliver } = setup(FULL_ENV, () => new Error("network down"));
    await expect(deliver(email("hotel"))).rejects.toMatchObject({ kind: "upstream_unavailable" });
  });
});

describe("inkbox deliver: with the real merchants", () => {
  const book = (overrides: Partial<BookingRequest>): BookingRequest => ({
    merchant_id: "airline",
    task_id: "task_nyc",
    task_email: "task-nyc@inkboxmail.com",
    item: "SFO-JFK",
    dates: { start: "2026-11-03" },
    amount: 41200,
    booked_at: FLIGHT_BOOKED_AT,
    ...overrides,
  });

  it("sends each confirmation as the right identity, in real address mode", async () => {
    const { deliver, sent } = setup(FULL_ENV);
    const fake = createFakeDeps();
    const merchants = createMerchants({ charge: fake.deps.charge, deliver }, { addresses: "real" });

    await merchants.book(book({}));
    await merchants.book(book({ merchant_id: "hotel", item: "Harborview Hotel, 3 nights", dates: { start: "2026-11-03", end: "2026-11-06" }, amount: 64000 }));
    await merchants.book(book({ merchant_id: "transfer", item: "Airport transfer", amount: 18800 }));
    await merchants.book(book({ merchant_id: "host", item: "Arrival email to the host", amount: 0 }));

    expect(sent.map((s) => [s.handle, s.apiKey])).toEqual([
      ["airline", AIRLINE],
      ["hotel-agent", HOTEL],
      ["transfer-support", TRANSFER],
      ["proxy-agent", PROXY],
    ]);
    expect(sent.every((s) => s.message.to[0] === "task-nyc@inkboxmail.com")).toBe(true);
    expect(sent[0].message.bodyHtml).toContain("application/ld+json");
  });

  it("sends the transfer desk's reply as transfer-support through the support route", async () => {
    const { deliver, sent } = setup(FULL_ENV);
    const fake = createFakeDeps();
    const deps = { charge: fake.deps.charge, deliver };
    const merchants = createMerchants(deps, { addresses: "real" });
    const routes = merchantRoutes(merchants, deps, fakeClock("2026-10-18T05:25:00.000Z"));
    const { ref } = await merchants.book(book({ merchant_id: "transfer", item: "Airport transfer", amount: 18800 }));
    sent.length = 0;

    const route = routes.find((r) => r.path === "/merchants/transfer/support") as (typeof routes)[number];
    const response = await route.handle({
      method: "POST",
      path: route.path,
      headers: {},
      query: {},
      rawBody: JSON.stringify({ from: "proxy-agent@inkboxmail.com", subject: `Cancel ${ref}`, body: `Please cancel ${ref}` }),
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ handle: "transfer-support", apiKey: TRANSFER });
    expect(sent[0].message.to).toEqual(["proxy-agent@inkboxmail.com"]);
    expect(sent[0].message.bodyText).toContain("REFUND APPROVED");
  });
});
