import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  IdentityKeys,
  MERCHANT_IDENTITIES,
  addressFor,
  addressMode,
  createFakeDeps,
  createMerchants,
  identityFor,
  loadIdentityKeys,
} from "../../src/merchants/index.js";
import type { BookingRequest } from "../../src/types.js";
import { DEMO_NOW, FLIGHT_BOOKED_AT } from "../helpers/demo.js";

// Synthetic values only. These are not real keys.
const KEYS = {
  INKBOX_AIRLINE_API_KEY: "fake-airline-key-0001",
  INKBOX_HOTEL_AGENT_API_KEY: "fake-hotel-key-0002",
  INKBOX_TRANSFER_SUPPORT_API_KEY: "fake-transfer-key-0003",
};

describe("identities: the table", () => {
  it("has the real Inkbox handles and addresses for the airline, hotel and transfer desk", () => {
    expect(MERCHANT_IDENTITIES.airline).toMatchObject({ handle: "airline", real_address: "airline@inkboxmail.com" });
    expect(MERCHANT_IDENTITIES.hotel).toMatchObject({ handle: "hotel-agent", real_address: "hotel-agent@inkboxmail.com" });
    expect(MERCHANT_IDENTITIES.transfer).toMatchObject({ handle: "transfer-support", real_address: "transfer-support@inkboxmail.com" });
  });

  it("keeps support@metrotransfer.example as the transfer desk's test address", () => {
    expect(MERCHANT_IDENTITIES.transfer.test_address).toBe("support@metrotransfer.example");
    for (const identity of Object.values(MERCHANT_IDENTITIES)) {
      expect(identity.test_address.endsWith(".example")).toBe(true);
      expect(identity.real_address.endsWith("@inkboxmail.com")).toBe(true);
    }
  });

  it("gives each identity its own key variable", () => {
    const names = Object.values(MERCHANT_IDENTITIES).map((i) => i.key_env);
    expect(new Set(names).size).toBe(3);
    expect(names.sort()).toEqual(["INKBOX_AIRLINE_API_KEY", "INKBOX_HOTEL_AGENT_API_KEY", "INKBOX_TRANSFER_SUPPORT_API_KEY"]);
  });

  it("has no identity for the host, who is a person", () => {
    expect(identityFor("host")).toBeNull();
    expect(identityFor("hotel")?.handle).toBe("hotel-agent");
  });
});

describe("identities: the address mode", () => {
  it("is test unless MERCHANT_ADDRESS_MODE is real", () => {
    expect(addressMode({})).toBe("test");
    expect(addressMode({ MERCHANT_ADDRESS_MODE: "test" })).toBe("test");
    expect(addressMode({ MERCHANT_ADDRESS_MODE: "anything else" })).toBe("test");
    expect(addressMode({ MERCHANT_ADDRESS_MODE: "real" })).toBe("real");
    expect(addressMode({ MERCHANT_ADDRESS_MODE: " REAL " })).toBe("real");
  });

  it("picks the matching address", () => {
    expect(addressFor(MERCHANT_IDENTITIES.transfer, "test")).toBe("support@metrotransfer.example");
    expect(addressFor(MERCHANT_IDENTITIES.transfer, "real")).toBe("transfer-support@inkboxmail.com");
  });
});

describe("identities: the keys", () => {
  it("reads each key from its own variable", () => {
    const keys = loadIdentityKeys({ ...KEYS });
    expect(keys.get("airline")).toBe(KEYS.INKBOX_AIRLINE_API_KEY);
    expect(keys.get("hotel")).toBe(KEYS.INKBOX_HOTEL_AGENT_API_KEY);
    expect(keys.get("transfer")).toBe(KEYS.INKBOX_TRANSFER_SUPPORT_API_KEY);
    expect(keys.missing()).toEqual([]);
  });

  it("reports missing keys by variable name, and ignores blank values", () => {
    const keys = loadIdentityKeys({ INKBOX_HOTEL_AGENT_API_KEY: KEYS.INKBOX_HOTEL_AGENT_API_KEY, INKBOX_AIRLINE_API_KEY: "   " });
    expect(keys.has("hotel")).toBe(true);
    expect(keys.has("airline")).toBe(false);
    expect(keys.missing().sort()).toEqual(["INKBOX_AIRLINE_API_KEY", "INKBOX_TRANSFER_SUPPORT_API_KEY"]);
  });

  it("trims whitespace around a key", () => {
    expect(loadIdentityKeys({ INKBOX_AIRLINE_API_KEY: `  ${KEYS.INKBOX_AIRLINE_API_KEY}\n` }).get("airline")).toBe(KEYS.INKBOX_AIRLINE_API_KEY);
  });

  it("does not use the admin key as a merchant key", () => {
    const keys = loadIdentityKeys({ INKBOX_API_KEY: "fake-admin-key-9999" });
    expect(keys.has("hotel")).toBe(false);
  });

  it("never shows a key when printed, logged or serialized", () => {
    const keys = new IdentityKeys({ ...KEYS });
    const shown = [JSON.stringify(keys), inspect(keys), inspect({ nested: keys }), JSON.stringify(keys.describe())].join("\n");
    for (const value of Object.values(KEYS)) {
      expect(shown).not.toContain(value);
    }
    // It does say which variables are set.
    expect(shown).toContain("INKBOX_HOTEL_AGENT_API_KEY");
    expect(shown).toContain('"present":true');
  });

  it("removes every key from text with redact", () => {
    const keys = new IdentityKeys({ ...KEYS });
    const text = `401 for ${KEYS.INKBOX_AIRLINE_API_KEY} and ${KEYS.INKBOX_TRANSFER_SUPPORT_API_KEY}, twice ${KEYS.INKBOX_AIRLINE_API_KEY}`;
    expect(keys.redact(text)).toBe("401 for [redacted] and [redacted], twice [redacted]");
  });
});

describe("merchants: test addresses by default, real addresses on request", () => {
  const request = (overrides: Partial<BookingRequest>): BookingRequest => ({
    merchant_id: "airline",
    task_id: "task_nyc",
    task_email: "task_nyc@tasks.proxy.example",
    item: "SFO-JFK",
    dates: { start: "2026-11-03" },
    amount: 41200,
    booked_at: FLIGHT_BOOKED_AT,
    ...overrides,
  });
  const hotel = (): BookingRequest => request({ merchant_id: "hotel", item: "Harborview Hotel, 3 nights", dates: { start: "2026-11-03", end: "2026-11-06" }, amount: 64000 });
  const transfer = (): BookingRequest => request({ merchant_id: "transfer", item: "Airport transfer", amount: 18800 });

  it("test (the default): the .example addresses, and support@metrotransfer.example for the desk", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps);
    await merchants.book(request({}));
    await merchants.book(hotel());
    await merchants.book(transfer());

    expect(fake.emails.map((e) => e.from.address)).toEqual([
      "reservations@skylinedemoair.example",
      "reservations@harborviewhotel.example",
      "bookings@metrotransfer.example",
    ]);
    expect(merchants.get("transfer")?.support_email).toBe("support@metrotransfer.example");
    expect(merchants.get("airline")?.support_email).toBe("reservations@skylinedemoair.example");
    expect(merchants.get("hotel")?.support_email).toBe("reservations@harborviewhotel.example");
  });

  it("passing test explicitly is the same as the default", async () => {
    const a = createFakeDeps();
    const b = createFakeDeps();
    await createMerchants(a.deps).book(request({}));
    await createMerchants(b.deps, { addresses: "test" }).book(request({}));
    expect(b.emails).toEqual(a.emails);
  });

  it("real: every merchant sends from its own inkboxmail.com address", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps, { addresses: "real" });
    await merchants.book(request({}));
    await merchants.book(hotel());
    await merchants.book(transfer());

    expect(fake.emails.map((e) => e.from.address)).toEqual([
      "airline@inkboxmail.com",
      "hotel-agent@inkboxmail.com",
      "transfer-support@inkboxmail.com",
    ]);
    expect(merchants.get("transfer")?.support_email).toBe("transfer-support@inkboxmail.com");
  });

  it("real: the transfer desk's confirmation tells people to email the real address, and the JSON-LD names it", async () => {
    const fake = createFakeDeps();
    await createMerchants(fake.deps, { addresses: "real" }).book(transfer());
    expect(fake.emails[0].body).toContain("transfer-support@inkboxmail.com");
    expect(fake.emails[0].html).toContain("transfer-support@inkboxmail.com");
    expect(fake.emails[0].body).not.toContain("metrotransfer.example");
  });

  it("real: the transfer desk replies from the real address", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps, { addresses: "real" });
    const { ref } = await merchants.book(transfer());
    const reply = await merchants.supportEmail("transfer", { from: "proxy-agent@inkboxmail.com", subject: `Cancel ${ref}`, body: ref }, DEMO_NOW);
    expect(reply.reply.from.address).toBe("transfer-support@inkboxmail.com");
  });

  it("the hotel agent's identity is the real handle in both modes", () => {
    for (const addresses of ["test", "real"] as const) {
      expect(createMerchants(createFakeDeps().deps, { addresses }).get("hotel")?.agent_identity).toBe("hotel-agent");
    }
  });

  it("marks each email with the merchant it is sent as", async () => {
    const fake = createFakeDeps();
    const merchants = createMerchants(fake.deps);
    await merchants.book(request({}));
    await merchants.book(hotel());
    await merchants.book(transfer());
    await merchants.book(request({ merchant_id: "host", item: "Arrival email", amount: 0 }));
    expect(fake.emails.map((e) => e.identity)).toEqual(["airline", "hotel", "transfer", "host"]);
  });
});
