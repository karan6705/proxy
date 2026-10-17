// The merchants' Inkbox identities: which handle and address each one sends from, and which environment variable
// holds its own key.
//
// Each sending identity needs its OWN Inkbox key (the admin key is rejected for agent-to-agent). Sarah creates the
// keys and shares them privately. They are read from process.env only. They are never written to a file, a log, an
// error message or a test, and an IdentityKeys object prints as a redacted summary.
//
// Addresses: tests and every default run use the .example addresses. The real @inkboxmail.com addresses are only for
// end-to-end runs, switched on with MERCHANT_ADDRESS_MODE=real.

import type { MerchantId } from "../types.js";

export type AddressMode = "test" | "real";

export interface MerchantIdentity {
  merchant_id: MerchantId;
  /** The Inkbox handle. */
  handle: string;
  /** The environment variable that holds this identity's own Inkbox key. */
  key_env: string;
  /** Used in tests and by default. */
  test_address: string;
  /** The real Inkbox address, for end-to-end runs. */
  real_address: string;
}

/** The merchants that have a real Inkbox identity. The host is a person, so it has none. */
export type InkboxMerchantId = "airline" | "hotel" | "transfer";

export const MERCHANT_IDENTITIES: Readonly<Record<InkboxMerchantId, MerchantIdentity>> = {
  airline: {
    merchant_id: "airline",
    handle: "airline",
    key_env: "INKBOX_AIRLINE_API_KEY",
    test_address: "reservations@skylinedemoair.example",
    real_address: "airline@inkboxmail.com",
  },
  hotel: {
    merchant_id: "hotel",
    handle: "hotel-agent",
    key_env: "INKBOX_HOTEL_AGENT_API_KEY",
    test_address: "reservations@harborviewhotel.example",
    real_address: "hotel-agent@inkboxmail.com",
  },
  transfer: {
    merchant_id: "transfer",
    handle: "transfer-support",
    key_env: "INKBOX_TRANSFER_SUPPORT_API_KEY",
    test_address: "support@metrotransfer.example",
    real_address: "transfer-support@inkboxmail.com",
  },
};

export function identityFor(merchant_id: MerchantId): MerchantIdentity | null {
  return merchant_id in MERCHANT_IDENTITIES ? MERCHANT_IDENTITIES[merchant_id as InkboxMerchantId] : null;
}

/** MERCHANT_ADDRESS_MODE=real switches to the real addresses. Anything else, including unset, is test. */
export function addressMode(env: NodeJS.ProcessEnv = process.env): AddressMode {
  return env.MERCHANT_ADDRESS_MODE?.trim().toLowerCase() === "real" ? "real" : "test";
}

export function addressFor(identity: MerchantIdentity, mode: AddressMode): string {
  return mode === "real" ? identity.real_address : identity.test_address;
}

export interface KeyStatus {
  merchant_id: MerchantId;
  handle: string;
  env_var: string;
  present: boolean;
}

/**
 * The merchants' own Inkbox keys, read from the environment. The values live in a private field, so printing,
 * logging or JSON.stringify of this object shows only which variables are set, never the keys.
 */
export class IdentityKeys {
  readonly #keys = new Map<MerchantId, string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const identity of Object.values(MERCHANT_IDENTITIES)) {
      const value = env[identity.key_env]?.trim();
      if (value) {
        this.#keys.set(identity.merchant_id, value);
      }
    }
  }

  has(merchant_id: MerchantId): boolean {
    return this.#keys.has(merchant_id);
  }

  /** The key, for passing straight to the SDK. Never log it. */
  get(merchant_id: MerchantId): string | undefined {
    return this.#keys.get(merchant_id);
  }

  /** Replaces every key in `text` with [redacted]. Use it on anything that may carry a key into a message. */
  redact(text: string): string {
    let safe = text;
    for (const key of this.#keys.values()) {
      safe = safe.split(key).join("[redacted]");
    }
    return safe;
  }

  /** Which keys are set, by variable name. Safe to print. */
  describe(): KeyStatus[] {
    return Object.values(MERCHANT_IDENTITIES).map((identity) => ({
      merchant_id: identity.merchant_id,
      handle: identity.handle,
      env_var: identity.key_env,
      present: this.#keys.has(identity.merchant_id),
    }));
  }

  /** Names of the variables that are not set. */
  missing(): string[] {
    return this.describe().filter((status) => !status.present).map((status) => status.env_var);
  }

  toJSON(): KeyStatus[] {
    return this.describe();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `IdentityKeys ${JSON.stringify(this.describe())}`;
  }
}

export function loadIdentityKeys(env: NodeJS.ProcessEnv = process.env): IdentityKeys {
  return new IdentityKeys(env);
}
