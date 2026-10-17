// A real MerchantDeps.deliver: sends a merchant's email through Inkbox as that merchant's own identity.
//
//   const deps = { charge, deliver: createInkboxDeliver() };
//
// Which key signs the send: the sending identity's own key (INKBOX_AIRLINE_API_KEY, INKBOX_HOTEL_AGENT_API_KEY,
// INKBOX_TRANSFER_SUPPORT_API_KEY), and if that one is not set, INKBOX_API_KEY (email out works with it). An email
// with no merchant identity, such as the copy of the agent's message to the host, goes out as Proxy's own identity
// (INKBOX_PROXY_HANDLE, default proxy-agent) using INKBOX_PROXY_API_KEY or INKBOX_API_KEY.
//
// INKBOX_DRY_RUN=1 logs what would be sent (sender, recipient, subject) and sends nothing. Keys are read from the
// environment only, are never logged, and are removed from any error message.
//
// Not yet tested against live Inkbox: that needs the identities' keys. The SDK calls are exactly the ones in
// Sarah's reality check in HANDOFF.md.

import { loadSdk } from "../inkbox/sdk.js";
import type { MerchantDeps, MerchantEmail } from "./deps.js";
import { IdentityKeys, identityFor, loadIdentityKeys } from "./identities.js";
import { MerchantError } from "./orders.js";

/** The slice of the Inkbox SDK this uses. */
export interface InkboxLike {
  getIdentity(handle: string): Promise<{
    sendEmail(message: { to: string[]; subject: string; bodyText: string; bodyHtml: string }): Promise<unknown>;
  }>;
}

export interface InkboxDeliverOptions {
  env?: NodeJS.ProcessEnv;
  /** Builds a ready client for one API key. Tests inject a fake. The default loads @inkbox/sdk. */
  clientFor?: (apiKey: string) => Promise<InkboxLike>;
  log?: (line: string) => void;
}

async function defaultClientFor(apiKey: string): Promise<InkboxLike> {
  const { Inkbox } = await loadSdk();
  return new Inkbox({ apiKey }).ready();
}

export function createInkboxDeliver(options: InkboxDeliverOptions = {}): MerchantDeps["deliver"] {
  const env = options.env ?? process.env;
  const keys: IdentityKeys = loadIdentityKeys(env);
  const clientFor = options.clientFor ?? defaultClientFor;
  const log = options.log ?? ((line: string) => console.log(`[merchants] ${line}`));
  const dryRun = env.INKBOX_DRY_RUN === "1";

  return async function deliver(email: MerchantEmail): Promise<void> {
    const identity = email.identity ? identityFor(email.identity) : null;
    const handle = identity?.handle ?? env.INKBOX_PROXY_HANDLE?.trim() ?? "proxy-agent";

    if (dryRun) {
      log(`dry run: would send from ${handle} to ${email.to}: ${email.subject}`);
      return;
    }

    const ownKey = identity ? keys.get(identity.merchant_id) : env.INKBOX_PROXY_API_KEY?.trim();
    const apiKey = ownKey || env.INKBOX_API_KEY?.trim();
    if (!apiKey) {
      const wanted = identity ? `${identity.key_env} (or INKBOX_API_KEY)` : "INKBOX_PROXY_API_KEY (or INKBOX_API_KEY)";
      throw new MerchantError("upstream_unavailable", `No Inkbox key to send as ${handle}: set ${wanted}`);
    }

    try {
      const client = await clientFor(apiKey);
      const sender = await client.getIdentity(handle);
      await sender.sendEmail({ to: [email.to], subject: email.subject, bodyText: email.body, bodyHtml: email.html });
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      // The SDK's own error text could carry a key. Remove every Inkbox key this process holds before it goes
      // anywhere: the merchants' own, Proxy's, the admin key, and the one used for this send.
      const held = [apiKey, env.INKBOX_API_KEY, env.INKBOX_PROXY_API_KEY].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
      const safe = held.reduce((text, secret) => text.split(secret).join("[redacted]"), keys.redact(raw));
      throw new MerchantError("upstream_unavailable", `Inkbox could not send as ${handle}: ${safe}`);
    }
  };
}
