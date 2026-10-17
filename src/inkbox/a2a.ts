// An identity's own A2A access. A2A rejects the admin key, so each side uses a key scoped to its identity:
// an explicit one if given (INKBOX_PROXY_API_KEY, INKBOX_KEY_HOTEL_AGENT), otherwise one minted once and kept in memory.
import { loadSdk, type InkboxSdk } from "./sdk.js";

export interface A2AAccess {
  /** The identity acting as itself, with the scoped client it was loaded from. */
  identity(): Promise<{ inkbox: InkboxSdk; identity: InkboxSdk }>;
}

export function createA2AAccess(opts: { admin: () => Promise<InkboxSdk>; handle: string; apiKey?: string }): A2AAccess {
  let cached: Promise<{ inkbox: InkboxSdk; identity: InkboxSdk }> | undefined;
  return {
    identity() {
      cached ??= (async () => {
        const { Inkbox } = await loadSdk();
        let apiKey = opts.apiKey;
        if (!apiKey) {
          const admin = await opts.admin();
          const me = await admin.getIdentity(opts.handle);
          apiKey = (await admin.apiKeys.create({ label: `${opts.handle}-a2a`, scopedIdentityId: me.id })).apiKey as string;
        }
        const scoped = await new Inkbox({ apiKey }).ready();
        return { inkbox: scoped, identity: await scoped.getIdentity(opts.handle) };
      })().catch((e) => {
        cached = undefined;
        throw e;
      });
      return cached;
    },
  };
}
